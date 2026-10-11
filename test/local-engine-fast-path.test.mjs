/**
 * Скорость пути «микрофон → ответ» при локальном движке.
 *
 * ensureStarted() вызывается на КАЖДОМ /stt и /speak. Раньше он звал полный
 * status(), а тот поднимал до четырёх процессов Python (`--version`), пробовал
 * импорт faster_whisper/piper и рекурсивно обходил каталог моделей. Панель
 * настроек, опрашивающая /local/status раз в 2 с, умножала это ещё.
 *
 * Тест не меряет скорость Python (она зависит от машины), а считает, СКОЛЬКО
 * РАЗ запускается интерпретатор: это и есть цена каждого запроса.
 *
 * Запуск: node test/local-engine-fast-path.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const { createLocalEngineManager } = await import(path.join(ROOT, "lib", "local-engine.js"));

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

/**
 * Подставной интерпретатор venv: каждый запуск (`--version`, `-c …`, …)
 * дописывает строку в лог. Так мы видим ровно число порождённых процессов.
 */
async function countingVenv(dataDir) {
	const binDir = path.join(dataDir, "venv", "bin");
	await mkdir(binDir, { recursive: true });
	const log = path.join(dataDir, "python-runs.log");
	const script = `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexit 0\n`;
	const bin = path.join(binDir, "python3");
	await writeFile(bin, script, { mode: 0o755 });
	return { bin, log };
}

const count = async (log) => {
	const text = await import("node:fs/promises").then((fs) => fs.readFile(log, "utf8").catch(() => ""));
	return text.split("\n").filter(Boolean).length;
};

const withEnv = async (env, fn) => {
	const saved = {};
	for (const [key, value] of Object.entries(env)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
};

console.log("\nГорячий путь: сколько раз запускается Python на один запрос");

/** Поднимает «сервер» (отвечает на /health) на свободном порту. */
async function startHealthServer() {
	const { createServer } = await import("node:http");
	const server = createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ status: "ok" }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: server.address().port };
}

await test("при поднятом сервере /stt и /speak не запускают Python вовсе", async () => {
	// Горячий путь в реальной работе: сервер уже запущен, идут запросы
	// распознавания и озвучки. Ни один из них не должен трогать окружение.
	const dataDir = await mkdtemp(path.join(tmpdir(), "dsh-vc-fast-hot-"));
	const { server, port } = await startHealthServer();
	try {
		const venv = await countingVenv(dataDir);
		await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: venv.bin }, async () => {
			const m = createLocalEngineManager({ port, startTimeoutMs: 2_000 });
			const before = await count(venv.log);
			for (let i = 0; i < 6; i++) await m.ensureStarted(port);
			const runs = (await count(venv.log)) - before;
			assert.equal(runs, 0,
				`шесть запросов при поднятом сервере запустили Python ${runs} раз — это и есть цена каждого /stt`);
		});
	} finally {
		server.close();
		await rm(dataDir, { recursive: true, force: true });
	}
});

await test("холодный путь проверяет интерпретатор один раз, а не три", async () => {
	// Порта никто не слушает: сервер не поднимется, но нас интересует только
	// число ПРОВЕРОК окружения до попытки старта.
	const dataDir = await mkdtemp(path.join(tmpdir(), "dsh-vc-fast-cold-"));
	try {
		const venv = await countingVenv(dataDir);
		await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: venv.bin }, async () => {
			const m = createLocalEngineManager({ startTimeoutMs: 600, healthPollIntervalMs: 50 });
			const before = await count(venv.log);
			await m.ensureStarted(8791).catch(() => {});
			const runs = (await count(venv.log)) - before;
			// 1 — проверка интерпретатора (из кэша), 2 — сам запуск сервера.
			// Раньше было 4: полный status() поднимал Python несколько раз.
			assert.ok(runs <= 2,
				`на холодный запуск допустимо 2 запуска Python (проверка + старт), было ${runs}`);
		});
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
});

await test("status() переиспользует результат для параллельных вызовов", async () => {
	const dataDir = await mkdtemp(path.join(tmpdir(), "dsh-vc-fast-status-"));
	try {
		const venv = await countingVenv(dataDir);
		await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: venv.bin }, async () => {
			const m = createLocalEngineManager();
			// Панель настроек опрашивает статус раз в 2 с — параллельные вызовы
			// не должны порождать каждый свой набор Python-проб.
			const before = await count(venv.log);
			await Promise.all([m.status(), m.status(), m.status(), m.status()]);
			const runs = (await count(venv.log)) - before;
			assert.ok(runs <= 4,
				`четыре параллельных status() дали ${runs} запусков Python — результат не переиспользуется`);
		});
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
});

await test("повторный status() в пределах окна кэша не запускает Python вовсе", async () => {
	const dataDir = await mkdtemp(path.join(tmpdir(), "dsh-vc-fast-cache-"));
	try {
		const venv = await countingVenv(dataDir);
		await withEnv({ DSH_VOICE_DATA_DIR: dataDir, DSH_VOICE_PYTHON: venv.bin }, async () => {
			const m = createLocalEngineManager();
			await m.status();                       // прогрев кэша
			const before = await count(venv.log);
			await m.status();
			await m.status();
			const runs = (await count(venv.log)) - before;
			assert.equal(runs, 0, `в пределах окна кэша Python запускаться не должен, было ${runs}`);
		});
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
});

console.log(`\n${passed} пройдено${process.exitCode ? "（есть падения）" : ""}`);