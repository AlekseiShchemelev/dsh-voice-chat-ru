/**
 * dsh-voice-chat —— половина хоста.
 *
 * Даёт HTTP-маршрут POST /dsh-voice-chat/stt: принимает записанный браузером через
 * MediaRecorder звук (webm/opus), переадресует его в ASR-интерфейс и возвращает { text }:
 *   - siliconflow (по умолчанию, прямое подключение, SenseVoiceSmall бесплатно) / groq / custom:
 *     OpenAI-совместимый multipart-протокол /audio/transcriptions, webm уходит как есть;
 *   - mimo (Xiaomi MiMo-V2.5-ASR): протокол chat/completions, звук в base64
 *     (data URL) кладётся в input_audio у messages.content, поддерживаются только wav/mp3
 *     (запись в браузере автоматически конвертируется в 16k моно WAV).
 * Если действующий baseUrl заканчивается на /chat/completions, протокол chat подставляется
 * автоматически (правка конфигурации не нужна).
 * Получив текст, браузер отправляет его в сессию через inputActions.
 *
 * Приоритет конфигурации: ⚙️ панель настроек (settings.local.json, меняется в браузере)>
 *   config строки (переопределение в cordis.patch.yml) > переменные окружения > значения по умолчанию.
 *
 * Base URL / модель / ключ / голос ASR и TTS **хранятся раздельно по движкам** (asr.<движок>,
 * tts.<движок>), переключение движков их не перезаписывает; старые плоские ключи
 * (asrBaseUrl/ttsBaseUrl…) при чтении автоматически переезжают в слот своего движка,
 * поэтому обновление проходит незаметно (см. migrateLegacySettings).
 *
 *   - config.asrEngine / env DSH_VOICE_ASR_ENGINE siliconflow | groq | mimo | custom
 *   - config.asr.<движок>.{baseUrl,model,apiKey}      конфигурация ASR, изолированная по движкам
 *   - config.asrApiKey / env DSH_VOICE_ASR_KEY    ключ ASR (старый одиночный слот, действует на текущий движок)
 *   - config.asrBaseUrl / env DSH_VOICE_ASR_BASE_URL (обязателен для custom; для mimo — полный
 *     эндпоинт chat/completions, по умолчанию https://api.xiaomimimo.com/v1/chat/completions)
 *   - config.asrModel   / env DSH_VOICE_ASR_MODEL
 *   - config.ttsEngine  движок TTS: edge | mimo | custom
 *   - config.tts.<движок>.{baseUrl,model,apiKey,voice}      конфигурация TTS, изолированная по движкам
 *   - config.ttsBaseUrl / ttsModel / ttsApiKey / ttsVoice старый одиночный слот, действует на текущий движок
 *   - config.voice / config.rate                           голос и скорость Edge TTS
 *   - config.llmApiKey  / env DSH_VOICE_LLM_KEY   ключ модели пересказа (по умолчанию берётся ключ ASR)
 *   - config.llmBaseUrl / env DSH_VOICE_LLM_BASE_URL
 *   - config.llmModel   / env DSH_VOICE_LLM_MODEL по умолчанию deepseek-v4-flash
 *     (используется как fallback для пересказа вслух, только если клиент не передал
 *     «модель текущего диалога»; по умолчанию идём по модели текущего диалога)
 *
 * Маршруты:
 *   POST /dsh-voice-chat/stt    звук → текст
 *   GET  /dsh-voice-chat/tts    текст → MP3 (читается как есть)
 *   POST /dsh-voice-chat/speak  текст → разговорный пересказ через LLM → MP3 (доклад в духе голосового помощника)
 *   GET  /dsh-voice-chat/settings прочитать текущие действующие настройки (включая ключи, только для локального использования)
 *   POST /dsh-voice-chat/settings сохранить правки панели настроек (пишет settings.local.json)
 *
 *
 * Устройство модулей:
 *   lib/shared.js       константы и чистые функции, общие для сервера и браузера;
 *   lib/settings.js     файл настроек, нормализация, слияние, миграция, разбор config;
 *   lib/net.js          транспорт: исходящие запросы, таймауты, чтение тел, JSON-ответы;
 *   lib/engines/asr.js  распознавание речи (multipart и chat-протокол);
 *   lib/engines/tts.js  синтез речи у внешних движков (OpenAI-совместимый и MiMo);
 *   lib/rewrite.js      разговорный пересказ ответа через LLM harness;
 *   lib/edge-tts.js     синтез через Microsoft Edge TTS;
 *   lib/local-engine.js менеджер локального Python-движка (faster-whisper + Piper);
 *   lib/client.js       браузерная половина (собирается одним файлом — см. её шапку);
 *   lib/index.js        этот файл: apply(), HTTP-маршруты и связывание всего вместе.
 *
 * @module dsh-voice-chat
 */

