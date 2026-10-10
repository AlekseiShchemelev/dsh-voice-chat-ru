/**
 * Распознавание речи: два протокола.
 *
 *   - OpenAI-совместимый multipart POST /audio/transcriptions (siliconflow, groq, custom, local);
 *   - chat-протокол POST /chat/completions с input_audio (MiMo — принимает только wav/mp3).
 *
 * @module dsh-voice-chat/engines/asr
 */

import { CHAT_ASR_URL_RE, asRecord, asText, isBrowserEngine, isLocalEngine } from "../shared.js";
import { NO_COMPRESSION_HEADERS, fetchDiagnostic, postJson, describeResponse } from "../net.js";

// ---------- ASR: два протокола ----------

/** Определить настоящий формат аудиобайтов: wav (RIFF/WAVE) / mp3 (ID3 или синхронизация кадра) / иначе пусто. */
export function detectAudioMime(buffer) {
	if (buffer.length >= 12) {
		if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WAVE") return "audio/wav";
	}
	if (buffer.length >= 3 && buffer.toString("latin1", 0, 3) === "ID3") return "audio/mpeg";
	// Синхронизация кадра MPEG — всего 2 байта (0xFF + 3 старших бита единицы), не ловитесь на порог >=3
	if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "audio/mpeg";
	return "";
}

/**
 * Распознавание по протоколу chat/completions (Xiaomi MiMo-V2.5-ASR, проверено на практике
 * в 2026-09): звук кладётся как data URL (base64) в input_audio у messages.content,
 * поддерживаются только wav/mp3; авторизация передаётся одновременно через api-key
 * и Bearer (совместимо с обоими способами из официальной документации);
 * распознанный текст лежит в choices[0].message.content.
 */
export async function transcribeWithChatAsr(audioBuffer, asr) {
	const mime = detectAudioMime(audioBuffer);
	if (mime !== "audio/wav" && mime !== "audio/mpeg") {
		const err = new Error("Этот ASR-интерфейс (chat/completions протокол, например MiMo) поддерживает только wav/mp3: обновите страницу, чтобы новый клиент автоматически сконвертировал формат записи");
		err.status = 400;
		throw err;
	}
	const format = mime === "audio/wav" ? "wav" : "mp3";
	const dataUrl = `data:${mime};base64,${audioBuffer.toString("base64")}`;
	const result = await postJson(asr.baseUrl.replace(/\/+$/, ""), {
		"api-key": asr.apiKey,
		Authorization: `Bearer ${asr.apiKey}`
	}, {
		model: asr.model || "mimo-v2.5-asr",
		messages: [{
			role: "user",
			content: [{ type: "input_audio", input_audio: { data: dataUrl, format } }]
		}]
	}, `ASR «${asr.engine}» chat-протокол (модель ${asr.model || "mimo-v2.5-asr"})`);
	const body = result.json;
	if (!result.ok) {
		const detail = typeof body === "object" && body !== null ? (body.error?.message ?? JSON.stringify(body)) : result.text;
		const err = new Error(`Ошибка ASR-интерфейса ${result.status}: ${detail}`);
		err.status = 502;
		throw err;
	}
	if (result.text.trim() === "" || Object.keys(asRecord(body)).length === 0) {
		const err = new Error(`ASR-интерфейс вернул пустой ответ (${describeResponse(result)})`);
		err.status = 502;
		throw err;
	}
	return parseChatContent(body).trim();
}

/**
 * Извлечь текст из тела ответа chat/completions (choices[0].message.content):
 * поддерживается и content-строка, и content в виде массива частей
 * [{type:"text",text}]. При несовпадении структуры возвращается пустая строка
 * (вызывающая сторона сообщает об ошибке).
 */
export function parseChatContent(body) {
	const message = Array.isArray(body?.choices) ? body.choices[0]?.message : null;
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
			.join("");
	}
	return "";
}

