/**
 * Общие константы и чистые функции — БЕЗ зависимостей от Node и от браузера.
 *
 * Зачем отдельный файл. Эти определения нужны серверной половине (lib/index.js)
 * и дублировались в браузерной (lib/client.js). Дубли — источник тихих
 * расхождений: список моделей/голосов, дефолтный порт и разбор сочетания клавиш
 * правились в одном файле и забывались в другом.
 *
 * Про границу с браузером: lib/client.js подключается хостом как
 * window.__ModuleLoader__.load({factory}) и require() у него умеет только
 * пакеты из графа модулей — относительные импорты вида "./shared.js" там
 * не резолвятся. Поэтому клиентская половина остаётся самодостаточной, а
 * паритет её копий с этим файлом закреплён тестом test/shared-parity.test.mjs.
 * Правку вносим здесь и в клиент одновременно.
 *
 * @module dsh-voice-chat/shared
 */

// ---------- Структура настроек ----------

/** Поля, которые могут появиться в слоте asr/tts (остальное отбрасывается при сохранении). */
export const SLOT_FIELDS = {
	asr: ["baseUrl", "model", "apiKey"],
	tts: ["baseUrl", "model", "apiKey", "voice"]
};

// ---------- Базовые утилиты ----------

/** Безопасная строка (null/undefined → ""). */
export function asText(value) {
	return value === undefined || value === null ? "" : String(value).trim();
}

/** Взять обычный объект (null/массив/прочее → пустой объект). */
export function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// ---------- Движки распознавания ----------

/** Встроенные значения по умолчанию для движков ASR (baseUrl — «базовый адрес»). */
export const ASR_ENGINE_DEFAULTS = {
	siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall" },
	groq: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
	mimo: { baseUrl: "https://api.xiaomimimo.com/v1/chat/completions", model: "mimo-v2.5-asr" },
	custom: { baseUrl: "", model: "" },
	browser: { baseUrl: "", model: "" },
	local: { baseUrl: "http://127.0.0.1:8765/v1", model: "small" }
};

export const ASR_ENGINES = ["siliconflow", "groq", "mimo", "custom", "browser", "local"];

/** Человекочитаемые имена движков (для подсказок про запасной ASR). */
export const ASR_ENGINE_LABELS = {
	siliconflow: "SiliconFlow", groq: "Groq", mimo: "MiMo",
	custom: "пользовательский ASR", browser: "браузерный", local: "локальный (faster-whisper)"
};

/** Нормализовать имя движка ASR; неизвестное → "" (считаем «не задано»). */
export function normalizeAsrEngine(value) {
	const s = String(value ?? "").trim().toLowerCase();
	return Object.prototype.hasOwnProperty.call(ASR_ENGINE_DEFAULTS, s) ? s : "";
}

// ---------- Движки озвучки ----------

export const TTS_ENGINES = ["edge", "mimo", "custom", "browser", "local"];

export const TTS_ENGINE_DEFAULTS = {
	edge: { baseUrl: "", model: "", voice: "ru-RU-SvetlanaNeural" },
	mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", voice: "mimo_default" },
	custom: { baseUrl: "", model: "tts-1", voice: "alloy" },
	browser: { baseUrl: "", model: "", voice: "" },
	local: { baseUrl: "http://127.0.0.1:8765/v1", model: "piper", voice: "ru_RU-irina-medium" }
};

/** Предустановленные голоса MiMo TTS (нужны при разборе старых настроек). */
/**
 * Предустановленные голоса MiMo TTS. Имена — китайские, это идентификаторы
 * производителя, а не текст интерфейса: переводить их нельзя, иначе перестанет
 * работать миграция старых настроек (lib/index.js, migrateLegacySettings).
 */
export const MIMO_TTS_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];

/** Нормализовать имя движка TTS; неизвестное → "" (считаем «не задано»). */
export function normalizeTtsEngine(value) {
	const s = String(value ?? "").trim().toLowerCase();
	return TTS_ENGINES.includes(s) ? s : "";
}

// ---------- Локальный движок ----------

/**
 * Локальный движок (faster-whisper + Piper на 127.0.0.1): ключей не имеет,
 * поэтому проверки «настроен ли API-ключ» для него неприменимы.
 */
export function isLocalEngine(engine) {
	return String(engine ?? "").trim().toLowerCase() === "local";
}

/** Браузерный движок: работает целиком в браузере, сервер в нём не участвует. */
export function isBrowserEngine(engine) {
	return String(engine ?? "").trim().toLowerCase() === "browser";
}

/** Модели faster-whisper, которые принимает локальный сервер (см. SUPPORTED_WHISPER_MODELS). */
export const LOCAL_ASR_MODELS = ["tiny", "base", "small", "medium", "large-v3"];
/** Голоса Piper, которые принимает локальный сервер (см. SUPPORTED_PIPER_VOICES). */
export const LOCAL_TTS_VOICES = ["ru_RU-irina-medium", "ru_RU-ruslan-medium", "ru_RU-dmitri-medium", "ru_RU-denis-medium"];
/** Порт локального сервера по умолчанию. */
export const DEFAULT_LOCAL_PORT = 8765;

