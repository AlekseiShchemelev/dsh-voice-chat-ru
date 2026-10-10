/**
 * Выбор моделей локального движка: цели установки, путь вызова download_models.py,
 * готовность моделей на диске и жизненный цикл сервера по портам.
 *
 * Полностью офлайн: вместо Python используются заглушки-интерпретаторы, которые
 * только пишут свои аргументы в лог (и, где нужно, создают каталог снапшота),
 * а «сервер» — обычный node:http.
 *
 * Запуск: node test/local-model-selection.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createLocalEngineManager } from "../lib/local-engine.js";

/** Есть ли путь на диске (fs.stat без исключений). */
async function pathExists(target) {
	try { await stat(target); return true; } catch { return false; }
}

let passed = 0;
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

const TMP_ROOT = await mkdtemp(path.join(os.tmpdir(), "dsh-voice-models-"));
const PROCS = new Set();

/** Изолированный dataDir для одного набора тестов. */
async function freshDataDir(name) {
	const dir = path.join(TMP_ROOT, name);
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Заглушка интерпретатора venv. Пишет в лог DSH_VOICE_DATA_DIR и свои аргументы,
 * после чего выполняет переданное тело скрипта (по умолчанию — падает).
 * Ни сети, ни настоящих моделей.
 */
async function fakePython(dir, { name = "python3", logName = "calls.log", body = [] } = {}) {
	await mkdir(dir, { recursive: true });
	const log = path.join(dir, logName);
	const bin = path.join(dir, name);
	await writeFile(bin, [
		"#!/bin/sh",
		`printf '%s :: %s\\n' "$DSH_VOICE_DATA_DIR" "$*" >> '${log}'`,
		'if [ "$1" = "--version" ]; then exit 0; fi',
		'if [ "$1" = "-c" ]; then echo "нет faster_whisper" >&2; exit 1; fi',
		...body,
		""
	].join("\n"), "utf8");
	await chmod(bin, 0o755);
	return { bin, log, readLog: async () => { try { return await readFile(log, "utf8"); } catch { return ""; } } };
}

/** Ставит venv-заглушку в правильную кроссплатформенную раскладку. */
async function fakeVenv(dataDir, opts = {}) {
	return fakePython(path.join(dataDir, "venv", "bin"), { name: "python3", ...opts });
}

/**
 * Заглушка, которая вместо download_models.py создаёт снапшот запрошенной
 * модели: ровно так же раскладывает файлы настоящий скрипт.
 */
const LAYOUT_SNAPSHOT = [
	'model=""',
	'while [ $# -gt 0 ]; do',
	'  if [ "$1" = "--whisper-model" ]; then model="$2"; shift 2; continue; fi',
	'  shift',
	"done",
	'if [ -n "$model" ]; then',
	'  mkdir -p "$DSH_VOICE_DATA_DIR/models--Systran--faster-whisper-$model/snapshots/fake"',
	"fi",
	"exit 0"
];

/** Кладёт голос Piper так, как его ждёт py/server.py. */
async function makeVoice(dataDir, voice) {
	const dir = path.join(dataDir, "models", "piper", voice);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, `${voice}.onnx`), "onnx", "utf8");
	await writeFile(path.join(dir, `${voice}.onnx.json`), "{}", "utf8");
	return dir;
}

/** Кладёт каталог снапшота faster-whisper. */
async function makeWhisper(dataDir, model) {
	const dir = path.join(dataDir, "models", `models--Systran--faster-whisper-${model}`);
	await mkdir(path.join(dir, "snapshots", "abc"), { recursive: true });
	return dir;
}

