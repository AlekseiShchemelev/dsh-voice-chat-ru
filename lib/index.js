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
 * @module dsh-voice-chat
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Общие константы и чистые функции живут в ./shared.js: ими пользуется и сервер,
// и (копией) браузерная половина. Паритет копий закреплён тестом
// test/shared-parity.test.mjs — иначе списки моделей и порт снова разъедутся.
import {
	ASR_ENGINE_DEFAULTS,
	ASR_ENGINES,
	DEFAULT_HOTKEY,
	DEFAULT_LOCAL_PORT,
	LOCAL_ASR_MODELS,
	LOCAL_TTS_VOICES,
	MIMO_TTS_VOICES,
	SLOT_FIELDS,
	TTS_ENGINE_DEFAULTS,
	TTS_ENGINES,
	asRecord,
	asText,
	cleanForTts,
	hotkeyFromEvent,
	hotkeyLabel,
	isBrowserEngine,
	isLocalEngine,
	normalizeAsrEngine,
	normalizeHotkey,
	normalizeTtsEngine
} from "./shared.js";

/** Версия плагина (синхронизируется вручную с package.json; возвращается в /settings, чтобы убедиться, что хост загрузил новую сборку). */
const VERSION = "0.8.0";

/** Порт локального сервера: адрес слота (127.0.0.1:8765/v1) > config.local.port > 8765. */
function localPort(config, slotBaseUrl) {
	const fromUrl = /127\.0\.0\.1:(\d+)|localhost:(\d+)/.exec(String(slotBaseUrl ?? ""));
	if (fromUrl) return Number(fromUrl[1] ?? fromUrl[2]);
	const cfgPort = Number(asRecord(asRecord(config).local).port);
	if (cfgPort > 0) return cfgPort;
	const envPort = Number(process.env.DSH_VOICE_LOCAL_PORT);
	return envPort > 0 ? envPort : DEFAULT_LOCAL_PORT;
}


/**
 * Разбор конфигурации ASR (слот этого движка в панели настроек > слот этого
 * движка в config строки > старые плоские ключи config > переменные окружения >
 * встроенные значения движка). Каждый движок читает только свой слот.
 * @param {object} config - config строки cordis.
 * @param {object} [saved] - настройки панели из settings.local.json (уже в новой структуре).
 */
function resolveAsrConfig(config, saved) {
	const cfg = asRecord(config);
	const engine = normalizeAsrEngine(asRecord(saved).asrEngine)
		|| normalizeAsrEngine(cfg.asrEngine)
		|| normalizeAsrEngine(process.env.DSH_VOICE_ASR_ENGINE)
		|| "siliconflow";
	const dft = ASR_ENGINE_DEFAULTS[engine];
	const slot = slotOf(saved, "asr", engine);
	const cfgSlot = asRecord(asRecord(cfg.asr)[engine]);
	const pick = (field, flatKey, envKey, fallback) =>
		asText(slot[field]) || asText(cfgSlot[field]) || asText(cfg[flatKey])
		|| asText(process.env[envKey]) || fallback;
	return {
		engine,
		baseUrl: pick("baseUrl", "asrBaseUrl", "DSH_VOICE_ASR_BASE_URL", dft.baseUrl),
		model: pick("model", "asrModel", "DSH_VOICE_ASR_MODEL", dft.model),
		apiKey: pick("apiKey", "asrApiKey", "DSH_VOICE_ASR_KEY", ""),
		// Язык распознавания из общих настроек речи (ru-RU → ru); нужен локальному
		// движку, сетевым уходит лишним полем и там игнорируется.
		// Если в настройках он не задан (null/absent) — берём тот же дефолт ru-RU,
		// который отдаёт publicSettings. Раньше здесь был просто asText(...), и
		// выбранный в UI язык до faster-whisper не доезжал: он угадывал язык сам
		// и на русской речи стабильно определял en.
		language: (asText(asRecord(saved).speechLang) || asText(cfg.speechLang) || "ru-RU")
			.toLowerCase().split(/[-_]/)[0]
	};
}

/**
 * Действующие слоты «по движкам» для показа в окне настроек: и asr, и tts
 * выдаются по одной копии на движок (недостающее дополняем встроенным
 * значением по умолчанию, чтобы пользователь видел, что движок реально
 * использует). Соответствуют слотам в saved один в один, не смешиваются.
 */
function buildPublicSlots(config, saved, edgeVoiceFallback) {
	const asr = {};
	for (const engine of Object.keys(ASR_ENGINE_DEFAULTS)) {
		const slot = resolveAsrConfig(config, { ...asRecord(saved), asrEngine: engine });
		asr[engine] = { baseUrl: slot.baseUrl, model: slot.model, apiKey: slot.apiKey };
	}
	const tts = {};
	for (const engine of TTS_ENGINES) {
		tts[engine] = resolveTtsConfig(config, saved, engine, edgeVoiceFallback);
	}
	return { asr, tts };
}

/** Действующий движок TTS: панель настроек > config строки > edge. */
function resolveTtsEngine(config, saved) {
	return normalizeTtsEngine(asRecord(saved).ttsEngine)
		|| normalizeTtsEngine(asRecord(config).ttsEngine)
		|| "edge";
}

/**
 * Разбор действующей конфигурации «одного движка TTS»:
 *   слот этого движка в панели настроек > слот этого движка в config строки
 *   > старые плоские ключи в config строки > встроенное значение движка.
 *   Каждый движок читает только свой слот, переключение движков не мешает конфигурации.
 * @param {object} config - config строки cordis.
 * @param {object} [saved] - настройки панели из settings.local.json (уже в новой структуре).
 * @param {string} engine - edge | mimo | custom.
 * @param {string} [edgeVoiceFallback] - запасной голос Edge (voice из cordis, по умолчанию Сяосяо).
 */
