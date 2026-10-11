/**
 * Тесты на дыры покрытия (Этап 25): модули и маршруты, на которые раньше не
 * было ни одного прямого теста — lib/rewrite.js, закрытие WebSocket в
 * lib/edge-tts.js, лимиты тел readBody и пер-route 413, /latest-message,
 * /local/stop, path traversal в query локального движка.
 *
 * Полностью офлайн: edge-tts бьёт в подделку WebSocket вместо wss://speech.…,
 * harness маршрутов — тот же, что в routes.test.mjs.
 * Запуск: node test/gaps.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";

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

const TMP_ROOT = await mkdtemp(path.join(os.tmpdir(), "dsh-vc-gaps-"));
process.env.DSH_VOICE_DATA_DIR = TMP_ROOT;
process.env.DSH_VOICE_SETTINGS_FILE = path.join(TMP_ROOT, "settings.local.json");

const { rewriteWithHarness } = await import("../lib/rewrite.js");
const { synthesizeSpeech } = await import("../lib/edge-tts.js");
const { readBody, MAX_BODY_BYTES } = await import("../lib/net.js");
const {
	BODY_LIMITS,
	MAX_SPEECH_CHARS,
	isValidPiperVoice,
	isValidWhisperModel
} = await import("../lib/index.js");

// =====================================================================
// 1. lib/rewrite.js — пересказ через LLM harness
// =====================================================================
console.log("\nrewrite.js: пересказ через LLM harness");

/** LLM-сервис-подделка: stream() отдаёт готовые чанки, всё пишет в calls. */
function fakeLlm(script) {
	const calls = [];
	let call = 0;
	const llm = {
		stream(params) {
			calls.push(params);
			const chunks = typeof script === "function" ? script(call++) : script;
			return (async function* () {
				for (const chunk of chunks) yield chunk;
			})();
		}
	};
	return { llm, calls };
}

await test("пересказ: склеивает text-delta и обрезает пробелы", async () => {
	const { llm, calls } = fakeLlm([
		{ type: "text-delta", text: "Короткий " },
		{ type: "text-delta", text: "отчёт.  " },
		{ type: "finish", reason: { kind: "stop" } }
	]);
	const out = await rewriteWithHarness({ llm }, "Длинный ответ модели", "deepseek-official", "deepseek-v4-flash");
	assert.equal(out, "Короткий отчёт.");
	assert.equal(calls.length, 1, "успешный вызов без повторов");
	assert.equal(calls[0].provider, "deepseek-official");
	assert.equal(calls[0].model, "deepseek-v4-flash");
	assert.ok(calls[0].system.includes("AI-ассистент"), "system-промпт пересказа передан");
	// reasoningEffort=off пробуем всегда первым: официальные deepseek отвечают быстрее без размышления
	assert.equal(calls[0].reasoningEffort, "off");
});

await test("пересказ: длинный исходник режется до 6000 символов", async () => {
	const { llm, calls } = fakeLlm([{ type: "text-delta", text: "ок" }, { type: "finish", reason: { kind: "stop" } }]);
	await rewriteWithHarness({ llm }, "x".repeat(9000), "p", "m");
	const text = calls[0].messages[0].content[0].text;
	assert.equal(text.length, 6000, "текст обрезан до 6000 символов");
});

await test("пересказ: reason.kind=error бросает настоящий сбой, а не «успех, но пусто»", async () => {
	const { llm } = fakeLlm([
		{ type: "text-delta", text: "" },
		{ type: "finish", reason: { kind: "error", failure: { message: "ключ просрочен" } } }
	]);
	await assert.rejects(
		() => rewriteWithHarness({ llm }, "текст", "p", "m"),
		/Ошибка пересказа LLM harness \(error\): ключ просрочен/
	);
});

await test("пересказ: aborted тоже ошибка, а не тишина", async () => {
	const { llm } = fakeLlm([{ type: "finish", reason: { kind: "aborted", failure: "поток прерван" } }]);
	await assert.rejects(
		() => rewriteWithHarness({ llm }, "текст", "p", "m"),
		/Ошибка пересказа LLM harness \(aborted\): поток прерван/
	);
});

await test("пересказ: пустой результат — ошибка", async () => {
	const { llm } = fakeLlm([{ type: "text-delta", text: "   " }, { type: "finish", reason: { kind: "stop" } }]);
	await assert.rejects(() => rewriteWithHarness({ llm }, "текст", "p", "m"), /пустой результат/);
});