/** Временно меняет переменные окружения. */
async function withEnv(env, fn) {
	const saved = new Map();
	for (const [key, value] of Object.entries(env)) {
		saved.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
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

/** Обычный node-овер: ответ /health — ровно как у py/server.py. */
function startNodeHealthServer(port) {
	const server = spawn(process.execPath, ["-e", [
		"const http = require('node:http');",
		`const port = ${port};`,
		"http.createServer((req, res) => {",
		"  res.writeHead(200, { 'Content-Type': 'application/json' });",
		"  res.end(JSON.stringify({ status: 'ok' }));",
		"}).listen(port, '127.0.0.1');"
	].join("\n")], { stdio: "ignore" });
	PROCS.add(server.pid);
	return server;
}

async function waitHealth(port, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* ждём */ }
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

// ---------------------------------------------------------------- setTargets()

console.log("setTargets(): выбор пользователя доходит до установщика");
await test("setTargets() обновляет цели и сообщает об изменении", async () => {
	const dataDir = await freshDataDir("targets");
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined }, async () => {
		const m = createLocalEngineManager();
		assert.equal((await m.status()).whisperModel, "small", "дефолт — small");
		assert.equal(m.setTargets({ whisperModel: "medium", piperVoice: "ru_RU-denis-medium" }), true);
		const st = await m.status();
		assert.equal(st.whisperModel, "medium");
		assert.equal(st.piperVoice, "ru_RU-denis-medium");
	});
});

await test("setTargets(): пустые значения игнорируются, повтор — не изменение", async () => {
	const dataDir = await freshDataDir("targets-empty");
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined }, async () => {
		const m = createLocalEngineManager({ whisperModel: "medium", piperVoice: "ru_RU-denis-medium" });
		assert.equal(m.setTargets({}), false, "пустой объект ничего не меняет");
		assert.equal(m.setTargets({ whisperModel: "", piperVoice: "   " }), false, "пустые строки не цели");
		assert.equal(m.setTargets({ whisperModel: null, piperVoice: undefined }), false);
		assert.equal(m.setTargets({ whisperModel: "medium" }), false, "тот же выбор — не изменение");
		const st = await m.status();
		assert.equal(st.whisperModel, "medium", "цели из config остались целыми");
		assert.equal(st.piperVoice, "ru_RU-denis-medium");
		// Меняется только одно поле — это тоже изменение
		assert.equal(m.setTargets({ whisperModel: "large" }), true);
		assert.equal((await m.status()).piperVoice, "ru_RU-denis-medium");
	});
});

// ---------------------------------------------------------------- ensureModels()

console.log("\nensureModels(): в download_models.py уходят выбранные модель и голос");
await test("ensureModels() передаёт выбранные модель и голос в py/download_models.py", async () => {
	const dataDir = await freshDataDir("ensure-models-args");
	const venv = await fakeVenv(dataDir, { body: ["echo 'stub failure' >&2", "exit 1"] });
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined }, async () => {
		const m = createLocalEngineManager();
		m.setTargets({ whisperModel: "medium", piperVoice: "ru_RU-denis-medium" });
		// Заглушка падает: сеть не нужна, а путь вызова всё равно виден в логе
		await assert.rejects(() => m.ensureModels(venv.bin), /Модели не загружены/);
		const log = await venv.readLog();
		const call = log.split("\n").find((l) => l.includes("download_models.py"));
		assert.ok(call, "модели качает py/download_models.py:\n" + log);
		// Регресс: раньше тут всегда жёстко стоял `small`, а --piper-voice не передавался
		assert.ok(/\s--whisper-model medium(\s|$)/.test(call), "в вызов должна попасть выбранная модель:\n" + call);
		assert.ok(/\s--piper-voice ru_RU-denis-medium(\s|$)/.test(call),
			"выбранный голос Piper должен передаваться отдельным флагом:\n" + call);
		assert.ok(!/--whisper-model small(\s|$)/.test(call), "жёстко зашитый small больше не передаётся:\n" + call);
	});
});

