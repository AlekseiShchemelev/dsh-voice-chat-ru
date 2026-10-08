/**
 * Локальный Python-движок (faster-whisper + Piper): тесты менеджера жизненного цикла.
 *
 * Без сети и без скачивания моделей: вместо настоящих моделей используются
 * заглушки-интерпретаторы, которые только пишут свои аргументы в лог.
 * Часть тестов (реальный py/server.py) условно пропускается, если нет python3.
 *
 * Запуск: node test/local-engine.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalEngineManager } from "../lib/local-engine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SERVER_PY = path.join(ROOT, "py", "server.py");

let passed = 0;
let skipped = 0;
async function test(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (err) {
		console.error(`FAIL  ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}
function skip(name, why) {
	skipped += 1;
	console.log(`skip  ${name} — ${why}`);
}
/** Тест с предусловием окружения: нет python3 → явный пропуск, а не молчание. */
async function testNeeds(name, ready, why, fn) {
	if (!(await ready())) {
		skip(name, why);
		return;
	}
	await test(name, fn);
}

const hasPython3 = async () => {
	const { spawnSync } = await import("node:child_process");
	const res = spawnSync("python3", ["--version"], { encoding: "utf8" });
	return res.status === 0;
};

const TMP_ROOT = await mkdtemp(path.join(os.tmpdir(), "dsh-voice-local-"));
const PROCS = new Set();

/** Изолированный dataDir для одного набора тестов. */
async function freshDataDir(name) {
	const dir = path.join(TMP_ROOT, name);
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Заглушка интерпретатора venv: пишет в лог DSH_VOICE_DATA_DIR и аргументы,
 * после чего либо проксирует вызов в настоящий python3, либо падает.
 * Ни сети, ни моделей.
 */
async function fakePython(dir, { name = "python3", mode = "proxy", logName = "calls.log", delayMs = 0 } = {}) {
	await mkdir(dir, { recursive: true });
	const log = path.join(dir, logName);
	const bin = path.join(dir, name);
	const lines = [
		// Задержка нужна тестам прогресса: без неё короткая фаза (python/venv)
		// проходит быстрее, чем успевает опрос статуса
		delayMs ? `sleep ${(delayMs / 1000).toFixed(3)}` : "",
		"#!/bin/sh",
		`printf '%s :: %s\\n' "$DSH_VOICE_DATA_DIR" "$*" >> '${log}'`,
		'if [ "$1" = "--version" ]; then exit 0; fi',
		mode === "proxy" ? 'exec python3 "$@"' : 'echo "stub failure" >&2; exit 1',
		""
	];
	await writeFile(bin, lines.join("\n"), "utf8");
	await chmod(bin, 0o755);
	return { bin, log, readLog: async () => { try { return await readFile(log, "utf8"); } catch { return ""; } } };
}

/** Ставит venv-заглушку в правильную кроссплатформенную раскладку. */
async function fakeVenv(dataDir, opts = {}) {
	// delayMs по умолчанию: заглушка спит, чтобы фазы установки было видно в статусе
	return fakePython(path.join(dataDir, "venv", "bin"), { name: "python3", delayMs: 250, ...opts });
}

/**
 * venv-заглушка, поднимающая HTTP-сервер, который ИГНОРИРУЕТ SIGTERM
 * (порт берётся из FAKE_PORT). Нужна, чтобы проверить эскалацию stop() в SIGKILL.
 */
async function fakeStubbornServer(dataDir) {
	await mkdir(path.join(dataDir, "venv", "bin"), { recursive: true });
	const dir = path.join(dataDir, "venv", "bin");
	const bin = path.join(dir, "python3");
	const log = path.join(dir, "calls.log");
	const py = [
		"import os, signal",
		"from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
		"signal.signal(signal.SIGTERM, signal.SIG_IGN)",
		"class H(BaseHTTPRequestHandler):",
		"    def do_GET(self):",
		"        self.send_response(200); self.send_header(\"Content-Length\", \"2\"); self.end_headers(); self.wfile.write(b\"{}\")",
		"    def log_message(self, *a): pass",
		"ThreadingHTTPServer((\"127.0.0.1\", int(os.environ[\"FAKE_PORT\"])), H).serve_forever()"
	].join("\n");
	await writeFile(bin, [
		"#!/bin/sh",
		`printf '%s :: %s\\n' "$DSH_VOICE_DATA_DIR" "$*" >> '${log}'`,
		'if [ "$1" = "--version" ]; then exit 0; fi',
		`exec python3 -c '${py}'`,
		""
	].join("\n"), "utf8");
	await chmod(bin, 0o755);
	return { bin, log };
}

/** Создаёт файлы моделей так, как их ждёт py/server.py. */
async function makeModels(dataDir, { piper = true, whisper = true } = {}) {
	const models = path.join(dataDir, "models");
	const voice = "ru_RU-irina-medium";
	if (piper) {
		const dir = path.join(models, "piper", voice);
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, `${voice}.onnx`), "onnx");
		await writeFile(path.join(dir, `${voice}.onnx.json`), "{}");
	}
	if (whisper) {
		await mkdir(path.join(models, "models--Systran--faster-whisper-small", "snapshots", "abc"), { recursive: true });
	}
	return models;
}

