/**
 * dsh-voice-chat —— 宿主半身。
 *
 * 提供 HTTP 路由 POST /dsh-voice-chat/stt：接收浏览器 MediaRecorder 录下的
 * 音频（webm/opus），转调 ASR 接口返回 { text }：
 *   - siliconflow（默认，国内直连，SenseVoiceSmall 免费）/ groq / custom：
 *     OpenAI 兼容 /audio/transcriptions multipart 协议，webm 原样上传；
 *   - mimo（小米 MiMo-V2.5-ASR）：chat/completions 协议，音频 base64
 *     (data URL) 放在 messages.content 的 input_audio 里，仅支持 wav/mp3
 *     （浏览器端录音会自动转 16k 单声道 WAV）。
 * 生效 baseUrl 以 /chat/completions 结尾时自动按 chat 协议处理（免改配置）。
 * 浏览器端拿到文字后经 inputActions 发送给会话。
 *
 * 配置优先级：⚙️ 设置面板（settings.local.json，浏览器里可改）>
 *   行 config（cordis.patch.yml 里覆盖）> 环境变量 > 默认值。
 *
 * ASR/TTS 的 Base URL / 模型 / 密钥 / 音色一律**按引擎分别保存**（asr.<引擎>、
 * tts.<引擎>），切换引擎互不覆盖；旧版扁平键（asrBaseUrl/ttsBaseUrl…）在读取时
 * 自动迁移到对应引擎的槽里，升级无感（见 migrateLegacySettings）。
 *
 *   - config.asrEngine / env DSH_VOICE_ASR_ENGINE siliconflow | groq | mimo | custom
 *   - config.asr.<引擎>.{baseUrl,model,apiKey}            按引擎隔离的 ASR 配置
 *   - config.asrApiKey / env DSH_VOICE_ASR_KEY    ASR 密钥（旧式单槽，作用于当前引擎）
 *   - config.asrBaseUrl / env DSH_VOICE_ASR_BASE_URL (custom 必填；mimo 填完整
 *     chat/completions 端点，默认 https://api.xiaomimimo.com/v1/chat/completions)
 *   - config.asrModel   / env DSH_VOICE_ASR_MODEL
 *   - config.ttsEngine  TTS 引擎：edge | mimo | custom
 *   - config.tts.<引擎>.{baseUrl,model,apiKey,voice}      按引擎隔离的 TTS 配置
 *   - config.ttsBaseUrl / ttsModel / ttsApiKey / ttsVoice 旧式单槽，作用于当前引擎
 *   - config.voice / config.rate                           Edge TTS 音色与语速
 *   - config.llmApiKey  / env DSH_VOICE_LLM_KEY   转述模型密钥（缺省用 ASR 密钥）
 *   - config.llmBaseUrl / env DSH_VOICE_LLM_BASE_URL
 *   - config.llmModel   / env DSH_VOICE_LLM_MODEL 默认 deepseek-v4-flash
 *     （仅在客户端未透传"当前对话实际模型"时作为转述朗读的 fallback；默认跟当前对话走）
 *
 * 路由：
 *   POST /dsh-voice-chat/stt    音频 → 文字
 *   GET  /dsh-voice-chat/tts    文字 → MP3（原样朗读）
 *   POST /dsh-voice-chat/speak  文字 → LLM 口语化转述 → MP3（语音助手式汇报）
 *   GET  /dsh-voice-chat/settings 读取当前生效设置（含密钥，仅本机自用）
 *   POST /dsh-voice-chat/settings 保存设置面板改动（落盘 settings.local.json）
 *
 * @module dsh-voice-chat
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 插件版本（随 package.json 手动同步；/settings 回显，便于确认宿主已加载新版）。 */
const VERSION = "0.6.0";

/** 各 ASR 引擎内置默认（baseUrl 为该引擎的"基地址"；mimo 为完整端点）。 */
const ASR_ENGINE_DEFAULTS = {
	siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall" },
	groq: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
	mimo: { baseUrl: "https://api.xiaomimimo.com/v1/chat/completions", model: "mimo-v2.5-asr" },
	custom: { baseUrl: "", model: "" },
	browser: { baseUrl: "", model: "" },
	local: { baseUrl: "http://127.0.0.1:8765/v1", model: "small" }
};

const ASR_ENGINES = ["siliconflow", "groq", "mimo", "custom", "browser", "local"];

/**
 * Локальный движок (faster-whisper + Piper на 127.0.0.1): ключей не имеет,
 * поэтому проверки «настроен ли API-ключ» для него неприменимы.
 */
function isLocalEngine(engine) {
	return String(engine ?? "").trim().toLowerCase() === "local";
}

/** Порт локального сервера: адрес слота (127.0.0.1:8765/v1) > config.local.port > 8765. */
function localPort(config, slotBaseUrl) {
	const fromUrl = /127\.0\.0\.1:(\d+)|localhost:(\d+)/.exec(String(slotBaseUrl ?? ""));
	if (fromUrl) return Number(fromUrl[1] ?? fromUrl[2]);
	const cfgPort = Number(asRecord(asRecord(config).local).port);
	if (cfgPort > 0) return cfgPort;
	const envPort = Number(process.env.DSH_VOICE_LOCAL_PORT);
	return envPort > 0 ? envPort : 8765;
}

/** 归一化引擎名；非法值返回空串（视为未设置，回落默认链）。 */
function normalizeAsrEngine(value) {
	const s = String(value ?? "").trim().toLowerCase();
	return Object.prototype.hasOwnProperty.call(ASR_ENGINE_DEFAULTS, s) ? s : "";
}

/**
 * 各 TTS 引擎内置默认。MiMo 是固定厂商端点 → 内置默认地址（与 MiMo ASR 一致），
 * 只填密钥即可用；Edge 不需要地址；自定义 TTS 必须自己填地址。
 */