await test("пересказ: модель без reasoningEffort — повтор без параметра", async () => {
	let call = 0;
	const calls = [];
	const llm = {
		stream(params) {
			calls.push(params);
			// Первый вызов: сервис отвечает ошибкой «reasoning effort» — так ведут
			// себя модели через AI-прокси. Второй: обычный успех.
			const chunks = call++ === 0
				? [{ type: "finish", reason: { kind: "error", failure: "reasoning effort is not supported" } }]
				: [{ type: "text-delta", text: "повтор удался" }, { type: "finish", reason: { kind: "stop" } }];
			return (async function* () { for (const c of chunks) yield c; })();
		}
	};
	const out = await rewriteWithHarness({ llm }, "текст", "pi-ai", "some-model");
	assert.equal(out, "повтор удался");
	assert.equal(calls.length, 2, "ровно два вызова");
	assert.equal("reasoningEffort" in calls[1], false, "повтор без reasoningEffort");
});

await test("пересказ: неизвестный reason.kind — понятная ошибка, не молчание", async () => {
	const { llm } = fakeLlm([{ type: "finish", reason: { kind: "weird" } }]);
	await assert.rejects(() => rewriteWithHarness({ llm }, "текст", "p", "m"), /неожиданно завершился/);
});

await test("пересказ: llm-сервиса нет — ошибка сразу", async () => {
	await assert.rejects(() => rewriteWithHarness({}, "текст", "p", "m"), /LLM-сервис harness недоступен/);
});

// =====================================================================
// 2. lib/edge-tts.js — сокет закрывается после синтеза
// =====================================================================
console.log("\nedge-tts: закрытие WebSocket");

/**
 * Подделка ws.WebSocket: emit-модель вместо event-target. Служебные кадры
 * ("speech.config", "ssml") не отвечают — отвечает только ssml: бинарный кадр
 * с аудио и строка Path:turn.end. close сокет НИКОГДА не эмитит — иначе
 * проверка «сокет закрыли мы сами» потеряла бы смысл.
 */
class FakeEdgeSocket {
	static instances = [];
	constructor(url, opts) {
		this.url = url;
		this.opts = opts;
		this.listeners = {};
		this.sent = [];
		this.closeCalls = 0;
		FakeEdgeSocket.instances.push(this);
		// ws эмитит open после рукопожатия; в подделке соединение «успешно» сразу
		queueMicrotask(() => this.emit("open", {}));
	}
	addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
	emit(type, ev) { for (const fn of this.listeners[type] ?? []) fn(ev); }
	send(data) {
		this.sent.push(String(data));
		if (!String(data).includes("Path:ssml")) return;
		const header = Buffer.from("X-RequestId:test\r\n\r\n", "utf8");
		const audio = Buffer.from("фальшивый mp3");
		const frame = Buffer.alloc(2 + header.length + audio.length);
		frame.writeUInt16BE(header.length, 0);
		header.copy(frame, 2);
		audio.copy(frame, 2 + header.length);
		queueMicrotask(() => {
			this.emit("message", { data: frame });
			this.emit("message", { data: "X-Timestamp:now\r\nPath:turn.end\r\n\r\n" });
		});
	}
	close() { this.closeCalls += 1; }
}

await test("успешный синтез: аудио собрано, сокет закрыт после turn.end", async () => {
	FakeEdgeSocket.instances = [];
	const audio = await synthesizeSpeech(
		{ text: "привет", voice: "ru-RU-SvetlanaNeural", rate: "+10%", pitch: "+0Hz" },
		5000,
		FakeEdgeSocket
	);
	assert.ok(Buffer.isBuffer(audio));
	assert.equal(audio.toString("utf8"), "фальшивый mp3");
	const sock = FakeEdgeSocket.instances[0];
	assert.equal(sock.closeCalls, 1, "сокет закрыт ровно один раз (сервер сам не закрылся)");
	assert.ok(sock.url.includes("Sec-MS-GEC="), "токен DRM в URL запроса");
	const ssml = sock.sent.find((m) => m.includes("Path:ssml"));
	assert.ok(ssml.includes("ru-RU-SvetlanaNeural"), "голос в SSML");
});

await test("таймаут синтеза: сокет тоже закрыт, ошибка с человеческим текстом", async () => {
	class DeafSocket extends FakeEdgeSocket {
		send(data) { this.sent.push(String(data)); /* службы не отвечают никогда */ }
	}
	FakeEdgeSocket.instances = [];
	await assert.rejects(
		() => synthesizeSpeech({ text: "привет", voice: "ru-RU-SvetlanaNeural", rate: "+0%", pitch: "+0Hz" }, 120, DeafSocket),
		/Таймаут синтеза/
	);
	assert.ok(FakeEdgeSocket.instances[0].closeCalls >= 1, "сокет закрыт и в аварийной ветке");
});

// =====================================================================
// 3. readBody — лимиты тела
// =====================================================================
console.log("\nreadBody: лимиты входящих тел");