/** Временно меняет переменные окружения и/или process.platform. */
async function withState({ env = {}, platform = null }, fn) {
	const savedEnv = new Map();
	for (const [key, value] of Object.entries(env)) {
		savedEnv.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const platformDesc = platform ? Object.getOwnPropertyDescriptor(process, "platform") : null;
	if (platform) Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return await fn();
	} finally {
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (platformDesc) Object.defineProperty(process, "platform", platformDesc);
	}
}

/** Никакого окружения: ни python3 в PATH, ни DSH_VOICE_PYTHON. */
function withoutEnv() {
	return { env: { PATH: "", DSH_VOICE_PYTHON: undefined } };
}

async function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitGone(pid, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return !isAlive(pid);
}

function runNode(cmd, args, opts = {}) {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
		let out = "";
		let err = "";
		proc.stdout?.on("data", (d) => { out += d; });
		proc.stderr?.on("data", (d) => { err += d; });
		proc.on("close", (code) => resolve({ code, out, err }));
		proc.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
	});
}

// ---------------------------------------------------------------- API / dataDir

console.log("Менеджер: API и каталог данных");
await test("createLocalEngineManager отдаёт весь публичный API", async () => {
	const dataDir = await freshDataDir("api");
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		const m = createLocalEngineManager();
		for (const fn of ["ensurePython", "ensureVenv", "ensureModels", "start", "stop", "status"]) {
			assert.equal(typeof m[fn], "function", `${fn} должен быть функцией`);
		}
		assert.equal(m.dataDir, dataDir);
	});
});

await test("dataDir уважает DSH_VOICE_DATA_DIR", async () => {
	const dataDir = await freshDataDir("env-dir");
	assert.ok(await stat(dataDir));
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		assert.equal(createLocalEngineManager().dataDir, dataDir);
		assert.equal(createLocalEngineManager({ port: 9000 }).dataDir, dataDir);
	});
});

await test("dataDir по умолчанию — $HOME/.local/share/dsh-voice-chat", async () => {
	await withState({ env: { DSH_VOICE_DATA_DIR: undefined } }, async () => {
		const home = process.env.HOME || process.env.USERPROFILE;
		assert.ok(home, "нужен HOME/USERPROFILE");
		assert.equal(createLocalEngineManager().dataDir, path.join(home, ".local", "share", "dsh-voice-chat"));
	});
});

// ---------------------------------------------------------------- status

console.log("\nstatus() без установленного окружения (не должен падать)");
const REQUIRED_STATUS_FIELDS = ["pythonReady", "venvReady", "modelsReady", "serverRunning", "port", "pid", "error"];

await test("status(): полный набор полей и ни одного исключения при пустом окружении", async () => {
	const dataDir = await freshDataDir("status-empty");
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir }, ...withoutEnv() }, async () => {
		const st = await createLocalEngineManager().status();
		for (const field of REQUIRED_STATUS_FIELDS) {
			assert.ok(field in st, `нет поля ${field}`);
		}
		assert.equal(st.pythonReady, false, "python3 не должен «находиться» при пустом PATH");
		assert.equal(st.venvReady, false);
		assert.equal(st.modelsReady, false);
		assert.equal(st.serverRunning, false);
		assert.equal(st.port, null);
		assert.equal(st.pid, null);
		assert.equal(typeof st.error, "string", "error должен описывать, почему Python недоступен");
	});
});

