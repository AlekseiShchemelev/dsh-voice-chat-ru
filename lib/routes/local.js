/**
 * Маршруты локального движка (faster-whisper + Piper):
 *   GET  /local/status          — состояние движка (с предпросмотром целей из UI);
 *   POST /local/install         — установка/запуск;
 *   POST /local/start|stop      — запуск и остановка сервера;
 *   POST /local/remove          — удаление окружения/моделей;
 *   POST /local/remove-model    — удаление одной модели;
 *   POST /local/download-voice  — скачивание голоса Piper;
 *   POST /local/download-model  — скачивание модели faster-whisper.
 *
 * Все ходят через общий менеджер движка (single-flight), который живёт в apply().
 *
 * @module dsh-voice-chat/routes/local
 */

import { HttpError, json, route } from "../net.js";
import { asText, isValidPiperVoice, isValidWhisperModel } from "../shared.js";
import { slotOf } from "../settings.js";

export function registerLocalRoutes(httpCtx, deps) {
	const engine = deps.localEngine;

	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/local/status",
		handler: route("GET", async ({ res, url }) => {
			const mgr = await engine.get(await deps.ensureSaved());
			// Клиент может спрашивать статус о ещё не сохранённом выборе
			// (?model=&voice=): тогда видно, что именно будет ставиться/качаться
			const statusTargets = {};
			const wantedModel = asText(url.searchParams.get("model"));
			const wantedVoice = asText(url.searchParams.get("voice"));
			if (wantedModel && !isValidWhisperModel(wantedModel)) {
				throw new HttpError(400, `Некорректное имя модели: ${wantedModel}`);
			}
			if (wantedVoice && !isValidPiperVoice(wantedVoice)) {
				throw new HttpError(400, `Некорректный голос: ${wantedVoice}`);
			}
			if (wantedModel) statusTargets.whisperModel = wantedModel;
			if (wantedVoice) statusTargets.piperVoice = wantedVoice;
			// Предпросмотр НЕ трогает цели менеджера: раньше опрос статуса
			// (панель делает его раз в 2 с) навсегда оставлял «явный выбор»
			// pickedTargets, и последующая установка/скачивание шли не по
			// сохранённым настройкам, а по случайно подсмотренному в UI
			// несохранённому значению. Переопределение теперь передаётся
			// только в этот вызов status().
			const status = await mgr.status(statusTargets);
			json(res, 200, status);
		})
	}));

	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/local/install",
		handler: route("POST", async ({ res, url }) => {
			const saved = await deps.ensureSaved();
			// Цели установки — из настроек (выбранная модель/голос), иначе всегда качался small
			const mgr = await engine.get(saved);
			// Пользователь мог выбрать модель в форме, но ещё не нажать «Сохранить».
			// Тогда цели из файла устарели, и кнопка «Установить» скачала бы не ту
			// модель, что показана в списке. Поэтому явный выбор из UI — приоритетнее.
			const wantedModel = asText(url.searchParams.get("model"));
			const wantedVoice = asText(url.searchParams.get("voice"));
			if (wantedModel && !isValidWhisperModel(wantedModel)) {
				throw new HttpError(400, `Некорректное имя модели: ${wantedModel}`);
			}
			if (wantedVoice && !isValidPiperVoice(wantedVoice)) {
				throw new HttpError(400, `Некорректный голос: ${wantedVoice}`);
			}
			if (wantedModel) mgr.setTargets({ whisperModel: wantedModel }, true);
			if (wantedVoice) mgr.setTargets({ piperVoice: wantedVoice }, true);
			const current = await mgr.status();
			if (current.venvReady && current.modelsReady) {
				// Уже установлен — не ждём новых минут, просто поднимаем сервер
				if (!current.serverRunning) {
					await mgr.start(current.venvPythonPath, engine.portFor(engine.slotUrl(saved))).catch((err) => {
						console.error("[dsh-voice-chat] local-engine start failed:", err);
					});
				}
				json(res, 200, { ok: true, alreadyInstalled: true, status: await mgr.status() });
				return;
			}
			// Установка идёт в фоне (Python + pip + модели занимают минуты),
			// клиент опрашивает /local/status и видит installing/installStage
			mgr.install().catch((err) => {
				console.error("[dsh-voice-chat] local-engine install failed:", err);
			});
			json(res, 200, { ok: true, message: "Установка начата", status: await mgr.status() });
		})
	}));

	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/local/start",
		handler: route("POST", async ({ res, url }) => {
			const saved = await deps.ensureSaved();
			const mgr = await engine.get(saved);
			const status = await mgr.status();
			if (!status.venvReady) {
				throw new HttpError(400, "Локальный движок не установлен. Сначала вызовите /local/install");
			}
			// Порт: ?port= из запроса, иначе из слота local (127.0.0.1:8765/v1)
			const port = Number(url.searchParams.get("port")) || engine.portFor(engine.slotUrl(saved));
			const result = await mgr.start(status.venvPythonPath, port);
			json(res, 200, result);
		})
	}));

	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/local/stop",
		handler: route("POST", async ({ res }) => {
			await (await engine.get()).stop();
			json(res, 200, { ok: true });
		})
	}));

	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/local/remove",
		handler: route("POST", async ({ res, url }) => {
			const mgr = await engine.get(await deps.ensureSaved());
			// По умолчанию сносим всё (модели занимают гигабайты);
			// keepModels=true оставляет скачанные модели
			const keepModels = url.searchParams.get("keepModels") === "true";
			const result = await mgr.remove({ includeModels: !keepModels });
			json(res, 200, { ok: true, ...result, status: await mgr.status() });
		})
	}));

	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/local/remove-model",
		handler: route("POST", async ({ res, url }) => {
			const mgr = await engine.get(await deps.ensureSaved());
			// Идентификатор приходит из UI — проверяется по реальному списку на диске
			const result = await mgr.removeModel(url.searchParams.get("id") ?? "");
			json(res, 200, { ok: true, ...result, status: await mgr.status() });
		})
	}));

	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/local/download-voice",
		handler: route("POST", async ({ res, url }) => {
			const mgr = await engine.get(await deps.ensureSaved());
			const result = await mgr.downloadVoice(url.searchParams.get("voice") ?? "");
			json(res, 200, { ok: true, ...result, status: await mgr.status() });
		})
	}));

	httpCtx.effect(() => httpCtx.webServer.register({
		kind: "exact",
		path: "/dsh-voice-chat/local/download-model",
		handler: route("POST", async ({ res, url }) => {
			const saved = await deps.ensureSaved();
			const mgr = await engine.get(saved);
			const model = url.searchParams.get("model") || asText(slotOf(saved, "asr", "local").model);
			const result = await mgr.downloadModel(model);
			json(res, 200, { ok: true, ...result, status: await mgr.status() });
		})
	}));
}