/** Вызов ASR для распознавания: протокол выбирается по движку и URL (mimo или адрес, оканчивающийся на /chat/completions → протокол chat; иначе multipart). */
export async function transcribe(audioBuffer, asr) {
	// Браузерный движок распознаёт на стороне браузера (Web Speech API) — запрос
	// сюда попадать не должен вовсе. Раньше он отваливался с «не настроен ключ»,
	// что сбивало с толку: ключ тут ни при чём.
	if (isBrowserEngine(asr.engine)) {
		const err = new Error("Движок «Браузер» распознаёт речь через Web Speech API самого браузера и не обращается к плагину. Если распознавание не работает (Electron, сборки Chromium без Google Speech), выберите движок «Локальный» или сетевой ASR");
		err.status = 400;
		throw err;
	}
	// У локального движка (faster-whisper на 127.0.0.1) ключа нет и он не требуется
	if (!asr.apiKey && !isLocalEngine(asr.engine)) {
		const err = new Error("Не настроен ASR-ключ: откройте Настройки DSH → голосовой чат и укажите API-ключ (или задайте DSH_VOICE_ASR_KEY)");
		err.status = 400;
		throw err;
	}
	if (asr.engine === "mimo" || CHAT_ASR_URL_RE.test(asr.baseUrl || "")) {
		return transcribeWithChatAsr(audioBuffer, asr);
	}
	const form = new FormData();
	form.append("file", new Blob([audioBuffer], { type: "audio/webm" }), "recording.webm");
	form.append("model", asr.model);
	// Язык из настроек: локальный Whisper без него угадывает и часто ошибается
	// (в тестах на русской речи определял en). Пустое значение = автоопределение.
	const lang = asText(asr.language).toLowerCase().split(/[-_]/)[0];
	if (lang) form.append("language", lang);
	const asrUrl = `${asr.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
	const resp = await fetchDiagnostic(asrUrl, {
		method: "POST",
		// Локальный сервер ключ не проверяет — Authorization просто не шлём
		headers: {
			...(asr.apiKey ? { Authorization: `Bearer ${asr.apiKey}` } : {}),
			...NO_COMPRESSION_HEADERS
		},
		body: form
	}, `ASR «${asr.engine}» (модель ${asr.model})`);
	const raw = await resp.text().catch(() => "");
	let body = {};
	try { body = JSON.parse(raw); } catch { body = {}; }
	if (!resp.ok) {
		const detail = typeof body === "object" && body !== null && Object.keys(body).length > 0
			? (body.error?.message ?? JSON.stringify(body))
			: (raw.slice(0, 200) || "(пустой ответ)");
		// 401/403 — это не «движок сломался», а неверный ключ: говорим об этом
		// прямо, иначе в UI это выглядит как случайная ошибка. 409 — локальному
		// движку не хватает модели (её надо скачать в настройках).
		const hint = resp.status === 401 || resp.status === 403
			? " Проверьте API-ключ этого движка в настройках голосового чата."
			: resp.status === 404
				? " Проверьте адрес (Base URL) и имя модели."
				: resp.status === 409
					? " Локальному движку не хватает модели — скачайте её в настройках."
					: "";
		const err = new Error(`Ошибка ASR-интерфейса ${resp.status}: ${detail}${hint}`);
		err.status = 502;
		throw err;
	}
	if (raw.trim() === "") {
		const err = new Error(`ASR-интерфейс вернул пустой ответ (HTTP ${resp.status} content-type=${resp.headers.get("content-type") || "-"})`);
		err.status = 502;
		throw err;
	}
	return parseTranscriptionText(body).trim();
}

/**
 * Извлечь text из тела ответа OpenAI-совместимого /audio/transcriptions
 * (если поля text нет, возвращается пустая строка).
 */
export function parseTranscriptionText(body) {
	if (typeof body !== "object" || body === null) return "";
	return String(body.text ?? "");
}
