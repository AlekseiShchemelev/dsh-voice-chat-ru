/**
 * Экспресс-диагностика цепочки озвучки: читаем действующие настройки из settings.local.json и реально
 * отправляем по одному запросу синтеза на каждый движок, чтобы понять, дело в «нет настроек»,
 * «неверный ключ» или «сеть/сервис недоступен». Запуск: node test/diagnose-tts.mjs
 * Скрипт действительно обращается к настроенным вами TTS-эндпоинтам (немного запросов и расходов), ключи в выводе маскируются.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateLegacySettings } from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(HERE, "..", "settings.local.json");
const TTS_DEFAULTS = {
	mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", voice: "mimo_default" },
	custom: { baseUrl: "", model: "tts-1", voice: "alloy" },
	edge: { baseUrl: "", model: "", voice: "zh-CN-XiaoxiaoNeural" }
};

const mask = (s) => (s ? `${String(s).slice(0, 6)}…${String(s).slice(-4)} (символов: ${String(s).length})` : "(пусто)");
const slot = (saved, engine) => {
	const s = saved.tts && typeof saved.tts === "object" ? saved.tts[engine] : null;
	return s && typeof s === "object" ? s : {};
};
const pick = (v, dft) => (typeof v === "string" && v.trim() ? v.trim() : dft);
const TEXT = "Это тестовая фраза для синтеза речи";

let raw = {};
try {
	raw = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
} catch {
	console.log(`(файл ${SETTINGS_FILE} не найден — диагностика по значениям по умолчанию)`);
}
const saved = migrateLegacySettings(raw);
const active = saved.ttsEngine || "edge";

console.log("=== Действующие настройки ===");
console.log(`Движок TTS: ${active}`);
for (const engine of ["edge", "mimo", "custom"]) {
	const s = slot(saved, engine);
	console.log(`  [${engine}] baseUrl=${pick(s.baseUrl, TTS_DEFAULTS[engine].baseUrl) || "(пусто)"} model=${pick(s.model, TTS_DEFAULTS[engine].model) || "(пусто)"} voice=${pick(s.voice, TTS_DEFAULTS[engine].voice) || "(пусто)"} apiKey=${mask(pick(s.apiKey, ""))}`);
}
console.log(`Движок ASR: ${saved.asrEngine || "siliconflow"}`);

const out = (name, buf) => {
	const file = path.join(process.env.TEMP || ".", name);
	return writeFile(file, buf).then(() => file);
};

// ---------- 1) Edge TTS ----------
console.log("\n=== 1. Edge TTS (бесплатно у Microsoft) ===");
try {
	const { synthesizeSpeech } = await import("../lib/edge-tts.js");
	const edgeVoice = pick(slot(saved, "edge").voice, "zh-CN-XiaoxiaoNeural");
	const t0 = Date.now();
	const audio = await synthesizeSpeech({ text: TEXT, voice: edgeVoice, rate: "+10%", pitch: "+0Hz" });
	console.log(`  ✓ синтез удался: ${audio.length} байт / ${Date.now() - t0} мс → ${await out("dsh-tts-edge.mp3", audio)}`);
} catch (err) {
	console.log(`  ✗ ошибка: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------- 2) MiMo TTS ----------
console.log("\n=== 2. MiMo TTS (chat/completions) ===");
{
	const s = slot(saved, "mimo");
	const baseUrl = pick(s.baseUrl, TTS_DEFAULTS.mimo.baseUrl);
	const apiKey = pick(s.apiKey, "");
	if (!apiKey) {
		console.log("  ✗ не задан API Key");
	} else {
		const endpoint = /\/chat\/completions\/?$/i.test(baseUrl) ? baseUrl : `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
		console.log(`  эндпоинт: ${endpoint}`);
		try {
			const t0 = Date.now();
			const resp = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", "api-key": apiKey, Authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({
					model: pick(s.model, TTS_DEFAULTS.mimo.model),
					messages: [
						{ role: "user", content: "Синтезируй речь из текста assistant-сообщения" },
						{ role: "assistant", content: TEXT }
					],
					audio: { format: "mp3", voice: pick(s.voice, TTS_DEFAULTS.mimo.voice) }
				})
			});
			const body = await resp.json().catch(() => ({}));
			if (!resp.ok) {
				console.log(`  ✗ HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 400)}`);
			} else {
				const data = body?.choices?.[0]?.message?.audio?.data;
				if (typeof data === "string" && data) {
					const audio = Buffer.from(data, "base64");
					console.log(`  ✓ синтез удался: ${audio.length} байт / ${Date.now() - t0} мс → ${await out("dsh-tts-mimo.mp3", audio)}`);
				} else {
					console.log(`  ✗ в ответе нет аудиоданных: ${JSON.stringify(body).slice(0, 400)}`);
				}
			}
		} catch (err) {
			console.log(`  ✗ запрос не удался: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// ---------- 3) Пользовательский TTS ----------
console.log("\n=== 3. Пользовательский TTS (OpenAI-совместимый /audio/speech) ===");
{
	const s = slot(saved, "custom");
	const baseUrl = pick(s.baseUrl, TTS_DEFAULTS.custom.baseUrl);
	const apiKey = pick(s.apiKey, "");
	if (!baseUrl) {
		console.log("  ✗ не задан Base URL");
	} else {
		const endpoint = `${baseUrl.replace(/\/+$/, "")}/audio/speech`;
		console.log(`  эндпоинт: ${endpoint}`);
		try {
			const t0 = Date.now();
			const headers = { "Content-Type": "application/json" };
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
			const resp = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({ model: pick(s.model, TTS_DEFAULTS.custom.model), input: TEXT, voice: pick(s.voice, TTS_DEFAULTS.custom.voice) })
			});
			if (!resp.ok) {
				const detail = await resp.text().catch(() => "");
				console.log(`  ✗ HTTP ${resp.status}: ${detail.slice(0, 400)}`);
			} else {
				const audio = Buffer.from(await resp.arrayBuffer());
				console.log(`  ✓ синтез удался: ${audio.length} байт / ${Date.now() - t0} мс → ${await out("dsh-tts-custom.mp3", audio)}`);
			}
		} catch (err) {
			console.log(`  ✗ запрос не удался: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// ---------- 4) Проверка локальных портов (пользовательский TTS / ASR) ----------
console.log("\n=== 4. Доступность локальных портов ===");
for (const [label, url] of [
	["Пользовательский TTS", pick(slot(saved, "custom").baseUrl, "")],
	["Пользовательский ASR", typeof saved.asr?.custom?.baseUrl === "string" ? saved.asr.custom.baseUrl : ""]
]) {
	if (!url) continue;
	const probe = url.replace(/\/+$/, "") + "/models";
	try {
		const resp = await fetch(probe, { method: "GET", signal: AbortSignal.timeout(4000) });
		console.log(`  ${label} ${probe} → HTTP ${resp.status}`);
	} catch (err) {
		console.log(`  ${label} ${probe} → не отвечает: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ---------- 5) Живая проверка маршрутов хоста (браузер вызывает именно эти два) ----------
// Прогоняем обработчики /tts и /speak плагина с настоящим settings.local.json: ответ 200 значит,
// что вся цепочка работает; 4xx/5xx — прямая причина, по которой озвучка не звучит.
console.log("\n=== 5. Живая проверка маршрутов (/tts, /speak) ===");
try {
	const { apply } = await import("../lib/index.js");
	const routes = new Map();
	const httpCtx = {
		webServer: { register(entry) { routes.set(entry.path, entry.handler); return () => routes.delete(entry.path); } },
		effect(fn) { return fn(); },
		get() { return undefined; },
		llm: {
			async *stream() {
				yield { type: "text-delta", text: "Это тестовый текст после пересказа" };
				yield { type: "finish", reason: { kind: "stop" } };
			}
		},
		sessions: {}
	};
	apply({ inject(deps, fn) { fn(httpCtx); } }, {});
	const call = async (routePath, req) => {
		const captured = {};
		const res = {
			writeHead(status) { captured.status = status; },
			end(body) { captured.body = body; }
		};
		await routes.get(routePath)(req, res);
		return captured;
	};
	const getReq = (url) => ({ method: "GET", url });
	const postReq = (url, payload) => ({
		method: "POST", url,
		async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload), "utf8"); }
	});
	for (const [label, routePath, req] of [
		["GET /tts", "/dsh-voice-chat/tts", getReq("/dsh-voice-chat/tts?text=" + encodeURIComponent(TEXT))],
		["POST /speak", "/dsh-voice-chat/speak", postReq("/dsh-voice-chat/speak", { text: TEXT })]
	]) {
		const { status, body } = await call(routePath, req);
		if (status === 200 && Buffer.isBuffer(body)) {
			console.log(`  ${label} → 200, аудио ${body.length} байт → ${await out(`dsh-tts-route-${label.includes("speak") ? "speak" : "tts"}.mp3`, body)}`);
		} else {
			let detail = body;
			try { detail = JSON.parse(String(body)).error; } catch { /* показываем как есть */ }
			console.log(`  ${label} → ${status}: ${String(detail).slice(0, 300)}`);
		}
	}
} catch (err) {
	console.log(`  ✗ сбой при проверке маршрутов: ${err instanceof Error ? err.message : String(err)}`);
}