await test("ensureModels(): дефолты уходят в скрипт вместе с --piper-voice", async () => {
	const dataDir = await freshDataDir("ensure-models-default");
	const venv = await fakeVenv(dataDir, { body: ["echo 'stub failure' >&2", "exit 1"] });
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined }, async () => {
		const m = createLocalEngineManager();
		await assert.rejects(() => m.ensureModels(venv.bin), /Модели не загружены/);
		const call = (await venv.readLog()).split("\n").find((l) => l.includes("download_models.py"));
		assert.ok(/\s--whisper-model small(\s|$)/.test(call), call);
		assert.ok(/\s--piper-voice ru_RU-irina-medium(\s|$)/.test(call),
			"даже для дефолтного голоса нужен явный --piper-voice:\n" + call);
		assert.equal(call.slice(0, call.indexOf(" :: ")), path.join(dataDir, "models"),
			"Python получает каталог моделей, а не корень dataDir");
	});
});

// ---------------------------------------------------------------- готовность моделей

console.log("\nГотовность моделей: важна именно запрошенная модель, а не «какая-то»");
await test("modelsReady=false, если на диске другая модель faster-whisper", async () => {
	const dataDir = await freshDataDir("wrong-whisper");
	const venv = await fakeVenv(dataDir);
	await makeVoice(dataDir, "ru_RU-irina-medium");
	await makeWhisper(dataDir, "small");           // скачан small…
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: venv.bin }, async () => {
		const m = createLocalEngineManager();
		m.setTargets({ whisperModel: "medium" });  // …а просят medium
		const st = await m.status();
		assert.equal(st.venvReady, true);
		assert.equal(st.modelsReady, false, "скачанный small не должен считаться запрошенной medium");
	});
});

await test("modelsReady=true, когда на диске именно запрошенная модель", async () => {
	const dataDir = await freshDataDir("right-whisper");
	const venv = await fakeVenv(dataDir);
	await makeVoice(dataDir, "ru_RU-irina-medium");
	await makeWhisper(dataDir, "small");
	await makeWhisper(dataDir, "medium");
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: venv.bin }, async () => {
		const m = createLocalEngineManager();
		assert.equal((await m.status()).modelsReady, true, "small — дефолт, он на диске");
		assert.equal(m.setTargets({ whisperModel: "medium" }), true);
		assert.equal((await m.status()).modelsReady, true, "medium тоже на диске");
		assert.equal(m.setTargets({ whisperModel: "large" }), true);
		assert.equal((await m.status()).modelsReady, false, "large не скачивали");
	});
});

await test("modelsReady=false, если голос Piper выбран другой", async () => {
	const dataDir = await freshDataDir("wrong-voice");
	const venv = await fakeVenv(dataDir);
	await makeVoice(dataDir, "ru_RU-irina-medium");
	await makeWhisper(dataDir, "small");
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: venv.bin }, async () => {
		const m = createLocalEngineManager();
		m.setTargets({ piperVoice: "ru_RU-denis-medium" });
		assert.equal((await m.status()).modelsReady, false, "нужен выбранный голос, а не любой");
		await makeVoice(dataDir, "ru_RU-denis-medium");
		assert.equal((await m.status()).modelsReady, true);
	});
});

// ---------------------------------------------------------------- список моделей

console.log("\ndownloadedModels(): inUse только у текущих целей");
await test("downloadedModels() отмечает используемыми ровно выбранные модель и голос", async () => {
	const dataDir = await freshDataDir("models-inuse");
	await fakeVenv(dataDir);
	await makeVoice(dataDir, "ru_RU-irina-medium");
	await makeVoice(dataDir, "ru_RU-denis-medium");
	await makeWhisper(dataDir, "small");
	await makeWhisper(dataDir, "medium");
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: "python3" }, async () => {
		const m = createLocalEngineManager();
		let models = await m.downloadedModels();
		const byId = Object.fromEntries(models.map((x) => [x.id, x]));
		assert.equal(models.length, 4, JSON.stringify(models.map((x) => x.id)));
		assert.equal(byId["models--Systran--faster-whisper-small"].inUse, true, "small — дефолт");
		assert.equal(byId["models--Systran--faster-whisper-medium"].inUse, false);
		assert.equal(byId["piper/ru_RU-irina-medium"].inUse, true);

		m.setTargets({ whisperModel: "medium", piperVoice: "ru_RU-denis-medium" });
		models = await m.downloadedModels();
		const next = Object.fromEntries(models.map((x) => [x.id, x]));
		assert.equal(next["models--Systran--faster-whisper-medium"].inUse, true);
		assert.equal(next["models--Systran--faster-whisper-small"].inUse, false, "прежняя модель больше не используется");
		assert.equal(next["piper/ru_RU-denis-medium"].inUse, true);
		assert.equal(next["piper/ru_RU-irina-medium"].inUse, false);
	});
});

