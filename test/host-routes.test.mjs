/**
 * Маршруты хоста под настоящим node:http: apply() вешается на заглушку
 * webServer, а маршруты реально обслуживает сервер на порту 0 — так проверяются
 * вещи, которых не видно на фейковых req/res:
 *   - POST /tts с длинным телом (лимит длины URL его больше не касается);
 *   - две одновременные записи в /settings (гонка «прочитал-объединил-записал»);
 *   - диагностика сетевых сбоев: 502 с адресом и подсказкой вместо «fetch failed».
 *
 * Полностью офлайн: ASR/TTS — это node:http-серверы на свободных портах,
 * локальный движок не установлен, Python не нужен.
 * Настройки и каталог данных — во временной папке (DSH_VOICE_SETTINGS_FILE /
 * DSH_VOICE_DATA_DIR задаются ДО импорта lib/index.js), боевой
 * settings.local.json тест не трогает.
 * Запуск: node test/host-routes.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = await mkdtemp(path.join(os.tmpdir(), "dsh-vc-host-routes-"));
process.env.DSH_VOICE_DATA_DIR = TMP_ROOT;
// Обязательно до импорта: иначе тест писал бы в боевой settings.local.json
process.env.DSH_VOICE_SETTINGS_FILE = path.join(TMP_ROOT, "settings.local.json");

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

// ---------- Хост: apply() + настоящий сервер ----------
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

// ---------- Внешние «движки»: всё, что нужно, — локальные серверы ----------
/** Поддельный TTS: /v1/audio/speech отдаёт «MP3» и запоминает, что ему прислали. */
async function startFakeTts() {
	const seen = { speech: [] };
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		await new Promise((r) => req.on("end", r));
		const raw = Buffer.concat(chunks).toString("utf8");
		if (req.url === "/v1/audio/speech") {
			seen.speech.push({ auth: req.headers.authorization ?? null, body: raw });
			res.writeHead(200, { "Content-Type": "audio/mpeg" });
			res.end(Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(64, 7)]));
			return;
		}
		res.writeHead(404); res.end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { server, port: server.address().port, seen, url: `http://127.0.0.1:${server.address().port}/v1` };
}

/** Поддельный ASR: /v1/audio/transcriptions отвечает заданным кодом и телом. */
async function startFakeAsr(status, payload) {
	const seen = { transcriptions: [] };
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		await new Promise((r) => req.on("end", r));
		if (req.url === "/v1/audio/transcriptions") {
			seen.transcriptions.push({ auth: req.headers.authorization ?? null, body: Buffer.concat(chunks) });
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(payload));
			return;
		}
		res.writeHead(404); res.end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { server, port: server.address().port, seen, url: `http://127.0.0.1:${server.address().port}/v1` };
}

const saveSettings = (patch) => fetch(`${base}/dsh-voice-chat/settings`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(patch)
});
const getSettings = () => fetch(`${base}/dsh-voice-chat/settings`).then((r) => r.json());
/** Настроить движок «custom» (OpenAI-совместимый) на поддельный сервер. */
async function useCustom({ tts, asr }) {
	await saveSettings({
		ttsEngine: "custom",
		tts: { custom: { baseUrl: tts, model: "tts-1", apiKey: "tts-key", voice: "alloy" } },
		asrEngine: "custom",
		asr: { custom: { baseUrl: asr, model: "asr-model", apiKey: "asr-key" } }
	});
}

await test("GET /tts?text= работает как раньше (регрессия после появления POST)", async () => {
	const tts = await startFakeTts();
	try {
		await useCustom({ tts: tts.url, asr: "http://127.0.0.1:1/v1" });
		const resp = await fetch(`${base}/dsh-voice-chat/tts?text=${encodeURIComponent("Привет, мир")}`);
		assert.equal(resp.status, 200, await resp.clone().text());
		assert.equal(resp.headers.get("content-type"), "audio/mpeg");
		assert.ok((await resp.arrayBuffer()).byteLength > 0);
		assert.equal(tts.seen.speech.length, 1);
		assert.equal(JSON.parse(tts.seen.speech[0].body).input, "Привет, мир");
		assert.equal(tts.seen.speech[0].auth, "Bearer tts-key");
	} finally {
		tts.server.close();
	}
});