await test("status(): DSH_VOICE_PYTHON на несуществующий путь — не падает", async () => {
	const dataDir = await freshDataDir("status-bad-python");
	const bogus = path.join(dataDir, "definitely", "not", "python");
	await withState({
		env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: bogus, PATH: "" },
	}, async () => {
		const st = await createLocalEngineManager().status();
		assert.equal(st.pythonReady, false);
		assert.equal(st.venvReady, false);
		assert.match(String(st.error), /not|не работает/);
		assert.ok(String(st.error).includes(bogus), "error должен называть проблемный путь");
	});
});

await testNeeds(
	"status(): системный python3 есть, но venv/моделей/сервера нет",
	hasPython3,
	"нет python3 в системе",
	async () => {
		const dataDir = await freshDataDir("status-bare");
		await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
			const st = await createLocalEngineManager().status();
			assert.equal(st.pythonReady, true);
			assert.equal(st.pythonPath, "python3");
			assert.equal(st.venvReady, false);
			assert.equal(st.modelsReady, false);
			assert.equal(st.serverRunning, false);
			assert.equal(st.port, null);
			assert.equal(st.pid, null);
			assert.equal(st.error, null, "отсутствие venv — это не ошибка");
		});
	}
);

await test("status(): готовый venv находится, модели — по файлам на диске, без импорта моделей", async () => {
	const dataDir = await freshDataDir("status-venv");
	const venv = await fakeVenv(dataDir);
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		const st = await createLocalEngineManager().status();
		assert.equal(st.venvReady, true);
		assert.equal(st.venvPythonPath, venv.bin);
		assert.equal(st.modelsReady, false, "моделей на диске нет");
		assert.equal(st.depsReady, false, "в пустом venv ни faster_whisper, ни piper не импортируются");
		const log = await venv.readLog();
		assert.match(log, /--version/);
		// Модели в Node-процесс не грузим: проверяются только файлы на диске и импорт
		// модулей в дочернем Python-процессе (WhisperModel/PiperVoice — никогда)
		assert.ok(!log.includes("WhisperModel(") && !log.includes("PiperVoice.load"),
			"status() не должен грузить модели:\n" + log);
	});
});

await test("status(): modelsReady=true только когда файлы моделей лежат в <dataDir>/models", async () => {
	const onlyPiper = await freshDataDir("status-models-partial");
	await fakeVenv(onlyPiper);
	await makeModels(onlyPiper, { piper: true, whisper: false });
	await withState({ env: { DSH_VOICE_DATA_DIR: onlyPiper, DSH_VOICE_PYTHON: undefined } }, async () => {
		const st = await createLocalEngineManager().status();
		assert.equal(st.venvReady, true);
		assert.equal(st.modelsReady, false, "без faster-whisper модели не готовы");
	});

	const full = await freshDataDir("status-models-full");
	await fakeVenv(full);
	await makeModels(full);
	await withState({ env: { DSH_VOICE_DATA_DIR: full, DSH_VOICE_PYTHON: undefined } }, async () => {
		const st = await createLocalEngineManager().status();
		assert.equal(st.modelsReady, true);
	});
});

await test("status() на Windows ищет интерпретатор venv в Scripts/python.exe", async () => {
	const dataDir = await freshDataDir("status-win");
	const scripts = path.join(dataDir, "venv", "Scripts");
	await fakePython(scripts, { name: "python.exe", logName: "win.log" });
	await withState({
		env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined, PATH: "" },
		platform: "win32"
	}, async () => {
		const st = await createLocalEngineManager().status();
		assert.equal(st.pythonReady, false, "в PATH ничего нет даже под win32");
		assert.ok(st.error);
	});
	// venv-проверка не зависит от pythonReady: проверяем её напрямую через config.pythonPath
	await withState({
		env: { DSH_VOICE_DATA_DIR: dataDir, PATH: "" },
		platform: "win32"
	}, async () => {
		const st = await createLocalEngineManager({ pythonPath: path.join(scripts, "python.exe") }).status();
		assert.equal(st.pythonReady, true);
		assert.equal(st.venvReady, true, "venv на Windows живёт в Scripts/, а не bin/");
		assert.equal(st.venvPythonPath, path.join(scripts, "python.exe"));
	});
});

