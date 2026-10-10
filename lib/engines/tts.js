/**
 * Синтез речи у внешних движков: OpenAI-совместимый /audio/speech и chat-протокол MiMo.
 *
 * Edge TTS лежит отдельно (lib/edge-tts.js), локальный Piper ходит через тот же
 * /audio/speech, а браузерный движок вообще не обращается к плагину.
 *
 * @module dsh-voice-chat/engines/tts
 */

import { isLocalEngine } from "../shared.js";
import { MAX_SPEECH_CHARS, NO_COMPRESSION_HEADERS, describeResponse, fetchDiagnostic, postJson } from "../net.js";

/**
 * Синтез речи через OpenAI-совместимый интерфейс /audio/speech.
 * @param text - текст для синтеза.
 * @param tts - конфигурация TTS { baseUrl, model, apiKey, voice, engine? }.
 * @returns байты MP3 (Buffer).
 */
export async function synthesizeWithCustomTts(text, tts) {
	if (!tts.baseUrl) {
		const err = new Error("Пользовательский TTS: не настроен Base URL. Откройте Настройки DSH → голосовой чат → Настройки озвучки → TTS Base URL");
		err.status = 400;
		throw err;
	}
	// Локальный Piper ключа не имеет и не требует
	if (!tts.apiKey && !isLocalEngine(tts.engine)) {
		const err = new Error("Пользовательский TTS: не настроен API-ключ. Откройте Настройки DSH → голосовой чат → Настройки озвучки → TTS API Key");
		err.status = 400;
		throw err;
	}
	const model = tts.model || "tts-1";
	const voice = String(tts.voice ?? "").trim() || "alloy";
	const speed = tts.ratePercent ? Math.min(4, Math.max(0.25, tts.ratePercent / 100)) : 1.0;
	const endpoint = `${tts.baseUrl.replace(/\/+$/, "")}/audio/speech`;
	const resp = await fetchDiagnostic(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			// Локальный сервер ключ не проверяет — Authorization просто не шлём
			...(tts.apiKey ? { Authorization: `Bearer ${tts.apiKey}` } : {}),
			...NO_COMPRESSION_HEADERS
		},
		body: JSON.stringify({ model, input: text, voice, speed })
	}, `TTS «${tts.engine || "custom"}» (модель ${model}, голос ${voice})`);
	if (!resp.ok) {
		const raw = await resp.text().catch(() => "");
		let detail = raw.slice(0, 200) || "(пустой ответ)";
		try {
			const body = JSON.parse(raw);
			detail = body?.error?.message ?? JSON.stringify(body);
		} catch { /* не JSON: берём как есть */ }
		const err = new Error(`Ошибка пользовательского TTS-интерфейса ${resp.status}: ${detail}`);
		err.status = 502;
		throw err;
	}
	const arrayBuffer = await resp.arrayBuffer();
	const audio = Buffer.from(arrayBuffer);
	if (audio.length === 0) {
		const err = new Error(`Пользовательский TTS вернул пустой аудиофайл (HTTP ${resp.status} content-type=${resp.headers.get("content-type") || "-"} content-encoding=${resp.headers.get("content-encoding") || "-"})`);
		err.status = 502;
		throw err;
	}
	return audio;
}

/**
 * MiMo TTS (протокол chat/completions, проверено на практике в 2026-09): текст
 * для синтеза кладётся в одно сообщение assistant, параметры звука — в объекте
 * audio (mp3/wav + предустановленный голос); вернувшийся звук в base64 лежит
 * в choices[0].message.audio.data. В baseUrl можно указать базовый адрес
 * (/chat/completions добавится автоматически) либо полный эндпоинт.
 * @param {string} text - текст для синтеза.
 * @param {{baseUrl:string, model:string, apiKey:string, voice?:string}} tts - конфигурация MiMo TTS.
 * @returns байты MP3 (Buffer).
 */
export async function synthesizeWithMimoTts(text, tts) {
	if (!tts.baseUrl) {
		const err = new Error("MiMo TTS: не настроен Base URL. Откройте Настройки DSH → голосовой чат → Настройки озвучки → TTS Base URL");
		err.status = 400;
		throw err;
	}
	if (!tts.apiKey) {
		const err = new Error("MiMo TTS: не настроен API-ключ. Откройте Настройки DSH → голосовой чат → Настройки озвучки → TTS API Key");
		err.status = 400;
		throw err;
	}
	const base = tts.baseUrl.replace(/\/+$/, "");
	const endpoint = CHAT_ASR_URL_RE.test(base) ? base : `${base}/chat/completions`;
	// Голос: предустановленное имя голоса MiMo (mimo_default/冰糖/茉莉/…); если указано имя голоса Edge, оно игнорируется
	const rawVoice = String(tts.voice ?? "").trim();
	const voice = rawVoice && !/Neural$/i.test(rawVoice) ? rawVoice : "mimo_default";
	const result = await postJson(endpoint, {
		"api-key": tts.apiKey,
		Authorization: `Bearer ${tts.apiKey}`
	}, {
		model: tts.model || "mimo-v2.5-tts",
		messages: [
			{ role: "user", content: "Синтезируй текст из сообщения assistant в речь" },
			{ role: "assistant", content: text.slice(0, MAX_SPEECH_CHARS) }
		],
		audio: { format: "mp3", voice }
	});
	const body = result.json;
	if (!result.ok) {
		const detail = Object.keys(asRecord(body)).length > 0
			? (body.error?.message ?? JSON.stringify(body))
			: (result.text.slice(0, 200) || "(пустой ответ)");
		const err = new Error(`Ошибка MiMo TTS-интерфейса ${result.status}: ${detail}`);
		err.status = 502;
		throw err;
	}
	const message = Array.isArray(body.choices) ? body.choices[0]?.message : null;
	const data = message?.audio?.data;
	if (typeof data !== "string" || data === "") {
		const err = new Error(`MiMo TTS не вернул аудиоданные (${describeResponse(result)})`);
		err.status = 502;
		throw err;
	}
	return Buffer.from(data, "base64");
}
