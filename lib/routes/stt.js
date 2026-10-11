/**
 * Маршрут распознавания речи: POST /stt, аудио в теле (до 32 МБ).
 *
 * @module dsh-voice-chat/routes/stt
 */

import { BODY_LIMITS, json, readBody, route } from "../net.js";
import { isLocalEngine } from "../shared.js";
import { transcribe } from "../engines/asr.js";
import { resolveAsrConfig } from "../settings.js";

export function registerSttRoutes(httpCtx, deps) {
	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/stt",
		handler: route("POST", async ({ req, res, url }) => {
			const audio = await readBody(req, BODY_LIMITS.audio);
			const saved = await deps.ensureSaved();
			const forced = deps.normalizeAsrEngine(url.searchParams.get("engine"));
			const asr = forced ? resolveAsrConfig(deps.config, { ...saved, asrEngine: forced }) : deps.liveAsr(saved);
			// Локальный движок: сервер должен быть поднят (иначе поднимаем сами)
			if (isLocalEngine(asr.engine) && deps.localEngine) await deps.localEngine.ensureStarted(asr.baseUrl);
			const text = await transcribe(audio, asr);
			json(res, 200, { text });
		})
	}));
}