// ---------------------------------------------------------------- start / stop

console.log("\nstart()/stop(): движок не поднимается без готового окружения");
await test("start() без интерпретатора venv не запускает процесс", async () => {
	const dataDir = await freshDataDir("start-no-venv");
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		const m = createLocalEngineManager({ startTimeoutMs: 2_000 });
		await assert.rejects(() => m.start(undefined, 8790), /не установлен|install/i);
		await assert.rejects(() => m.start(null, 8790), /не установлен|install/i);
		const st = await m.status();
		assert.equal(st.serverRunning, false);
		assert.equal(st.port, null);
		assert.equal(st.pid, null);
	});
});

await test("start() с неработающим интерпретатором отклоняется сразу", async () => {
	const dataDir = await freshDataDir("start-bad-python");
	const m = createLocalEngineManager({ startTimeoutMs: 10_000 });
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		const missing = path.join(dataDir, "venv", "bin", "python3");
		const t0 = Date.now();
		await assert.rejects(() => m.start(missing, 8791), /не работает|установлен/i);
		assert.ok(Date.now() - t0 < 5_000, "не должен ждать таймаут старта");
	});
});

await test("start(): процесс, умерший сразу, отклоняется до health-таймаута", async () => {
	const dataDir = await freshDataDir("start-dies");
	const venv = await fakeVenv(dataDir, { mode: "fail" });
	const m = createLocalEngineManager({ startTimeoutMs: 30_000, healthPollIntervalMs: 50 });
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		const t0 = Date.now();
		await assert.rejects(() => m.start(venv.bin, 8792), /завершился с кодом/);
		assert.ok(Date.now() - t0 < 10_000, "ранний выход должен определяться сразу, а не по таймауту");
	});
});

await test("stop() на неподнятом движке — no-op", async () => {
	const dataDir = await freshDataDir("stop-noop");
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		const m = createLocalEngineManager();
		assert.deepEqual(await m.stop(), { stopped: false });
		assert.deepEqual(await m.stop(), { stopped: false });
		const st = await m.status();
		assert.equal(st.serverRunning, false);
	});
});

// ---------------------------------------------------------------- ensure*

console.log("\nensurePython/ensureVenv/ensureModels (без сети)");
await test("ensurePython: сломанный DSH_VOICE_PYTHON → ошибка, а не скачивание portable Python", async () => {
	const dataDir = await freshDataDir("ensure-python-bad");
	const bogus = path.join(dataDir, "no-python-here");
	await withState({
		env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: bogus, PATH: "" },
	}, async () => {
		const t0 = Date.now();
		await assert.rejects(() => createLocalEngineManager().ensurePython(), /не работает/);
		assert.ok(Date.now() - t0 < 10_000, "скачивание Python не должно даже начинаться");
		assert.equal(await stat(path.join(dataDir, "python")).then(() => true, () => false), false);
	});
});

await test("ensureVenv: готовый venv переиспользуется (без пересоздания и без pip)", async () => {
	const dataDir = await freshDataDir("ensure-venv-reuse");
	const venv = await fakeVenv(dataDir);
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		const res = await createLocalEngineManager().ensureVenv("/usr/bin/python3");
		assert.equal(res.venvPythonPath, venv.bin);
		const log = await venv.readLog();
		assert.match(log, /--version/);
		assert.ok(!log.includes("-m venv"), "venv уже готов, создавать заново нельзя");
		assert.ok(!log.includes("pip"), "зависимости не переустанавливаются");
	});
});

await test("ensureVenv: провал `python -m venv` даёт понятную ошибку", async () => {
	const dataDir = await freshDataDir("ensure-venv-fail");
	const broken = await fakePython(path.join(dataDir, "fake"), { mode: "fail", logName: "broken.log" });
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		await assert.rejects(() => createLocalEngineManager().ensureVenv(broken.bin), /Не удалось создать venv/);
		const log = await broken.readLog();
		assert.match(log, /-m venv/, "venv должен был создаваться");
		assert.ok(!log.includes("pip"), "до успешного создания venv pip не запускается");
	});
});