function resolveTtsConfig(config, saved, engine, edgeVoiceFallback) {
	const cfg = asRecord(config);
	const dft = TTS_ENGINE_DEFAULTS[engine] ?? TTS_ENGINE_DEFAULTS.edge;
	const slot = slotOf(saved, "tts", engine);
	const cfgSlot = asRecord(asRecord(cfg.tts)[engine]);
	const pick = (field, flatKey, fallback) =>
		asText(slot[field]) || asText(cfgSlot[field]) || asText(cfg[flatKey]) || fallback;
	return {
		engine,
		baseUrl: pick("baseUrl", "ttsBaseUrl", dft.baseUrl),
		model: pick("model", "ttsModel", dft.model),
		apiKey: pick("apiKey", "ttsApiKey", ""),
		voice: pick("voice", "ttsVoice",
			engine === "edge" ? (asText(edgeVoiceFallback) || dft.voice) : dft.voice)
	};
}

/**
 * Разбор конфигурации «модели пересказа»: используется как fallback, только
 * если клиент не передал «модель текущего диалога». По умолчанию
 * deepseek-v4-flash (та же, что у агента); переопределяется через
 * config.llmModel в строке cordis или переменную окружения DSH_VOICE_LLM_MODEL.
 * Обычно пересказ идёт по модели текущего диалога и сюда не заходит.
 */
function resolveLlmModel(config) {
	const cfg = config ?? {};
	return typeof cfg.llmModel === "string" && cfg.llmModel.trim()
		? cfg.llmModel.trim()
		: (process.env.DSH_VOICE_LLM_MODEL?.trim() || "deepseek-v4-flash");
}

// ---------- Горячая клавиша запуска распознавания ----------
// По умолчанию — правый Ctrl: его удобно держать большим пальцем, не отпуская
// мышь, и он не конфликтует с Ctrl+C/Ctrl+V (левый Ctrl).
/**
 * Разбор конфигурации «озвучивание/интерактив»: голос, скорость, длительность
 * тишины, порог короткого текста, переключатель пересказа.
 * Всё переопределяется через config строки voice-chat в cordis.patch.yml (значения по умолчанию ниже).
 */
function resolveVoiceConfig(config) {
	const cfg = config ?? {};
	const num = (v, fallback) => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
	};
	const ratePercent = num(cfg.ratePercent, 110);
	return {
		voice: typeof cfg.voice === "string" && cfg.voice.trim() ? cfg.voice.trim() : "ru-RU-SvetlanaNeural",
		rate: typeof cfg.rate === "string" && cfg.rate.trim() ? cfg.rate.trim() : `${ratePercent >= 100 ? "+" : ""}${ratePercent - 100}%`,
		ratePercent,
		silenceMs: num(cfg.silenceMs, 2500),
		shortTextChars: num(cfg.shortTextChars, 50),
		rewrite: cfg.rewrite === true,
		hotkey: typeof cfg.hotkey === "string" && cfg.hotkey.trim() ? cfg.hotkey.trim() : DEFAULT_HOTKEY
	};
}

// ---------- Панель настроек: сохранение в settings.local.json ----------
// Настройки, изменённые в окне ⚙️ браузера, пишутся в settings.local.json в корне
// плагина (в git не попадают). Сохраняются только «явно заданные» ключи: пустые
// и незаданные поля по-прежнему откатываются к config строки > переменные окружения >
// встроенное значение по умолчанию.
//
// Структура (v0.4+) — у ASR/TTS свой отдельный слот на каждый движок, переключение
// движков ничего не перезаписывает:
//   {
//     "asrEngine": "custom", "ttsEngine": "mimo",
//     "autoSend": false, "silenceMs": 2000, "rewrite": true,
//     "asr": { "siliconflow": {baseUrl,model,apiKey}, "groq": {...}, "mimo": {...}, "custom": {...} },
//     "tts": { "edge": {voice}, "mimo": {baseUrl,model,apiKey,voice}, "custom": {baseUrl,model,apiKey,voice} }
//   }
// В старой версии (≤0.3.x) ASR/TTS хранились плоскими ключами (asrBaseUrl/ttsBaseUrl/ttsVoice…),
// и переключение движков перезаписывало их (настройки смешивались); при чтении
// migrateLegacySettings один раз переносит их в новую структуру.
/**
 * Файл настроек. Путь переопределяется переменной окружения
 * DSH_VOICE_SETTINGS_FILE — это обязательный путь для тестов: иначе прогон
 * тестов пишет мусор (случайные порты 127.0.0.1:NNNNN, случайные движки) в
 * боевой конфиг, и реальное распознавание у пользователя ломается.
 */
const DEFAULT_SETTINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "settings.local.json");
const SETTINGS_FILE = process.env.DSH_VOICE_SETTINGS_FILE
	? path.resolve(process.env.DSH_VOICE_SETTINGS_FILE)
	: DEFAULT_SETTINGS_FILE;

/** Старые плоские ключи (для миграции и очистки). */
const LEGACY_FLAT_KEYS = [
	"asrBaseUrl", "asrModel", "asrApiKey",
	"ttsBaseUrl", "ttsModel", "ttsApiKey", "ttsVoice"
];

/** Слот заданного движка в группе (asr/tts); при отсутствии или порче — пустой объект. */
function slotOf(saved, group, engine) {
	return asRecord(asRecord(asRecord(saved)[group])[engine]);
}

/** Глубокая копия группы слотов (чтобы не менять объект вызывающей стороны). */
function cloneSlots(group) {
	const out = {};
	for (const [engine, slot] of Object.entries(asRecord(group))) {
		out[engine] = { ...asRecord(slot) };
	}
	return out;
}