// Общие константы и чистые функции живут в ./shared.js: ими пользуется и сервер,
// и (копией) браузерная половина. Паритет копий закреплён тестом
// test/shared-parity.test.mjs — иначе списки моделей и порт снова разъедутся.
import {
	ASR_ENGINE_DEFAULTS,
	ASR_ENGINES,
	TTS_ENGINE_DEFAULTS,
	DEFAULT_HOTKEY,
	DEFAULT_LOCAL_PORT,
	LOCAL_ASR_MODELS,
	LOCAL_TTS_VOICES,
	TTS_ENGINES,
	asRecord,
	asText,
	cleanForTts,
	hotkeyFromEvent,
	hotkeyLabel,
	isLocalEngine,
	isValidPiperVoice,
	isValidWhisperModel,
	normalizeAsrEngine,
	normalizeHotkey
} from "./shared.js";

import {
	buildPublicSlots,
	loadSavedSettings,
	localPort,
	migrateLegacySettings,
	mergeSettings,
	resolveAsrConfig,
	resolveLlmModel,
	resolveTtsConfig,
	resolveTtsEngine,
	resolveVoiceConfig,
	sanitizeSettings,
	slotOf,
	writeSettingsAtomic
} from "./settings.js";

import { BODY_LIMITS, HttpError, MAX_SPEECH_CHARS, json, readBody, readJson, route } from "./net.js";
import {
	detectAudioMime,
	parseChatContent,
	parseTranscriptionText,
	transcribe,
	transcribeWithChatAsr
} from "./engines/asr.js";
import { synthesizeByEngine as synthesizeByEngineImpl, synthesizeWithCustomTts, synthesizeWithMimoTts } from "./engines/tts.js";
import { rewriteWithHarness } from "./rewrite.js";

/** Версия плагина (совпадает с package.json; отдаётся в /settings, чтобы проверить, что загружена нужная). */
const VERSION = "0.8.5";

