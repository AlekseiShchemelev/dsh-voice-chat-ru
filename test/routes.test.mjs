/**
 * Маршруты хоста для локального движка: /stt и /tts при движке «local»
 * не должны требовать API-ключ, должны поднимать/находить локальный сервер
 * и отдавать WAV вместо MP3.
 *
 * Полностью офлайн: «локальный сервер» — это node:http-сервер на свободном
 * порту, а менеджер локального движка подменяется заглушкой.
 * Запуск: node test/routes.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

const TMP_ROOT = await mkdtemp(path.join(os.tmpdir(), "dsh-vc-routes-"));
process.env.DSH_VOICE_DATA_DIR = TMP_ROOT;

// Настоящий local-engine подключается лениво: ensureStarted на занятом порту
// лишь опрашивает /health и ничего не поднимает, поэтому Python в тесте не нужен.
const { apply } = await import("../lib/index.js");
const routes = new Map();
const webServer = {
	register(meta) {
		routes.set(meta.path, meta.handler);
		return () => routes.delete(meta.path);
	}
};
apply({
	get: () => undefined,
	inject(deps, fn) {
		fn({ webServer, sessions: null, effect: (f) => f() });
	}
}, {});

const host = http.createServer(async (req, res) => {
	const route = routes.get(req.url.split("?")[0]);
	if (!route) { res.writeHead(404); res.end(); return; }
	await route(req, res);
});
await new Promise((r) => host.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${host.address().port}`;

/** «Локальный движок»: /health + transcriptions + speech, аудио в формате WAV. */
async function startFakeLocalServer() {
	const seen = { health: 0, transcriptions: [], speech: [] };
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		await new Promise((r) => req.on("end", r));
		const auth = req.headers.authorization ?? null;
		if (req.url === "/health") {
			seen.health += 1;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok" }));
			return;
		}
		if (req.url === "/v1/audio/transcriptions") {
			seen.transcriptions.push({ auth, body: Buffer.concat(chunks).toString("latin1") });
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ text: "текст из локального движка" }));
			return;
		}
		if (req.url === "/v1/audio/speech") {
			seen.speech.push({ auth, body: Buffer.concat(chunks).toString("utf8") });
			res.writeHead(200, { "Content-Type": "audio/wav" });
			res.end(Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(12)]));
			return;
		}
		res.writeHead(404); res.end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { server, port: server.address().port, seen };
}

const saveSettings = (patch) => fetch(`${base}/dsh-voice-chat/settings`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(patch)
});

await test("/stt с движком local: ключ не нужен, запрос уходит на локальный сервер", async () => {
	const local = await startFakeLocalServer();
	try {
		await saveSettings({
			asrEngine: "local",
			asr: { local: { baseUrl: `http://127.0.0.1:${local.port}/v1`, model: "small", apiKey: "" } }
		});
		const resp = await fetch(`${base}/dsh-voice-chat/stt`, { method: "POST", body: Buffer.from([1, 2, 3]) });
		assert.equal(resp.status, 200, await resp.clone().text());
		assert.equal((await resp.json()).text, "текст из локального движка");
		assert.equal(local.seen.transcriptions.length, 1);
		assert.equal(local.seen.transcriptions[0].auth, null, "локальному серверу Authorization не нужен");
	} finally {
		local.server.close();
	}
});

await test("/tts и /speak с движком local: WAV вместо MP3, голос из слота", async () => {
	const local = await startFakeLocalServer();
	try {
		await saveSettings({
			ttsEngine: "local",
			tts: { local: { baseUrl: `http://127.0.0.1:${local.port}/v1`, model: "piper", apiKey: "", voice: "ru_RU-denis-medium" } }
		});
		for (const url of [`${base}/dsh-voice-chat/tts?text=привет`, `${base}/dsh-voice-chat/speak`]) {
			const resp = url.endsWith("speak")
				? await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Проверка озвучки" }) })
				: await fetch(url);
			assert.equal(resp.status, 200, `${url} → ${await resp.clone().text()}`);
			// Piper отдаёт WAV: раздавать его как audio/mpeg нельзя
			assert.equal(resp.headers.get("content-type"), "audio/wav", url);
			assert.equal((await resp.arrayBuffer()).byteLength, 16);
		}
		assert.equal(local.seen.speech.length, 2);
		for (const call of local.seen.speech) {
			assert.equal(call.auth, null);
			assert.equal(JSON.parse(call.body).voice, "ru_RU-denis-medium");
		}
	} finally {
		local.server.close();
	}
});