/**
 * Старые плоские настройки → структура с разделением по движкам (идемпотентно;
 * уже существующие слоты важнее, новая структура не перезаписывается).
 * В старом файле baseUrl/model/apiKey могут принадлежать только «одному»
 * движку, определяем по следующим признакам:
 *   - ASR: baseUrl заканчивается на /chat/completions → mimo; иначе текущему
 *     выбранному движку ASR;
 *   - реквизиты TTS: в URL/модели есть mimo → mimo; иначе текущему выбранному
 *     движку TTS (если выбран edge — пользовательскому TTS, ведь edge не нужны
 *     реквизиты);
 *   - голос TTS: заканчивается на Neural → edge; предустановленный голос MiMo →
 *     mimo; иначе пользовательскому TTS.
 */
function migrateLegacySettings(raw) {
	const src = asRecord(raw);
	const asr = cloneSlots(src.asr);
	const tts = cloneSlots(src.tts);
	const asrEngine = normalizeAsrEngine(src.asrEngine);
	const ttsEngine = normalizeTtsEngine(src.ttsEngine) || "edge";
	// Плоские ключи ASR → слот
	if (["asrBaseUrl", "asrModel", "asrApiKey"].some((key) => asText(src[key]))) {
		const owner = CHAT_ASR_URL_RE.test(asText(src.asrBaseUrl)) ? "mimo" : (asrEngine || "siliconflow");
		if (asr[owner] === undefined) {
			asr[owner] = {
				baseUrl: asText(src.asrBaseUrl),
				model: asText(src.asrModel),
				apiKey: asText(src.asrApiKey)
			};
		}
	}
	// Плоские реквизиты TTS → слот
	if (["ttsBaseUrl", "ttsModel", "ttsApiKey"].some((key) => asText(src[key]))) {
		const hint = `${asText(src.ttsBaseUrl)} ${asText(src.ttsModel)}`;
		const owner = ttsEngine !== "edge" ? ttsEngine : (/mimo/i.test(hint) ? "mimo" : "custom");
		if (tts[owner] === undefined) {
			tts[owner] = {
				baseUrl: asText(src.ttsBaseUrl),
				model: asText(src.ttsModel),
				apiKey: asText(src.ttsApiKey)
			};
		}
	}
	// Плоский голос TTS → слот
	const voice = asText(src.ttsVoice);
	if (voice) {
		let owner;
		if (/Neural$/i.test(voice)) owner = "edge";
		else if (MIMO_TTS_VOICES.includes(voice)) owner = "mimo";
		else if (tts.custom !== undefined || ttsEngine === "custom") owner = "custom";
		else if (ttsEngine === "edge") owner = "edge";
		// mimo/local/browser: голос достаётся текущему выбранному движку (старая
		// логика всегда писала в edge, из-за чего локальный голос piper попадал
		// в слот Edge, и озвучка Edge получала недопустимый голос)
		else owner = ttsEngine;
		if (!asText(asRecord(tts[owner]).voice)) {
			tts[owner] = { ...asRecord(tts[owner]), voice };
		}
	}
	return { ...src, asr, tts };
}

/** Убрать старые плоские ключи (для записи на диск: в файле остаётся только новая структура с разделением по движкам). */
function withoutLegacyFlat(settings) {
	const out = { ...settings };
	for (const key of LEGACY_FLAT_KEYS) delete out[key];
	return out;
}

/**
 * Чтение локально сохранённых настроек; если файла нет или он повреждён,
 * возвращается пустая структура. Старая плоская структура мигрируется в новую
 * с разделением по движкам и **заодно сразу записывается обратно** (идемпотентно),
 * чтобы не мигрировать при каждом запуске и чтобы пользователь мог просто
 * посмотреть файл и убедиться в конфигурации.
 */
async function loadSavedSettings() {
	let parsed = null;
	try {
		parsed = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
	} catch {
		return { asr: {}, tts: {} };
	}
	if (!parsed || typeof parsed !== "object") return { asr: {}, tts: {} };
	const migrated = migrateLegacySettings(parsed);
	if (LEGACY_FLAT_KEYS.some((key) => key in parsed)) {
		try {
			await writeFile(SETTINGS_FILE, JSON.stringify(withoutLegacyFlat(migrated), null, "\t") + "\n", "utf8");
			console.log("[dsh-voice-chat] старые плоские настройки мигрированы в структуру с отдельными слотами по движкам (asr/tts)");
		} catch (err) {
			console.warn("[dsh-voice-chat] не удалось записать мигрированные настройки (в памяти уже применены):", err instanceof Error ? err.message : String(err));
		}
	}
	return migrated;
}

/**
 * Нормализация одного патча настроек: остаются только явно переданные ключи.
 * silenceMs зажимается в 300~15000 мс (недопустимое значение считается незаданным);
 * autoSend/rewrite приводятся к булеву; строковые поля сохраняются после trim
 * (пустая строка = снять переопределение, вернётся значение по умолчанию).
 * asr/tts нормализуются по слотам движков, остаются только известные движки и
 * известные поля; старые плоские ключи (их всё ещё присылают старые клиенты)
 * сохраняются как есть, mergeSettings относит их к «текущему выбранному движку»,
 * и в файле их больше не остаётся.
 * asrEngine принимает только siliconflow/groq/mimo/custom; ttsEngine — только
 * "edge", "mimo" или "custom", недопустимое значение откатывается к "edge".
 */