await test("ensureModels зовёт py/download_models.py с DSH_VOICE_DATA_DIR=<dataDir>/models", async () => {
	const dataDir = await freshDataDir("ensure-models");
	const venv = await fakeVenv(dataDir, { mode: "fail" });
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		// mode= fail → скрипт сразу падает: сеть не нужна, а путь вызова всё равно виден в логе
		await assert.rejects(() => createLocalEngineManager().ensureModels(venv.bin), /Модели не загружены/);
		const log = await venv.readLog();
		assert.match(log, /download_models\.py/, "модели качает py/download_models.py");
		assert.match(log, /--whisper-model small/);
		assert.ok(!log.includes("piper.download_voices"),
			"piper-tts качает голос отдельной командой: у неё свой расклад каталогов\n" + log);
		for (const line of log.trim().split("\n")) {
			if (!line.includes("download_models.py")) continue;
			assert.equal(line.slice(0, line.indexOf(" :: ")), path.join(dataDir, "models"),
				"Python должен получать каталог моделей, а не корень dataDir");
		}
	});
});

await test("ensureModels без интерпретатора venv — понятная ошибка, без скачивания", async () => {
	const dataDir = await freshDataDir("ensure-models-novenv");
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		await assert.rejects(() => createLocalEngineManager().ensureModels(), /интерпретатор venv не работает/);
		assert.equal(await stat(path.join(dataDir, "models", "piper")).then(() => true, () => false), false);
	});
});

// ---------------------------------------------------------------- install / ensureStarted

console.log("\ninstall(): single-flight, прогресс и автозапуск");

await test("install(): идёт по трём фазам, стадия видна в статусе и в журнале", async () => {
	const dataDir = await freshDataDir("install-progress");
	// Модели качаются дольше всего — эту фазу видно в статусе без гонок;
	// короткие фазы (python/venv) проверяем по журналу установки
	const venv = await fakeVenv(dataDir, { delayMs: 250 });
	await makeModels(dataDir);
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: "python3" } }, async () => {
		const manager = createLocalEngineManager();
		const done = manager.install();
		let sawInstalling = false;
		let sawModels = false;
		for (let i = 0; i < 40 && !sawModels; i++) {
			const st = await manager.status();
			if (st.installing) sawInstalling = true;
			if (st.installStage === "models") sawModels = true;
			if (!sawModels) await new Promise((r) => setTimeout(r, 30));
		}
		assert.ok(sawInstalling, "installing должен быть true, пока установка идёт");
		assert.ok(sawModels, "стадия models должна быть видна в status()");
		await done;
		const after = await manager.status();
		assert.equal(after.installing, false);
		assert.equal(after.installStage, null);
		assert.equal(after.installError, null);
		// Журнал содержит все три этапа в порядке выполнения
		const log = after.logTail;
		const order = ["python", "venv", "models"].map((st) => log.indexOf(`этап установки: ${st}`));
		assert.ok(order.every((i) => i >= 0), "в журнале должны быть все этапы:\n" + log);
		assert.ok(order[0] < order[1] && order[1] < order[2], "этапы идут по порядку:\n" + log);
		assert.ok((await venv.readLog()).includes("--version"));
	});
});

await test("install(): параллельные вызовы не дублируют работу (одно обещание)", async () => {
	const dataDir = await freshDataDir("install-single-flight");
	await fakeVenv(dataDir);
	await makeModels(dataDir);
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: "python3" } }, async () => {
		const manager = createLocalEngineManager();
		const a = manager.install();
		const b = manager.install();
		assert.equal(a, b, "второй вызов должен переиспользовать текущую установку");
		await a;
		// После завершения следующий вызов — новая попытка (а не зависшее обещание)
		const c = manager.install();
		assert.notEqual(c, a);
		await c;
	});
});

await test("install(): ошибка попадает в installError и не «залипает»", async () => {
	const dataDir = await freshDataDir("install-error");
	await fakeVenv(dataDir, { mode: "fail" });
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: "python3" } }, async () => {
		const manager = createLocalEngineManager();
		await assert.rejects(() => manager.install());
		const st = await manager.status();
		assert.equal(st.installing, false);
		assert.equal(typeof st.installError, "string");
		assert.ok(st.installError.length > 0);
	});
});

await test("ensureStarted(): не установлен → понятная ошибка про кнопку «Установить»", async () => {
	const dataDir = await freshDataDir("ensure-not-installed");
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, ...withoutEnv().env } }, async () => {
		const manager = createLocalEngineManager({ port: await freePort() });
		await assert.rejects(
			() => manager.ensureStarted(),
			(err) => {
				assert.equal(err.status, 400);
				assert.match(err.message, /Установить локальный движок/);
				return true;
			}
		);
	});
});

