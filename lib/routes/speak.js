/**
 * Маршруты озвучивания: GET/POST /tts (готовый текст) и POST /speak (текст
 * ответа assistant с опциональным разговорным пересказом через LLM harness).
 *
 * @module dsh-voice-chat/routes/speak
 */

import { BODY_LIMITS, HttpError, MAX_SPEECH_CHARS, json, readBody, route } from "../net.js";
import { cleanForTts } from "../shared.js";
import { rewriteWithHarness } from "../rewrite.js";

export function registerSpeakRoutes(httpCtx, deps) {
	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/tts",
		handler: route(["GET", "POST"], async ({ req, res, url }) => {
			// GET ?text= (короткие тексты) и POST {text} (длинные ответы:
			// в query string они упирались в лимит длины URL прокси/хоста,
			// и озвучка больших ответов молча падала).
			let text = url.searchParams.get("text") ?? "";
			if (req.method === "POST") {
				const raw = Buffer.from(await readBody(req, BODY_LIMITS.speech)).toString("utf8");
				try {
					const body = JSON.parse(raw || "{}");
					if (typeof body?.text === "string") text = body.text;
				} catch {
					// Не JSON — берём как есть (частый случай: text/plain)
					if (raw.trim()) text = raw;
				}
			}
			text = String(text ?? "").trim().slice(0, MAX_SPEECH_CHARS);
			if (!text) {
				throw new HttpError(400, "empty text");
			}
			const saved = await deps.ensureSaved();
			// Очистка перед озвучиванием: убрать markdown/emoji/спецсимволы, сжать повторяющуюся пунктуацию
			const clean = cleanForTts(text);
			await deps.sendSpeech(res, saved, clean || text, url.searchParams.get("voice") ?? "");
		})
	}));

	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/speak",
		handler: route("POST", async ({ req, res }) => {
			let original = "";
			let spoken = "";
			try {
				const raw = Buffer.from(await readBody(req, BODY_LIMITS.speech)).toString("utf8");
				let payload = {};
				try { payload = JSON.parse(raw || "{}"); } catch (err) { /* ignore */ }
				original = String(payload.text ?? "").trim();
				if (!original) {
					throw new HttpError(400, "empty text");
				}
				const saved = await deps.ensureSaved();
				// 1) Выбираем, что читать вслух: только сжатие, никакого разрастания.
				//    - пересказ выключен → читаем оригинал как есть;
				//    - оригинал короткий (<= shortTextChars знаков): короткий
				//      служебный ответ, читаем как есть, не беспокоя LLM;
				//    - оригинал длинный: модель пересказа сжимает и обобщает, но
				//      результат пересказа должен быть короче или равен оригиналу,
				//      иначе возвращаемся к оригиналу.
				// Модель пересказа: сначала provider/model, полученные клиентом из
				// текущего диалога; если клиент ничего не передал — текущая
				// выбранная умолчательная модель главного интерфейса DSH
				// (agentDefaultModel, следует за выбором модели в интерфейсе); и
				// только потом цепочка конфигурации cordis/env. deepseek-official
				// жёстко не зашиваем — в окружении его ключ может быть не настроен
				// вовсе (например, если используется только pi-ai).
				const rewriteSel = deps.resolveRewriteSelection(payload);
				const rewriteProvider = rewriteSel.provider;
				const rewriteModel = rewriteSel.model;
				spoken = original.slice(0, MAX_SPEECH_CHARS);
				if (deps.liveRewrite(saved) && original.length > deps.vc.shortTextChars) {
					try {
						// Сначала пробуем пересказ через LLM самого harness (та же модель, что у агента)
						console.log(`[dsh-voice-chat] speak: rewrite start (original=${original.length} chars, provider=${rewriteProvider}, model=${rewriteModel}, source=${rewriteSel.source})`);
						const rewritten = await rewriteWithHarness({ llm: deps.llm() }, original, rewriteProvider, rewriteModel);
						if (rewritten && rewritten.length <= original.length) {
							spoken = rewritten.slice(0, MAX_SPEECH_CHARS);
							console.log(`[dsh-voice-chat] speak: rewrite ok (${original.length} -> ${rewritten.length} chars)`);
						} else if (rewritten) {
							console.warn(`[dsh-voice-chat] rewrite longer than original (${rewritten.length} > ${original.length}), keep raw`);
						} else {
							console.warn("[dsh-voice-chat] rewrite returned empty, keep raw");
						}
					} catch (error) {
						// При сбое сразу откатываемся к чтению оригинала (внешний LLM больше не используется)
						console.warn("[dsh-voice-chat] harness rewrite failed, read raw:", error instanceof Error ? error.message : String(error));
					}
				} else {
					console.log(`[dsh-voice-chat] speak: raw read (length=${original.length}, rewrite=${deps.liveRewrite(saved)}, threshold=${deps.vc.shortTextChars})`);
				}
				// 2) Очистка перед озвучиванием: убрать markdown/emoji/спецсимволы, сжать повторяющуюся пунктуацию (если после очистки пусто, возвращаем исходный текст)
				const cleaned = cleanForTts(spoken);
				if (cleaned) spoken = cleaned;
				// 3) Синтез текущим движком TTS (у каждого движка своя конфигурация в слоте)
				await deps.sendSpeech(res, saved, spoken, typeof payload.voice === "string" ? payload.voice : "");
			} catch (error) {
				// При сбое синтеза TTS возвращаем «текст, который реально будет
				// прочитан» (пересказ удался → разговорная версия; сбой или
				// выключено → оригинал), чтобы запасной браузерный TTS озвучил
				// именно его, а не непересказанный оригинал.
				const status = error && typeof error === "object" && error.status ? error.status : 500;
				json(res, status, { error: error instanceof Error ? error.message : String(error), spoken });
			}
		})
	}));
}