function sanitizeSettings(input) {
	const src = asRecord(input);
	const out = {};
	// Настройки распознавания речи
	if ("asrEngine" in src) out.asrEngine = normalizeAsrEngine(src.asrEngine) || "siliconflow";
	if ("autoSend" in src) out.autoSend = src.autoSend !== false && src.autoSend !== "false";
	if ("continuousMode" in src) out.continuousMode = src.continuousMode !== false && src.continuousMode !== "false";
	if ("silenceMs" in src) out.silenceMs = clampNumber(src.silenceMs, 300, 15000);
	// Клавиша/сочетание для запуска распознавания (пустая строка = выключено); недопустимое значение откатывается к умолчанию
	if ("asrFallback" in src) {
		const fb = normalizeAsrEngine(src.asrFallback);
		// browser как запасной не годится (он и есть основной), пусто = выключено
		out.asrFallback = fb && fb !== "browser" ? fb : "";
	}
	if ("asrHotkey" in src) {
		const combo = normalizeHotkey(src.asrHotkey);
		out.asrHotkey = combo === null ? DEFAULT_HOTKEY : combo;
	}
	// Настройки озвучивания
	if ("rewrite" in src) out.rewrite = src.rewrite !== false && src.rewrite !== "false";
	if ("ttsEngine" in src) out.ttsEngine = normalizeTtsEngine(src.ttsEngine) || "edge";
	if ("ratePercent" in src) out.ratePercent = clampNumber(src.ratePercent, 50, 200);
	if ("speechLang" in src) {
		const lang = String(src.speechLang).trim();
		out.speechLang = ["ru-RU", "zh-CN", "en-US", "ja-JP"].includes(lang) ? lang : null;
	}
	// Слоты с разделением по движкам (новая структура)
	if ("asr" in src) out.asr = sanitizeSlots(src.asr, "asr");
	if ("tts" in src) out.tts = sanitizeSlots(src.tts, "tts");
	// Старые плоские ключи (совместимость со старыми клиентами и ручной конфигурацией)
	for (const key of LEGACY_FLAT_KEYS) {
		if (key in src) out[key] = asText(src[key]);
	}
	return out;
}

/**
 * Нормализация числовой настройки: пустое значение (null/undefined/пустая строка/
 * нечисловая строка) всегда считается «не задано» и возвращает null
 * (слой разбора откатит его к умолчанию), остальное округляется и зажимается
 * в [min, max]. Старая реализация просто делала Number(v): Number(null)=0 →
 * значение зажималось к нижней границе (silenceMs 300 / rate 50%), то есть
 * «очистить» превращалось в «поставить минимальное».
 */
function clampNumber(value, min, max) {
	if (value === null || value === undefined || typeof value === "boolean") return null;
	if (typeof value === "string" && value.trim() === "") return null;
	const n = Math.round(Number(value));
	if (!Number.isFinite(n)) return null;
	return Math.min(max, Math.max(min, n));
}

/** Нормализация патча слотов asr/tts по движкам: остаются только известные движки и известные поля. */
function sanitizeSlots(input, group) {
	const src = asRecord(input);
	const engines = group === "asr" ? Object.keys(ASR_ENGINE_DEFAULTS) : TTS_ENGINES;
	const out = {};
	for (const engine of engines) {
		if (!(engine in src)) continue;
		const slot = asRecord(src[engine]);
		const clean = {};
		for (const field of SLOT_FIELDS[group]) {
			if (field in slot) clean[field] = asText(slot[field]);
		}
		out[engine] = clean;
	}
	return out;
}

/** Извлечь из патча старые плоские ключи → поля слота (asrBaseUrl → baseUrl). */
function flatPatchToSlot(patch, group) {
	const out = {};
	const fields = group === "tts" ? SLOT_FIELDS.tts : SLOT_FIELDS.asr;
	for (const field of fields) {
		const flatKey = `${group}${field[0].toUpperCase()}${field.slice(1)}`;
		if (flatKey in patch) out[field] = patch[flatKey];
	}
	return out;
}

/**
 * Слияние одного патча настроек (вызывается перед сохранением):
 *   - asr/tts сливаются глубоко по движкам: перезаписываются только движки,
 *     присутствующие в патче, остальные остаются как есть;
 *   - старые плоские ключи относятся к слоту «текущего выбранного движка»
 *     (edge не нужны реквизиты, он принимает только голос);
 *   - в результате слияния старых плоских ключей не остаётся.
 */
function mergeSettings(savedRaw, patch) {
	const saved = migrateLegacySettings(savedRaw);
	const out = { ...saved, ...patch };
	const groups = cloneSlots({ asr: saved.asr, tts: saved.tts });
	for (const group of ["asr", "tts"]) {
		if (!patch[group]) continue;
		for (const [engine, slot] of Object.entries(patch[group])) {
			groups[group][engine] = { ...asRecord(groups[group][engine]), ...slot };
		}
	}
	// Старые плоские ключи → слот текущего движка
	const asrEngine = normalizeAsrEngine(out.asrEngine)
		|| normalizeAsrEngine(saved.asrEngine) || "siliconflow";
	const asrFlat = flatPatchToSlot(patch, "asr");
	if (Object.keys(asrFlat).length > 0) {
		groups.asr[asrEngine] = { ...asRecord(groups.asr[asrEngine]), ...asrFlat };
	}
	const ttsEngine = normalizeTtsEngine(out.ttsEngine)
		|| normalizeTtsEngine(saved.ttsEngine) || "edge";
	const ttsFlat = flatPatchToSlot(patch, "tts");
	if (ttsEngine === "edge") {
		delete ttsFlat.baseUrl;
		delete ttsFlat.model;
		delete ttsFlat.apiKey;
	}
	if (Object.keys(ttsFlat).length > 0) {
		groups.tts[ttsEngine] = { ...asRecord(groups.tts[ttsEngine]), ...ttsFlat };
	}
	out.asr = groups.asr;
	out.tts = groups.tts;
	for (const key of LEGACY_FLAT_KEYS) delete out[key];
	return out;
}