await testNeeds(
	"ensureStarted(): поднимает сервер сам (выбрал движок → нажал микрофон)",
	hasPython3, "нет python3 в системе",
	async () => {
		const dataDir = await freshDataDir("ensure-autostart");
		await fakeVenv(dataDir);
		await makeModels(dataDir);
		const port = await freePort();
		await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: "python3" } }, async () => {
			const manager = createLocalEngineManager({ port, startTimeoutMs: 20_000 });
			const result = await manager.ensureStarted();
			PROCS.add(result.pid);
			assert.ok(result.pid, "ensureStarted должен вернуть pid поднятого сервера");
			const health = await fetch(`http://127.0.0.1:${port}/health`);
			assert.equal(health.status, 200);
			// Повторный вызов не перезапускает процесс
			const again = await manager.ensureStarted();
			assert.equal(again.alreadyRunning, true);
			assert.equal(again.pid, result.pid);
			await manager.stop();
		});
	}
);

await testNeeds(
	"ensureStarted(): чужой сервер на порту не перезапускаем (уже работает)",
	hasPython3, "нет python3 в системе",
	async () => {
		const dataDir = await freshDataDir("ensure-external");
		await fakeVenv(dataDir);
		await makeModels(dataDir);
		const port = await freePort();
		const proc = spawn("python3", [path.join(ROOT, "py", "server.py"), "--port", String(port)], {
			stdio: "ignore", env: { ...process.env, DSH_VOICE_DATA_DIR: path.join(dataDir, "models") }
		});
		PROCS.add(proc.pid);
		try {
			// Ждём готовности чужого сервера
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* ждём */ }
				await new Promise((r) => setTimeout(r, 100));
			}
			await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: "python3" } }, async () => {
				const manager = createLocalEngineManager({ port });
				const result = await manager.ensureStarted();
				assert.equal(result.alreadyRunning, true);
				assert.equal(result.external, true);
				assert.equal(result.pid, null, "чужой процесс мы не переименовываем в свой");
				const st = await manager.status();
				assert.equal(st.serverRunning, true);
				assert.equal(st.external, true);
			});
		} finally {
			proc.kill("SIGTERM");
			await waitGone(proc.pid);
		}
	}
);

await test("ensureModels: причина сбоя попадает в текст ошибки (а не теряется)", async () => {
	const dataDir = await freshDataDir("models-error-reason");
	// venv-заглушка, которая падает на download_models.py: причина — в её stderr
	await fakeVenv(dataDir, { mode: "fail" });
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: "python3" } }, async () => {
		const manager = createLocalEngineManager();
		await assert.rejects(
			() => manager.ensureModels(),
			(err) => {
				assert.match(err.message, /Модели не загружены/);
				// Именно это пользователь и не видел раньше: «нет Piper-голоса» без причины
				assert.ok(/stub failure|завершился с кодом/.test(err.message), "нет причины сбоя: " + err.message);
				assert.ok(typeof err.logTail === "string" && err.logTail.length > 0, "лог должен быть приложен");
				return true;
			}
		);
		const st = await manager.status();
		assert.equal(typeof st.logTail, "string");
		assert.ok(st.logTail.length > 0, "хвост лога должен быть в status()");
		assert.match(st.logFile, /logs[\\/]install\.log$/);
	});
});

await test("status(): depsReady=null, когда venv ещё нет", async () => {
	const dataDir = await freshDataDir("status-no-venv");
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, ...withoutEnv().env } }, async () => {
		const st = await createLocalEngineManager().status();
		assert.equal(st.venvReady, false);
		assert.equal(st.depsReady, null, "проверять нечего — не запускаем импорт");
	});
});

await test("probe(): свободный порт → false, без исключений", async () => {
	const port = await freePort();
	await withState({ env: { DSH_VOICE_DATA_DIR: await freshDataDir("probe") } }, async () => {
		const manager = createLocalEngineManager({ port });
		assert.equal(await manager.probe(port), false);
	});
});

// ---------------------------------------------------------------- интеграция с py/server.py