const TTS_ENGINES = ["edge", "mimo", "custom", "browser", "local"];
const TTS_ENGINE_DEFAULTS = {
	edge: { baseUrl: "", model: "", voice: "ru-RU-SvetlanaNeural" },
	mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", voice: "mimo_default" },
	custom: { baseUrl: "", model: "tts-1", voice: "alloy" },
	browser: { baseUrl: "", model: "", voice: "" },
	local: { baseUrl: "http://127.0.0.1:8765/v1", model: "piper", voice: "ru_RU-irina-medium" }
};

/** MiMo TTS 预置音色（迁移旧配置时用来判断音色属于哪个引擎）。 */
const MIMO_TTS_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];

/** 归一化 TTS 引擎名；非法值返回空串（视为未设置，回落默认链）。 */
function normalizeTtsEngine(value) {
	const s = String(value ?? "").trim().toLowerCase();
	return TTS_ENGINES.includes(s) ? s : "";
}

/** 安全转成 trim 后的字符串（null/undefined → 空串）。 */
function asText(value) {
	return value === undefined || value === null ? "" : String(value).trim();
}

/** 取普通对象（null/数组/其它类型一律退化为空对象）。 */
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * 解析 ASR 配置（设置面板该引擎的槽 > 行 config 该引擎的槽 > 旧式扁平
 * config 键 > 环境变量 > 引擎内置默认）。每个引擎只读自己的槽，互不串味。
 * @param {object} config - cordis 行 config。
 * @param {object} [saved] - settings.local.json 保存的面板设置（已迁移的新结构）。
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
		apiKey: pick("apiKey", "asrApiKey", "DSH_VOICE_ASR_KEY", "")
	};
}

/**
 * 弹窗回显用的"每个引擎的生效槽"：asr/tts 都按引擎各给一份（缺省补上内置默认，
 * 便于用户看到该引擎实际会用的值）。与 saved 里的槽一一对应，互不串味。
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

/** 生效 TTS 引擎：设置面板 > 行 config > edge。 */
function resolveTtsEngine(config, saved) {
	return normalizeTtsEngine(asRecord(saved).ttsEngine)
		|| normalizeTtsEngine(asRecord(config).ttsEngine)
		|| "edge";
}

/**
 * 解析"某一个 TTS 引擎"的生效配置：
 *   设置面板该引擎的槽 > 行 config 该引擎的槽 > 行 config 旧式扁平键
 *   > 引擎内置默认。每个引擎只读自己的槽，切换引擎不会串配置。
 * @param {object} config - cordis 行 config。
 * @param {object} [saved] - settings.local.json 保存的面板设置（已迁移的新结构）。
 * @param {string} engine - edge | mimo | custom。
 * @param {string} [edgeVoiceFallback] - Edge 音色兜底（cordis 的 voice，默认晓晓）。
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
 * 解析"转述模型"配置：仅在客户端未透传"当前对话实际模型"时作为 fallback。
 * 默认 deepseek-v4-flash（agent 同款）；用 cordis 行 config.llmModel 或环境变量
 * DSH_VOICE_LLM_MODEL 可覆盖。正常情况下转述跟随当前对话走的模型走，不走这里。
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
const DEFAULT_HOTKEY = "ControlRight";

/** Коды одиночных модификаторов (левый/правый) — их можно использовать сами по себе. */
const SOLO_MODIFIER_CODES = new Set([
	"ControlLeft", "ControlRight",
	"ShiftLeft", "ShiftRight",
	"AltLeft", "AltRight",
	"MetaLeft", "MetaRight",
	"OSLeft", "OSRight"
]);

/**
 * 解析"语音播放/交互"配置：音色、语速、静音时长、短文阈值、转述开关。
 * 全部可经 cordis.patch.yml 的 voice-chat 行 config 覆盖（默认值见下）。
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

/** Текстовые синонимы клавиш (чтобы «Ctrl + space» и Ctrl+Space совпадали). */
const KEY_ALIASES = {
	space: "Space", spacebar: "Space", esc: "Escape", escape: "Escape",
	enter: "Enter", return: "Enter", tab: "Tab", backspace: "Backspace",
	del: "Delete", delete: "Delete", up: "ArrowUp", down: "ArrowDown",
	left: "ArrowLeft", right: "ArrowRight", plus: "+", minus: "-"
};

/** Коды одиночных модификаторов в любом регистре: "controlright" → "ControlRight". */
const SOLO_MODIFIER_BY_LOWER = new Map(
	[...SOLO_MODIFIER_CODES].map((code) => [code.toLowerCase(), code])
);

/** Приводит код клавиши к каноническому имени: KeyM→M, Digit1→1, пробел→Space. */
function canonicalKeyName(code, key) {
	if (SOLO_MODIFIER_CODES.has(code)) return code;
	if (SOLO_MODIFIER_BY_LOWER.has(String(code).toLowerCase())) return SOLO_MODIFIER_BY_LOWER.get(String(code).toLowerCase());
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit\d$/.test(code)) return code.slice(5);
	if (/^Numpad\d$/.test(code)) return "Num" + code.slice(6);
	const raw = String(key ?? "");
	if (KEY_ALIASES[raw.toLowerCase()]) return KEY_ALIASES[raw.toLowerCase()];
	const k = raw === " " ? "Space" : raw;
	if (k.length === 1) return k.toUpperCase();
	return k || code || "";
}

/**
 * Нормализует сочетание клавиш к канонической строке ("Ctrl+Shift+Space",
 * "ControlRight"). Пустая строка (или "off"/"none") = горячая клавиша выключена.
 * Неразобранное значение → null (значит «не установлено»).
 */