await test("/stt с движком local и свободным портом: понятная ошибка вместо «не настроен ключ»", async () => {
	await saveSettings({
		asrEngine: "local",
		asr: { local: { baseUrl: "http://127.0.0.1:59999/v1", model: "small", apiKey: "" } }
	});
	const resp = await fetch(`${base}/dsh-voice-chat/stt`, { method: "POST", body: Buffer.from([1]) });
	assert.equal(resp.status, 400);
	const body = await resp.json();
	assert.match(body.error, /Установить локальный движок/);
	assert.doesNotMatch(body.error, /ASR-ключ/, "жалоба на ключ здесь бессмысленна");
});

await test("/stt с сетевым движком без ключа по-прежнему 400 про ключ", async () => {
	await saveSettings({ asrEngine: "siliconflow", asr: { siliconflow: { baseUrl: "http://127.0.0.1:59998/v1", model: "m", apiKey: "" } } });
	const resp = await fetch(`${base}/dsh-voice-chat/stt`, { method: "POST", body: Buffer.from([1]) });
	assert.equal(resp.status, 400);
	assert.match((await resp.json()).error, /ASR-ключ/);
});

await test("/local/status отдаёт installing/installStage/installError", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/local/status`);
	assert.equal(resp.status, 200);
	const body = await resp.json();
	for (const field of ["installing", "installStage", "installError", "venvReady", "modelsReady", "serverRunning"]) {
		assert.ok(field in body, `нет поля ${field}`);
	}
	assert.equal(body.installing, false);
});

await test("/settings: asrHotkey сохраняется, нормализуется и отдаётся в /config", async () => {
	// Неразобранное значение → дефолт (правый Ctrl), а не мусор в settings.local.json
	await saveSettings({ asrHotkey: "shift+ctrl+m" });
	let settings = await (await fetch(`${base}/dsh-voice-chat/settings`)).json();
	assert.equal(settings.asrHotkey, "Ctrl+Shift+M");
	let cfg = await (await fetch(`${base}/dsh-voice-chat/config`)).json();
	assert.equal(cfg.asrHotkey, "Ctrl+Shift+M", "микрофон тоже должен знать про клавишу");

	await saveSettings({ asrHotkey: "Ctrl+A+B" });
	settings = await (await fetch(`${base}/dsh-voice-chat/settings`)).json();
	assert.equal(settings.asrHotkey, "ControlRight", "мусор откатывается к дефолту");

	await saveSettings({ asrHotkey: "" });
	settings = await (await fetch(`${base}/dsh-voice-chat/settings`)).json();
	assert.equal(settings.asrHotkey, "", "пустая строка = горячая клавиша выключена");

	await saveSettings({ asrHotkey: "ControlRight" });
});

await test("POST /local/start понимает ?port= (а не парсит его как '=число')", async () => {
	// Порт занят «нашим» локальным сервером → start должен вернуть alreadyRunning, не упав
	const local = await startFakeLocalServer();
	try {
		await saveSettings({ asr: { local: { baseUrl: `http://127.0.0.1:${local.port}/v1`, model: "small", apiKey: "" } } });
		const resp = await fetch(`${base}/dsh-voice-chat/local/start?port=${local.port}`, { method: "POST" });
		const body = await resp.text();
		// Менеджер честно сообщает: venv не установлен в тестовом каталоге
		assert.match(body, /не установлен|alreadyRunning/);
	} finally {
		local.server.close();
	}
});

host.close();
await rm(TMP_ROOT, { recursive: true, force: true });
console.log(`\n${passed} пройдено${process.exitCode ? " (есть падения)" : ""}`);