console.log("\nЖивой цикл: py/server.py поднимается, отвечает /health, корректно отдаёт 400");

let integration = null;
await testNeeds("start(): порт и таймауты берутся из конфигурации", hasPython3, "нет python3 в системе", async () => {
	const dataDir = await freshDataDir("live");
	const venv = await fakeVenv(dataDir, { mode: "proxy" });
	await makeModels(dataDir, { piper: false, whisper: false });
	const port = await freePort();
	// Менеджер создаём внутри withState: dataDir читается из env в момент создания
	const result = await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		const m = createLocalEngineManager({ startTimeoutMs: 15_000, healthPollIntervalMs: 100, stopTimeoutMs: 1_000 });
		integration = { dataDir, venv, m, port };
		return m.start(venv.bin, port);
	});
	PROCS.add(result.pid);
	integration.pid = result.pid;
	assert.equal(result.port, port, "порт из аргумента start()");
	assert.equal(typeof result.pid, "number");
	assert.ok(!result.alreadyRunning);
	assert.ok(isAlive(result.pid));
	const log = await venv.readLog();
	assert.match(log, new RegExp(`server\\.py --port ${port}`), "сервер запускается с --port из конфигурации");
	const logLine = log.trim().split("\n").at(-1);
	assert.equal(logLine.slice(0, logLine.indexOf(" :: ")), path.join(dataDir, "models"),
		"сервер должен видеть каталог моделей, а не корень dataDir");
});

await testNeeds("start(): повторный вызов возвращает тот же pid", hasPython3, "нет python3 в системе", async () => {
	assert.ok(integration, "предыдущий тест должен был поднять сервер");
	const again = await integration.m.start(integration.venv.bin, integration.port);
	assert.equal(again.pid, integration.pid);
	assert.equal(again.port, integration.port);
	assert.equal(again.alreadyRunning, true);
});

await testNeeds("GET /health отвечает status=ok без моделей", hasPython3, "нет python3 в системе", async () => {
	assert.ok(integration);
	const resp = await fetch(`http://127.0.0.1:${integration.port}/health`);
	assert.equal(resp.status, 200);
	const body = await resp.json();
	assert.equal(body.status, "ok");
	assert.ok(body.models.piper.includes("ru_RU-irina-medium"));
});

await testNeeds("status() видит запущенный сервер (serverRunning/port/pid)", hasPython3, "нет python3 в системе", async () => {
	assert.ok(integration);
	const st = await integration.m.status();
	assert.equal(st.serverRunning, true);
	assert.equal(st.port, integration.port);
	assert.equal(st.pid, integration.pid);
});

await testNeeds("POST /v1/audio/speech с неизвестным голосом → 400 (модели не нужны)", hasPython3, "нет python3 в системе", async () => {
	assert.ok(integration);
	const resp = await fetch(`http://127.0.0.1:${integration.port}/v1/audio/speech`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ input: "привет", voice: "zz_ZZ-nope-medium" })
	});
	assert.equal(resp.status, 400);
	assert.match((await resp.json()).error, /unsupported voice/);
});

await testNeeds("POST /v1/audio/speech: пустой input и битый speed → 400, а не 500", hasPython3, "нет python3 в системе", async () => {
	assert.ok(integration);
	const post = (payload) => fetch(`http://127.0.0.1:${integration.port}/v1/audio/speech`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload)
	});
	assert.equal((await post({ voice: "ru_RU-irina-medium" })).status, 400);
	const badSpeed = await post({ input: "привет", voice: "ru_RU-irina-medium", speed: "быстро" });
	assert.equal(badSpeed.status, 400, "нечисловой speed должен давать 400, а не рвать соединение");
	assert.match((await badSpeed.json()).error, /speed/);
	assert.equal((await post({ input: "привет", voice: "ru_RU-irina-medium", speed: 0 })).status, 400);
});

await testNeeds("неизвестный маршрут → 404", hasPython3, "нет python3 в системе", async () => {
	assert.ok(integration);
	assert.equal((await fetch(`http://127.0.0.1:${integration.port}/v1/nope`)).status, 404);
});