// ---------- Общая часть исходящих запросов ----------
/**
 * Все исходящие запросы несут `Accept-Encoding: identity` (просим сервер не сжимать).
 * Повод: в процессе хоста на практике наблюдалось, что «body сжатого ответа
 * (gzip/chunked) съедался в пустоту» — тот же API и тот же ключ внутри хоста давали
 * `в ответе нет аудиоданных: {}`, а при прямом подключении мимо хоста всё работало
 * (страницы 404 от openresty у MiMo TTS/ASR и у производителей — это gzip, тогда
 * как 401 от siliconflow и открытый текст httpbin читаются нормально). Ответы
 * этих интерфейсов и так всего несколько десятков KB, так что отказ от сжатия
 * ничего не теряет, зато цепочка перестаёт зависеть от неизвестного поведения
 * распаковки ответов в процессе хоста.
 */
const NO_COMPRESSION_HEADERS = { "Accept-Encoding": "identity" };

/**
 * Сколько символов текста реально уходит в синтез речи. Раньше лимит жил в
 * четырёх местах и различался (/tts — 2000, /speak — 2000, MiMo TTS — 2000),
 * из-за чего длинный ответ молча обрезался на середине и озвучивался не полностью.
 */
const MAX_SPEECH_CHARS = 4000;

/**
 * fetch, который не превращает сетевую ошибку в бесполезное «fetch failed».
 *
 * Раньше TypeError от undici пролетал мимо всех обработчиков, и маршрут отвечал
 * 500 с текстом «fetch failed»: в консоли не было ни адреса, ни модели, ни
 * подсказки. Почти всегда это ровно три вещи — не поднялся локальный сервер
 * (порт в настройках разошёлся с запущенным), неверный адрес/ключ сетевого
 * движка или его недоступность из этой сети.
 */
async function fetchDiagnostic(url, init, label, timeoutMs = 120_000) {
	try {
		// Таймаут обязателен: иначе «висящий» движок держит /stt или /speak
		// открытым бесконечно, и кнопка микрофона навсегда застревает
		// в состоянии «Распознавание…».
		return await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
	} catch (err) {
		const cause = err && err.cause && err.cause.code ? ` (${err.cause.code})` : "";
		const message = `${label}: не удалось соединиться с ${url}${cause}. `
			+ (/127\.0\.0\.1|localhost/.test(url)
				? "Локальный сервер не запущен или в настройках указан другой порт — "
					+ "проверьте блок «Локальный» в настройках голосового чата."
				: "Проверьте адрес и ключ движка, а также доступность сервиса из этой сети.");
		console.error(`[dsh-voice-chat] ${message}`, err);
		const wrapped = new Error(message);
		wrapped.status = 502;
		wrapped.cause = err;
		throw wrapped;
	}
}

/**
 * Отправка JSON POST с одной повторной попыткой на «пустой body» (то же самое:
 * внутри хоста изредка приходит пустой ответ). Возвращает
 * `{ ok, status, text, json }`, причём text сохраняется как есть, чтобы можно было
 * вписать настоящий ответ в текст ошибки.
 */
async function postJson(url, headers, payload, label = "chat-интерфейс") {
	const send = async () => {
		// Через fetchDiagnostic: chat-протоколы (MiMo ASR/TTS) отдавали голое
		// «fetch failed» с кодом 500 — ровно то, что мы починили для multipart,
		// а эти два движка остались без диагностики.
		const resp = await fetchDiagnostic(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...NO_COMPRESSION_HEADERS, ...headers },
			body: JSON.stringify(payload)
		}, label);
		const text = await resp.text().catch(() => "");
		let json = {};
		try { json = JSON.parse(text); } catch { json = {}; }
		return { ok: resp.ok, status: resp.status, text, json, headers: resp.headers };
	};
	let result = await send();
	if (result.ok && result.text.trim() === "") {
		// Пустой 200: ещё одна попытка на новом соединении (на практике первый запрос внутри хоста может вернуть пустой body)
		console.warn("[dsh-voice-chat] получен пустой ответ, повторяем попытку:", url);
		result = await send();
	}
	return result;
}

/** Вписать сводку об ответе в текст ошибки, чтобы не видеть только «в ответе нет аудиоданных». */
function describeResponse(result) {
	const headers = result.headers;
	const ce = headers?.get?.("content-encoding") || "-";
	const ct = headers?.get?.("content-type") || "-";
	const body = result.text ? `body[${result.text.length}]=${result.text.slice(0, 200)}` : "тело пустое";
	return `HTTP ${result.status} content-type=${ct} content-encoding=${ce} ${body}`;
}

/** Промпт пересказа: голосом самого AI-ассистента, короткий доклад; только сжатие, никакого расширения. */
const SPEAK_SYSTEM_PROMPT = "Ты — тот самый AI-ассистент, который только что ответил пользователю. " +
	"Теперь сделай краткий устный отчёт по своему ответу: коротко, по делу, сначала вывод, затем ключевые моменты; " +
	"разговорный стиль, естественно, без лишних слов и вступлений; " +
	"без кода, таблиц, ссылок и markdown-разметки, при необходимости одной фразой обсуть суть; " +
	"только сжатие и обобщение оригинала, запрещено добавлять новое и отвлекаться; " +
	"результат должен быть короче или равен оригиналу, никогда не длиннее; " +
	"если оригинал короткий (например «Понял», «Хорошо, сделаю»), просто повтори его без изменений; " +
	"выдавай только текст отчёта, не более 150 слов. " +
	"Отвечай на том же языке, что и пользователь.";

/**
 * Разговорный пересказ через LLM-сервис самого harness (та же модель и ключ, что у агента).
 * При ошибке бросает исключение, и вызывающая сторона откатывается к чтению оригинала.
 * @param httpCtx - контекст с внедрёнными сервисами webServer и llm.
 * @param text - исходный ответ AI для пересказа.
 * @param provider - id провайдера harness (например, "deepseek-official"), который клиент передаёт из текущего диалога.
 * @param model - имя модели harness (deepseek-v4-flash / deepseek-v4-pro / своя ...).
 */