function normalizeHotkey(value) {
	const raw = String(value ?? "").trim();
	if (!raw || /^none$|^off$|^выкл$/i.test(raw)) return "";
	const parts = raw.split("+").map((p) => p.trim()).filter(Boolean);
	if (!parts.length) return "";
	// Одиночный модификатор допустим (например, правый Ctrl)
	if (parts.length === 1 && SOLO_MODIFIER_CODES.has(parts[0])) return parts[0];
	const MODS = { ctrl: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta", cmd: "Meta", command: "Meta", win: "Meta", os: "Meta" };
	const mods = [];
	let key = null;
	for (const part of parts) {
		const asMod = MODS[part.toLowerCase()];
		if (asMod) { if (!mods.includes(asMod)) mods.push(asMod); continue; }
		if (key !== null) return null;           // две «обычные» клавиши — так нельзя
		const name = canonicalKeyName(part, part);
		if (!name) return null;
		key = name;
	}
	if (key === null) return null;
	// Порядок модификаторов фиксирован, иначе "Shift+Ctrl+M" и "Ctrl+Shift+M" — разные строки
	mods.sort((a, b) => ["Ctrl", "Alt", "Shift", "Meta"].indexOf(a) - ["Ctrl", "Alt", "Shift", "Meta"].indexOf(b));
	return [...mods, key].join("+");
}

/** Собирает каноническую строку сочетания по событию клавиатуры (браузер → настройки). */
function hotkeyFromEvent(event) {
	const code = String(event?.code ?? "");
	if (SOLO_MODIFIER_CODES.has(code)) return code;
	const key = canonicalKeyName(code, event?.key);
	if (!key) return null;
	const mods = [];
	if (event.ctrlKey) mods.push("Ctrl");
	if (event.altKey) mods.push("Alt");
	if (event.shiftKey) mods.push("Shift");
	if (event.metaKey) mods.push("Meta");
	return [...mods, key].join("+");
}

/** Человекочитаемое имя сочетания для UI. */
function hotkeyLabel(value) {
	const combo = normalizeHotkey(value);
	if (!combo) return "";
	return combo.split("+").map((part) => ({
		Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Cmd",
		Space: "Пробел", Enter: "Enter", Escape: "Esc", Tab: "Tab", Backspace: "Backspace",
		ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
		ControlLeft: "Левый Ctrl", ControlRight: "Правый Ctrl",
		ShiftLeft: "Левый Shift", ShiftRight: "Правый Shift",
		AltLeft: "Левый Alt", AltRight: "Правый Alt",
		MetaLeft: "Левый Cmd", MetaRight: "Правый Cmd",
		OSLeft: "Левый Win", OSRight: "Правый Win"
	}[part] ?? part)).join(" + ");
}

// ---------- 设置面板：settings.local.json 持久化 ----------
// 浏览器端 ⚙️ 弹窗改的设置落盘在插件根目录 settings.local.json（不进 git）。
// 只保存"显式设置过"的键：留空/未设置的项继续回落到 行 config > 环境变量 > 内置默认。
//
// 结构（v0.4+）——ASR/TTS 每个引擎一份独立的槽，切换引擎不会互相覆盖：
//   {
//     "asrEngine": "custom", "ttsEngine": "mimo",
//     "autoSend": false, "silenceMs": 2000, "rewrite": true,
//     "asr": { "siliconflow": {baseUrl,model,apiKey}, "groq": {...}, "mimo": {...}, "custom": {...} },
//     "tts": { "edge": {voice}, "mimo": {baseUrl,model,apiKey,voice}, "custom": {baseUrl,model,apiKey,voice} }
//   }
// 旧版（≤0.3.x）把 ASR/TTS 各存一份扁平键（asrBaseUrl/ttsBaseUrl/ttsVoice…），
// 切换引擎会相互覆盖（配置串味）；读取时由 migrateLegacySettings 一次性迁移。
const SETTINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "settings.local.json");

/** asr/tts 槽里允许出现的字段。 */
const SLOT_FIELDS = {
	asr: ["baseUrl", "model", "apiKey"],
	tts: ["baseUrl", "model", "apiKey", "voice"]
};

/** 旧版扁平键（迁移/清理用）。 */
const LEGACY_FLAT_KEYS = [
	"asrBaseUrl", "asrModel", "asrApiKey",
	"ttsBaseUrl", "ttsModel", "ttsApiKey", "ttsVoice"
];

/** 取某组（asr/tts）里指定引擎的槽；缺失/损坏返回空对象。 */
function slotOf(saved, group, engine) {
	return asRecord(asRecord(asRecord(saved)[group])[engine]);
}

/** 深拷贝一组槽（避免改动调用方对象）。 */
function cloneSlots(group) {
	const out = {};
	for (const [engine, slot] of Object.entries(asRecord(group))) {
		out[engine] = { ...asRecord(slot) };
	}
	return out;
}

/**
 * 旧版扁平设置 → 按引擎隔离结构（幂等；已存在的槽优先，不覆盖新结构）。
 * 旧文件里 baseUrl/model/apiKey 只可能属于"某一个"引擎，按下列线索归属：
 *   - ASR：baseUrl 以 /chat/completions 结尾 → mimo；否则归当前选中的 ASR 引擎；
 *   - TTS 凭据：URL/模型里含 mimo → mimo；否则归当前选中的 TTS 引擎
 *     （选中的是 edge 时归自定义 TTS——edge 不需要凭据）；
 *   - TTS 音色：以 Neural 结尾 → edge；MiMo 预置音色 → mimo；否则归自定义 TTS。
 */
