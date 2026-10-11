/**
 * Маршруты настроек и служебной конфигурации:
 *   GET/POST /settings — чтение (секреты замаскированы) и запись переопределений;
 *   GET /config        — нечувствительная конфигурация для браузерной половины;
 *   GET /latest-message — текст последнего ответа assistant через сервис sessions.
 *
 * Каждый маршрут регистрируется своим `effect`, чтобы при перезагрузке хоста
 * снимался ровно он, а не весь пакет целиком.
 *
 * @module dsh-voice-chat/routes/settings
 */

import { BODY_LIMITS, HttpError, json, readJson, route } from "../net.js";

/**
 * @param httpCtx - внедрённый контекст с обязательным webServer.
 * @param deps - общие зависимости apply() (см. lib/index.js).
 */
export function registerSettingsRoutes(httpCtx, deps) {
	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/settings",
		handler: route(["GET", "POST"], async ({ req, res }) => {
			if (req.method === "GET") {
				const saved = await deps.ensureSaved();
				json(res, 200, deps.publicSettings(saved));
				return;
			}
			// Раньше битое JSON молча превращалось в пустой патч и ответ был
			// {ok:true} — опечатка в теле запроса выглядела как успешное
			// сохранение. Теперь readJson бросает 400.
			const payload = await readJson(req, BODY_LIMITS.settings);
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
				throw new HttpError(400, "Тело запроса должно быть JSON-объектом с настройками");
			}
			const merged = await deps.saveSettings(deps.sanitizeSettings(payload));
			json(res, 200, { ok: true, settings: deps.publicSettings(merged) });
		})
	}));

	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/config",
		handler: route("GET", async ({ res }) => {
			// Отдаём браузерной половине нечувствительную конфигурацию времени
			// выполнения (длительность тишины и прочее, уже учтённую в слое
			// переопределений панели).
			const saved = await deps.ensureSaved();
			json(res, 200, {
				voice: deps.liveTts(saved, deps.liveTtsEngine(saved)).voice,
				rate: deps.vc.rate,
				ratePercent: saved.ratePercent ?? deps.vc.ratePercent,
				speechLang: saved.speechLang ?? "ru-RU",
				silenceMs: deps.liveSilenceMs(saved),
				shortTextChars: deps.vc.shortTextChars,
				rewrite: deps.liveRewrite(saved),
				continuousMode: deps.liveContinuousMode(saved),
				asrHotkey: deps.liveHotkey(saved),
				asrFallback: deps.liveAsrFallback(saved)
			});
		})
	}));

	// Адаптация к новому DSH: клиент, увидев session.running true→false, вызывает
	// сюда за текстом последнего сообщения assistant (берётся через сервис
	// sessions, без сканирования DOM).
	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/latest-message",
		handler: route("GET", async ({ res, url }) => {
			const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
			if (!sessionId) {
				throw new HttpError(400, "missing sessionId");
			}
			const store = deps.getSessions();
			const session = typeof store?.get === "function" ? store.get(sessionId) : undefined;
			if (!session || typeof session.deriveMessages !== "function") {
				throw new HttpError(404, "session not found: " + sessionId);
			}
			const messages = session.deriveMessages();
			// Идём с конца в поисках последнего assistant-сообщения с текстовым содержимым
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i];
				if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
				const text = msg.content
					.filter((b) => b && (b.type === "text" || b.kind === "text") && typeof b.text === "string")
					.map((b) => b.text)
					.join("\n")
					.trim();
				if (text) {
					json(res, 200, { text: text.slice(0, 5000) });
					return;
				}
			}
			throw new HttpError(404, "no assistant message with text");
		})
	}));
}