// ---------------------------------------------------------------- downloadModel()

console.log("\ndownloadModel(): докачка модели, выбранной после установки");
await test("downloadModel(): некорректное имя модели отклоняется", async () => {
	const dataDir = await freshDataDir("download-model-bad");
	const venv = await fakeVenv(dataDir);
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: venv.bin }, async () => {
		const m = createLocalEngineManager();
		await assert.rejects(() => m.downloadModel(""), /Не указана модель/);
		for (const bad of ["../../models", "medium;rm -rf /", "модель", "models/../x"]) {
			await assert.rejects(() => m.downloadModel(bad), /Некорректное имя модели/, "должно быть отклонено: " + bad);
		}
		assert.equal((await venv.readLog()).includes("download_models.py"), false,
			"до проверки имени скрипт запускаться не должен");
	});
});

await test("downloadModel(): уже скачанная модель не качается заново", async () => {
	const dataDir = await freshDataDir("download-model-present");
	const venv = await fakeVenv(dataDir, { body: LAYOUT_SNAPSHOT });
	await makeWhisper(dataDir, "medium");
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: venv.bin }, async () => {
		const m = createLocalEngineManager({ whisperModel: "medium" });
		const result = await m.downloadModel("medium");
		assert.equal(result.alreadyDownloaded, true, "модель уже на диске — сеть не трогаем");
		assert.equal(result.model, "medium");
		assert.equal((await venv.readLog()).includes("download_models.py"), false, "скрипт не запускался");
	});
});

await test("downloadModel(): скачивает новую модель и создаёт снапшот на диске", async () => {
	const dataDir = await freshDataDir("download-model-new");
	const venv = await fakeVenv(dataDir, { body: LAYOUT_SNAPSHOT });
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: venv.bin }, async () => {
		const m = createLocalEngineManager();
		assert.equal((await m.status()).modelsReady, false, "моделей ещё нет");
		const result = await m.downloadModel("medium");
		assert.equal(result.alreadyDownloaded, false);
		assert.equal(result.model, "medium");
		const log = await venv.readLog();
		const call = log.split("\n").find((l) => l.includes("download_models.py"));
		assert.ok(/\s--whisper-model medium(\s|$)/.test(call), "скрипт зовётся с выбранной моделью:\n" + log);
		assert.equal(call.slice(0, call.indexOf(" :: ")), path.join(dataDir, "models"));
		assert.ok(await pathExists(path.join(dataDir, "models", "models--Systran--faster-whisper-medium")),
			"снапшот должен появиться в каталоге моделей");
		// Цель переключилась на только что скачанную модель
		assert.equal((await m.status()).whisperModel, "medium");
		assert.equal((await m.downloadModel("medium")).alreadyDownloaded, true, "повтор уже не качает");
	});
});

await test("downloadModel(): неудачное скачивание откатывает цель и объясняет причину", async () => {
	const dataDir = await freshDataDir("download-model-fail");
	const venv = await fakeVenv(dataDir, { body: ["echo 'stub failure' >&2", "exit 1"] });
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: venv.bin }, async () => {
		const m = createLocalEngineManager();
		await assert.rejects(
			() => m.downloadModel("medium"),
			(err) => {
				assert.match(err.message, /Модель medium не скачалась/);
				assert.ok(/stub failure|завершился с кодом/.test(err.message), "в сообщении должна быть причина: " + err.message);
				return true;
			}
		);
		assert.equal((await m.status()).whisperModel, "small", "неудачная загрузка не должна оставлять битую цель");
		assert.equal((await m.status()).installing, false, "стадия установки обязана сброситься");
	});
});