await test("POST /tts с JSON {text} длинного текста (~5000 симв.) обходит лимит длины URL", async () => {
	const tts = await startFakeTts();
	try {
		await useCustom({ tts: tts.url, asr: "http://127.0.0.1:1/v1" });
		const long = "Съешь ещё этих мягких французских булок. ".repeat(150).trim();
		assert.ok(long.length > 5000, `текст должен быть длиннее 5000 символов, а ${long.length}`);
		const resp = await fetch(`${base}/dsh-voice-chat/tts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: long })
		});
		assert.equal(resp.status, 200, await resp.clone().text());
		const audio = await resp.arrayBuffer();
		assert.ok(audio.byteLength > 0, "аудио должно прийти телом ответа");
		assert.equal(tts.seen.speech.length, 1);
		const sent = JSON.parse(tts.seen.speech[0].body).input;
		assert.ok(sent.length > 100, `движок должен получить текст, а не пустую строку (${sent.length})`);
		console.log(`      (в движок ушло ${sent.length} симв. из ${long.length} — маршрут обрезает до 4000)`);
	} finally {
		tts.server.close();
	}
});

await test("POST /tts с телом text/plain тоже озвучивается", async () => {
	const tts = await startFakeTts();
	try {
		await useCustom({ tts: tts.url, asr: "http://127.0.0.1:1/v1" });
		const resp = await fetch(`${base}/dsh-voice-chat/tts`, {
			method: "POST",
			headers: { "Content-Type": "text/plain; charset=utf-8" },
			body: "Обычный текст без JSON"
		});
		assert.equal(resp.status, 200, await resp.clone().text());
		assert.ok((await resp.arrayBuffer()).byteLength > 0);
		assert.equal(JSON.parse(tts.seen.speech[0].body).input, "Обычный текст без JSON");
	} finally {
		tts.server.close();
	}
});

await test("PUT /tts → 405 (метод не должен молча читаться как GET)", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/tts?text=привет`, { method: "PUT" });
	assert.equal(resp.status, 405);
	assert.equal((await resp.json()).error, "method not allowed");
});

await test("Два параллельных POST /settings не теряют правку (записи выстроены в очередь)", async () => {
	// Оба запроса стартуют одновременно и меняют РАЗНЫЕ поля: раньше второй
	// затирал первый, читая один и тот же снимок настроек.
	const [first, second] = await Promise.all([
		saveSettings({ asrHotkey: "ControlLeft" }),
		saveSettings({ silenceMs: 1234 })
	]);
	assert.equal(first.status, 200, await first.clone().text());
	assert.equal(second.status, 200, await second.clone().text());
	const settings = await getSettings();
	assert.equal(settings.asrHotkey, "ControlLeft", "первая правка потерялась");
	assert.equal(settings.silenceMs, 1234, "вторая правка потерялась");
	const onDisk = JSON.parse(await readFile(process.env.DSH_VOICE_SETTINGS_FILE, "utf8"));
	assert.equal(onDisk.asrHotkey, "ControlLeft", "на диске тоже обе правки");
	assert.equal(onDisk.silenceMs, 1234, "на диске тоже обе правки");
});

await test("/local/download-model без ?model= берёт модель из слота asr.local", async () => {
	// Имя модели из слота — заведомо недопустимое: так видно, какое именно имя
	// дошло до движка (движок не установлен, но проверка имени идёт первой).
	await saveSettings({ asr: { local: { baseUrl: "http://127.0.0.1:59997/v1", model: "модель из слота" } } });
	const resp = await fetch(`${base}/dsh-voice-chat/local/download-model`, { method: "POST" });
	assert.equal(resp.status, 400);
	const err = (await resp.json()).error;
	assert.match(err, /Некорректное имя модели/, `взята не модель из слота: ${err}`);
	assert.match(err, /модель из слота/);
});

await test("/local/download-model?model= перекрывает модель слота", async () => {
	await saveSettings({ asr: { local: { baseUrl: "http://127.0.0.1:59997/v1", model: "small" } } });
	const resp = await fetch(`${base}/dsh-voice-chat/local/download-model?model=${encodeURIComponent("large-v3")}`, { method: "POST" });
	assert.equal(resp.status, 400);
	const err = (await resp.json()).error;
	// small/v3 проходят проверку имени, дальше — движок не установлен
	assert.match(err, /Установить локальный движок/, `ожидалась понятная ошибка установки, а: ${err}`);
	assert.doesNotMatch(err, /Некорректное имя модели/, "явное ?model= должно побеждать слот");
});

await test("/local/download-model с кривым ?model= → 400 про имя модели", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/local/download-model?model=${encodeURIComponent("../../etc")}`, { method: "POST" });
	assert.equal(resp.status, 400);
	assert.match((await resp.json()).error, /Некорректное имя модели/);
});

await test("Сетевой сбой: 502 с адресом и подсказкой вместо бесполезного «fetch failed»", async () => {
	// Порт закрыт по-настоящему (занимаем и сразу освобождаем) — ровно тот
	// случай, когда локальный сервер не поднят или в настройках разошёлся порт.
	const closedPort = await startFakeAsr(200, {}).then(async (s) => {
		const port = s.port;
		await new Promise((r) => s.server.close(r));
		return port;
	});
	await saveSettings({
		asrEngine: "custom",
		asr: { custom: { baseUrl: `http://127.0.0.1:${closedPort}/v1`, model: "whisper-small", apiKey: "asr-key" } }
	});
	const resp = await fetch(`${base}/dsh-voice-chat/stt`, { method: "POST", body: Buffer.from([1, 2, 3]) });
	const body = await resp.json();
	assert.equal(resp.status, 502, `ожидался 502, а ${resp.status}: ${JSON.stringify(body)}`);
	assert.match(body.error, new RegExp(`http://127\\.0\\.0\\.1:${closedPort}/v1/audio/transcriptions`), "в ошибке должен быть адрес");
	assert.match(body.error, /Локальный сервер не запущен или в настройках указан другой порт/);
	assert.doesNotMatch(body.error, /fetch failed/, "это ровно тот текст, который больше не должен утекать");
});

