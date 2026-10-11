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
 *   lib/routes/*.js     HTTP-маршруты по группам (settings/config, local, stt, speak/tts);
 *   lib/client.js       браузерная половина (собирается одним файлом — см. её шапку);
 *   lib/index.js        этот файл: apply(), зависимости маршрутов и связывание всего вместе.
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
	MASKED_SECRET,
	TTS_ENGINES,
	asRecord,
	asText,
	cleanForTts,
	hotkeyFromEvent,
	hotkeyLabel,
	isLocalEngine,
	isValidPiperVoice,
	isValidWhisperModel,
	maskSecret,
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

import { BODY_LIMITS, HttpError, MAX_SPEECH_CHARS, json, readBody, readJson, route, truncateBody } from "./net.js";
import {
	detectAudioMime,
	parseChatContent,
	parseTranscriptionText,
	transcribe,
	transcribeWithChatAsr
} from "./engines/asr.js";
import { synthesizeByEngine as synthesizeByEngineImpl, synthesizeWithCustomTts, synthesizeWithMimoTts } from "./engines/tts.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerLocalRoutes } from "./routes/local.js";
import { registerSttRoutes } from "./routes/stt.js";
import { registerSpeakRoutes } from "./routes/speak.js";

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
	const maskSlots = (group) => {
		const out = {};
		for (const [engine, slot] of Object.entries(asRecord(group))) {
			out[engine] = { ...asRecord(slot), apiKey: maskSecret(asRecord(slot).apiKey) };
		}
		return out;
	};
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
			asrApiKey: maskSecret(asr.apiKey),
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
			ttsApiKey: maskSecret(tts.apiKey),
			ratePercent: saved.ratePercent ?? vc.ratePercent,
			speechLang: saved.speechLang ?? "ru-RU",
			// Полные слоты с разделением по движкам (новая панель настроек заполняет и сохраняет их отдельно по движкам); секреты замаскированы
			asrConfig: maskSlots(slots.asr),
			ttsConfig: maskSlots(slots.tts)
		};
	};

	// ---------- Локальный движок (faster-whisper + Piper) ----------
	// Single-flight создания менеджера: /stt и /speak (в постоянном диалоге
	// приходят внахлёст) оба видели localEngine === null, оба ждали import()
	// и создавали РАЗНЫЕ менеджеры. Последний побеждал, а первый продолжал
	// обслуживать свой запрос с отдельным installPromise/child/activePort —
	// отсюда «сервер не установлен» на ровном месте и двойные старты.
	let localEngine = null;
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
				localEnginePromise = import("./local-engine.js").then((mod) => {
					localEngine = mod.createLocalEngineManager(config);
					return localEngine;
				});
			}
			localEngine = await localEnginePromise;
		}
		if (saved) localEngine.setTargets(localTargets(saved));
		return localEngine;
	};
	/** Порт из адреса слота (http://127.0.0.1:8765/v1), чтобы адрес в UI и порт сервера всегда совпадали. */
	const localPortFor = (baseUrl) => localPort(config, baseUrl);
	ensureLocalEngine = async (baseUrl) => {
		const engine = await getLocalEngine(await ensureSaved());
		// Порт — из baseUrl того слота, к которому идёт запрос: у ASR и TTS
		// он может различаться. ensureStarted ничего не поднимает, если на
		// этом порту уже отвечает сервер.
		await engine.ensureStarted(localPortFor(baseUrl));
		return engine.status();
	};
	// Разбор модели для пересказа: то, что передал клиент (модель текущей сессии) > текущий выбранный умолчательный в главном интерфейсе > цепочка конфигурации
	const resolveRewriteSelection = (payload) => {
		const cp = (typeof payload.llmProvider === "string" && payload.llmProvider.trim()) || "";
		const cm = (typeof payload.llmModel === "string" && payload.llmModel.trim()) || "";
		if (cp && cm) return { provider: cp, model: cm, source: "client" };
		try {
			const adm = ctx.get("agentDefaultModel");
			const sel = adm && typeof adm.currentSelection === "function" ? adm.currentSelection() : void 0;
			if (sel && typeof sel.provider === "string" && sel.provider && typeof sel.model === "string" && sel.model) {
				return { provider: sel.provider, model: sel.model, source: "agent-default-model" };
			}
		} catch (err) { /* сервис недоступен: игнорируем и идём по цепочке конфигурации */ }
		return { provider: "deepseek-official", model: defaultRewriteModel, source: "config" };
	};
	/**
	 * Общий набор зависимостей маршрутов. Вынесен отдельно, чтобы регистраторы
	 * в lib/routes/*.js не знали о внутренних замыканиях apply().
	 */
	const deps = {
		config,
		vc,
		ensureSaved,
		saveSettings,
		sanitizeSettings,
		normalizeAsrEngine,
		publicSettings,
		liveAsr,
		liveTts,
		liveTtsEngine,
		liveRewrite,
		liveContinuousMode,
		liveHotkey,
		liveAsrFallback,
		liveSilenceMs,
		synthesizeByEngine,
		sendSpeech,
		localEngine: {
			get: getLocalEngine,
			ensureStarted: (baseUrl) => ensureLocalEngine(baseUrl),
			portFor: localPortFor,
			slotUrl: localSlotUrl
		},
		resolveRewriteSelection,
		llm: () => ctx.get("llm"),
		getSessions: () => ctx.get("sessions")
	};
	// Проблема порядка активации строки: webServer может быть ещё не готов,
	// поэтому ждём его через ctx.inject. Остальные сервисы (llm,
	// agentDefaultModel, sessions) опциональны и читаются через ctx.get()
	// в момент запроса, чтобы плагин стартовал и без них. Активация каждого
	// маршрута — отдельным effect внутри соответствующего регистратора.
	ctx.inject(["webServer"], (httpCtx) => {
		registerSettingsRoutes(httpCtx, deps);
		registerLocalRoutes(httpCtx, deps);
		registerSttRoutes(httpCtx, deps);
		registerSpeakRoutes(httpCtx, deps);
		// При выгрузке плагина останавливаем локальный Python-сервер, если он был поднят.
		httpCtx.effect(() => () => {
			if (localEngine) localEngine.stop().catch(() => {});
		}, "dsh-voice-chat: local engine cleanup");
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
	MASKED_SECRET,
	cleanForTts,
	hotkeyFromEvent,
	hotkeyLabel,
	isLocalEngine,
	maskSecret,
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
	// net.js
	truncateBody,
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