// ---------------------------------------------------------------- порты

console.log("\nПорты: ensureStarted() не возвращает чужой порт молча");
await test("ensureStarted(portA) затем ensureStarted(portB): второй порт не подменяется первым", async () => {
	const dataDir = await freshDataDir("ports");
	// «Сервер» на portB — обычный node-процесс, Python не нужен
	const portA = await freePort();
	const portB = await freePort();
	const venv = await fakeVenv(dataDir, {
		body: [`exec ${process.execPath} -e 'require("node:http").createServer((q,s)=>{s.writeHead(200,{"Content-Type":"application/json"});s.end("{}")}).listen(${portA},"127.0.0.1")'`]
	});
	startNodeHealthServer(portB);
	assert.ok(await waitHealth(portB), "внешний сервер на portB должен подняться");
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined }, async () => {
		const m = createLocalEngineManager({ port: portA, startTimeoutMs: 15_000, healthPollIntervalMs: 100 });
		const first = await m.ensureStarted(portA);
		assert.equal(first.port, portA);
		assert.ok(first.pid, "сервер на portA должен быть нашим процессом");
		PROCS.add(first.pid);

		// Тот же порт — тот же процесс, без перезапуска
		const same = await m.ensureStarted(portA);
		assert.equal(same.port, portA);
		assert.equal(same.pid, first.pid);
		assert.equal(same.alreadyRunning, true);

		// Регресс: второй запрос уходил на чужой порт и получал «fetch failed»
		const second = await m.ensureStarted(portB);
		assert.equal(second.port, portB, "ensureStarted обязан вернуть запрошенный порт");
		assert.equal(second.external, true, "на portB уже есть чужой сервер — он и считается нами");
		assert.equal(second.pid, null);

		await m.stop();
		PROCS.delete(first.pid);
	});
});

console.log("\nГонка запуска: параллельные /stt и /speak не убивают сервер друг друга");

await test("параллельные ensureStarted() поднимают ОДИН процесс и не убивают его", async () => {
	// Регресс, из-за которого озвучка падала с ECONNRESET: /stt и /speak приходят
	// внахлёст (в постоянном диалоге — постоянно), оба видели child === null,
	// и второй убивал сервер, только что поднятый первым. В логе пользователя
	// было «сервер остановлен (сигнал SIGTERM)», а идущий запрос — ECONNRESET.
	const dataDir = await freshDataDir("race");
	const port = await freePort();
	const venv = await fakeVenv(dataDir, {
		body: [`exec ${process.execPath} -e 'require("node:http").createServer((q,s)=>{s.writeHead(200,{"Content-Type":"application/json"});s.end("{}")}).listen(${port},"127.0.0.1")'`]
	});
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined }, async () => {
		const m = createLocalEngineManager({ port, startTimeoutMs: 15_000, healthPollIntervalMs: 50 });
		const results = await Promise.all([
			m.ensureStarted(port),
			m.ensureStarted(port),
			m.ensureStarted(port),
			m.ensureStarted(port)
		]);
		const pids = new Set(results.map((r) => r.pid).filter(Boolean));
		assert.equal(pids.size, 1, "параллельные вызовы должны вернуть один и тот же pid, а не разные процессы: " + [...pids]);
		const pid = [...pids][0];
		PROCS.add(pid);

		// Сервер обязан ЖИТЬ после всех четырёх вызовов
		assert.ok(await waitHealth(port), "сервер не должен быть убит собственными же вызовами");
		const alive = (await m.status()).serverRunning;
		assert.equal(alive, true, "после параллельных ensureStarted сервер обязан остаться запущенным");

		await m.stop();
		PROCS.delete(pid);
	});
});