async function rewriteWithHarness(httpCtx, text, provider, model) {
	const llm = httpCtx.llm;
	if (llm === undefined) throw new Error("LLM-сервис harness недоступен");
	/** Один вызов пересказа: запускает поток с заданными параметрами и сводит его к тексту; ошибки пробрасываются вверх. */
	const runOnce = async (extra) => {
		const stream = llm.stream({
			provider,
			model,
			system: SPEAK_SYSTEM_PROMPT,
			messages: [
				{ role: "user", content: [{ type: "text", text: text.slice(0, 6000) }] }
			],
			maxTokens: 2000,
			...extra
		});
		let out = "";
		for await (const chunk of stream) {
			if (chunk.type === "text-delta") {
				out += chunk.text;
			} else if (chunk.type === "finish") {
				const reason = chunk.reason;
				// Блок завершения с ошибкой/прерыванием несёт настоящую причину сбоя, его обязательно нужно бросить (иначе это посчитают «успехом, но пусто» и молча прочитают оригинал)
				if (reason.kind === "error" || reason.kind === "aborted") {
					const failure = reason.failure;
					let detail = "";
					if (failure) {
						detail = typeof failure === "string" ? failure
							: (failure.message ?? failure.code ?? JSON.stringify(failure));
					}
					throw new Error(`Ошибка пересказа LLM harness (${reason.kind}): ${String(detail)}`.trim());
				}
				if (reason.kind !== "stop" && reason.kind !== "tool-calls" && reason.kind !== "max-tokens") {
					throw new Error("LLM harness неожиданно завершился: " + JSON.stringify(reason));
				}
			}
		}
		if (out.trim() === "") throw new Error("LLM harness вернул пустой результат пересказа");
		return out.trim();
	};
	// Сначала пробуем отключить размышление (официальные рассуждающие модели deepseek: отвечают
	// сразу, без размышления — быстрее и стабильнее); но модели вроде pi-ai, работающие через
	// совместимый AI-прокси, параметр reasoningEffort не поддерживают, при ошибке повторяем без него.
	try {
		return await runOnce({ reasoningEffort: "off" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/reasoning effort/i.test(message)) throw error;
		console.warn(`[dsh-voice-chat] rewrite: ${provider}/${model} не поддерживает reasoningEffort=off, повторяем без этого параметра`);
		return await runOnce({});
	}
}

// ---------- ASR: два протокола ----------
/** baseUrl заканчивается на /chat/completions → работаем по протоколу chat (как у MiMo). */
const CHAT_ASR_URL_RE = /\/chat\/completions\/?$/i;

/** Определить настоящий формат аудиобайтов: wav (RIFF/WAVE) / mp3 (ID3 или синхронизация кадра) / иначе пусто. */
function detectAudioMime(buffer) {
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
async function transcribeWithChatAsr(audioBuffer, asr) {
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
function parseChatContent(body) {
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
async function transcribe(audioBuffer, asr) {
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
function parseTranscriptionText(body) {
	if (typeof body !== "object" || body === null) return "";
	return String(body.text ?? "");
}

/**
 * Сбор тела запроса с верхней границей размера.
 * Без неё POST /tts с ответом на сотни килобайт и POST /stt с длинной записью
 * буферизуются в память целиком и без ограничения — достаточно одного
 * кривого клиента, чтобы съесть память процесса хоста.
 */
const MAX_BODY_BYTES = 128 * 1024 * 1024;
async function readBody(req, limit = MAX_BODY_BYTES) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > limit) {
			const err = new Error(`Тело запроса больше ${Math.round(limit / 1024 / 1024)} МБ`);
			err.status = 413;
			throw err;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/**
 * Синтез речи через OpenAI-совместимый интерфейс /audio/speech.
 * @param text - текст для синтеза.
 * @param tts - конфигурация TTS { baseUrl, model, apiKey, voice, engine? }.
 * @returns байты MP3 (Buffer).
 */
async function synthesizeWithCustomTts(text, tts) {
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
async function synthesizeWithMimoTts(text, tts) {
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

function json(res, status, payload) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}

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
			await writeFile(SETTINGS_FILE, JSON.stringify(merged, null, "\t") + "\n", "utf8");
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
	 * Синтез речи заданным движком TTS (общий для /tts и /speak).
	 * Каждый движок использует только конфигурацию своего слота; если ключ MiMo TTS
	 * пуст, **только** берётся ключ из слота «MiMo ASR» (тот же производитель,
	 * часто тот же ключ), ключи других движков ASR не занимаются (чтобы настройки
	 * не смешивались).
	 */
	const synthesizeByEngine = async (saved, engine, text, voiceOverride) => {
		const tts = liveTts(saved, engine);
		const voice = asText(voiceOverride) || tts.voice;
		const ratePercent = saved.ratePercent ?? vc.ratePercent;
		if (engine === "mimo") {
			const mimoAsrKey = asText(slotOf(saved, "asr", "mimo").apiKey);
			return await synthesizeWithMimoTts(text, {
				baseUrl: tts.baseUrl,
				model: tts.model,
				apiKey: tts.apiKey || mimoAsrKey,
				voice
			});
		}
		if (isBrowserEngine(engine)) {
			// Озвучку делает браузер (speechSynthesis); если сюда попали — значит
			// браузер её не смог, и подменять молча Edge-TTS нельзя: вернём понятную ошибку
			const err = new Error("Движок «Браузер» озвучивает через speechSynthesis и не обращается к плагину. Если в браузере нет доступных голосов, выберите «Локальный» (Piper) или Edge TTS");
			err.status = 400;
			throw err;
		}
		if (engine === "custom" || engine === "local") {
			if (engine === "local" && ensureLocalEngine) await ensureLocalEngine(tts.baseUrl);
			return await synthesizeWithCustomTts(text, {
				baseUrl: tts.baseUrl,
				model: tts.model,
				apiKey: tts.apiKey,
				voice,
				engine,
				ratePercent
			});
		}
		// Microsoft Edge TTS (бесплатно, ключ не нужен)
		const { synthesizeSpeech } = await import("./edge-tts.js");
		return await synthesizeSpeech({ text, voice, rate: vc.rate, pitch: "+0Hz" });
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
					const { createLocalEngineManager } = await import("./local-engine.js");
					localEngine = createLocalEngineManager(config);
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
				handler: async (req, res) => {
					if (req.method !== "GET") { json(res, 405, { error: "method not allowed" }); return; }
					const engine = await getLocalEngine(await ensureSaved());
					const status = await engine.status();
					json(res, 200, status);
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/install",
				handler: async (req, res) => {
					if (req.method !== "POST") { json(res, 405, { error: "method not allowed" }); return; }
					const saved = await ensureSaved();
					// Цели установки — из настроек (выбранная модель/голос), иначе всегда качался small
					const engine = await getLocalEngine(saved);
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
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/start",
				handler: async (req, res) => {
					if (req.method !== "POST") { json(res, 405, { error: "method not allowed" }); return; }
					try {
						const saved = await ensureSaved();
						const engine = await getLocalEngine(saved);
						const status = await engine.status();
						if (!status.venvReady) {
							json(res, 400, { error: "Локальный движок не установлен. Сначала вызовите /local/install" });
							return;
						}
						// Порт: ?port= из запроса, иначе из слота local (127.0.0.1:8765/v1)
						const reqUrl = new URL(req.url ?? "/", "http://dsh-voice-chat");
						const port = Number(reqUrl.searchParams.get("port")) || localPortFor(localSlotUrl(saved));
						const result = await engine.start(status.venvPythonPath, port);
						json(res, 200, result);
					} catch (err) {
						json(res, 500, { error: err.message });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/stop",
				handler: async (req, res) => {
					if (req.method !== "POST") { json(res, 405, { error: "method not allowed" }); return; }
					await (await getLocalEngine()).stop();
					json(res, 200, { ok: true });
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/remove",
				handler: async (req, res) => {
					if (req.method !== "POST") { json(res, 405, { error: "method not allowed" }); return; }
					try {
						const engine = await getLocalEngine(await ensureSaved());
						// По умолчанию сносим всё (модели занимают гигабайты);
						// keepModels=true оставляет скачанные модели
						const url = new URL(req.url ?? "/", "http://dsh-voice-chat");
						const keepModels = url.searchParams.get("keepModels") === "true";
						const result = await engine.remove({ includeModels: !keepModels });
						json(res, 200, { ok: true, ...result, status: await engine.status() });
					} catch (err) {
						json(res, 500, { error: err.message });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/remove-model",
				handler: async (req, res) => {
					if (req.method !== "POST") { json(res, 405, { error: "method not allowed" }); return; }
					try {
						const engine = await getLocalEngine(await ensureSaved());
						const url = new URL(req.url ?? "/", "http://dsh-voice-chat");
						const id = url.searchParams.get("id") ?? "";
						// Идентификатор приходит из UI — проверяется по реальному списку на диске
						const result = await engine.removeModel(id);
						json(res, 200, { ok: true, ...result, status: await engine.status() });
					} catch (err) {
						json(res, 400, { error: err.message });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/download-voice",
				handler: async (req, res) => {
					if (req.method !== "POST") { json(res, 405, { error: "method not allowed" }); return; }
					try {
						const engine = await getLocalEngine(await ensureSaved());
						const url = new URL(req.url ?? "/", "http://dsh-voice-chat");
						const voice = url.searchParams.get("voice") ?? "";
						const result = await engine.downloadVoice(voice);
						json(res, 200, { ok: true, ...result, status: await engine.status() });
					} catch (err) {
						json(res, 400, { error: err.message });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/download-model",
				handler: async (req, res) => {
					if (req.method !== "POST") { json(res, 405, { error: "method not allowed" }); return; }
					try {
						const saved = await ensureSaved();
						const engine = await getLocalEngine(saved);
						const url = new URL(req.url ?? "/", "http://dsh-voice-chat");
						const model = url.searchParams.get("model") || asText(slotOf(saved, "asr", "local").model);
						const result = await engine.downloadModel(model);
						json(res, 200, { ok: true, ...result, status: await engine.status() });
					} catch (err) {
						json(res, 400, { error: err.message });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/config",
				handler: async (req, res) => {
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
				}
			}));
			// Адаптация к новому DSH: клиент, увидев session.running true→false, вызывает
			// сюда за текстом последнего сообщения assistant (берётся через сервис sessions, без сканирования DOM).
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/latest-message",
				handler: async (req, res) => {
					if (req.method !== "GET") {
						json(res, 405, { error: "method not allowed" });
						return;
					}
					try {
						const url = new URL(req.url ?? "/", "http://dsh-voice-chat");
						const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
						if (!sessionId) {
							json(res, 400, { error: "missing sessionId" });
							return;
						}
						const store = httpCtx.sessions;
						const session = typeof store?.get === "function" ? store.get(sessionId) : undefined;
						if (!session || typeof session.deriveMessages !== "function") {
							json(res, 404, { error: "session not found: " + sessionId });
							return;
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
						json(res, 404, { error: "no assistant message with text" });
					} catch (error) {
						json(res, 500, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/settings",
				handler: async (req, res) => {
					if (req.method === "GET") {
						const saved = await ensureSaved();
						json(res, 200, publicSettings(saved));
						return;
					}
					if (req.method !== "POST") {
						json(res, 405, { error: "method not allowed" });
						return;
					}
					try {
						const raw = Buffer.from(await readBody(req)).toString("utf8");
						let payload = {};
						// Раньше битое JSON молча превращалось в пустой патч и ответ был
						// {ok:true} — опечатка в теле запроса выглядела как успешное
						// сохранение. Теперь это явная ошибка 400.
						try {
							payload = JSON.parse(raw || "{}");
						} catch (err) {
							json(res, 400, { error: "Не удалось разобрать JSON настроек: " + (err instanceof Error ? err.message : String(err)) });
							return;
						}
						if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
							json(res, 400, { error: "Тело запроса должно быть JSON-объектом с настройками" });
							return;
						}
						const patch = sanitizeSettings(payload);
						const merged = await saveSettings(patch);
						json(res, 200, { ok: true, settings: publicSettings(merged) });
					} catch (error) {
						json(res, 500, { error: "Ошибка сохранения настроек: " + (error instanceof Error ? error.message : String(error)) });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/stt",
				handler: async (req, res) => {
					if (req.method !== "POST") {
						json(res, 405, { error: "method not allowed" });
						return;
					}
					try {
						const audio = await readBody(req);
						if (audio.length === 0) {
							json(res, 400, { error: "empty audio body" });
							return;
						}
						const saved = await ensureSaved();
						// ?engine= — разовое переопределение движка (запасной ASR, когда
						// браузерный Web Speech API не работает); без него берётся настроенный
						const forced = normalizeAsrEngine(
							new URL(req.url ?? "/", "http://dsh-voice-chat").searchParams.get("engine")
						);
						const asr = forced ? resolveAsrConfig(config, { ...saved, asrEngine: forced }) : liveAsr(saved);
						// Локальный движок: сервер должен быть поднят (иначе поднимаем сами)
						if (isLocalEngine(asr.engine) && ensureLocalEngine) await ensureLocalEngine(asr.baseUrl);
						const text = await transcribe(audio, asr);
						json(res, 200, { text });
					} catch (error) {
						const status = error && typeof error === "object" && error.status ? error.status : 500;
						json(res, status, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/tts",
				handler: async (req, res) => {
					// GET ?text= (короткие тексты) и POST {text} (длинные ответы:
					// в query string они упирались в лимит длины URL прокси/хоста,
					// и озвучка больших ответов молча падала).
					if (req.method !== "GET" && req.method !== "POST") {
						json(res, 405, { error: "method not allowed" });
						return;
					}
					try {
						const url = new URL(req.url ?? "/", "http://dsh-voice-chat");
						let text = url.searchParams.get("text") ?? "";
						if (req.method === "POST") {
							const raw = Buffer.from(await readBody(req)).toString("utf8");
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
							json(res, 400, { error: "empty text" });
							return;
						}
						const saved = await ensureSaved();
						// Очистка перед озвучиванием: убрать markdown/emoji/спецсимволы, сжать повторяющуюся пунктуацию
						const clean = cleanForTts(text);
						// Синтез текущим движком TTS (у каждого движка своя конфигурация в слоте)
						const ttsEngine = liveTtsEngine(saved);
						const audio = await synthesizeByEngine(
							saved,
							ttsEngine,
							clean || text,
							url.searchParams.get("voice") ?? ""
						);
						res.writeHead(200, {
							// Piper отдаёт WAV, остальные движки — MP3
							"Content-Type": isLocalEngine(ttsEngine) ? "audio/wav" : "audio/mpeg",
							"Content-Length": audio.length,
							"Cache-Control": "no-store"
						});
						res.end(audio);
					} catch (error) {
						const status = error && typeof error === "object" && error.status ? error.status : 500;
						json(res, status, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/speak",
				handler: async (req, res) => {
					if (req.method !== "POST") {
						json(res, 405, { error: "method not allowed" });
						return;
					}
					let original = "";
					let spoken = "";
					try {
						const raw = Buffer.from(await readBody(req)).toString("utf8");
						let payload = {};
						try { payload = JSON.parse(raw || "{}"); } catch (err) { /* ignore */ }
						original = String(payload.text ?? "").trim();
						if (!original) {
							json(res, 400, { error: "empty text" });
							return;
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
						const ttsEngine = liveTtsEngine(saved);
						const audio = await synthesizeByEngine(
							saved,
							ttsEngine,
							spoken,
							typeof payload.voice === "string" ? payload.voice : ""
						);
						res.writeHead(200, {
							// Piper отдаёт WAV, остальные движки — MP3
							"Content-Type": isLocalEngine(ttsEngine) ? "audio/wav" : "audio/mpeg",
							"Content-Length": audio.length,
							"Cache-Control": "no-store"
						});
						res.end(audio);
					} catch (error) {
						// При сбое синтеза TTS возвращаем «текст, который реально будет
						// прочитан» (пересказ удался → разговорная версия; сбой или
						// выключено → оригинал), чтобы запасной браузерный TTS озвучил
						// именно его, а не непересказанный оригинал.
						const status = error && typeof error === "object" && error.status ? error.status : 500;
						json(res, status, { error: error instanceof Error ? error.message : String(error), spoken });
					}
				}
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
export {
	ASR_ENGINE_DEFAULTS,
	ASR_ENGINES,
	TTS_ENGINE_DEFAULTS,
	TTS_ENGINES,
	DEFAULT_HOTKEY,
	buildPublicSlots,
	cleanForTts,
	DEFAULT_LOCAL_PORT,
	LOCAL_ASR_MODELS,
	LOCAL_TTS_VOICES,
	detectAudioMime,
	hotkeyFromEvent,
	hotkeyLabel,
	isLocalEngine,
	localPort,
	migrateLegacySettings,
	mergeSettings,
	normalizeHotkey,
	parseChatContent,
	parseTranscriptionText,
	resolveAsrConfig,
	resolveTtsConfig,
	resolveTtsEngine,
	sanitizeSettings,
	synthesizeWithCustomTts,
	transcribe,
	transcribeWithChatAsr
};