/** Порт из адреса слота local ("http://127.0.0.1:8765/v1" → 8765). */
export function localPortFromUrl(url) {
	const m = /127\.0\.0\.1:(\d+)|localhost:(\d+)/.exec(String(url ?? ""));
	return m ? String(Number(m[1] ?? m[2])) : String(DEFAULT_LOCAL_PORT);
}

/** Адрес слота local из порта; дефолтный порт → "" (работает встроенное значение). */
export function localUrlFromPort(port) {
	const n = Number(port);
	return Number.isFinite(n) && n > 0 && n !== DEFAULT_LOCAL_PORT
		? `http://127.0.0.1:${n}/v1`
		: "";
}

// ---------- Клавиша запуска распознавания ----------

/** Клавиша запуска распознавания по умолчанию — правый Ctrl (удобно держать большим пальцем). */
export const DEFAULT_HOTKEY = "ControlRight";

/** Коды одиночных модификаторов (левый/правый) — их можно использовать сами по себе. */
export const SOLO_MODIFIER_CODES = new Set([
	"ControlLeft", "ControlRight",
	"ShiftLeft", "ShiftRight",
	"AltLeft", "AltRight",
	"MetaLeft", "MetaRight",
	"OSLeft", "OSRight"
]);

/** Текстовые синонимы клавиш (чтобы «Ctrl + space» и Ctrl+Space совпадали). */
export const KEY_ALIASES = {
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
export function canonicalKeyName(code, key) {
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
export function normalizeHotkey(value) {
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
export function hotkeyFromEvent(event) {
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
export function hotkeyLabel(value) {
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

// ---------- Протоколы движков ----------

/**
 * baseUrl заканчивается на /chat/completions → работаем по chat-протоколу (как у MiMo).
 * Живёт здесь, потому что на это правило опираются и разбор адреса движка
 * (lib/engines/asr.js), и миграция старых настроек (lib/settings.js).
 */
export const CHAT_ASR_URL_RE = /\/chat\/completions\/?$/i;

// ---------- Текст для озвучки ----------

/**
 * Убрать из ответа разметку перед чтением вслух: markdown, эмодзи, таблицы,
 * списки, повторные знаки препинания. Пустая строка = читать нечего.
 */
export function cleanForTts(raw) {
	let t = String(raw ?? "");
	// Блоки кода удаляем целиком; из инлайнового кода убираем обратные кавычки,
	// содержимое сохраняем. Незакрытая ограда кода (частое дело при обрезанном ответе LLM)
	// тоже вырезаем целиком, иначе код вслух произносится.
	t = t.replace(/```[\s\S]*?```/g, " ");
	t = t.replace(/```[\s\S]*$/, " ");
	t = t.replace(/`([^`]*)`/g, "$1");
	// markdown-ссылки [текст](url) → текст
	t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	// Таблицы: сначала удаляем строки-разделители (строка состоит только из |:- и
	// пробелов), затем убираем вертикальные черты по краям, потом остальные
	t = t.replace(/^\s*\|?[\s|:-]+\|?\s*$/gm, "");
	t = t.replace(/^\s*\|/gm, "");
	t = t.replace(/\|\s*$/gm, "");
	// Служебные символы разметки заменяем пробелами: # * _ | > ~
	t = t.replace(/[#*_|>~]/g, " ");
	// Маркеры списков (в начале строки - + или цифра со знаком . / ) / 、) убираем,
	// текст строки сохраняем. «、» после цифры — это китайская нумерация
	// (2.、вторая), после неё пробела может не быть.
	t = t.replace(/(^|\n)\s*[-+]\s+/g, "$1");
	t = t.replace(/(^|\n)\s*\d+[.)]\s+/g, "$1");
	t = t.replace(/(^|\n)\s*\d+、\s*/g, "$1");
	// Эмодзи и декоративные символы (эмоции, знаковые блоки, стрелки, флаги,
	// модификаторы тона кожи, варианты отображения)
	t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}]/gu, "");
	// Прочие одиночные символы → пробел
	t = t.replace(/[→←↑↓⇒⇔•·★☆✓✔✗⚠°±×÷√≈≠≤≥]/g, " ");
	// Сжимаем повторные знаки препинания: ！！！→！，。。。→。，？？？？
	// (повторы полуширинных , ; : тоже считаются шумом)
	t = t.replace(/([。！？，；：、,;:.!?])\1+/g, "$1");
	// Чистим лишние пробелы: сначала убираем остатки по краям строк (замена
	// символов разметки на пробелы оставляет одиночные пробелы), затем
	// схлопываем повторные пробелы внутри строк и пустые строки.
	t = t.replace(/[ \t]*\n[ \t]*/g, "\n");
	t = t.replace(/[ \t]{2,}/g, " ");
	t = t.replace(/\n{3,}/g, "\n\n");
	return t.trim();
}
