/**
 * Локальный Python-движок (faster-whisper + Piper): менеджер жизненного цикла.
 *
 * Обеспечивает:
 * - Скачивание/распаковку portable Python (astral-sh/python-build-standalone)
 * - Создание venv и установку зависимостей (faster-whisper, piper-tts)
 * - Предзагрузку моделей (Piper ru_RU-irina-medium, faster-whisper small)
 * - Запуск/остановку py/server.py как дочернего процесса
 *
 * Все данные хранятся в ~/.local/share/dsh-voice-chat/ (или DSH_VOICE_DATA_DIR):
 *   <dataDir>/python   — portable Python
 *   <dataDir>/venv     — venv с зависимостями
 *   <dataDir>/models   — модели (её же получает Python через DSH_VOICE_DATA_DIR)
 *
 * ВАЖНО: py/server.py и py/download_models.py трактуют DSH_VOICE_DATA_DIR как
 * каталог МОДЕЛЕЙ (Piper кладёт в <DATA_DIR>/piper/<voice>/, faster-whisper —
 * в <DATA_DIR>/models--*). Поэтому наружу всегда передаётся именно modelsDir,
 * иначе модели разъезжаются по домашнему каталогу и сервер их не находит.
 */

import { spawn } from "node:child_process";
import { appendFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY_DIR = path.join(HERE, "..", "py");
const SERVER_PY = path.join(PY_DIR, "server.py");
const DOWNLOAD_MODELS_PY = path.join(PY_DIR, "download_models.py");
const REQUIREMENTS_TXT = path.join(PY_DIR, "requirements.txt");

const LOG = "[dsh-voice-chat] local-engine:";

const DEFAULT_PORT = 8765;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_POLL_MS = 250;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
/** Импорт ctranslate2/onnxruntime может идти несколько секунд — отдельный таймаут. */
const DEFAULT_DEPS_PROBE_TIMEOUT_MS = 90_000;
const DEFAULT_WHISPER_MODEL = "small";
const DEFAULT_PIPER_VOICE = "ru_RU-irina-medium";

const PYTHON_VERSION = "3.12.15";
const PYTHON_TAG = "20261003";
const PYTHON_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_TAG}/cpython-${PYTHON_VERSION}+${PYTHON_TAG}-{platform}-install_only_stripped.tar.gz`;

function getDataDir() {
	return process.env.DSH_VOICE_DATA_DIR || path.join(
		process.env.HOME || process.env.USERPROFILE || "/tmp",
		".local", "share", "dsh-voice-chat"
	);
}

function getPlatform() {
	const { platform, arch } = process;
	if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
	if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
	if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
	if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
	if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
	if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc";
	return null;
}

/** Интерпретатор внутри venv. На Windows это Scripts/python.exe, а НЕ bin/. */
export function venvPythonPath(venvDir) {
	return process.platform === "win32"
		? path.join(venvDir, "Scripts", "python.exe")
		: path.join(venvDir, "bin", "python3");
}

/** Интерпретатор portable Python: install_only сборки кладут его в корень на Windows. */
export function portablePythonPath(pythonDir) {
	return process.platform === "win32"
		? path.join(pythonDir, "python.exe")
		: path.join(pythonDir, "bin", "python3");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Гонка «событие vs таймаут»; таймер всегда снимается, чтобы не держать цикл событий. */
function withDeadline(promise, ms, onTimeout) {
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve(onTimeout), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function pathExists(target) {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

async function downloadFile(url, dest, onProgress) {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`HTTP ${resp.status} при скачивании ${url}`);
	const total = Number(resp.headers.get("content-length")) || 0;
	const reader = resp.body.getReader();
	const chunks = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.length;
		if (onProgress && total) onProgress(received, total);
	}
	const buf = Buffer.concat(chunks);
	await writeFile(dest, buf);
	return buf.length;
}

async function extractTarGz(src, dest) {
	await mkdir(dest, { recursive: true });
	const proc = spawn("tar", ["-xzf", src, "-C", dest, "--strip-components=1"]);
	return new Promise((resolve, reject) => {
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`tar завершился с кодом ${code}`));
		});
		proc.on("error", reject);
	});
}

async function run(cmd, args, opts = {}) {
	const { timeoutMs, ...spawnOpts } = opts;
	const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOpts });
	let stdout = "";
	let stderr = "";
	proc.stdout?.on("data", (d) => { stdout += d; });
	proc.stderr?.on("data", (d) => { stderr += d; });
	return new Promise((resolve, reject) => {
		let timer = null;
		const settle = (fn) => {
			if (timer) { clearTimeout(timer); timer = null; }
			fn();
		};
		if (timeoutMs) {
			timer = setTimeout(() => {
				try { proc.kill("SIGKILL"); } catch { /* уже мёртв */ }
				settle(() => reject(new Error(`${cmd} не завершился за ${timeoutMs} мс`)));
			}, timeoutMs);
		}
		proc.on("close", (code) => {
			if (code === 0) settle(() => resolve({ stdout, stderr }));
			else settle(() => reject(new Error(`${cmd} завершился с кодом ${code}: ${stderr.slice(-500)}`)));
		});
		// Слушатель 'error' обязателен: без него неудачный spawn роняет весь процесс Node
		proc.on("error", (err) => settle(() => reject(new Error(`${cmd}: ${err.message}`))));
	});
}

/** Молча проверяет, что интерпретатор запускается. Никогда не бросает и не качает ничего. */
async function isWorkingPython(binPath, timeoutMs) {
	if (!binPath) return false;
	try {
		await run(binPath, ["--version"], { timeoutMs });
		return true;
	} catch {
		return false;
	}
}

export function createLocalEngineManager(config = {}) {
	const dataDir = getDataDir();
	const pythonDir = path.join(dataDir, "python");
	const venvDir = path.join(dataDir, "venv");
	const modelsDir = path.join(dataDir, "models");
	const venvPython = venvPythonPath(venvDir);

	const port0 = () => Number(config.port) > 0 ? Number(config.port) : DEFAULT_PORT;
	const whisperModel = config.whisperModel || DEFAULT_WHISPER_MODEL;
	const piperVoice = config.piperVoice || DEFAULT_PIPER_VOICE;

	let child = null;
	let childPort = null;
	/** Текущая фаза установки (null = установка не идёт) — показывается в status(). */
	let installStage = null;
	/** Последняя ошибка установки: остаётся в status(), чтобы UI её показал. */
	let installError = null;
	/** Обещание текущей установки: повторные вызовы install() не дублируют работу. */
	let installPromise = null;
	/** Последние строки вывода установки (stderr/stdout Python) — для UI и лог-файла. */
	let logLines = [];
	/** Результат проверки импорта faster_whisper/piper (кэш: импорт тяжёлый). */
	let depsProbePromise = null;
	const LOG_FILE = () => path.join(dataDir, "logs", "install.log");

	/** Дописать строки в кольцевой буфер (последние ~40 строк). */
	function noteLog(...chunks) {
		for (const chunk of chunks) {
			const text = String(chunk ?? "").trim();
			if (!text) continue;
			for (const line of text.split(/\r?\n/)) {
				if (line.trim()) logLines.push(line);
			}
		}
		if (logLines.length > 40) logLines = logLines.slice(-40);
	}

	/** Хвост буфера лога для показа пользователю. */
	const logTail = (lines = 20) => logLines.slice(-lines).join("\n");

	/** Продублировать вывод установки в <dataDir>/logs/install.log. */
	async function appendLog(stdout, stderr) {
		const text = [stdout, stderr].filter(Boolean).join("").trim();
		if (!text) return;
		noteLog(text);
		try {
			await mkdir(path.dirname(LOG_FILE()), { recursive: true });
			await appendFile(LOG_FILE(), `${new Date().toISOString()} ${text}\n`, "utf8");
		} catch { /* лог — не критично, не мешаем установке */ }
	}
	/**
	 * Реальная проверка зависимостей: venv-интерпретатор запускается и без pip-пакетов,
	 * поэтому «venv существует» ≠ «faster-whisper установлен». Импорт тяжёлый, поэтому
	 * результат кэшируется и не пересчитывается на каждом опросе статуса.
	 */
	function probeDeps(interpreter) {
		if (depsProbePromise) return depsProbePromise;
		depsProbePromise = (async () => {
			const code = "import faster_whisper, piper";
			try {
				const res = await run(interpreter, ["-c", code], { timeoutMs: DEFAULT_DEPS_PROBE_TIMEOUT_MS });
				return { ready: res.stderr.includes("Traceback") ? false : true, error: "" };
			} catch (err) {
				return { ready: false, error: err.message };
			}
		})();
		return depsProbePromise;
	}
	/** Окружение для всех дочерних Python-процессов: DSH_VOICE_DATA_DIR = каталог моделей. */
	const pythonEnv = () => ({
		...process.env,
		DSH_VOICE_DATA_DIR: modelsDir,
		PYTHONUNBUFFERED: "1"
	});

	/** Рекурсивный размер каталога в байтах (модели весят сотни мегабайт — надо их видеть). */
	async function dirSize(dir) {
		let total = 0;
		let entries;
		try { entries = await readdir(dir, { withFileTypes: true }); }
		catch { return 0; }
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			try {
				if (entry.isDirectory()) total += await dirSize(full);
				else total += (await stat(full)).size;
			} catch { /* файл мог исчезнуть между readdir и stat */ }
		}
		return total;
	}

	/**
	 * Что реально скачано в <dataDir>/models — поштучно, с размерами.
	 * Пользователь может накачать несколько моделей (две whisper, три голоса Piper),
	 * и по одной кнопке «удалить всё» их не убрать: нужен список, из которого
	 * видно, сколько места занимает каждый пункт и что именно удаляется.
	 */
	async function downloadedModels() {
		const out = [];
		// Голоса Piper: <modelsDir>/piper/<voice>/<voice>.onnx + .onnx.json
		try {
			const voices = await readdir(path.join(modelsDir, "piper"), { withFileTypes: true });
			for (const entry of voices) {
				if (!entry.isDirectory()) continue;
				const dir = path.join(modelsDir, "piper", entry.name);
				const onnx = path.join(dir, `${entry.name}.onnx`);
				if (!(await pathExists(onnx))) continue;
				out.push({
					id: `piper/${entry.name}`,
					type: "piper",
					name: entry.name,
					dir,
					bytes: await dirSize(dir),
					inUse: entry.name === piperVoice
				});
			}
		} catch { /* каталога нет — голоса не качались */ }
		// faster-whisper: <modelsDir>/models--<org>--faster-whisper-<size>
		try {
			const entries = await readdir(modelsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() || !entry.name.startsWith("models--")) continue;
				if (!entry.name.includes("whisper")) continue;
				const dir = path.join(modelsDir, entry.name);
				out.push({
					id: entry.name,
					type: "whisper",
					// models--Systran--faster-whisper-small → small
					name: entry.name.replace(/^models--.*?faster-whisper-?/, "") || entry.name,
					dir,
					bytes: await dirSize(dir),
					inUse: entry.name.includes(whisperModel)
				});
			}
		} catch { /* каталога нет — модели не качались */ }
		out.sort((a, b) => b.bytes - a.bytes);
		return out;
	}

	async function modelsState() {
		const voiceOnnx = path.join(modelsDir, "piper", piperVoice, `${piperVoice}.onnx`);
		const voiceConfig = path.join(modelsDir, "piper", piperVoice, `${piperVoice}.onnx.json`);
		const piperReady = (await pathExists(voiceOnnx)) && (await pathExists(voiceConfig));
		let whisperReady = false;
		try {
			// faster-whisper кладёт снапшоты в <download_root>/models--<org>--<repo>
			const entries = await readdir(modelsDir);
			whisperReady = entries.some((name) => name.startsWith("models--") && name.includes("whisper"));
		} catch { /* каталога нет — модель не качалась */ }
		return { piperReady, whisperReady, ready: piperReady && whisperReady };
	}

	/**
	 * Удалить одну скачанную модель (голос Piper или снапшот faster-whisper).
	 * Идентификатор приходит из UI, поэтому проверяем его по списку того, что
	 * действительно лежит на диске: служебные каталоги и «..» удалить нельзя.
	 */
	async function removeModel(id) {
		const wanted = String(id ?? "").trim();
		if (!wanted) throw new Error("Не указан идентификатор модели");
		const models = await downloadedModels();
		const target = models.find((m) => m.id === wanted);
		if (!target) {
			throw new Error(`Модель «${wanted}» не найдена в каталоге моделей`);
		}
		if (!target.id.startsWith("piper/") && !target.id.startsWith("models--")) {
			throw new Error(`Недопустимый идентификатор модели: ${target.id}`);
		}
		try {
			await rm(target.dir, { recursive: true, force: true, maxRetries: 3 });
		} catch (err) {
			throw new Error(`Не удалось удалить ${target.name}: ${err.message}`);
		}
		console.log(`${LOG} удалена модель ${target.type} ${target.name} (${Math.round(target.bytes / 1e6)} МБ)`);
		// Если удалили то, что было выбрано настройками — сбрасываем кэш импорта
		if (target.inUse) depsProbePromise = null;
		return { removed: target.id, type: target.type, name: target.name, freedBytes: target.bytes };
	}

	async function ensurePython() {
		const custom = config.pythonPath || process.env.DSH_VOICE_PYTHON;
		if (custom) {
			if (!(await isWorkingPython(custom, DEFAULT_PROBE_TIMEOUT_MS))) {
				throw new Error(`Указанный Python (${custom}) не работает`);
			}
			return { pythonPath: custom, isPortable: false };
		}
		if (await isWorkingPython("python3", DEFAULT_PROBE_TIMEOUT_MS)) {
			return { pythonPath: "python3", isPortable: false };
		}

		const platform = getPlatform();
		if (!platform) throw new Error(`Неподдерживаемая платформа: ${process.platform}/${process.arch}`);

		const pythonBin = portablePythonPath(pythonDir);
		if (await isWorkingPython(pythonBin, DEFAULT_PROBE_TIMEOUT_MS)) {
			return { pythonPath: pythonBin, isPortable: true };
		}

		console.log(`${LOG} скачивание portable Python...`);
		await mkdir(pythonDir, { recursive: true });
		const tarPath = path.join(dataDir, "python.tar.gz");
		const url = PYTHON_URL.replace("{platform}", platform);
		await downloadFile(url, tarPath, (received, total) => {
			console.log(`${LOG} Python ${(received / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} МБ`);
		});
		await extractTarGz(tarPath, pythonDir);
		await rm(tarPath, { force: true });
		if (!(await isWorkingPython(pythonBin, DEFAULT_PROBE_TIMEOUT_MS))) {
			throw new Error(`Portable Python не запускается: ${pythonBin}`);
		}
		return { pythonPath: pythonBin, isPortable: true };
	}

	async function ensureVenv(pythonPath) {
		if (await isWorkingPython(venvPython, DEFAULT_PROBE_TIMEOUT_MS)) {
			return { venvPythonPath: venvPython };
		}

		// pythonPath может прийти пустым (например, из status() без pythonPath)
		let basePython = pythonPath;
		if (!basePython) {
			if (await isWorkingPython("python3", DEFAULT_PROBE_TIMEOUT_MS)) basePython = "python3";
			else basePython = portablePythonPath(pythonDir);
		}
		if (!(await isWorkingPython(basePython, DEFAULT_PROBE_TIMEOUT_MS))) {
			throw new Error(`Не удалось создать venv: интерпретатор Python не работает (${basePython}). Сначала вызовите ensurePython()`);
		}

		console.log(`${LOG} создание venv (${path.relative(dataDir, venvDir) || venvDir})...`);
		await mkdir(venvDir, { recursive: true });
		try {
			await run(basePython, ["-m", "venv", venvDir], { timeoutMs: config.venvTimeoutMs ?? 300_000 });
		} catch (err) {
			throw new Error(`Не удалось создать venv: ${err.message}`);
		}
		if (!(await isWorkingPython(venvPython, DEFAULT_PROBE_TIMEOUT_MS))) {
			throw new Error(`venv создан, но его интерпретатор не найден: ${venvPython} (проверьте, что python3-venv установлен)`);
		}
		console.log(`${LOG} установка зависимостей (faster-whisper, piper-tts)...`);
		try {
			await run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-r", REQUIREMENTS_TXT], {
				timeoutMs: config.pipTimeoutMs ?? 1_800_000
			});
		} catch (err) {
			throw new Error(`Не удалось установить зависимости из ${REQUIREMENTS_TXT}: ${err.message}`);
		}
		return { venvPythonPath: venvPython };
	}

	/**
	 * Модели качает py/download_models.py ( Piper + faster-whisper ) — единственный
	 * источник правды по раскладке файлов, которую потом ждёт py/server.py.
	 * Вывод Python пишется в <dataDir>/logs/install.log и показывается в status(),
	 * потому что «модели не загружены» без причины бесполезно: обычно это сеть,
	 * антивирус или прокси, и угадать это можно только по stderr.
	 */
	async function ensureModels(venvPythonPathArg) {
		const interpreter = venvPythonPathArg || venvPython;
		await mkdir(modelsDir, { recursive: true });
		if (!(await isWorkingPython(interpreter, DEFAULT_PROBE_TIMEOUT_MS))) {
			const msg = `Не удалось скачать модели: интерпретатор venv не работает (${interpreter}). Сначала вызовите ensureVenv()`;
			console.warn(`${LOG} ${msg}`);
			await appendLog("", `${LOG} ${msg}`);
			const err = new Error(msg);
			err.logTail = logTail();
			throw err;
		}
		console.log(`${LOG} предзагрузка моделей в ${modelsDir} (Piper ${piperVoice}, faster-whisper ${whisperModel})...`);
		/** Причина сбоя загрузки (null = скрипт отработал без ошибок). */
		let downloadError = null;
		try {
			const result = await run(interpreter, [DOWNLOAD_MODELS_PY, "--whisper-model", whisperModel], {
				env: pythonEnv(),
				timeoutMs: config.modelsTimeoutMs ?? 3_600_000
			});
			await appendLog(result.stdout, result.stderr);
		} catch (err) {
			downloadError = err;
			// В сообщении уже есть хвост stderr, но он обрезан — доклеиваем полный лог
			await appendLog("", `${LOG} скачивание моделей упало: ${err.message}`);
			console.warn(`${LOG} предзагрузка моделей не удалась: ${err.message}`);
			console.warn(`${LOG} модель Piper ожидается в ${path.join(modelsDir, "piper", piperVoice)}, faster-whisper — в ${modelsDir}`);
		}
		const state = await modelsState();
		if (!state.ready) {
			const missing = [
				state.piperReady ? null : `нет Piper-голоса ${path.join(modelsDir, "piper", piperVoice)}`,
				state.whisperReady ? null : `нет модели faster-whisper (${whisperModel}) в ${modelsDir}`
			].filter(Boolean).join("; ");
			// Причина сбоя — в конце сообщения: её и копируют в бабл ошибки и в UI
			const reason = downloadError ? downloadError.message : (logTail().slice(-400) || "");
			const err = new Error(`Модели не загружены: ${missing}${reason ? ` — ${reason}` : ""}`);
			err.logTail = logTail();
			throw err;
		}
		return { modelsReady: true, modelsDir, ...state };
	}

	/**
	 * Полная установка: portable Python → venv с зависимостями → модели.
	 * Одновременные вызовы переиспользуют одно обещание (single-flight), иначе
	 * двойной клик по кнопке «Установить» запустил бы две загрузки в один каталог.
	 */
	function install() {
		if (installPromise) return installPromise;
		installError = null;
		installPromise = (async () => {
			/** Смена этапа попадает в журнал: по нему видно весь путь установки. */
			const stage = (name) => {
				installStage = name;
				noteLog(`${LOG} этап установки: ${name}`);
			};
			try {
				stage("python");
				const { pythonPath } = await ensurePython();
				stage("venv");
				const { venvPythonPath } = await ensureVenv(pythonPath);
				stage("models");
				await ensureModels(venvPythonPath);
				installStage = null;
				noteLog(`${LOG} установка завершена успешно`);
				await appendLog("", `${LOG} установка завершена успешно`);
				return { ok: true };
			} catch (err) {
				installStage = null;
				installError = err.message;
				await appendLog("", `${LOG} ${err.message}`);
				throw err;
			} finally {
				// Сбрасываем даже при ошибке: следующий клик должен дать новую попытку
				installPromise = null;
			}
		})();
		return installPromise;
	}

	/**
	 * Убедиться, что локальный сервер отвечает на порту из настроек.
	 * Ничего не поднимает — только опрос /health (для статуса и авто-старта).
	 */
	async function probe(port = port0()) {
		const targetPort = Number(port) > 0 ? Number(port) : port0();
		try {
			const resp = await fetch(`http://127.0.0.1:${targetPort}/health`, {
				signal: AbortSignal.timeout(config.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS)
			});
			if (!resp.ok) return false;
			await resp.json().catch(() => ({}));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Поднять сервер, если он ещё не отвечает: типовой путь «выбрал движок local →
	 * нажал микрофон» не должен требовать ручного нажатия «Запустить».
	 * Уже запущенный нами процесс не трогаем; чужой процесс на том же порту —
	 * тоже не трогаем, просто считаем, что сервер есть.
	 */
	async function ensureStarted(port = config.port) {
		if (child) return { port: childPort, pid: child.pid, alreadyRunning: true };
		const targetPort = Number(port) > 0 ? Number(port) : port0();
		if (await probe(targetPort)) return { port: targetPort, pid: null, alreadyRunning: true, external: true };
		const st = await status();
		if (!st.venvReady) {
			const err = new Error("Локальный движок не установлен: откройте Настройки DSH → голосовой чат и нажмите «Установить локальный движок»");
			err.status = 400;
			throw err;
		}
		return await start(st.venvPythonPath, targetPort);
	}

	async function start(venvPythonPathArg, port = config.port) {
		if (child) return { port: childPort, pid: child.pid, alreadyRunning: true };

		// Не поднимаем процесс, пока окружение не готово
		if (!venvPythonPathArg) {
			throw new Error("Локальный движок не установлен: нет интерпретатора venv. Сначала вызовите /local/install");
		}
		if (!(await isWorkingPython(venvPythonPathArg, DEFAULT_PROBE_TIMEOUT_MS))) {
			throw new Error(`Интерпретатор venv не работает: ${venvPythonPathArg}. Сначала вызовите /local/install`);
		}

		const targetPort = Number(port) > 0 ? Number(port) : port0();
		const startTimeoutMs = config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
		const pollMs = config.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_MS;
		const healthTimeoutMs = config.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
		const healthUrl = `http://127.0.0.1:${targetPort}/health`;

		let proc;
		try {
			proc = spawn(venvPythonPathArg, [SERVER_PY, "--port", String(targetPort)], {
				stdio: ["ignore", "pipe", "pipe"],
				env: pythonEnv()
			});
		} catch (err) {
			throw new Error(`Не удалось запустить ${SERVER_PY}: ${err.message}`);
		}
		child = proc;
		childPort = targetPort;

		let spawnError = null;
		let exitInfo = null;
		proc.on("error", (err) => { spawnError = err; });
		proc.on("exit", (code, signal) => {
			exitInfo = { code, signal };
			console.log(`${LOG} сервер остановлен (код ${code}, сигнал ${signal})`);
			if (child === proc) {
				child = null;
				childPort = null;
			}
		});
		// Читаем stdout/stderr: иначе переполнится pipe-буфер и сервер встанет
		const tail = { out: "", err: "" };
		proc.stdout?.on("data", (d) => { tail.out = (tail.out + d).slice(-1000); });
		proc.stderr?.on("data", (d) => { tail.err = (tail.err + d).slice(-1000); });

		try {
			const deadline = Date.now() + startTimeoutMs;
			while (Date.now() < deadline) {
				if (spawnError) {
					throw new Error(`Не удалось запустить ${SERVER_PY}: ${spawnError.message}`);
				}
				if (exitInfo) {
					throw new Error(`${SERVER_PY} завершился с кодом ${exitInfo.code} (сигнал ${exitInfo.signal}) до готовности: ${tail.err.slice(-300)}`);
				}
				try {
					const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(healthTimeoutMs) });
					if (resp.ok) return { port: targetPort, pid: proc.pid };
				} catch { /* ещё не готов */ }
				await sleep(pollMs);
			}
			throw new Error(`Локальный сервер не ответил на ${healthUrl} за ${Math.round(startTimeoutMs / 1000)} с: ${tail.err.slice(-300)}`);
		} catch (err) {
			await stop();
			throw err;
		}
	}

	async function stop() {
		const proc = child;
		if (!proc) return { stopped: false };
		const stopTimeoutMs = config.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

		let onExit = null;
		const exited = new Promise((resolve) => {
			onExit = () => resolve(true);
			proc.once("exit", onExit);
		});
		const alreadyDead = proc.exitCode !== null || proc.signalCode !== null;

		try {
			proc.kill("SIGTERM");
		} catch { /* уже мёртв */ }

		const stopped = alreadyDead
			|| await withDeadline(exited, stopTimeoutMs, false);

		if (!stopped) {
			console.warn(`${LOG} сервер не завершился за ${stopTimeoutMs} мс после SIGTERM, шлём SIGKILL`);
			try {
				proc.kill("SIGKILL");
			} catch { /* уже мёртв */ }
			await withDeadline(exited, stopTimeoutMs, false);
		}

		if (onExit) proc.removeListener("exit", onExit);
		if (child === proc) {
			child = null;
			childPort = null;
		}
		return { stopped: true, forced: !stopped };
	}

	/**
	 * Полностью удалить скачанное окружение и модели (кнопка «Удалить локальный
	 * движок»). Останавливаем сервер, затем сносим python/venv/models/logs —
	 * на диске они занимают гигабайты, а ставить заново можно одной кнопкой.
	 * Каталог dataDir удаляем только целиком и только если внутри нет ничего
	 * постороннего; настройки лежат в settings.local.json и не затрагиваются.
	 */
	async function remove({ includeModels = true } = {}) {
		await stop();
		const removed = [];
		for (const [name, dir] of [["venv", venvDir], ["python", pythonDir],
			...(includeModels ? [["models", modelsDir]] : []), ["logs", path.join(dataDir, "logs")]]) {
			if (!(await pathExists(dir))) continue;
			try {
				await rm(dir, { recursive: true, force: true, maxRetries: 3 });
				removed.push(name);
			} catch (err) {
				const message = `Не удалось удалить ${name}: ${err.message}`;
				console.warn(`${LOG} ${message}`);
				throw new Error(message);
			}
		}
		// Кэш заново: после удаления статус обязан всё перечитать с диска
		depsProbePromise = null;
		logLines = [];
		installError = null;
		console.log(`${LOG} удалено: ${removed.join(", ") || "(ничего не было)"}${includeModels ? "" : " (модели сохранены)"}`);
		return { removed, includeModels, dataDir };
	}

	async function status() {
		const result = {
			pythonReady: false,
			venvReady: false,
			depsReady: null,      // null = не проверяли (venv нет), иначе импорт пакетов
			depsError: null,
			modelsReady: false,
			serverRunning: false,
			hasFiles: false,
			installedFiles: [],
			models: [],
			modelsBytes: 0,
			installing: false,
			installStage: null,
			installError: null,
			port: null,
			pid: null,
			error: null,
			pythonPath: null,
			venvPythonPath: null,
			dataDir,
			modelsDir,
			logFile: LOG_FILE(),
			logTail: ""
		};
		try {
			const custom = config.pythonPath || process.env.DSH_VOICE_PYTHON;
			if (custom) {
				if (await isWorkingPython(custom, DEFAULT_PROBE_TIMEOUT_MS)) {
					result.pythonReady = true;
					result.pythonPath = custom;
				} else {
					result.error = `Указанный Python (${custom}) не работает`;
				}
			} else if (await isWorkingPython("python3", DEFAULT_PROBE_TIMEOUT_MS)) {
				result.pythonReady = true;
				result.pythonPath = "python3";
			} else {
				const portable = portablePythonPath(pythonDir);
				if (await isWorkingPython(portable, DEFAULT_PROBE_TIMEOUT_MS)) {
					result.pythonReady = true;
					result.pythonPath = portable;
				} else {
					result.error = "Python не найден: установите python3 или задайте DSH_VOICE_PYTHON";
				}
			}

			if (result.pythonReady && await isWorkingPython(venvPython, DEFAULT_PROBE_TIMEOUT_MS)) {
				result.venvReady = true;
				result.venvPythonPath = venvPython;
				// venv-интерпретатор запускается и без пакетов, поэтому проверяем импорт:
				// иначе «✓ Зависимости» означало бы лишь «venv создан»
				const deps = await probeDeps(venvPython);
				result.depsReady = deps.ready;
				result.depsError = deps.error || null;
				// Проверяем файлы на диске, а не импортируем тяжёлые модели в Node-процесс
				result.modelsReady = (await modelsState()).ready;
			}

			if (child) {
				result.port = childPort;
				result.pid = child.pid;
				result.serverRunning = await probe(childPort);
			} else if (await probe(port0())) {
				// Сервер на порту по умолчанию есть, но поднят не нами (запуск вручную)
				result.serverRunning = true;
				result.port = port0();
				result.external = true;
			}
		} catch (err) {
			// status() не имеет права бросать: наружу всегда отдаётся полный объект
			result.error = err.message;
		}
		// Что именно лежит на диске — по этому решаем, есть ли смысл предлагать удаление
		// (битое окружение, например, не даёт venvReady=true, но файлы на месте)
		result.installedFiles = [
			...(await pathExists(pythonDir) ? ["python"] : []),
			...(await pathExists(venvDir) ? ["venv"] : []),
			...(await pathExists(modelsDir) ? ["models"] : [])
		];
		result.hasFiles = result.installedFiles.length > 0;
		// Что скачано и сколько это занимает: пользователь может накачать несколько
		// моделей, и «удалить всё» — слишком грубо
		result.models = await downloadedModels();
		result.modelsBytes = result.models.reduce((sum, m) => sum + m.bytes, 0);
		result.installing = installStage !== null;
		result.installStage = installStage;
		result.installError = installError;
		result.logTail = logTail();
		for (const key of ["pythonReady", "venvReady", "modelsReady", "serverRunning"]) {
			result[key] = result[key] === true;
		}
		if (result.depsReady !== null) result.depsReady = result.depsReady === true;
		return result;
	}

	return { install, ensurePython, ensureVenv, ensureModels, ensureStarted, probe, start, stop, remove, removeModel, downloadedModels, dirSize, status, dataDir };
}