function migrateLegacySettings(raw) {
	const src = asRecord(raw);
	const asr = cloneSlots(src.asr);
	const tts = cloneSlots(src.tts);
	const asrEngine = normalizeAsrEngine(src.asrEngine);
	const ttsEngine = normalizeTtsEngine(src.ttsEngine) || "edge";
	// ASR 扁平键 → 槽
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
	// TTS 扁平凭据 → 槽
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
	// TTS 扁平音色 → 槽
	const voice = asText(src.ttsVoice);
	if (voice) {
		let owner;
		if (/Neural$/i.test(voice)) owner = "edge";
		else if (MIMO_TTS_VOICES.includes(voice)) owner = "mimo";
		else if (tts.custom !== undefined || ttsEngine === "custom") owner = "custom";
		else if (ttsEngine === "edge") owner = "edge";
		// mimo/local/browser：音色归当前选中的引擎（旧逻辑一律塞 edge，
		// 会把本地 piper 音色写进 Edge 槽，Edge 朗读时拿到非法音色）
		else owner = ttsEngine;
		if (!asText(asRecord(tts[owner]).voice)) {
			tts[owner] = { ...asRecord(tts[owner]), voice };
		}
	}
	return { ...src, asr, tts };
}

/** 去掉旧版扁平键（写盘用：文件里只保留按引擎隔离的新结构）。 */
function withoutLegacyFlat(settings) {
	const out = { ...settings };
	for (const key of LEGACY_FLAT_KEYS) delete out[key];
	return out;
}

/**
 * 读取本地保存的设置；文件不存在/损坏返回空结构。
 * 读到旧版扁平结构时迁移成按引擎隔离的新结构并**顺手落盘一次**（幂等），
 * 免得每次启动都重复迁移、也方便用户直接看文件确认配置。
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
			console.log("[dsh-voice-chat] 已把旧版扁平设置迁移为按引擎隔离结构（asr/tts 分槽）");
		} catch (err) {
			console.warn("[dsh-voice-chat] 迁移后的设置写盘失败（内存里已生效）:", err instanceof Error ? err.message : String(err));
		}
	}
	return migrated;
}

/**
 * 归一化一次设置补丁：只保留显式提供的键。
 * silenceMs 夹在 300~15000ms（非法值视为未设置）；autoSend/rewrite 强转布尔；
 * 字符串字段 trim 后保存（空串=清除覆盖，回落默认）。asr/tts 按引擎槽归一化，
 * 只保留已知引擎与已知字段；旧版扁平键（老客户端仍在发）原样保留，由
 * mergeSettings 归入"当前选中的引擎"，文件里不再留存。
 * asrEngine 只接受 siliconflow/groq/mimo/custom；ttsEngine 只接受
 * "edge"、"mimo" 或 "custom"，非法值回落 "edge"。
 */
function sanitizeSettings(input) {
	const src = asRecord(input);
	const out = {};
	// 语音识别设置
	if ("asrEngine" in src) out.asrEngine = normalizeAsrEngine(src.asrEngine) || "siliconflow";
	if ("autoSend" in src) out.autoSend = src.autoSend !== false && src.autoSend !== "false";
	if ("continuousMode" in src) out.continuousMode = src.continuousMode !== false && src.continuousMode !== "false";
	if ("silenceMs" in src) out.silenceMs = clampNumber(src.silenceMs, 300, 15000);
	// 启动识别的按键/组合键（空串 = 关闭）；非法值回落默认
	if ("asrHotkey" in src) {
		const combo = normalizeHotkey(src.asrHotkey);
		out.asrHotkey = combo === null ? DEFAULT_HOTKEY : combo;
	}
	// 朗读设置
	if ("rewrite" in src) out.rewrite = src.rewrite !== false && src.rewrite !== "false";
	if ("ttsEngine" in src) out.ttsEngine = normalizeTtsEngine(src.ttsEngine) || "edge";
	if ("ratePercent" in src) out.ratePercent = clampNumber(src.ratePercent, 50, 200);
	if ("speechLang" in src) {
		const lang = String(src.speechLang).trim();
		out.speechLang = ["ru-RU", "zh-CN", "en-US", "ja-JP"].includes(lang) ? lang : null;
	}
	// 按引擎隔离的槽（新结构）
	if ("asr" in src) out.asr = sanitizeSlots(src.asr, "asr");
	if ("tts" in src) out.tts = sanitizeSlots(src.tts, "tts");
	// 旧版扁平键（兼容老客户端/手写配置）
	for (const key of LEGACY_FLAT_KEYS) {
		if (key in src) out[key] = asText(src[key]);
	}
	return out;
}

/**
 * 数值型设置归一化：空值（null/undefined/空串/非数值字符串）一律视为"未设置"
 * 返回 null（由解析层回落到默认），其余四舍五入后夹在 [min, max]。
 * 旧实现直接 Number(v)：Number(null)=0 → 被夹成下限（silenceMs 300 / rate 50%），
 * 相当于"清空"被写成了"改成最小值"。
 */
function clampNumber(value, min, max) {
	if (value === null || value === undefined || typeof value === "boolean") return null;
	if (typeof value === "string" && value.trim() === "") return null;
	const n = Math.round(Number(value));
	if (!Number.isFinite(n)) return null;
	return Math.min(max, Math.max(min, n));
}

/** 归一化 asr/tts 的按引擎槽补丁：只保留已知引擎 + 已知字段。 */
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

/** 从补丁里取出旧版扁平键 → 槽字段（asrBaseUrl → baseUrl）。 */
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
 * 合并一次设置补丁（保存前调用）：
 *   - asr/tts 按引擎深合并：只覆盖补丁里出现的引擎，其它引擎原样保留；
 *   - 旧版扁平键归入"当前选中的引擎"槽（edge 不需要凭据，只接音色）；
 *   - 合并结果里不再留旧版扁平键。
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
	// 旧版扁平键 → 当前引擎的槽
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