await test("неудачный запуск не убивает сервер, поднятый параллельным вызовом", async () => {
	// Второй дефект той же гонки: в catch упавшего start() стоял stop(), который
	// гасил «текущий child» — а к тому моменту это уже мог быть чужой процесс.
	const dataDir = await freshDataDir("race-foreign");
	const good = await freePort();
	const dead = await freePort();
	const venv = await fakeVenv(dataDir, {
		body: [`exec ${process.execPath} -e 'require("node:http").createServer((q,s)=>{s.writeHead(200,{"Content-Type":"application/json"});s.end("{}")}).listen(${good},"127.0.0.1")'`]
	});
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined }, async () => {
		const m = createLocalEngineManager({ port: good, startTimeoutMs: 2_000, healthPollIntervalMs: 50 });
		const started = await m.ensureStarted(good);
		PROCS.add(started.pid);

		// Порт, который никто не слушает и наш битый интерпретатор не поднимет
		await assert.rejects(
			() => m.ensureStarted(dead),
			(err) => err instanceof Error,
			"заведомо неуспешный запуск должен упасть"
		);

		assert.ok(await waitHealth(good), "работающий сервер должен уцелеть после неудачного запуска на другом порту");
		await m.stop();
		PROCS.delete(started.pid);
	});
});

await test("start() без интерпретатора venv: ошибка со статусом 400", async () => {
	const dataDir = await freshDataDir("start-status-400");
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined, PATH: "" }, async () => {
		const m = createLocalEngineManager({ startTimeoutMs: 2_000 });
		// Регресс: ошибка без .status всплывала наружу как непонятный HTTP 500
		await assert.rejects(() => m.start(undefined, 8799), (err) => {
			assert.equal(err.status, 400, "у ошибки должен быть HTTP-статус 400");
			assert.match(err.message, /не установлен|install/i);
			return true;
		});
		await assert.rejects(() => m.start(null, 8799), (err) => {
			assert.equal(err.status, 400);
			return true;
		});
		await assert.rejects(() => m.start(path.join(dataDir, "venv", "bin", "python3"), 8799), (err) => {
			assert.equal(err.status, 400, "неработающий интерпретатор — тоже 400, а не 500");
			assert.match(err.message, /не работает/);
			return true;
		});
	});
});

// ---------------------------------------------------------------- status()

console.log("\nstatus(): цели и порт из настроек");
await test("status() отдаёт выбранные whisperModel и piperVoice", async () => {
	const dataDir = await freshDataDir("status-targets");
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined }, async () => {
		const m = createLocalEngineManager();
		const before = await m.status();
		assert.equal(before.whisperModel, "small");
		assert.equal(before.piperVoice, "ru_RU-irina-medium");
		m.setTargets({ whisperModel: "large", piperVoice: "ru_RU-svetlana-medium" });
		const after = await m.status();
		assert.equal(after.whisperModel, "large");
		assert.equal(after.piperVoice, "ru_RU-svetlana-medium");
	});
});

await test("status() проверяет serverRunning на настроенном порту, а не на дефолтном", async () => {
	const dataDir = await freshDataDir("status-port");
	const busy = await freePort();
	const quiet = await freePort();
	startNodeHealthServer(busy);
	assert.ok(await waitHealth(busy), "внешний сервер должен подняться");
	await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: undefined }, async () => {
		// Регресс: status() опрашивал /health на жёстко зашитом 8765 и писал
		// «сервер не запущен», хотя он поднят на порту из настроек
		const onBusy = await createLocalEngineManager({ port: busy }).status();
		assert.equal(onBusy.serverRunning, true, "сервер на настроенном порту должен быть виден");
		assert.equal(onBusy.port, busy);
		assert.equal(onBusy.external, true);
		const onQuiet = await createLocalEngineManager({ port: quiet }).status();
		assert.equal(onQuiet.serverRunning, false);
		assert.equal(onQuiet.port, null);
	});
});

// ---------------------------------------------------------------- уборка

for (const pid of PROCS) {
	try { process.kill(pid, "SIGKILL"); } catch { /* уже мёртв */ }
}
await rm(TMP_ROOT, { recursive: true, force: true });

console.log(`\n${passed} пройдено${process.exitCode ? " (есть падения)" : ""}`);