/** Подделка req: асинхронный iterable чанков заданного размера. */
function chunkSource(sizes) {
	return (async function* () {
		for (const size of sizes) yield Buffer.alloc(size, 0x61);
	})();
}

await test("тело в пределах лимита собирается целиком", async () => {
	const body = await readBody(chunkSource([1024, 1024]), 4096);
	assert.equal(body.length, 2048);
});

await test("тело больше лимита → ошибка со статусом 413", async () => {
	await assert.rejects(
		() => readBody(chunkSource([4096, 4096]), 4096),
		(err) => {
			assert.equal(err.status, 413);
			assert.match(err.message, /больше/i);
			return true;
		}
	);
});

await test("дефолтный лимит — 128 МБ, как заявлено в константе", () => {
	assert.equal(MAX_BODY_BYTES, 128 * 1024 * 1024);
});

// =====================================================================
// 4. Пер-route лимиты: /settings 64 КБ, /tts|/speak 1 МБ, /stt 32 МБ → 413
// =====================================================================
console.log("\nпер-route лимиты: 413 на слишком большие тела");

const routes = new Map();
const webServer = {
	register(meta) {
		routes.set(meta.path, meta.handler);
		return () => routes.delete(meta.path);
	}
};
const sessionsStore = new Map(); // sessionId → { deriveMessages() }
const { apply } = await import("../lib/index.js");
apply({
	get: (name) => (name === "sessions" ? { get: (id) => sessionsStore.get(id) } : undefined),
	inject(deps, fn) {
		fn({ webServer, effect: (f) => f() });
	}
}, {});

const host = http.createServer(async (req, res) => {
	const route = routes.get(req.url.split("?")[0]);
	if (!route) { res.writeHead(404); res.end(); return; }
	await route(req, res);
});
await new Promise((r) => host.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${host.address().port}`;

await test("POST /settings: тело больше 64 КБ отклоняется лимитом маршрута", async () => {
	const big = JSON.stringify({ asrEngine: "edge", note: "x".repeat(BODY_LIMITS.settings + 10) });
	const resp = await fetch(`${base}/dsh-voice-chat/settings`, { method: "POST", body: big });
	assert.equal(resp.status, 413);
	assert.match((await resp.json()).error, /больше/i);
});

await test("POST /tts: тело больше 1 МБ отклоняется лимитом маршрута", async () => {
	const big = JSON.stringify({ text: "x".repeat(BODY_LIMITS.speech + 10) });
	const resp = await fetch(`${base}/dsh-voice-chat/tts`, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: big
	});
	assert.equal(resp.status, 413);
});

await test("POST /stt: тело больше 32 МБ отклоняется лимитом маршрута", async () => {
	const big = Buffer.alloc(BODY_LIMITS.audio + 1, 0x62);
	const resp = await fetch(`${base}/dsh-voice-chat/stt`, { method: "POST", body: big });
	assert.equal(resp.status, 413);
});

await test("лимит скорости речи согласован: MAX_SPEECH_CHARS = 4000", () => {
	// Был 2000 в четырёх местах, длинные ответы обрезались на середине
	assert.equal(MAX_SPEECH_CHARS, 4000);
});

// =====================================================================
// 5. /latest-message — последний ответ assistant через сервис sessions
// =====================================================================
console.log("\n/latest-message: текст последнего ответа assistant");

await test("без sessionId → 400", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/latest-message`);
	assert.equal(resp.status, 400);
});