// ---------- 出网请求公共部分 ----------
/**
 * 出网请求统一带 `Accept-Encoding: identity`（要求服务端别压缩）。
 * 起因：宿主进程里实测到"压缩响应（gzip/chunked）的 body 被吃成空"——
 * 同一个 API、同一把密钥，宿主里报 `响应里没有音频数据: {}`，脱离宿主直连却正常
 * （MiMo TTS/ASR 与厂商 openresty 的 404 页都是 gzip，而 siliconflow 的 401、
 * httpbin 的明文响应都能正常读）。这些接口的响应本来就只有几十 KB，
 * 不压缩没有损失，却能让链路不再依赖宿主进程那层未知的响应解压行为。
 */
const NO_COMPRESSION_HEADERS = { "Accept-Encoding": "identity" };

/**
 * 发一个 JSON POST，并对"空 body"做一次重试（同上：宿主里偶发拿到空响应）。
 * 返回 `{ ok, status, text, json }`——text 原样保留，便于把真实响应写进报错。
 */
async function postJson(url, headers, payload) {
	const send = async () => {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...NO_COMPRESSION_HEADERS, ...headers },
			body: JSON.stringify(payload)
		});
		const text = await resp.text().catch(() => "");
		let json = {};
		try { json = JSON.parse(text); } catch { json = {}; }
		return { ok: resp.ok, status: resp.status, text, json, headers: resp.headers };
	};
	let result = await send();
	if (result.ok && result.text.trim() === "") {
		// 空 200：换一个新连接再试一次（实测宿主里首个请求可能拿到空 body）
		console.warn("[dsh-voice-chat] 收到空响应，重试一次:", url);
		result = await send();
	}
	return result;
}

/** 把响应概况写进报错，避免只看到一句"没有音频数据"。 */
function describeResponse(result) {
	const headers = result.headers;
	const ce = headers?.get?.("content-encoding") || "-";
	const ct = headers?.get?.("content-type") || "-";
	const body = result.text ? `body[${result.text.length}]=${result.text.slice(0, 200)}` : "body 为空";
	return `HTTP ${result.status} content-type=${ct} content-encoding=${ce} ${body}`;
}

/** 转述提示词：AI 助手本人的口吻，简短汇报；只许压缩收敛，禁止发散扩写。 */
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
 * 用 harness 自带的 LLM 服务做口语化转述（复用 agent 同一个模型/密钥）。
 * 失败抛错，由调用方降级为原文朗读。
 * @param httpCtx - 注入了 webServer 与 llm 服务的上下文。
 * @param text - 待转述的 AI 回复原文。
 * @param provider - harness provider id（如 "deepseek-official"），由客户端透传当前对话实际在用的。
 * @param model - harness 模型名（deepseek-v4-flash / deepseek-v4-pro / 自定义 ...）。
 */
