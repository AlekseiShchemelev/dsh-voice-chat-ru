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
import { appendFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { asText, isValidPiperVoice, isValidWhisperModel } from "./shared.js";
import {
	DEFAULT_DEPS_PROBE_TIMEOUT_MS,
	DEFAULT_HEALTH_POLL_MS,
	DEFAULT_HEALTH_TIMEOUT_MS,
	DEFAULT_PIPER_VOICE,
	DEFAULT_PORT,
	DEFAULT_PROBE_TIMEOUT_MS,
	DEFAULT_START_TIMEOUT_MS,
	DEFAULT_STOP_TIMEOUT_MS,
	DEFAULT_WARM_INTERVAL_MS,
	DEFAULT_WARM_TIMEOUT_MS,
	DEFAULT_WHISPER_MODEL,
	DOWNLOAD_MODELS_PY,
	LOG,
	PYTHON_URL,
	READY_CACHE_MS,
	REQUIREMENTS_TXT,
	SERVER_PY,
	STATUS_CACHE_MS,
	getDataDir,
	getPlatform,
	portablePythonPath,
	venvPythonPath
} from "./local/paths.js";
import {
	MIN_PYTHON,
	badRequest,
	downloadFile,
	extractTarGz,
	isTooOldPython,
	isWorkingPython,
	pathExists,
	pythonVersion,
	run,
	sleep,
	withDeadline,
	dirSize
} from "./local/proc.js";
import {
	downloadedModels as scanDownloadedModels,
	modelsState as scanModelsState
} from "./local/store.js";

// Реэкспорт справочных функций: их дергает scripts/lock-py.mjs и тесты,
// менеджер же пользуется ими через импорт выше.
export { venvPythonPath, portablePythonPath } from "./local/paths.js";
export { MIN_PYTHON, badRequest, isWorkingPython, pythonVersion, run, dirSize } from "./local/proc.js";

export function createLocalEngineManager(config = {}) {
	const dataDir = getDataDir();
	const pythonDir = path.join(dataDir, "python");
	const venvDir = path.join(dataDir, "venv");
	const modelsDir = path.join(dataDir, "models");
	const venvPython = venvPythonPath(venvDir);

	const port0 = () => Number(config.port) > 0 ? Number(config.port) : DEFAULT_PORT;
	/**
	 * Цели установки: какую модель faster-whisper качать и какой голос Piper.
	 * Раньше это были `const` из config, поэтому выбор пользователя в настройках
	 * (settings.local.json → asr.local.model / tts.local.voice) до установщика
	 * не доходил НИКОГДА и всегда качался дефолтный small + irina.
	 * Теперь это изменяемое состояние, обновляемое хостом из живых настроек
	 * (см. setTargets) перед install()/ensureModels().
	 */
	const targets = {
		whisperModel: config.whisperModel || DEFAULT_WHISPER_MODEL,
		piperVoice: config.piperVoice || DEFAULT_PIPER_VOICE
	};
	/**
	 * Цели из settings.local.json — «постоянные», их присылает хост на каждом
	 * запросе. И явный выбор из UI (?model=/?voice= в /local/install и
	 * /local/status), который действует до следующего ИЗМЕНЕНИЯ настроек.
	 *
	 * Разделение нужно из-за одного сценария: пользователь выбрал tiny, нажал
	 * «Установить», и панель каждые 2 с опрашивает /local/status. Если бы опрос
	 * снова приравнивал цели к настройкам (в которых ещё small), статус показал
	 * бы «faster-whisper small» прямо во время установки tiny — ровно то
	 * враньё, из-за которого непонятно, что качается.
	 */
	let settingsTargets = { whisperModel: targets.whisperModel, piperVoice: targets.piperVoice };
	let pickedTargets = null;
	const whisperModel = () => (pickedTargets && pickedTargets.whisperModel)
		|| settingsTargets.whisperModel;
	const piperVoice = () => (pickedTargets && pickedTargets.piperVoice)
		|| settingsTargets.piperVoice;

	let child = null;
	let childPort = null;
	/** Порт, за которым мы реально работаем (настройка, а не дефолт) — для status(). */
	let activePort = null;
	/** Текущая фаза установки (null = установка не идёт) — показывается в status(). */
	let installStage = null;
	/** Последняя ошибка установки: остаётся в status(), чтобы UI её показал. */
	let installError = null;
	/** Обещание текущей установки: повторные вызовы install() не дублируют работу. */
	let installPromise = null;
	/**
	 * Единый «замок» эксклюзивных операций: установка, скачивание модели/голоса.
	 * Пока одна идёт, вторая не стартует, а remove() запрещён — иначе удаление
	 * каталогов во время записи в них оставляет битое окружение, которое потом
	 * невозможно починить кнопкой «Установить».
	 */
	let operationKind = null;
	/**
	 * Промисы запуска сервера, по одному на порт. Раньше был один startPromise
	 * без учёта порта: параллельные /stt (порт 8765) и /speak (другой порт из
	 * настроек) получали ОДИН и тот же результат, и второй запрос считал, что
	 * сервер поднят на его порту, хотя это не так.
	 */
	const startPromises = new Map();
	/** Кэш готовности окружения на READY_CACHE_MS: { value, at }. */
	let readyCache = null;
	/** Одноразовый status(): параллельные вызовы ждут один результат. */
	let statusInFlight = null;
	/** Готовый ответ status() с меткой времени — на STATUS_CACHE_MS. */
	let statusCached = null;
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

	/** Сменить фазу установки через единую точку (в журнал попадает весь путь). */
	function setStage(name) {
		installStage = name;
		noteLog(`${LOG} этап установки: ${name}`);
	}

	/**
	 * Захватить эксклюзивную операцию. Возвращает функцию-освобождение.
	 * Ошибка помечена status=409: маршрут может отдать «конфликт», а не 500.
	 */
	function beginOperation(kind, label) {
		if (operationKind) {
			const err = new Error(`${label}: уже идёт операция «${operationKind}» — дождитесь её завершения`);
			err.status = 409;
			throw err;
		}
		operationKind = kind;
		return () => { if (operationKind === kind) operationKind = null; };
	}

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

	/**
	 * Что реально скачано в <dataDir>/models — поштучно, с размерами.
	 * Пользователь может накачать несколько моделей (две whisper, три голоса Piper),
	 * и по одной кнопке «удалить всё» их не убрать: нужен список, из которого
	 * видно, сколько места занимает каждый пункт и что именно удаляется.
	 * Чтение каталога живёт в lib/local/store.js; менеджер только подставляет
	 * свой modelsDir и текущие цели.
	 */
	async function downloadedModels(model = whisperModel(), voice = piperVoice()) {
		return scanDownloadedModels(modelsDir, model, voice);
	}

	/** Лежат ли на диске именно запрошенные модель/голос (см. lib/local/store.js). */
	async function modelsState(model = whisperModel(), voice = piperVoice()) {
		return scanModelsState(modelsDir, model, voice);
	}

	/**
	 * Удалить одну скачанную модель (голос Piper или снапшот faster-whisper).
	 * Идентификатор приходит из UI, поэтому проверяем его по списку того, что
	 * действительно лежит на диске: служебные каталоги и «..» удалить нельзя.
	 */
	async function removeModel(id) {
		const wanted = String(id ?? "").trim();
		if (!wanted) throw badRequest("Не указан идентификатор модели");
		const models = await downloadedModels();
		const target = models.find((m) => m.id === wanted);
		if (!target) {
			throw badRequest(`Модель «${wanted}» не найдена в каталоге моделей`);
		}
		if (!target.id.startsWith("piper/") && !target.id.startsWith("models--")) {
			throw badRequest(`Недопустимый идентификатор модели: ${target.id}`);
		}
		try {
			await rm(target.dir, { recursive: true, force: true, maxRetries: 3 });
		} catch (err) {
			throw new Error(`Не удалось удалить ${target.name}: ${err.message}`);
		}
		// Освобождаем и RAM: файлы удалены, но работающий сервер держал веса
		// в памяти. Выгрузка — best-effort: сервер мог быть не запущен.
		await unloadOnServer(target.type === "whisper" ? { model: target.name } : { voice: target.name });
		console.log(`${LOG} удалена модель ${target.type} ${target.name} (${Math.round(target.bytes / 1e6)} МБ)`);
		invalidateReadiness();
		return { removed: target.id, type: target.type, name: target.name, freedBytes: target.bytes };
	}

	async function ensurePython() {
		const minLabel = `${MIN_PYTHON.major}.${MIN_PYTHON.minor}`;
		const custom = config.pythonPath || process.env.DSH_VOICE_PYTHON;
		if (custom) {
			if (!(await isWorkingPython(custom, DEFAULT_PROBE_TIMEOUT_MS))) {
				throw new Error(`Указанный Python (${custom}) не работает`);
			}
			const version = await pythonVersion(custom, DEFAULT_PROBE_TIMEOUT_MS);
			if (isTooOldPython(version)) {
				throw new Error(`Указанный Python (${custom}) слишком старый: нужен Python >= ${minLabel}, а найден ${version.major}.${version.minor}`);
			}
			return { pythonPath: custom, isPortable: false };
		}
		if (await isWorkingPython("python3", DEFAULT_PROBE_TIMEOUT_MS)) {
			// Системный python3 может быть слишком старым (faster-whisper требует
			// >=3.10): в этом случае не отказываемся совсем, а берём portable.
			const systemVersion = await pythonVersion("python3", DEFAULT_PROBE_TIMEOUT_MS);
			if (isTooOldPython(systemVersion)) {
				console.log(`${LOG} системный python3 ${systemVersion.major}.${systemVersion.minor} старше ${minLabel} — используем portable Python`);
			} else {
				return { pythonPath: "python3", isPortable: false };
			}
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

	/**
	 * Поставить зависимости в уже существующий venv.
	 *
	 * Отдельная функция не только для красоты: venv мог остаться без пакетов
	 * после прерванной установки, и тогда `python --version` работает, а
	 * faster_whisper не импортируется. Раньше pip жил только в ветке «создаём venv
	 * заново», поэтому такой venv был нечинимым: кнопка «Установить» ничего
	 * не делала, а статус честно писал «✗ Зависимости».
	 */
	async function installDeps() {
		console.log(`${LOG} установка зависимостей (faster-whisper, piper-tts)...`);
		try {
			await run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-r", REQUIREMENTS_TXT], {
				timeoutMs: config.pipTimeoutMs ?? 1_800_000
			});
		} catch (err) {
			throw new Error(`Не удалось установить зависимости из ${REQUIREMENTS_TXT}: ${err.message}`);
		}
		// Прежняя проверка импорта теперь неверна — она кэширует неудачу
		depsProbePromise = null;
	}

	async function ensureVenv(pythonPath) {
		if (await isWorkingPython(venvPython, DEFAULT_PROBE_TIMEOUT_MS)) {
			// venv без пакетов запускается и выглядит целым: проверяем импорт и
			// доустанавливаем, если faster-whisper/piper не видны
			const deps = await probeDeps(venvPython);
			if (!deps.ready) {
				console.log(`${LOG} venv есть, но faster-whisper/piper не импортируются — доустанавливаем зависимости`);
				await installDeps();
				const after = await probeDeps(venvPython);
				if (!after.ready) {
					const err = new Error("Зависимости установились, но faster-whisper / piper всё ещё не импортируются. "
						+ "Удалите локальный движок кнопкой в настройках и установите заново");
					err.status = 400;
					throw err;
				}
				invalidateReadiness();
			}
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
		console.log(`${LOG} создание venv завершено, ставлю зависимости`);
		await installDeps();
		return { venvPythonPath: venvPython };
	}

	/**
	 * Модели качает py/download_models.py ( Piper + faster-whisper ) — единственный
	 * источник правды по раскладке файлов, которую потом ждёт py/server.py.
	 * Вывод Python пишется в <dataDir>/logs/install.log и показывается в status(),
	 * потому что «модели не загружены» без причины бесполезно: обычно это сеть,
	 * антивирус или прокси, и угадать это можно только по stderr.
	 */
	/**
	 * Скачать только голос Piper (без модели faster-whisper).
	 * Русских голосов в репозитории ровно четыре, все medium, но Piper умеет и
	 * другие языки — пользователь может докачать любой голос по имени, положив
	 * его в <dataDir>/models/piper/<имя>, и выбрать в настройках.
	 */
	async function downloadVoice(voiceName) {
		const voice = String(voiceName ?? "").trim();
		if (!voice) throw badRequest("Не указан голос Piper");
		if (!isValidPiperVoice(voice)) {
			throw badRequest(`Некорректное имя голоса: ${voice}. Ожидается вид ru_RU-irina-medium`);
		}
		const dir = path.join(modelsDir, "piper", voice);
		if ((await pathExists(path.join(dir, `${voice}.onnx`)))) {
			return { alreadyDownloaded: true, voice, dir };
		}
		// Имя status затеняет функцию status(), поэтому переменная другая
		const env = await status();
		if (!env.venvReady) {
			throw badRequest("Локальный движок не установлен: сначала нажмите «Установить локальный движок»");
		}
		const release = beginOperation("download-voice", "Скачивание голоса");
		setStage("voice");
		try {
			await mkdir(dir, { recursive: true });
			const result = await run(venvPython, [DOWNLOAD_MODELS_PY, "--piper-voice", voice, "--only-voice"], {
				env: pythonEnv(),
				timeoutMs: config.voiceTimeoutMs ?? 900_000
			});
			await appendLog(result.stdout, result.stderr);
			if (!(await pathExists(path.join(dir, `${voice}.onnx`)))) {
				throw new Error(`Голос ${voice} не скачался: ${(logTail(6) || "").slice(-300)}`);
			}
			console.log(`${LOG} голос Piper скачан: ${voice}`);
			invalidateReadiness();
			return { alreadyDownloaded: false, voice, dir };
		} finally {
			release();
		}
	}

	/**
	 * Скачать выбранную пользователем модель faster-whisper (не трогая голос Piper).
	 * Нужно, когда модель переключили в настройках уже после установки движка:
	 * без этого /stt ушёл бы на сервер с моделью, которой на диске нет.
	 */
	/** Сбросить только кэш status(): цели изменились, а готовность та же. */
	function invalidateStatus() {
		statusCached = null;
	}

	/** Сбросить кэш готовности: окружение изменилось, прежний ответ неверен. */
	function invalidateReadiness() {
		readyCache = null;
		statusCached = null;
		warmAt = 0;
		// Кэш импорта тоже протух: после установки/удаления он обязан пересчитаться,
		// иначе status() до перезапуска хоста продолжит писать «✗ Зависимости».
		depsProbePromise = null;
	}

	let warmAt = 0;

	/**
	 * Прогрев сервера: просим его загрузить модель и голос в память.
	 *
	 * Первое распознавание на холодном сервере читает веса с диска — это 5–30 с
	 * (для medium и large-v3 — минуты), и пользователь в это время видит жёлтый
	 * микрофон и решает, что всё зависло. Прогрев идёт в фоне сразу после
	 * старта сервера, и к моменту первого запроса модель обычно уже в памяти.
	 *
	 * Повторяем не чаще раза в минуту: каждый прогрев держит блокировки синтеза,
	 * а сервер и так живёт долго.
	 */
	function warmUp(port = port0()) {
		const targetPort = Number(port) > 0 ? Number(port) : port0();
		const now = Date.now();
		if (now - warmAt < DEFAULT_WARM_INTERVAL_MS) return;
		warmAt = now;
		const url = `http://127.0.0.1:${targetPort}/warm?model=${encodeURIComponent(whisperModel())}`
			+ `&voice=${encodeURIComponent(piperVoice())}`;
		fetch(url, { signal: AbortSignal.timeout(config.warmTimeoutMs ?? DEFAULT_WARM_TIMEOUT_MS) })
			.then((resp) => resp.json())
			.then((data) => {
				const errors = (data && Array.isArray(data.errors)) ? data.errors : [];
				if (!errors.length) {
					console.log(`${LOG} прогрев завершён за ${data.seconds} с (модель ${data.model}, голос ${data.voice})`);
				} else {
					// Не поломка плагина: сервер просто не готов, запрос разберётся сам
					console.warn(`${LOG} прогрев: ${errors.join("; ")}`);
				}
			})
			.catch((err) => {
				// Прогрев — фоновая операция: молча выходим, запрос отработает сам
				console.warn(`${LOG} прогрев не удался: ${err.message}`);
			});
	}

	async function downloadModel(modelName) {
		const model = String(modelName ?? "").trim();
		if (!model) throw badRequest("Не указана модель faster-whisper");
		if (!isValidWhisperModel(model)) {
			throw badRequest(`Некорректное имя модели: ${model}`);
		}
		// Уже скачана именно эта модель?
		const before = await modelsState();
		if (model === whisperModel() && before.whisperReady) {
			return { alreadyDownloaded: true, model };
		}
		// Имя status затеняет функцию status(), поэтому переменная другая
		const env = await status();
		if (!env.venvReady) {
			throw badRequest("Локальный движок не установлен: сначала нажмите «Установить локальный движок»");
		}
		const release = beginOperation("download-model", "Скачивание модели");
		const previous = whisperModel();
		setTargets({ whisperModel: model }, true);
		setStage("models");
		try {
			await run(venvPython, [DOWNLOAD_MODELS_PY, "--whisper-model", model], {
				env: pythonEnv(),
				timeoutMs: config.modelsTimeoutMs ?? 3_600_000
			}).then((r) => appendLog(r.stdout, r.stderr), (e) => appendLog("", String(e && e.message ? e.message : e)));
			const after = await modelsState();
			if (!after.whisperReady) {
				setTargets({ whisperModel: previous }, true);
				throw new Error(`Модель ${model} не скачалась: ${(logTail(6) || "").slice(-300)}`);
			}
			console.log(`${LOG} модель faster-whisper скачана: ${model}`);
			invalidateReadiness();
			return { alreadyDownloaded: false, model };
		} finally {
			installStage = null;
			release();
		}
	}

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
		console.log(`${LOG} предзагрузка моделей в ${modelsDir} (Piper ${piperVoice()}, faster-whisper ${whisperModel()})...`);
		/** Причина сбоя загрузки (null = скрипт отработал без ошибок). */
		let downloadError = null;
		try {
			const result = await run(interpreter, [DOWNLOAD_MODELS_PY, "--whisper-model", whisperModel(), "--piper-voice", piperVoice()], {
				env: pythonEnv(),
				timeoutMs: config.modelsTimeoutMs ?? 3_600_000
			});
			await appendLog(result.stdout, result.stderr);
		} catch (err) {
			downloadError = err;
			// В сообщении уже есть хвост stderr, но он обрезан — доклеиваем полный лог
			await appendLog("", `${LOG} скачивание моделей упало: ${err.message}`);
			console.warn(`${LOG} предзагрузка моделей не удалась: ${err.message}`);
			console.warn(`${LOG} модель Piper ожидается в ${path.join(modelsDir, "piper", piperVoice())}, faster-whisper — в ${modelsDir}`);
		}
		const state = await modelsState();
		if (!state.ready) {
			const missing = [
				state.piperReady ? null : `нет Piper-голоса ${path.join(modelsDir, "piper", piperVoice())}`,
				state.whisperReady ? null : `нет модели faster-whisper (${whisperModel()}) в ${modelsDir}`
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
		// Замок берём до старта: параллельный downloadModel/remove должен получить
		// 409, а не влезть в наполовину установленное окружение.
		const release = beginOperation("install", "Установка");
		installPromise = (async () => {
			try {
				setStage("python");
				const { pythonPath } = await ensurePython();
				setStage("venv");
				const { venvPythonPath } = await ensureVenv(pythonPath);
				setStage("models");
				await ensureModels(venvPythonPath);
				installStage = null;
				// Окружение только что изменилось — прежняя готовность неверена
				invalidateReadiness();
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
				release();
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
	 * Попросить локальный сервер выгрузить веса из памяти (best-effort).
	 * Нужен после удаления модели: каталог снесён, но процесс мог держать её
	 * в RAM. Сервер может быть не запущен — тогда выгружать нечего, ошибку глотаем.
	 */
	async function unloadOnServer(payload) {
		const targetPort = Number.isInteger(activePort) && activePort > 0 ? activePort : port0();
		try {
			await fetch(`http://127.0.0.1:${targetPort}/unload`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(2_000)
			});
		} catch { /* сервер не запущен или недоступен — выгружать нечего */ }
	}

	/**
	 * Поднять сервер, если он ещё не отвечает: типовой путь «выбрал движок local →
	 * нажал микрофон» не должен требовать ручного нажатия «Запустить».
	 * Уже запущенный нами процесс не трогаем; чужой процесс на том же порту —
	 * тоже не трогаем, просто считаем, что сервер есть.
	 */
	/**
	 * Готов ли интерпретатор venv — быстрая проверка без полного status().
	 * Результат кэшируется на READY_CACHE_MS: и /stt, и /speak, и опрос
	 * панели настроек не должны каждый раз порождать процессы Python.
	 */
	async function venvReady() {
		const now = Date.now();
		if (readyCache && now - readyCache.at < READY_CACHE_MS) return readyCache.value;
		const value = { ok: await isWorkingPython(venvPython, DEFAULT_PROBE_TIMEOUT_MS), pythonPath: venvPython };
		readyCache = { value, at: Date.now() };
		return value;
	}

	async function ensureStarted(port = config.port) {
		const targetPort = Number(port) > 0 ? Number(port) : port0();
		// activePort до попытки — на случай провала: status() не должен решить,
		// что мы работаем на порту, который на самом деле не поднялся.
		const previousActivePort = activePort;
		activePort = targetPort;
		try {
		// Процесс УЖЕ на том же порту — просто возвращаемся.
		// Раньше проверка была «есть ли вообще child»: при разных портах для ASR и TTS
		// (именно так и было в битых настройках) второй запрос уходил на чужой порт
		// и получал «fetch failed».
		if (child && childPort === targetPort) return { port: childPort, pid: child.pid, alreadyRunning: true };
		if (await probe(targetPort)) return { port: targetPort, pid: null, alreadyRunning: true, external: true };
		// Порт сменился (пользователь поменял порт в настройках). Старый сервер
		// отвязываем, но НЕ гасим сразу: если новый не поднимется, работающий
		// старый должен остаться в живых. Раньше он убивался здесь, и любая
		// неудача на новом порту оставляла пользователя вообще без движка.
		const previousChild = (child && childPort !== targetPort) ? child : null;
		const previousPort = childPort;
		if (previousChild) {
			console.log(`${LOG} порт изменён (${previousPort} → ${targetPort}), перезапускаем локальный сервер`);
			child = null;
			childPort = null;
		}
		// Полный status() здесь не нужен и дорог: он поднимает Python, пробует
		// импорт зависимостей и обходит каталог моделей. Для решения «можно ли
		// стартовать» хватает проверки интерпретатора venv.
		const ready = await venvReady();
		if (!ready.ok) {
			if (previousChild) { child = previousChild; childPort = previousPort; }
			const err = new Error("Локальный движок не установлен: откройте Настройки DSH → голосовой чат и нажмите «Установить локальный движок»");
			err.status = 400;
			throw err;
		}
		let result;
		try {
			result = await startOnce(ready.pythonPath, targetPort);
		} catch (err) {
			// Новый порт не поднялся — возвращаем прежний процесс, он ещё жив
			if (previousChild && previousChild.exitCode === null && previousChild.signalCode === null) {
				child = previousChild;
				childPort = previousPort;
				console.warn(`${LOG} не удалось поднять сервер на порту ${targetPort}, возвращаем порт ${previousPort}: ${err.message}`);
			}
			throw err;
		}
		if (previousChild) await stopProcess(previousChild);
		// Фоновая загрузка модели: первое распознавание не должно платить за неё
		warmUp(targetPort);
		return result;
		} catch (err) {
			activePort = previousActivePort;
			throw err;
		}
	}

	/**
	 * Single-flight запуска сервера.
	 *
	 * Без этого /stt и /speak, приходящие внахлёст (в постоянном диалоге это
	 * постоянно: пользователь уже говорит, а хост озвучивает прошлый ответ),
	 * оба видели child === null, оба проходили дальше, и второй убивал сервер,
	 * только что поднятый первым. Дальше падал и health-опрос первого, который
	 * в своём catch тоже вызывал stop() — и убивал уже чужой процесс. Итог:
	 * в логе «сервер остановлен (сигнал SIGTERM)», а идущий в этот момент
	 * запрос озвучки падал с ECONNRESET — ровно то, что видел пользователь.
	 */
	function startOnce(venvPythonPathArg, port) {
		// Ключ — порт: запросы к РАЗНЫМ портам не должны получать чужой результат.
		const key = String(port);
		const existing = startPromises.get(key);
		if (existing) return existing;
		const task = start(venvPythonPathArg, port);
		const tracked = task.then(
			(result) => { if (startPromises.get(key) === tracked) startPromises.delete(key); return result; },
			(error) => { if (startPromises.get(key) === tracked) startPromises.delete(key); throw error; }
		);
		startPromises.set(key, tracked);
		return tracked;
	}

	async function start(venvPythonPathArg, port = config.port) {
		const wantedPort = Number(port) > 0 ? Number(port) : port0();
		const previousActivePort = activePort;
		if (child && childPort === wantedPort) return { port: childPort, pid: child.pid, alreadyRunning: true };
		// Процесс на ДРУГОМ порту: он больше не нужен. Только его — child к
		// этому моменту может быть уже заменён (см. startOnce).
		if (child) await stopProcess(child);

		// Не поднимаем процесс, пока окружение не готово
		if (!venvPythonPathArg) {
			const err = new Error("Локальный движок не установлен: нет интерпретатора venv. Сначала вызовите /local/install");
			err.status = 400;
			throw err;
		}
		// Проверку берём из кэша, а не запускаем Python заново: ensureStarted()
		// уже проверял тот же интерпретатор секунду назад, а на каждый /stt
		// это лишний процесс.
		if (venvPythonPathArg === venvPython) {
			const cached = await venvReady();
			if (!cached.ok) {
				const err = new Error(`Интерпретатор venv не работает: ${venvPythonPathArg}. Сначала вызовите /local/install`);
				err.status = 400;
				throw err;
			}
		} else if (!(await isWorkingPython(venvPythonPathArg, DEFAULT_PROBE_TIMEOUT_MS))) {
			const err = new Error(`Интерпретатор venv не работает: ${venvPythonPathArg}. Сначала вызовите /local/install`);
			err.status = 400;
			throw err;
		}

		const targetPort = wantedPort;
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
		// activePort меняем только когда процесс реально запущен: если он упадёт
		// до готовности, status() не должен показывать порт, на котором ничего нет.
		activePort = targetPort;

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
			// Гасим ТОЛЬКО свой процесс. Раньше здесь был stop(), который убивал
			// «текущий child» — а к этому моменту им мог быть уже чужой процесс,
			// поднятый параллельным запросом.
			await stopProcess(proc);
			activePort = previousActivePort;
			throw err;
		}
	}

	/**
	 * Остановить КОНКРЕТНЫЙ процесс и, только если он ещё был текущим, забыть
	 * его. Разделение на stop()/stopProcess() нужно из-за гонки запуска: иначе
	 * неудачный start() убивает сервер, который поднял кто-то другой.
	 */
	async function stopProcess(proc) {
		if (!proc) return;
		const stopTimeoutMs = config.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
		if (child === proc) {
			child = null;
			childPort = null;
		}
		if (proc.exitCode !== null || proc.signalCode !== null) return;

		let onExit = null;
		const exited = new Promise((resolve) => {
			onExit = () => resolve(true);
			proc.once("exit", onExit);
		});
		try {
			proc.kill("SIGTERM");
		} catch (err) {
			return;
		}
		await Promise.race([exited, sleep(stopTimeoutMs)]);
		try { proc.kill("SIGKILL"); } catch (err) { /* уже мёртв */ }
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
		// Замок берём до stop(): если сейчас идёт установка/скачивание, снос
		// каталогов из-под пишущего процесса оставил бы битое окружение.
		const release = beginOperation("remove", "Удаление");
		try {
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
			invalidateReadiness();
			logLines = [];
			installError = null;
			console.log(`${LOG} удалено: ${removed.join(", ") || "(ничего не было)"}${includeModels ? "" : " (модели сохранены)"}`);
			return { removed, includeModels, dataDir };
		} finally {
			release();
		}
	}

	/**
	 * @param {{whisperModel?:string, piperVoice?:string}|null} overrides
	 *   Предпросмотр «а что если выбрать эту модель/голос»: считаем статус с
	 *   этими целями, НЕ меняя внутреннее состояние (pickedTargets) и не кэшируя.
	 */
	function status(overrides = null) {
		const preview = overrides && (asText(overrides.whisperModel) || asText(overrides.piperVoice));
		if (preview) return computeStatus(overrides);
		// Два уровня экономии: параллельные вызовы ждут один расчёт (in-flight),
		// а повторный запрос в пределах окна берёт готовый ответ. Панель настроек
		// опрашивает статус раз в 2 с, а каждый расчёт — это запуск Python.
		const now = Date.now();
		if (statusCached && now - statusCached.at < STATUS_CACHE_MS) return statusCached.promise;
		if (statusInFlight) return statusInFlight;
		const task = computeStatus();
		statusInFlight = task;
		const done = () => {
			if (statusInFlight === task) statusInFlight = null;
			statusCached = { promise: task, at: Date.now() };
		};
		task.then(done, done);
		return task;
	}

	async function computeStatus(overrides = null) {
		const targetModel = asText(overrides && overrides.whisperModel) || whisperModel();
		const targetVoice = asText(overrides && overrides.piperVoice) || piperVoice();
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
			// Что именно мы собираемся использовать/качать (из настроек плагина
			// либо из preview-overrides запроса)
			whisperModel: targetModel,
			piperVoice: targetVoice,
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
				result.modelsReady = (await modelsState(targetModel, targetVoice)).ready;
			}

			if (child) {
				result.port = childPort;
				result.pid = child.pid;
				result.serverRunning = await probe(childPort);
		} else {
			// Проверяем тот порт, который реально настроен (иначе UI писал бы
			// «сервер не запущен», хотя он поднят на нестандартном порту)
			const checkPort = activePort || port0();
			if (await probe(checkPort)) {
				result.serverRunning = true;
				result.port = checkPort;
				result.external = true;
			}
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
		result.models = await downloadedModels(targetModel, targetVoice);
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

	/**
	 * Обновить цели установки из живых настроек плагина
	 * (settings.local.json → asr.local.model / tts.local.voice).
	 * Хост вызывает это перед install() и перед ensureModels(); возвращает
	 * true, если цели поменялись (тогда стоит перепроверить status()).
	 *
	 * picked: true — явный выбор из UI (кнопка «Установить»/«Скачать» или опрос
	 * статуса с ?model=). Он действует, пока настройки реально не изменятся:
	 * после сохранения файла цели снова берутся из него.
	 *
	 * picked: false (обычный вызов хоста с settings.local.json) — обновляет цели
	 * из файла и сбрасывает явный выбор, только если значения файла изменились.
	 * Без этой проверки опрос статуса во время установки tiny снова подставлял
	 * бы small из файла, и установку было бы видно «не той».
	 */
	function setTargets(next = {}, picked = false) {
		const rawModel = String(next.whisperModel ?? "").trim();
		const rawVoice = String(next.piperVoice ?? "").trim();
		// Единая точка валидации: имена уходят в пути файлов и аргументы Python.
		// Некорректное значение молча отбрасывается (defense in depth): маршруты,
		// принимающие ввод пользователя, дополнительно отвечают 400.
		const model = isValidWhisperModel(rawModel) ? rawModel : "";
		const voice = isValidPiperVoice(rawVoice) ? rawVoice : "";
		if (rawModel && !model) console.warn(`${LOG} отклонено некорректное имя модели: ${rawModel}`);
		if (rawVoice && !voice) console.warn(`${LOG} отклонён некорректный голос Piper: ${rawVoice}`);
		const before = `${whisperModel()}|${piperVoice()}`;
		if (picked) {
			// Явный выбор из UI НЕ трогает цели из файла: иначе следующий же опрос
			// статуса (он идёт с настройками) счёл бы файл изменившимся и вернул
			// бы к прошлой модели — ровно то, что и было багом.
			pickedTargets = {
				whisperModel: model || (pickedTargets && pickedTargets.whisperModel) || "",
				piperVoice: voice || (pickedTargets && pickedTargets.piperVoice) || ""
			};
		} else {
			const settingsChanged =
				(model && model !== settingsTargets.whisperModel)
				|| (voice && voice !== settingsTargets.piperVoice);
			if (model) settingsTargets.whisperModel = model;
			if (voice) settingsTargets.piperVoice = voice;
			// Настройки сохранили другое значение — явный выбор больше не актуален
			if (settingsChanged) pickedTargets = null;
		}
		if (before === `${whisperModel()}|${piperVoice()}`) return false;
		invalidateStatus();
		console.log(`${LOG} цели локального движка: faster-whisper ${whisperModel()}, Piper ${piperVoice()}`);
		return true;
	}

	return { install, ensurePython, ensureVenv, ensureModels, ensureStarted, probe, start, stop, remove, removeModel, downloadedModels, downloadVoice, downloadModel, setTargets, dirSize, status, dataDir };
}