export function apply(ctx, config) {
	const defaultRewriteModel = resolveLlmModel(config); // только как fallback, если клиент не передал модель текущего диалога
	const vc = resolveVoiceConfig(config);    // голос/скорость/длительность тишины/порог короткого текста/переключатель пересказа (значения по умолчанию уровня config строки)
	// ---------- Слой переопределений панели настроек ----------
	let savedSettingsPromise = null;
	const ensureSaved = () => {
		if (!savedSettingsPromise) savedSettingsPromise = loadSavedSettings();
		return savedSettingsPromise;
	};
	/**
	 * Сериализация записи настроек: два параллельных POST /settings оба читали
	 * один и тот же ensureSaved(), оба мержили и оба писали файл — второй
	 * затирал первый. Теперь записи выстраиваются в очередь.
	 */
	let settingsWriteChain = Promise.resolve();
	const saveSettings = (patch) => {
		const task = settingsWriteChain.then(async () => {
			const merged = mergeSettings(await ensureSaved(), patch);
			await writeSettingsAtomic(merged);
			savedSettingsPromise = Promise.resolve(merged); // действует сразу, перезапуск не нужен
			return merged;
		});
		// Ошибка одного сохранения не должна ломать очередь следующих
		settingsWriteChain = task.then(() => {}, () => {});
		return task;
	};
	// Действующая конфигурация ASR = собственный слот этого движка > умолчания config строки/окружения > встроенные значения движка.
	const liveAsr = (saved) => resolveAsrConfig(config, saved);
	const liveSilenceMs = (saved) =>
		Number.isFinite(Number(saved.silenceMs)) && Number(saved.silenceMs) > 0
			? Math.round(Number(saved.silenceMs))
			: vc.silenceMs;
	const liveAutoSend = (saved) => saved.autoSend !== false; // по умолчанию автоотправка включена
	// Запасной ASR-движок для браузерного ("" = выключено)
	const liveAsrFallback = (saved) => {
		const fb = normalizeAsrEngine(asText(asRecord(saved).asrFallback));
		return fb && fb !== "browser" ? fb : "";
	};
	const liveRewrite = (saved) => saved.rewrite === true;    // чтение с пересказом по умолчанию выключено (включается только явным true)
	const liveContinuousMode = (saved) => saved.continuousMode === true;
	// Действующая горячая клавиша: панель настроек > config строки/окружение > встроенное значение; "" = выключено
	const liveHotkey = (saved) => {
		const fromSaved = normalizeHotkey(asText(saved.asrHotkey));
		if (fromSaved !== null) return fromSaved;
		const fromCfg = normalizeHotkey(asText(asRecord(config).hotkey) || process.env.DSH_VOICE_HOTKEY || "");
		if (fromCfg !== null) return fromCfg;
		return DEFAULT_HOTKEY;
	};
	/**
	 * Автозапуск локального Python-сервера перед первым обращением к нему:
	 * выбрал движок «Локальный» → нажал микрофон → всё работает без ручного
	 * нажатия «Запустить». Не установлен — понятная ошибка 400.
	 * Заполняется внутри httpCtx.effect (нужен доступ к локальному менеджеру).
	 */
	let ensureLocalEngine = null;
	// Действующая конфигурация TTS: каждый движок читает только свой слот, переключение движков ничего не перезаписывает.
	const liveTtsEngine = (saved) => resolveTtsEngine(config, saved);
	const liveTts = (saved, engine) =>
		resolveTtsConfig(config, saved, engine ?? liveTtsEngine(saved), vc.voice);
	/**
	 * Синтез заданным движком TTS (общий для /tts и /speak): собирает
	 * конфигурацию слота и делегирует в engines/tts.js. Если ключ MiMo TTS
	 * пуст, берётся ключ из слота «MiMo ASR» (тот же производитель, часто тот
	 * же ключ); ключи других движков ASR не занимаются.
	 */
	const synthesizeByEngine = async (saved, engine, text, voiceOverride) => {
		const tts = liveTts(saved, engine);
		const ratePercent = saved.ratePercent ?? vc.ratePercent;
		return await synthesizeByEngineImpl(text, {
			engine,
			tts,
			voice: asText(voiceOverride) || tts.voice,
			ratePercent,
			mimoAsrApiKey: asText(slotOf(saved, "asr", "mimo").apiKey),
			ensureLocal: ensureLocalEngine
		});
	};
	/** Общий хвост /tts и /speak: синтез текущим движком и отдача аудио. */
	const sendSpeech = async (res, saved, text, voiceOverride) => {
		const engine = liveTtsEngine(saved);
		const audio = await synthesizeByEngine(saved, engine, text, voiceOverride);
		res.writeHead(200, {
			// Piper отдаёт WAV, остальные движки — MP3
			"Content-Type": isLocalEngine(engine) ? "audio/wav" : "audio/mpeg",
			"Content-Length": audio.length,
			"Cache-Control": "no-store"
		});
		res.end(audio);
	};
	/** Действующие слоты по движкам для показа в окне настроек (недостающее дополняем встроенным значением, чтобы пользователь видел, что реально будет использовано). */
const publicSlots = (saved) => buildPublicSlots(config, saved, vc.voice);
	/** Эффективный baseUrl конкретного слота ASR-движка. */
	const asrSlot = (saved, engine) => resolveAsrConfig(config, { ...asRecord(saved), asrEngine: engine }).baseUrl;
	/** Базовый адрес локального движка для маршрутов /local/* (приоритет у ASR-слота). */
	const localSlotUrl = (saved) =>
		asrSlot(saved, "local") || resolveTtsConfig(config, saved, "local").baseUrl;
	// Полный набор действующих настроек наружу (для показа в окне настроек; инструмент для локального использования, ключи возвращаются как есть).
	const publicSettings = (saved) => {
		const asr = liveAsr(saved);
		const ttsEngine = liveTtsEngine(saved);
		const tts = liveTts(saved, ttsEngine);
		const slots = publicSlots(saved);
		return {
			version: VERSION,
			// Настройки распознавания речи (плоские ключи = действующие значения текущего движка, для старых клиентов и совместимости)
			asrEngine: asr.engine,
			asrBaseUrl: asr.baseUrl,
			asrModel: asr.model,
			asrApiKey: asr.apiKey,
			autoSend: liveAutoSend(saved),
			continuousMode: liveContinuousMode(saved),
			silenceMs: liveSilenceMs(saved),
			asrHotkey: liveHotkey(saved),
			// Запасной движок: если выбран browser и он не работает, распознаём через него
			asrFallback: liveAsrFallback(saved),
			// Настройки озвучивания (плоские ключи = действующие значения текущего движка)
			ttsVoice: tts.voice,
			rewrite: liveRewrite(saved),
			ttsEngine,
			ttsBaseUrl: tts.baseUrl,
			ttsModel: tts.model,
			ttsApiKey: tts.apiKey,
			ratePercent: saved.ratePercent ?? vc.ratePercent,
			speechLang: saved.speechLang ?? "ru-RU",
			// Полные слоты с разделением по движкам (новая панель настроек заполняет и сохраняет их отдельно по движкам)
			asrConfig: slots.asr,
			ttsConfig: slots.tts
		};
	};
	// Проблема порядка активации строки: webServer/llm могут быть ещё не готовы,
	// поэтому ждём появления сервисов через ctx.inject (как в хостовой половине
	// официального клиентского пакета, например dsh-client-ui-theme).
	// Сервис agentDefaultModel («модель по умолчанию», синхронизируемая с выбором
	// модели в главном интерфейсе DSH) внедряется опционально: при каждом /speak
	// читается текущий provider/model сессии как запасной вариант для пересказа.
	// Сервис sessions (SessionStore из dsh-session): /latest-message берёт через
	// него сообщения сессии по sessionId (deriveMessages), не сканируя DOM в браузере.
	ctx.inject(["webServer", "llm", "agentDefaultModel", "sessions"], (httpCtx) => {
		// Разбор модели для пересказа: то, что передал клиент (модель текущей сессии) > текущий выбранный умолчательный в главном интерфейсе > цепочка конфигурации
		const resolveRewriteSelection = (payload) => {
			const cp = (typeof payload.llmProvider === "string" && payload.llmProvider.trim()) || "";
			const cm = (typeof payload.llmModel === "string" && payload.llmModel.trim()) || "";
			if (cp && cm) return { provider: cp, model: cm, source: "client" };
			try {
				const adm = httpCtx.get("agentDefaultModel");
				const sel = adm && typeof adm.currentSelection === "function" ? adm.currentSelection() : void 0;
				if (sel && typeof sel.provider === "string" && sel.provider && typeof sel.model === "string" && sel.model) {
					return { provider: sel.provider, model: sel.model, source: "agent-default-model" };
				}
			} catch (err) { /* сервис недоступен: игнорируем и идём по цепочке конфигурации */ }
			return { provider: "deepseek-official", model: defaultRewriteModel, source: "config" };
		};
		httpCtx.effect(() => {
			const disposers = [];
			// Локальный движок (faster-whisper + Piper)
			let localEngine = null;
			// Single-flight создания менеджера: /stt и /speak (в постоянном диалоге
			// приходят внахлёст) оба видели localEngine === null, оба ждали import()
			// и создавали РАЗНЫЕ менеджеры. Последний побеждал, а первый продолжал
			// обслуживать свой запрос с отдельным installPromise/child/activePort —
			// отсюда «сервер не установлен» на ровном месте и двойные старты.
			let localEnginePromise = null;
			/**
			 * Цели локального движка из ЖИВЫХ настроек плагина: какую модель
			 * faster-whisper качать и какой голос Piper. Раньше установщик брал
			 * только cordis-конфиг (там whisperModel не документирован и всегда
			 * пусто), поэтому выбор модели в настройках игнорировался и всегда
			 * скачивался small.
			 */
			const localTargets = (saved) => ({
				whisperModel: asText(slotOf(saved, "asr", "local").model),
				piperVoice: asText(slotOf(saved, "tts", "local").voice)
			});
			const getLocalEngine = async (saved = null) => {
				if (!localEngine) {
					if (!localEnginePromise) {
						localEnginePromise = import("./local-engine.js").then(({ createLocalEngineManager }) => {
							localEngine = createLocalEngineManager(config);
							return localEngine;
						});
						// Неудачный import не должен навсегда «залипнуть»: следующая
						// попытка вправе снова попробовать
						localEnginePromise.catch(() => { localEnginePromise = null; });
					}
					await localEnginePromise;
				}
				// Всегда синхронизируем цели с текущими настройками (дёшево, идемпотентно)
				if (saved) localEngine.setTargets(localTargets(saved));
				return localEngine;
			};
			/** Порт из слота local (127.0.0.1:8765/v1) — чтобы адрес в UI и порт сервера совпадали. */
			/**
			 * Порт из адреса слота (http://127.0.0.1:8765/v1), чтобы адрес в UI
			 * и порт сервера всегда совпадали.
			 */
			const localPortFor = (baseUrl) => localPort(config, baseUrl);
			ensureLocalEngine = async (baseUrl) => {
				const engine = await getLocalEngine(await ensureSaved());
				// Порт — из baseUrl того слота, к которому идёт запрос: у ASR и TTS
				// он может различаться. ensureStarted ничего не поднимает, если на
				// этом порту уже отвечает сервер.
				await engine.ensureStarted(localPortFor(baseUrl));
				return engine.status();
			};
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/status",
				handler: route("GET", async ({ res, url }) => {
					const engine = await getLocalEngine(await ensureSaved());
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
					const status = await engine.status(statusTargets);
					json(res, 200, status);
				})
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/install",
				handler: route("POST", async ({ res, url }) => {
					const saved = await ensureSaved();
					// Цели установки — из настроек (выбранная модель/голос), иначе всегда качался small
					const engine = await getLocalEngine(saved);
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
					if (wantedModel) engine.setTargets({ whisperModel: wantedModel }, true);
					if (wantedVoice) engine.setTargets({ piperVoice: wantedVoice }, true);
					const current = await engine.status();
					if (current.venvReady && current.modelsReady) {
						// Уже установлен — не ждём новых минут, просто поднимаем сервер
						if (!current.serverRunning) {
							await engine.start(current.venvPythonPath, localPortFor(localSlotUrl(saved))).catch((err) => {
								console.error("[dsh-voice-chat] local-engine start failed:", err);
							});
						}
						json(res, 200, { ok: true, alreadyInstalled: true, status: await engine.status() });
						return;
					}
					// Установка идёт в фоне (Python + pip + модели занимают минуты),
					// клиент опрашивает /local/status и видит installing/installStage
					engine.install().catch((err) => {
						console.error("[dsh-voice-chat] local-engine install failed:", err);
					});
					json(res, 200, { ok: true, message: "Установка начата", status: await engine.status() });
				})
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/start",
				handler: route("POST", async ({ res, url }) => {
					const saved = await ensureSaved();
					const engine = await getLocalEngine(saved);
					const status = await engine.status();
					if (!status.venvReady) {
						throw new HttpError(400, "Локальный движок не установлен. Сначала вызовите /local/install");
					}
					// Порт: ?port= из запроса, иначе из слота local (127.0.0.1:8765/v1)
					const port = Number(url.searchParams.get("port")) || localPortFor(localSlotUrl(saved));
					const result = await engine.start(status.venvPythonPath, port);
					json(res, 200, result);
				})
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/stop",
				handler: route("POST", async ({ res }) => {
					await (await getLocalEngine()).stop();
					json(res, 200, { ok: true });
				})
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/remove",
				handler: route("POST", async ({ res, url }) => {
					const engine = await getLocalEngine(await ensureSaved());
					// По умолчанию сносим всё (модели занимают гигабайты);
					// keepModels=true оставляет скачанные модели
					const keepModels = url.searchParams.get("keepModels") === "true";
					const result = await engine.remove({ includeModels: !keepModels });
					json(res, 200, { ok: true, ...result, status: await engine.status() });
				})
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/remove-model",
				handler: route("POST", async ({ res, url }) => {
					const engine = await getLocalEngine(await ensureSaved());
					// Идентификатор приходит из UI — проверяется по реальному списку на диске
					const result = await engine.removeModel(url.searchParams.get("id") ?? "");
					json(res, 200, { ok: true, ...result, status: await engine.status() });
				})
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/download-voice",
				handler: route("POST", async ({ res, url }) => {
					const engine = await getLocalEngine(await ensureSaved());
					const result = await engine.downloadVoice(url.searchParams.get("voice") ?? "");
					json(res, 200, { ok: true, ...result, status: await engine.status() });
				})
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/download-model",
				handler: route("POST", async ({ res, url }) => {
					const saved = await ensureSaved();
					const engine = await getLocalEngine(saved);
					const model = url.searchParams.get("model") || asText(slotOf(saved, "asr", "local").model);
					const result = await engine.downloadModel(model);
					json(res, 200, { ok: true, ...result, status: await engine.status() });
				})
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/config",
				handler: route("GET", async ({ res }) => {
					// Отдаём браузерной половине нечувствительную конфигурацию времени выполнения (длительность тишины и прочее, уже учтённую в слое переопределений панели)
					const saved = await ensureSaved();
					json(res, 200, {
						voice: liveTts(saved, liveTtsEngine(saved)).voice,
						rate: vc.rate,
						ratePercent: saved.ratePercent ?? vc.ratePercent,
						speechLang: saved.speechLang ?? "ru-RU",
						silenceMs: liveSilenceMs(saved),
						shortTextChars: vc.shortTextChars,
						rewrite: liveRewrite(saved),
						continuousMode: liveContinuousMode(saved),
						asrHotkey: liveHotkey(saved),
						asrFallback: liveAsrFallback(saved)
					});
				})
			}));
			// Адаптация к новому DSH: клиент, увидев session.running true→false, вызывает
			// сюда за текстом последнего сообщения assistant (берётся через сервис sessions, без сканирования DOM).
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/latest-message",
				handler: route("GET", async ({ res, url }) => {
					const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
					if (!sessionId) {
						throw new HttpError(400, "missing sessionId");
					}
					const store = httpCtx.sessions;
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
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/settings",
				handler: route(["GET", "POST"], async ({ req, res }) => {
					if (req.method === "GET") {
						const saved = await ensureSaved();
						json(res, 200, publicSettings(saved));
						return;
					}
					// Раньше битое JSON молча превращалось в пустой патч и ответ был
					// {ok:true} — опечатка в теле запроса выглядела как успешное
					// сохранение. Теперь readJson бросает 400.
					const payload = await readJson(req, BODY_LIMITS.settings);
					if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
						throw new HttpError(400, "Тело запроса должно быть JSON-объектом с настройками");
					}
					const merged = await saveSettings(sanitizeSettings(payload));
					json(res, 200, { ok: true, settings: publicSettings(merged) });
				})
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/stt",
				handler: route("POST", async ({ req, res, url }) => {
					const audio = await readBody(req, BODY_LIMITS.audio);
					if (audio.length === 0) {
						throw new HttpError(400, "empty audio body");
					}
					const saved = await ensureSaved();
					// ?engine= — разовое переопределение движка (запасной ASR, когда
					// браузерный Web Speech API не работает); без него берётся настроенный
					const forced = normalizeAsrEngine(url.searchParams.get("engine"));
					const asr = forced ? resolveAsrConfig(config, { ...saved, asrEngine: forced }) : liveAsr(saved);
					// Локальный движок: сервер должен быть поднят (иначе поднимаем сами)
					if (isLocalEngine(asr.engine) && ensureLocalEngine) await ensureLocalEngine(asr.baseUrl);
					const text = await transcribe(audio, asr);
					json(res, 200, { text });
				})
			}));
			disposers.push(httpCtx.webServer.register({
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
					const saved = await ensureSaved();
					// Очистка перед озвучиванием: убрать markdown/emoji/спецсимволы, сжать повторяющуюся пунктуацию
					const clean = cleanForTts(text);
					await sendSpeech(res, saved, clean || text, url.searchParams.get("voice") ?? "");
				})
			}));
			disposers.push(httpCtx.webServer.register({
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
						const saved = await ensureSaved();
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
						const rewriteSel = resolveRewriteSelection(payload);
						const rewriteProvider = rewriteSel.provider;
						const rewriteModel = rewriteSel.model;
						spoken = original.slice(0, MAX_SPEECH_CHARS);
						if (liveRewrite(saved) && original.length > vc.shortTextChars) {
							try {
								// Сначала пробуем пересказ через LLM самого harness (та же модель, что у агента)
								console.log(`[dsh-voice-chat] speak: rewrite start (original=${original.length} chars, provider=${rewriteProvider}, model=${rewriteModel}, source=${rewriteSel.source})`);
								const rewritten = await rewriteWithHarness(httpCtx, original, rewriteProvider, rewriteModel);
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
							console.log(`[dsh-voice-chat] speak: raw read (length=${original.length}, rewrite=${liveRewrite(saved)}, threshold=${vc.shortTextChars})`);
						}
						// 2) Очистка перед озвучиванием: убрать markdown/emoji/спецсимволы, сжать повторяющуюся пунктуацию (если после очистки пусто, возвращаем исходный текст)
						const cleaned = cleanForTts(spoken);
						if (cleaned) spoken = cleaned;
						// 3) Синтез текущим движком TTS (у каждого движка своя конфигурация в слоте)
						await sendSpeech(res, saved, spoken, typeof payload.voice === "string" ? payload.voice : "");
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
			return () => {
				for (const dispose of disposers) {
					try { dispose(); } catch (err) { /* ignore */ }
				}
				if (localEngine) localEngine.stop().catch(() => {});
			};
		}, "dsh-voice-chat: config+stt+tts+speak routes");
	});
}