async function rewriteWithHarness(httpCtx, text, provider, model) {
	const llm = httpCtx.llm;
	if (llm === undefined) throw new Error("LLM-сервис harness недоступен");
	/** 单次转述调用：按给定选项发起流并收敛出文本；错误以抛错形式上抛。 */
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
				// 错误/中止结束块带真实失败信息，必须抛出来（否则会被当成"成功但空"而静默读原文）
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
	// 优先尝试关闭思考（deepseek 官方推理模型：不思考、直接回答，又快又稳）；
	// 但 pi-ai 等兼容 AI 代理的模型不支持 reasoningEffort 参数，报错时去掉该参数重试一次。
	try {
		return await runOnce({ reasoningEffort: "off" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/reasoning effort/i.test(message)) throw error;
		console.warn(`[dsh-voice-chat] rewrite: ${provider}/${model} 不支持 reasoningEffort=off，去掉该参数重试`);
		return await runOnce({});
	}
}

// ---------- ASR：两种协议 ----------
/** baseUrl 以 /chat/completions 结尾 → 按 chat 协议（MiMo 式）处理。 */
const CHAT_ASR_URL_RE = /\/chat\/completions\/?$/i;

/** 识别音频字节的真实格式：wav(RIFF/WAVE) / mp3(ID3 或帧同步) / 其他返回空。 */
function detectAudioMime(buffer) {
	if (buffer.length >= 12) {
		if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WAVE") return "audio/wav";
	}
	if (buffer.length >= 3 && buffer.toString("latin1", 0, 3) === "ID3") return "audio/mpeg";
	// MPEG 帧同步只需 2 字节（0xFF + 3 个高位 1），别被 >=3 的门槛挡住
	if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "audio/mpeg";
	return "";
}

/**
 * chat/completions 协议转写（小米 MiMo-V2.5-ASR，2026-09 实测通过）：
 * 音频以 data URL(base64) 放在 messages.content 的 input_audio 里，仅支持
 * wav/mp3；鉴权同时带 api-key 与 Bearer（两种官方文档方式都兼容）；
 * 识别文本在 choices[0].message.content。
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
	});
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
 * 从 chat/completions 响应体里取出文本（choices[0].message.content）：
 * 既支持 content 是字符串，也支持 content 是 [{type:"text",text}] 这样的分段数组。
 * 结构不符时返回空串（调用方据此报错）。
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

/** 调 ASR 转写：按引擎/URL 自动选协议（mimo 或以 /chat/completions 结尾 → chat 协议；否则 multipart）。 */
async function transcribe(audioBuffer, asr) {
	// Локальный движок (faster-whisper на 127.0.0.1) ключа не имеет и не требует
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
	const resp = await fetch(`${asr.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
		method: "POST",
		// Локальный сервер ключ не проверяет — Authorization просто не шлём
		headers: {
			...(asr.apiKey ? { Authorization: `Bearer ${asr.apiKey}` } : {}),
			...NO_COMPRESSION_HEADERS
		},
		body: form
	});
	const raw = await resp.text().catch(() => "");
	let body = {};
	try { body = JSON.parse(raw); } catch { body = {}; }
	if (!resp.ok) {
		const detail = typeof body === "object" && body !== null && Object.keys(body).length > 0
			? (body.error?.message ?? JSON.stringify(body))
			: (raw.slice(0, 200) || "(пустой ответ)");
		const err = new Error(`Ошибка ASR-интерфейса ${resp.status}: ${detail}`);
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
 * 从 OpenAI 兼容 /audio/transcriptions 响应体里取出 text（无 text 字段返回空串）。
 */
function parseTranscriptionText(body) {
	if (typeof body !== "object" || body === null) return "";
	return String(body.text ?? "");
}

/** 收集请求体（node:http IncomingMessage）。 */
async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return Buffer.concat(chunks);
}

/**
 * 调 OpenAI 兼容 /audio/speech 接口合成语音。
 * @param text - 待合成文本。
 * @param tts - TTS 配置 { baseUrl, model, apiKey, voice, engine? }。
 * @returns MP3 字节（Buffer）。
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
	const resp = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			// Локальный сервер ключ не проверяет — Authorization просто не шлём
			...(tts.apiKey ? { Authorization: `Bearer ${tts.apiKey}` } : {}),
			...NO_COMPRESSION_HEADERS
		},
		body: JSON.stringify({ model, input: text, voice, speed })
	});
	if (!resp.ok) {
		const raw = await resp.text().catch(() => "");
		let detail = raw.slice(0, 200) || "(пустой ответ)";
		try {
			const body = JSON.parse(raw);
			detail = body?.error?.message ?? JSON.stringify(body);
		} catch { /* 非 JSON：直接用原文 */ }
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
 * MiMo TTS（chat/completions 协议，2026-09 实测通过）：待合成文本放在一条
 * assistant 消息里，音频参数在 audio 对象（mp3/wav + 预置音色）；返回的
 * 音频 base64 在 choices[0].message.audio.data。baseUrl 填基地址（自动拼
 * /chat/completions）或完整端点均可。
 * @param {string} text - 待合成文本。
 * @param {{baseUrl:string, model:string, apiKey:string, voice?:string}} tts - MiMo TTS 配置。
 * @returns MP3 字节（Buffer）。
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
	// 音色：MiMo 预置音色名（mimo_default/冰糖/茉莉/…）；填了 Edge 音色名则忽略
	const rawVoice = String(tts.voice ?? "").trim();
	const voice = rawVoice && !/Neural$/i.test(rawVoice) ? rawVoice : "mimo_default";
	const result = await postJson(endpoint, {
		"api-key": tts.apiKey,
		Authorization: `Bearer ${tts.apiKey}`
	}, {
		model: tts.model || "mimo-v2.5-tts",
		messages: [
			{ role: "user", content: "Синтезируй текст из сообщения assistant в речь" },
			{ role: "assistant", content: text.slice(0, 2000) }
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

/**
 * 朗读前清洗文本：去掉 markdown / emoji / 特殊装饰符号，压缩重复标点。
 * 保留基本句读（。！？，；：等）用于 edge-tts 断句换气，只去掉"噪音符号"。
 */
function cleanForTts(raw) {
	let t = String(raw ?? "");
	// 代码块整体删除；行内代码去掉反引号、保留内容
	// 未闭合的围栏（LLM 截断的回复常见）也要整段删掉，否则代码会被念出来
	t = t.replace(/```[\s\S]*?```/g, " ");
	t = t.replace(/```[\s\S]*$/, " ");
	t = t.replace(/`([^`]*)`/g, "$1");
	// markdown 链接 [文字](url) → 文字
	t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	// 表格：先整行删分隔行（整行只含 |:- 和空白）、再去行首尾竖线，再处理剩余竖线
	t = t.replace(/^\s*\|?[\s|:-]+\|?\s*$/gm, "");
	t = t.replace(/^\s*\|/gm, "");
	t = t.replace(/\|\s*$/gm, "");
	// markdown 排版符号统一换成空格：# * _ | > ~
	t = t.replace(/[#*_|>~]/g, " ");
	// 列表符（行首 - + / 数字.、)）删除，保留行内容；
	// 数字后的 "、" 是中文序号（2、第二），后面不一定有空格
	t = t.replace(/(^|\n)\s*[-+]\s+/g, "$1");
	t = t.replace(/(^|\n)\s*\d+[.)]\s+/g, "$1");
	t = t.replace(/(^|\n)\s*\d+、\s*/g, "$1");
	// emoji / 装饰符号（表情、符号区、箭头几何、国旗、肤色修饰、变体选择符）
	t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}]/gu, "");
	// 常见杂项符号单字 → 空格
	t = t.replace(/[→←↑↓⇒⇔•·★☆✓✔✗⚠°±×÷√≈≠≤≥]/g, " ");
	// 压缩重复标点：！！！→！，。。。→。，？？？？（半角 , ; : 也算重复噪音）
	t = t.replace(/([。！？，；：、,;:.!?])\1+/g, "$1");
	// 清理多余空白：先去掉行首行尾残留（markdown 符号换成空格会留下单空格），
	// 再压缩行内连续空格与空行
	t = t.replace(/[ \t]*\n[ \t]*/g, "\n");
	t = t.replace(/[ \t]{2,}/g, " ");
	t = t.replace(/\n{3,}/g, "\n\n");
	return t.trim();
}

export function apply(ctx, config) {
	const defaultRewriteModel = resolveLlmModel(config); // 仅在客户端未透传当前对话模型时作 fallback
	const vc = resolveVoiceConfig(config);    // 音色/语速/静音时长/短文阈值/转述开关（行 config 层默认值）
	// ---------- 设置面板覆盖层 ----------
	let savedSettingsPromise = null;
	const ensureSaved = () => {
		if (!savedSettingsPromise) savedSettingsPromise = loadSavedSettings();
		return savedSettingsPromise;
	};
	// 生效 ASR 配置 = 该引擎自己的槽 > 行 config/env 默认 > 引擎内置默认。
	const liveAsr = (saved) => resolveAsrConfig(config, saved);
	const liveSilenceMs = (saved) =>
		Number.isFinite(Number(saved.silenceMs)) && Number(saved.silenceMs) > 0
			? Math.round(Number(saved.silenceMs))
			: vc.silenceMs;
	const liveAutoSend = (saved) => saved.autoSend !== false; // 默认自动发送
	const liveRewrite = (saved) => saved.rewrite === true;    // 转述朗读默认关闭（显式 true 才开启）
	const liveContinuousMode = (saved) => saved.continuousMode === true;
	// 生效热键：设置面板 > 行 config/env > 内置默认；"" = 关闭
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
	// 生效 TTS 配置：每个引擎只读自己的槽，切换引擎互不覆盖。
	const liveTtsEngine = (saved) => resolveTtsEngine(config, saved);
	const liveTts = (saved, engine) =>
		resolveTtsConfig(config, saved, engine ?? liveTtsEngine(saved), vc.voice);
	/**
	 * 按指定 TTS 引擎合成语音（/tts 与 /speak 共用）。
	 * 每个引擎只用自己的槽位配置；MiMo TTS 密钥留空时**只**沿用"MiMo ASR"槽的
	 * 密钥（同一厂商、常常同一把 key），不会借用其它 ASR 引擎的密钥（避免串配置）。
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
		// 微软 Edge TTS（免费，无需密钥）
		const { synthesizeSpeech } = await import("./edge-tts.js");
		return await synthesizeSpeech({ text, voice, rate: vc.rate, pitch: "+0Hz" });
	};
	/** 弹窗回显用：每个引擎的生效槽（缺省补上内置默认，便于用户看到实际会用的值）。 */
const publicSlots = (saved) => buildPublicSlots(config, saved, vc.voice);
	/** Эффективный baseUrl конкретного слота ASR-движка. */
	const asrSlot = (saved, engine) => resolveAsrConfig(config, { ...asRecord(saved), asrEngine: engine }).baseUrl;
	/** Базовый адрес локального движка для маршрутов /local/* (приоритет у ASR-слота). */
	const localSlotUrl = (saved) =>
		asrSlot(saved, "local") || resolveTtsConfig(config, saved, "local").baseUrl;
	// 对外暴露的完整生效设置（弹窗回显用；本机自用工具，密钥原样返回）。
	const publicSettings = (saved) => {
		const asr = liveAsr(saved);
		const ttsEngine = liveTtsEngine(saved);
		const tts = liveTts(saved, ttsEngine);
		const slots = publicSlots(saved);
		return {
			version: VERSION,
			// 语音识别设置（扁平键=当前引擎的生效值，供旧版客户端/兼容读取）
			asrEngine: asr.engine,
			asrBaseUrl: asr.baseUrl,
			asrModel: asr.model,
			asrApiKey: asr.apiKey,
			autoSend: liveAutoSend(saved),
			continuousMode: liveContinuousMode(saved),
			silenceMs: liveSilenceMs(saved),
			asrHotkey: liveHotkey(saved),
			// 朗读设置（扁平键=当前引擎的生效值）
			ttsVoice: tts.voice,
			rewrite: liveRewrite(saved),
			ttsEngine,
			ttsBaseUrl: tts.baseUrl,
			ttsModel: tts.model,
			ttsApiKey: tts.apiKey,
			ratePercent: saved.ratePercent ?? vc.ratePercent,
			speechLang: saved.speechLang ?? "ru-RU",
			// 按引擎隔离的完整槽（新版设置面板按引擎分开回填/保存）
			asrConfig: slots.asr,
			ttsConfig: slots.tts
		};
	};
	// 行激活顺序问题：webServer/llm 可能尚未就绪，必须用 ctx.inject 等服务出现
	// （参照官方客户端包的宿主半身写法，如 dsh-client-ui-theme）。
	// agentDefaultModel 服务（DSH 主界面模型选择器同步的"默认模型"）可选注入：
	// 每次 /speak 时读取当前会话正在用的 provider/model 作为转述模型兜底。
	// sessions 服务(dsh-session SessionStore)：/latest-message 用它按 sessionId
	// 读会话消息(deriveMessages)，避免浏览器端 DOM 扫描。
	ctx.inject(["webServer", "llm", "agentDefaultModel", "sessions"], (httpCtx) => {
		// 解析转述用模型：客户端透传（当前会话实际模型） > 主界面当前选中默认模型 > 配置链
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
			} catch (err) { /* 服务不可用时忽略，走配置链 */ }
			return { provider: "deepseek-official", model: defaultRewriteModel, source: "config" };
		};
		httpCtx.effect(() => {
			const disposers = [];
			// Локальный движок (faster-whisper + Piper)
			let localEngine = null;
			const getLocalEngine = async () => {
				if (!localEngine) {
					const { createLocalEngineManager } = await import("./local-engine.js");
					localEngine = createLocalEngineManager(config);
				}
				return localEngine;
			};
			/** Порт из слота local (127.0.0.1:8765/v1) — чтобы адрес в UI и порт сервера совпадали. */
			/**
			 * Порт из адреса слота (http://127.0.0.1:8765/v1), чтобы адрес в UI
			 * и порт сервера всегда совпадали.
			 */
			const localPortFor = (baseUrl) => localPort(config, baseUrl);
			ensureLocalEngine = async (baseUrl) => {
				const engine = await getLocalEngine();
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
					const engine = await getLocalEngine();
					const status = await engine.status();
					json(res, 200, status);
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/local/install",
				handler: async (req, res) => {
					if (req.method !== "POST") { json(res, 405, { error: "method not allowed" }); return; }
					const engine = await getLocalEngine();
					const saved = await ensureSaved();
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
						const engine = await getLocalEngine();
						const saved = await ensureSaved();
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
					const engine = await getLocalEngine();
					await engine.stop();
					json(res, 200, { ok: true });
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/config",
				handler: async (req, res) => {
					// 把非敏感的运行时配置暴露给浏览器端（静音时长等，已并入面板覆盖层）
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
					asrHotkey: liveHotkey(saved)
					});
				}
			}));
			// 新版 DSH 适配：客户端检测到 session.running true→false 后调这里拿
			// 最新一条 assistant 消息文本(经 sessions 服务读会话,不靠 DOM 扫描)。
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
						// 从后往前找最后一条有文本内容的 assistant 消息
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
						try { payload = JSON.parse(raw || "{}"); } catch { /* 视为空补丁 */ }
						const patch = sanitizeSettings(payload);
						const merged = mergeSettings(await ensureSaved(), patch);
						await writeFile(SETTINGS_FILE, JSON.stringify(merged, null, "\t") + "\n", "utf8");
						savedSettingsPromise = Promise.resolve(merged); // 立即生效，无需重启
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
						const asr = liveAsr(saved);
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
					if (req.method !== "GET") {
						json(res, 405, { error: "method not allowed" });
						return;
					}
					try {
						const url = new URL(req.url ?? "/", "http://dsh-voice-chat");
						const text = (url.searchParams.get("text") ?? "").trim().slice(0, 2000);
						if (!text) {
							json(res, 400, { error: "empty text" });
							return;
						}
						const saved = await ensureSaved();
						// 朗读前清洗：去掉 markdown/emoji/特殊符号，压缩重复标点
						const clean = cleanForTts(text);
						// 按当前 TTS 引擎合成（每个引擎各用自己的槽位配置）
						const audio = await synthesizeByEngine(
							saved,
							liveTtsEngine(saved),
							clean || text,
							url.searchParams.get("voice") ?? ""
						);
						res.writeHead(200, {
							// Piper отдаёт WAV, остальные движки — MP3
							"Content-Type": isLocalEngine(liveTtsEngine(saved)) ? "audio/wav" : "audio/mpeg",
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
						// 1) 决定朗读台词：只许收敛，不许发散。
						//    - 转述开关关闭 → 直接原样读；
						//    - 原文很短（<= shortTextChars 字）：过程性短回复，直接原样读，不劳烦 LLM；
						//    - 原文较长：让转述模型压缩概括，但转述结果必须比原文短或等长，否则退回原文。
						// 转述模型：客户端从当前对话拿到的 provider/model 优先；客户端未透传则
						// 用 DSH 主界面当前选中的默认模型（agentDefaultModel，跟随用户在
						// 界面上的模型选择）；最后才退回 cordis/env 配置链。绝不硬编码
						// deepseek-official——环境里可能根本没配它的 key（如只用 pi-ai）。
						const rewriteSel = resolveRewriteSelection(payload);
						const rewriteProvider = rewriteSel.provider;
						const rewriteModel = rewriteSel.model;
						spoken = original.slice(0, 2000);
						if (liveRewrite(saved) && original.length > vc.shortTextChars) {
							try {
								// 优先用 harness 自带的 LLM（agent 同款模型）做转述
								console.log(`[dsh-voice-chat] speak: rewrite start (original=${original.length} chars, provider=${rewriteProvider}, model=${rewriteModel}, source=${rewriteSel.source})`);
								const rewritten = await rewriteWithHarness(httpCtx, original, rewriteProvider, rewriteModel);
								if (rewritten && rewritten.length <= original.length) {
									spoken = rewritten.slice(0, 2000);
									console.log(`[dsh-voice-chat] speak: rewrite ok (${original.length} -> ${rewritten.length} chars)`);
								} else if (rewritten) {
									console.warn(`[dsh-voice-chat] rewrite longer than original (${rewritten.length} > ${original.length}), keep raw`);
								} else {
									console.warn("[dsh-voice-chat] rewrite returned empty, keep raw");
								}
							} catch (error) {
								// 失败直接降级为原文朗读（不再走外部 LLM）
								console.warn("[dsh-voice-chat] harness rewrite failed, read raw:", error instanceof Error ? error.message : String(error));
							}
						} else {
							console.log(`[dsh-voice-chat] speak: raw read (length=${original.length}, rewrite=${liveRewrite(saved)}, threshold=${vc.shortTextChars})`);
						}
						// 2) 朗读前清洗：去掉 markdown/emoji/特殊符号，压缩重复标点（清洗后为空则退回原台词）
						const cleaned = cleanForTts(spoken);
						if (cleaned) spoken = cleaned;
						// 3) 按当前 TTS 引擎合成（每个引擎各用自己的槽位配置）
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
						// TTS 合成失败时把"实际会朗读的台词"带回（转述成功→口语版；失败/关闭→原文），
						// 浏览器端兜底（浏览器 TTS）优先播它，而不是播没转述过的原文。
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

// ---------- 测试/诊断用导出（纯函数，宿主加载时不执行任何副作用） ----------
export {
	ASR_ENGINE_DEFAULTS,
	ASR_ENGINES,
	TTS_ENGINE_DEFAULTS,
	TTS_ENGINES,
	DEFAULT_HOTKEY,
	buildPublicSlots,
	cleanForTts,
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