await testNeeds("stop() реально убивает процесс сервера", hasPython3, "нет python3 в системе", async () => {
	assert.ok(integration);
	const { m, pid } = integration;
	const res = await m.stop();
	assert.equal(res.stopped, true);
	assert.ok(await waitGone(pid), `процесс ${pid} остался жив после stop()`);
	PROCS.delete(pid);
	integration = null;
	const st = await m.status();
	assert.equal(st.serverRunning, false);
	assert.equal(st.port, null);
	assert.equal(st.pid, null);
});

await testNeeds("start() сразу после stop(): handle не теряется, сообщение не врёт", hasPython3, "нет python3 в системе", async () => {
	// Регресс: 'exit' убитого процесса обнулял child, и start() падал с «не запустился за 30 с»,
	// хотя новый сервер уже отвечал (TypeError на child.pid глотался внутренним catch).
	const dataDir = await freshDataDir("restart-race");
	const venv = await fakeStubbornServer(dataDir);
	const p1 = await freePort();
	const p2 = await freePort();
	await withState({ env: { DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined } }, async () => {
		const m = createLocalEngineManager({ startTimeoutMs: 8_000, healthPollIntervalMs: 100, stopTimeoutMs: 300 });
		process.env.FAKE_PORT = String(p1);
		const a = await m.start(venv.bin, p1);
		PROCS.add(a.pid);
		await m.stop();

		// Без паузы: событие exit от первого процесса прилетает уже после spawn второго
		process.env.FAKE_PORT = String(p2);
		const t0 = Date.now();
		const b = await m.start(venv.bin, p2);
		PROCS.add(b.pid);
		assert.ok(Date.now() - t0 < 5_000, "start() после stop() обязан уложиться в startTimeoutMs, а не висеть");
		assert.notEqual(b.pid, a.pid);
		assert.equal(b.port, p2);

		const stopped = await m.stop();
		assert.equal(stopped.stopped, true);
		assert.equal(stopped.forced, true, "сервер игнорирует SIGTERM — stop() обязан дослать SIGKILL");
		assert.ok(await waitGone(b.pid), "после stop() процесс обязан быть мёртв");
		PROCS.delete(a.pid);
		PROCS.delete(b.pid);
	});
});

console.log("\npy/server.py напрямую (без моделей)");
await testNeeds("python3 -m py_compile py/server.py проходит", hasPython3, "нет python3 в системе", async () => {
	const res = await runNode("python3", ["-m", "py_compile", SERVER_PY]);
	assert.equal(res.code, 0, res.err);
});

await testNeeds("python3 py/server.py --port <свободный> поднимается и отдаёт 400 на неизвестный голос", hasPython3, "нет python3 в системе", async () => {
	const dataDir = await freshDataDir("server-direct");
	await mkdir(path.join(dataDir, "models"), { recursive: true });
	const port = await freePort();
	const proc = spawn("python3", [SERVER_PY, "--port", String(port)], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, DSH_VOICE_DATA_DIR: path.join(dataDir, "models") }
	});
	let stderr = "";
	proc.stderr.on("data", (d) => { stderr += d; });
	let exited = null;
	proc.on("exit", (code, signal) => { exited = { code, signal }; });
	proc.on("error", () => {});
	try {
		const deadline = Date.now() + 15_000;
		let health = null;
		while (Date.now() < deadline && !exited) {
			try {
				const resp = await fetch(`http://127.0.0.1:${port}/health`);
				if (resp.ok) { health = await resp.json(); break; }
			} catch { /* ждём */ }
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.ok(health, `сервер не поднялся: ${stderr.slice(-500)}`);
		assert.equal(health.status, "ok");

		const speech = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: "тест", voice: "no-such-voice" })
		});
		assert.equal(speech.status, 400);
		assert.match((await speech.json()).error, /unsupported voice/);

		const notFound = await fetch(`http://127.0.0.1:${port}/health/extra`);
		assert.equal(notFound.status, 404);
	} finally {
		proc.kill("SIGTERM");
		await waitGone(proc.pid);
		if (!exited) proc.kill("SIGKILL");
	}
});

// ---------------------------------------------------------------- уборка

for (const pid of PROCS) {
	try { process.kill(pid, "SIGKILL"); } catch { /* уже мёртв */ }
}
await rm(TMP_ROOT, { recursive: true, force: true });

const skippedNote = skipped ? `, пропущено ${skipped}` : "";
console.log(`\n${passed} пройдено${skippedNote}${process.exitCode ? " (есть падения)" : ""}`);