// ---------- Экспорт для тестов и диагностики (чистые функции, при загрузке хостом никаких побочных эффектов) ----------
//
// Тесты и diagnose-tts импортируют эти функции прямо отсюда, поэтому список
// остаётся плоским façade над модулями: тестам не нужно знать, где что лежит.
export {
	// shared.js
	ASR_ENGINE_DEFAULTS,
	ASR_ENGINES,
	TTS_ENGINE_DEFAULTS,
	TTS_ENGINES,
	DEFAULT_HOTKEY,
	DEFAULT_LOCAL_PORT,
	LOCAL_ASR_MODELS,
	LOCAL_TTS_VOICES,
	cleanForTts,
	hotkeyFromEvent,
	hotkeyLabel,
	isLocalEngine,
	normalizeHotkey,
	// settings.js
	buildPublicSlots,
	localPort,
	migrateLegacySettings,
	mergeSettings,
	resolveAsrConfig,
	resolveTtsConfig,
	resolveTtsEngine,
	sanitizeSettings,
	// engines/asr.js
	detectAudioMime,
	parseChatContent,
	parseTranscriptionText,
	transcribe,
	transcribeWithChatAsr,
	// engines/tts.js
	synthesizeWithCustomTts,
	synthesizeWithMimoTts,
	// net.js
	json,
	readBody
};