await test("неизвестная сессия → 404", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/latest-message?sessionId=nope`);
	assert.equal(resp.status, 404);
});

await test("текст последнего assistant-сообщения возвращается (text-блоки, joined \\n)", async () => {
	sessionsStore.set("s1", {
		deriveMessages: () => [
			{ role: "user", content: [{ type: "text", text: "вопрос" }] },
			{ role: "assistant", content: [{ type: "text", text: "Первая реплика" }] },
			{ role: "assistant", content: [{ type: "text", text: "Финал" }, { type: "text", text: "из двух частей" }] }
		]
	});
	const resp = await fetch(`${base}/dsh-voice-chat/latest-message?sessionId=s1`);
	assert.equal(resp.status, 200);
	assert.deepEqual(await resp.json(), { text: "Финал\nиз двух частей" });
});

await test("content с kind:text (другой блок) тоже собирается", async () => {
	sessionsStore.set("s2", {
		deriveMessages: () => [
			{ role: "assistant", content: [{ kind: "text", text: "старый формат блока" }] }
		]
	});
	const resp = await fetch(`${base}/dsh-voice-chat/latest-message?sessionId=s2`);
	assert.equal(resp.status, 200);
	assert.deepEqual(await resp.json(), { text: "старый формат блока" });
});

await test("у сессии нет текстовых ответов → 404, а не пустой текст", async () => {
	sessionsStore.set("s3", {
		deriveMessages: () => [
			{ role: "assistant", content: [{ type: "tool_call" }] }
		]
	});
	const resp = await fetch(`${base}/dsh-voice-chat/latest-message?sessionId=s3`);
	assert.equal(resp.status, 404);
});

await test("текст длиннее 5000 символов обрезается", async () => {
	sessionsStore.set("s4", {
		deriveMessages: () => [
			{ role: "assistant", content: [{ type: "text", text: "y".repeat(9000) }] }
		]
	});
	const resp = await fetch(`${base}/dsh-voice-chat/latest-message?sessionId=s4`);
	const body = await resp.json();
	assert.equal(body.text.length, 5000);
});

// =====================================================================
// 6. /local/stop — останавливает то, что не работает, без падений
// =====================================================================
console.log("\n/local/stop: idempotent без поднятого сервера");

await test("POST /local/stop без работающего сервера → {ok:true}", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/local/stop`, { method: "POST" });
	assert.equal(resp.status, 200, await resp.clone().text());
	assert.equal((await resp.json()).ok, true);
	// И повторно — идемпотентно
	const again = await fetch(`${base}/dsh-voice-chat/local/stop`, { method: "POST" });
	assert.equal(again.status, 200);
});

// =====================================================================
// 7. Path traversal в query локального движка
// =====================================================================
console.log("\ntraversal: имя модели/голоса из query не выходит за каталог данных");

await test("валидаторы режут разделители пути (юнит)", () => {
	assert.equal(isValidWhisperModel("../../etc/passwd"), false);
	assert.equal(isValidWhisperModel("small"), true);
	assert.equal(isValidWhisperModel("large-v3"), true);
	assert.equal(isValidWhisperModel(""), false);
	assert.equal(isValidPiperVoice("ru_RU-irina-medium"), true);
	assert.equal(isValidPiperVoice("../../etc/passwd"), false);
	assert.equal(isValidPiperVoice("ru_RU-irina-medium/../../x"), false);
	assert.equal(isValidPiperVoice(""), false);
});

await test("GET /local/status?voice=../../etc → 400", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/local/status?voice=${encodeURIComponent("../../etc/passwd")}`);
	assert.equal(resp.status, 400);
	assert.match((await resp.json()).error, /голос/i);
});

await test("GET /local/status?model=../../etc → 400", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/local/status?model=${encodeURIComponent("../../etc/passwd")}`);
	assert.equal(resp.status, 400);
	assert.match((await resp.json()).error, /модел/i);
});

await test("POST /local/install с traversal-целями → 400, установка не начинается", async () => {
	const voice = await fetch(`${base}/dsh-voice-chat/local/install?voice=${encodeURIComponent("../pwn")}`, { method: "POST" });
	assert.equal(voice.status, 400);
	const model = await fetch(`${base}/dsh-voice-chat/local/install?model=${encodeURIComponent("../pwn")}`, { method: "POST" });
	assert.equal(model.status, 400);
	// Цели не тронуты: traversal-имя не осело в менеджере
	const status = await (await fetch(`${base}/dsh-voice-chat/local/status`)).json();
	assert.notEqual(String(status.whisperModel ?? ""), "../pwn");
	assert.notEqual(String(status.piperVoice ?? ""), "../pwn");
});

await test("POST /local/download-model с traversal-именем → 400/ошибка валидации", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/local/download-model?model=${encodeURIComponent("../../pwn")}`, { method: "POST" });
	assert.ok(resp.status >= 400, "должен быть отказ");
});

await test("POST /local/download-voice с traversal-именем → 400", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/local/download-voice?voice=${encodeURIComponent("../../pwn")}`, { method: "POST" });
	assert.equal(resp.status, 400);
});

await test("POST /local/remove-model с traversal-идентификатором → 400", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/local/remove-model?id=${encodeURIComponent("../../venv")}`, { method: "POST" });
	assert.equal(resp.status, 400);
});

await test("POST /settings с телом-массивом → 400 (не объект)", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/settings`, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: "[1,2,3]"
	});
	assert.equal(resp.status, 400);
});

await test("битый JSON в POST /settings → 400, а не молчаливое «сохранено»", async () => {
	const resp = await fetch(`${base}/dsh-voice-chat/settings`, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops"
	});
	assert.equal(resp.status, 400);
});

host.close();
await rm(TMP_ROOT, { recursive: true, force: true });
console.log(`\n${passed} пройдено${process.exitCode ? " (есть падения)" : ""}`);