await test("401 от ASR: ошибка говорит проверить API-ключ", async () => {
	const asr = await startFakeAsr(401, { error: { message: "invalid api key" } });
	try {
		await saveSettings({
			asrEngine: "custom",
			asr: { custom: { baseUrl: asr.url, model: "asr-model", apiKey: "wrong-key" } }
		});
		const resp = await fetch(`${base}/dsh-voice-chat/stt`, { method: "POST", body: Buffer.from([1, 2, 3]) });
		const body = await resp.json();
		assert.equal(resp.status, 502, JSON.stringify(body));
		assert.match(body.error, /Проверьте API-ключ/);
		assert.match(body.error, /invalid api key/, "и текст ответа движка не теряется");
		assert.equal(asr.seen.transcriptions[0].auth, "Bearer wrong-key");
	} finally {
		asr.server.close();
	}
});

await test("POST /stt?engine=browser → 400 с объяснением, а не «не настроен ключ»", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/stt?engine=browser`, { method: "POST", body: Buffer.from([1, 2, 3]) });
	assert.equal(resp.status, 400);
	const err = (await resp.json()).error;
	assert.match(err, /Web Speech API/);
	assert.doesNotMatch(err, /ключ/i, "браузерный движок ключа не требует — жалоба сбивает с толку");
});

await test("Все маршруты, которые вызывает клиент, зарегистрированы", async () => {
	// Список берём из самого клиента: если он начнёт дёргать новый путь, тест
	// упадёт на несовпадении, а не в браузере у пользователя.
	const client = await readFile(path.join(HERE, "..", "lib", "client.js"), "utf8");
	const lines = client.split("\n");
	const wanted = new Set();
	for (const line of lines) {
		if (!line.includes('window.fetch("/dsh-voice-chat')) continue;
		const prefix = /window\.fetch\("(\/dsh-voice-chat[^"?]*)/.exec(line)?.[1];
		if (!prefix) continue;
		// Динамический путь вида "/dsh-voice-chat/local/" + path: подставляем
		// всё, что клиент реально просит через call(...)
		if (/\/$/.test(prefix)) {
			for (const m of client.matchAll(/call\("([a-z-]+)"/g)) wanted.add(prefix + m[1]);
		} else {
			wanted.add(prefix);
		}
	}
	assert.ok(wanted.size >= 8, `нашлось подозрительно мало путей: ${[...wanted].join(", ")}`);
	for (const p of wanted) {
		assert.ok(routes.has(p), `маршрут ${p} вызывается клиентом, но не зарегистрирован`);
	}
	console.log(`      (проверено путей: ${wanted.size})`);
});

host.close();
await rm(TMP_ROOT, { recursive: true, force: true });
console.log(`\n${passed} пройдено${process.exitCode ? " (есть падения)" : ""}`);
