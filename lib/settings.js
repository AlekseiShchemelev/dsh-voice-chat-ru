/**
 * Настройки: путь к файлу, чтение/запись settings.local.json, нормализация,
 * слияние и миграция со старого плоского формата, а также разбор конфигурации
 * cordis-строки в действующие значения по движкам.
 *
 * Вынесено отдельно от apply(), потому что это единственная часть плагина, у
 * которой есть собственное состояние (файл на диске) и собственные инварианты
 * (не потерять чужой слот при сохранении, не затереть старый формат).
 *
 * @module dsh-voice-chat/settings
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ASR_ENGINE_DEFAULTS,
	CHAT_ASR_URL_RE,
	DEFAULT_HOTKEY,
	DEFAULT_LOCAL_PORT,
	MIMO_TTS_VOICES,
	SLOT_FIELDS,
	TTS_ENGINE_DEFAULTS,
	TTS_ENGINES,
	asRecord,
	asText,
	normalizeAsrEngine,
	normalizeHotkey,
	normalizeTtsEngine
} from "./shared.js";

/** Порт локального сервера: адрес слота (127.0.0.1:8765/v1) > config.local.port > 8765. */
export function localPort(config, slotBaseUrl) {
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
export function resolveAsrConfig(config, saved) {
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
export function buildPublicSlots(config, saved, edgeVoiceFallback) {
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
export function resolveTtsEngine(config, saved) {
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
export function resolveTtsConfig(config, saved, engine, edgeVoiceFallback) {
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
export function resolveLlmModel(config) {
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
export function resolveVoiceConfig(config) {
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
export const SETTINGS_FILE = process.env.DSH_VOICE_SETTINGS_FILE
	? path.resolve(process.env.DSH_VOICE_SETTINGS_FILE)
	: DEFAULT_SETTINGS_FILE;

/** Старые плоские ключи (для миграции и очистки). */
export const LEGACY_FLAT_KEYS = [
	"asrBaseUrl", "asrModel", "asrApiKey",
	"ttsBaseUrl", "ttsModel", "ttsApiKey", "ttsVoice"
];

/** Слот заданного движка в группе (asr/tts); при отсутствии или порче — пустой объект. */
export function slotOf(saved, group, engine) {
	return asRecord(asRecord(asRecord(saved)[group])[engine]);
}

/** Глубокая копия группы слотов (чтобы не менять объект вызывающей стороны). */
export function cloneSlots(group) {
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
export function migrateLegacySettings(raw) {
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
export function withoutLegacyFlat(settings) {
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
export async function loadSavedSettings() {
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
export function sanitizeSettings(input) {
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
export function clampNumber(value, min, max) {
	if (value === null || value === undefined || typeof value === "boolean") return null;
	if (typeof value === "string" && value.trim() === "") return null;
	const n = Math.round(Number(value));
	if (!Number.isFinite(n)) return null;
	return Math.min(max, Math.max(min, n));
}

/** Нормализация патча слотов asr/tts по движкам: остаются только известные движки и известные поля. */
export function sanitizeSlots(input, group) {
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
export function flatPatchToSlot(patch, group) {
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
export function mergeSettings(savedRaw, patch) {
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
