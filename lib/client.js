window.__ModuleLoader__.load({
	id: "dsh-voice-chat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let React = require("react");
		const { useState, useEffect, useRef, useCallback } = React;

		// ---------- Помощники модуля ----------
		/** Безопасная строка (null/undefined → ""). */
		function asText(value) {
			return value === undefined || value === null ? "" : String(value).trim();
		}

				/** Извлекает чистый текст из блоков содержимого (совместимо с wire-слоем {type:'text'} и UI-слоем {kind:'text'}). */
		function extractText(blocks) {
			if (!Array.isArray(blocks)) return "";
			return blocks
				.filter((b) => b && (b.type === "text" || b.kind === "text") && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n")
				.trim();
		}

				/** Выбирает доступный mimeType для записи. */
		function pickMime() {
			if (typeof MediaRecorder === "undefined") return "";
			const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
			for (const m of candidates) {
				if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
			}
			return "";
		}

		/** Встроенные значения по умолчанию для движков ASR (совпадают с серверными ASR_ENGINE_DEFAULTS; нужны только для плейсхолдеров и переключения движков). */
	const ASR_ENGINE_DEFAULTS = {
		siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall" },
		groq: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
		mimo: { baseUrl: "https://api.xiaomimimo.com/v1/chat/completions", model: "mimo-v2.5-asr" },
		custom: { baseUrl: "", model: "" },
		browser: { baseUrl: "", model: "" },
		local: { baseUrl: "http://127.0.0.1:8765/v1", model: "small" }
	};
	const ASR_ENGINES = ["siliconflow", "groq", "mimo", "custom", "browser", "local"];
	/** Человекочитаемые имена движков (для подсказок про запасной ASR). */
	const ASR_ENGINE_LABELS = {
		siliconflow: "SiliconFlow", groq: "Groq", mimo: "MiMo",
		custom: "пользовательский ASR", browser: "браузерный", local: "локальный (faster-whisper)"
	};
	/** Модели faster-whisper, принимаемые локальным сервером (см. lib/index.js LOCAL_ASR_MODELS). */
	const LOCAL_ASR_MODELS = ["tiny", "base", "small", "medium", "large-v3"];
	/** Голоса Piper, принимаемые локальным сервером. */
	const LOCAL_TTS_VOICES = ["ru_RU-irina-medium", "ru_RU-ruslan-medium", "ru_RU-dmitri-medium", "ru_RU-denis-medium"];
	/** Порт локального сервера по умолчанию. */
	const DEFAULT_LOCAL_PORT = 8765;

	/**
	 * Порт из адреса слота local ("http://127.0.0.1:8765/v1" → 8765).
	 * Пользователю показываем только порт: сам адрес собирается плагином.
	 */
	function localPortFromUrl(url) {
		const m = /127\.0\.0\.1:(\d+)|localhost:(\d+)/.exec(String(url ?? ""));
		return m ? String(Number(m[1] ?? m[2])) : String(DEFAULT_LOCAL_PORT);
	}

	/** Адрес слота local из порта; дефолтный порт → "" (работает встроенное значение). */
	function localUrlFromPort(port) {
		const n = Number(port);
		return Number.isFinite(n) && n > 0 && n !== DEFAULT_LOCAL_PORT
			? `http://127.0.0.1:${n}/v1`
			: "";
	}
		/** Встроенные значения по умолчанию для движков TTS (совпадают с серверными TTS_ENGINE_DEFAULTS; нужны для плейсхолдеров и подсказок к полям). */
	const TTS_ENGINE_DEFAULTS = {
		edge: { baseUrl: "", model: "", voice: "ru-RU-SvetlanaNeural" },
		mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", voice: "mimo_default" },
		custom: { baseUrl: "", model: "tts-1", voice: "alloy" },
		browser: { baseUrl: "", model: "", voice: "" },
		local: { baseUrl: "http://127.0.0.1:8765/v1", model: "piper", voice: "ru_RU-irina-medium" }
	};
	const TTS_ENGINES = ["edge", "mimo", "custom", "browser", "local"];
				/** Поля, редактируемые в панели настроек (у ASR и TTS настроек "по одному на движку" — они не смешиваются). */
		const SLOT_FIELDS = {
			asr: ["baseUrl", "model", "apiKey"],
			tts: ["baseUrl", "model", "apiKey", "voice"]
		};

				/** Создаёт пустую структуру слотов "по одному на движку". */
		function emptySlots(group) {
			const engines = group === "asr" ? ASR_ENGINES : TTS_ENGINES;
			const out = {};
			for (const engine of engines) out[engine] = {};
			return out;
		}

		/**
		 		 * Читаем слоты "по одному на движку" из ответа хоста /settings:
		 		 *   новый хост отдаёт asrConfig/ttsConfig (конфигурацию каждого движка);
		 		 *   старый хост (без этих полей) — плоские ключи (ttsBaseUrl…) считаются
		 		 *   значениями слота текущего движка.
		 */
		function slotsFromSettings(settings, group) {
			const src = settings && typeof settings === "object" ? settings : {};
			const engines = group === "asr" ? ASR_ENGINES : TTS_ENGINES;
			const slotKey = group === "asr" ? "asrConfig" : "ttsConfig";
			const rawSlots = src[slotKey];
			const hasSlots = rawSlots && typeof rawSlots === "object";
			const current = String(group === "asr" ? (src.asrEngine || "siliconflow") : (src.ttsEngine || "edge"));
			const out = {};
			for (const engine of engines) {
				const slot = hasSlots && rawSlots[engine] && typeof rawSlots[engine] === "object" ? rawSlots[engine] : {};
				out[engine] = {};
				for (const field of SLOT_FIELDS[group]) {
					// Фолбэк для старого хоста: плоские ключи относятся только к "движку, выбранному в данный момент", чтобы не принять их за общие для всех
					const flat = !hasSlots && engine === current
						? src[`${group}${field[0].toUpperCase()}${field.slice(1)}`]
						: "";
					out[engine][field] = typeof slot[field] === "string" && slot[field] !== ""
						? slot[field]
						: (typeof flat === "string" ? flat : "");
				}
			}
			return out;
		}

				/** Проверяет, используют ли действующие настройки ASR протокол chat/completions (в стиле MiMo, только wav/mp3). */
		function isChatAsrSettings(s) {
			if (!s || typeof s !== "object") return false;
			if (s.asrEngine === "mimo") return true;
			return /\/chat\/completions\/?$/i.test(String(s.asrBaseUrl || ""));
		}

		/**
		 		 * В браузере конвертируем запись (webm/ogg/mp4) в WAV 16 кГц, моно, 16 бит:
		 		 * ASR с chat-протоколом (MiMo и подобные) принимает только wav/mp3; декодирование
		 * и передискретизация — штатными API Web Audio, без внешних библиотек.
		 */
		async function blobToWav(blob) {
			const arr = await blob.arrayBuffer();
			const AudioCtx = window.AudioContext || window.webkitAudioContext;
			const decodeCtx = new AudioCtx();
			let audioBuf;
			try {
				audioBuf = await decodeCtx.decodeAudioData(arr);
			} finally {
				try { decodeCtx.close(); } catch (err) { /* ignore */ }
			}
			const rate = 16000;
			const frames = Math.max(1, Math.ceil(audioBuf.duration * rate));
			const off = new OfflineAudioContext(1, frames, rate);
			const src = off.createBufferSource();
			src.buffer = audioBuf;
			src.connect(off.destination);
			src.start(0);
			const rendered = await off.startRendering();
			const ch = rendered.getChannelData(0);
			const len = ch.length;
			const buf = new ArrayBuffer(44 + len * 2);
			const view = new DataView(buf);
			const wstr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
			wstr(0, "RIFF"); view.setUint32(4, 36 + len * 2, true); wstr(8, "WAVE");
			wstr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
			view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
			wstr(36, "data"); view.setUint32(40, len * 2, true);
			let o = 44;
			for (let i = 0; i < len; i++, o += 2) {
				const s = Math.max(-1, Math.min(1, ch[i]));
				view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
			}
			return new Blob([buf], { type: "audio/wav" });
		}

		/**
		 		 * Адаптация к новому DSH (0.1.2-rc.1): в session нет списка сообщений — сообщения
		 		 * лежат в отдельном conversation store (слоту плагина он недоступен). Текст
		 		 * последнего ответа ассистента берём из DOM: чат рендерится в порядке документа,
		 		 * чем ниже — тем свежее; исключаем поле ввода, боковую панель и контейнеры с
		 */
		function extractLatestAssistantText() {
			try {
				const all = document.querySelectorAll("div,article,section,p");
				let last = null;
				for (const el of all) {
					const t = (el.textContent || "").trim();
					if (t.length < 2 || t.length > 6000) continue;    // Только пустой текст и слишком крупные контейнеры
					if (el.children.length > 15) continue;
					if (el.offsetHeight < 10) continue;
					// Исключаем поле ввода (с редактором/текстовым полем) и навигацию/боковую панель
					if (el.querySelector("textarea,input,[contenteditable='true'],[role='textbox']")) continue;
					const cls = String(el.className || "") + " " + String(el.id || "");
					if (/composer|inputBar|input-bar|sidebar|settings|toolbar|header|footer|hero|nav/i.test(cls)) continue;
					last = el;
				}
				if (!last) return null;
				return (last.textContent || "").trim().slice(0, 5000);
			} catch (err) {
				console.warn("[dsh-voice-chat] не удалось извлечь текст из DOM:", err);
				return null;
			}
		}

		// ---------- Плоские SVG-иконки (стиль Feather, линейная обводка, цвет из currentColor) ----------
		const ICON_MIC = [
			"M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z",
			"M19 10v2a7 7 0 0 1-14 0v-2",
			"M12 19v4",
			"M8 23h8"
		];
		const ICON_SPEAKER = [
			"M11 5L6 9H2v6h4l5 4V5z",
			"M15.54 8.46a5 5 0 0 1 0 7.07",
			"M19.07 4.93a10 10 0 0 1 0 14.14"
		];
		const ICON_MUTED = [
			"M11 5L6 9H2v6h4l5 4V5z",
			"M23 9l-6 6",
			"M17 9l6 6"
		];
				/** Рисует линейную SVG-иконку 24x24. */
		function Icon({ paths, size = 16 }) {
			return React.createElement("svg", {
				viewBox: "0 0 24 24",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, paths.map((d, i) => React.createElement("path", { key: i, d })));
		}

		// ---------- Страница настроек (категория settings.section во встроенном диалоге настроек DSH) ----------
	// Популярные голоса Edge TTS (можно вручную ввести любое имя voice)
	const VOICE_PRESETS = [
		"ru-RU-SvetlanaNeural",   // Светлана (жен., по умолчанию)
		"ru-RU-DmitryNeural",     // Дмитрий (муж.)
		"zh-CN-XiaoxiaoNeural",   // Сяосяо (жен.)
		"zh-CN-YunxiNeural",      // Юньси (муж.)
		"zh-CN-YunyangNeural",    // Юньян (муж., новости)
		"zh-CN-YunjianNeural",    // Юньцзянь (муж.)
		"zh-CN-XiaoyiNeural",     // Сяои (жен.)
		"zh-HK-HiuMaanNeural",    // кантонский Хиуман
		"zh-TW-HsiaoChenNeural",  // тайваньская Сяочэнь
		"en-US-AriaNeural",
		"en-US-GuyNeural",
		"ja-JP-NanamiNeural"
	];
		// Предустановленные голоса MiMo TTS (допустимые значения для mimo-v2.5-tts; пусто — значит mimo_default)
		const MIMO_TTS_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];

		// ---------- Клавиша/сочетание для запуска распознавания ----------
		// По умолчанию — правый Ctrl: держится большим пальцем, не конфликтует
		// с Ctrl+C/Ctrl+V (левый Ctrl) и не мешает печатать.
		// Настройки хранятся канонической строкой ("ControlRight", "Ctrl+Shift+Space").
		// Пустая строка = горячая клавиша выключена. Логика продублирована в
		// lib/index.js (браузерный модуль не может импортировать серверный код).
		const DEFAULT_HOTKEY = "ControlRight";
		/** Коды одиночных модификаторов: их можно использовать сами по себе. */
		const SOLO_MODIFIER_CODES = new Set([
			"ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
			"AltLeft", "AltRight", "MetaLeft", "MetaRight", "OSLeft", "OSRight"
		]);
		const HOTKEY_MOD_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];
		/** Коды одиночных модификаторов в любом регистре: "controlright" → "ControlRight". */
		const SOLO_MODIFIER_BY_LOWER = new Map(
			[...SOLO_MODIFIER_CODES].map((code) => [code.toLowerCase(), code])
		);

		/** Текстовые синонимы клавиш (чтобы «Ctrl + space» и Ctrl+Space совпадали). */
		const HOTKEY_KEY_ALIASES = {
			space: "Space", spacebar: "Space", esc: "Escape", escape: "Escape",
			enter: "Enter", return: "Enter", tab: "Tab", backspace: "Backspace",
			del: "Delete", delete: "Delete", up: "ArrowUp", down: "ArrowDown",
			left: "ArrowLeft", right: "ArrowRight"
		};

		/** Код клавиши → каноническое имя: KeyM→M, Digit1→1, пробел→Space. */
		function hotkeyKeyName(code, key) {
			if (SOLO_MODIFIER_CODES.has(code)) return code;
			if (SOLO_MODIFIER_BY_LOWER.has(String(code).toLowerCase())) return SOLO_MODIFIER_BY_LOWER.get(String(code).toLowerCase());
			if (/^Key[A-Z]$/.test(code)) return code.slice(3);
			if (/^Digit\d$/.test(code)) return code.slice(5);
			if (/^Numpad\d$/.test(code)) return "Num" + code.slice(6);
			const raw = String(key ?? "");
			const alias = HOTKEY_KEY_ALIASES[raw.toLowerCase()];
			if (alias) return alias;
			const k = raw === " " ? "Space" : raw;
			if (k.length === 1) return k.toUpperCase();
			return k || code || "";
		}

		/** Событие клавиатуры → каноническая строка сочетания (null — не годится). */
		function hotkeyFromEvent(event) {
			if (!event) return null;
			const code = String(event.code ?? "");
			if (SOLO_MODIFIER_CODES.has(code)) return code;
			const key = hotkeyKeyName(code, event.key);
			if (!key) return null;
			const mods = [];
			if (event.ctrlKey) mods.push("Ctrl");
			if (event.altKey) mods.push("Alt");
			if (event.shiftKey) mods.push("Shift");
			if (event.metaKey) mods.push("Meta");
			return [...mods, key].join("+");
		}

		/** Разбирает сохранённую строку в { mods, key } (key === null → выключено). */
		function parseHotkey(combo) {
			const parts = String(combo ?? "").split("+").map((p) => p.trim()).filter(Boolean);
			if (!parts.length) return { mods: [], key: null };
			const key = parts[parts.length - 1];
			return {
				mods: HOTKEY_MOD_ORDER.filter((m) => parts.includes(m)),
				key: SOLO_MODIFIER_CODES.has(key) ? key : hotkeyKeyName(key, key)
			};
		}

		/** Совпадает ли событие с сохранённым сочетанием. */
		function hotkeyMatches(event, combo) {
			const target = parseHotkey(combo);
			if (!target.key) return false;
			const mods = [];
			if (event.ctrlKey) mods.push("Ctrl");
			if (event.altKey) mods.push("Alt");
			if (event.shiftKey) mods.push("Shift");
			if (event.metaKey) mods.push("Meta");
			// У одиночного модификатора остальные нажатые клавиши не важны
			if (SOLO_MODIFIER_CODES.has(target.key)) {
				return String(event.code ?? "") === target.key;
			}
			const key = hotkeyKeyName(event.code, event.key);
			if (key !== target.key) return false;
			if (mods.length !== target.mods.length) return false;
			return mods.every((m) => target.mods.includes(m));
		}

		/** Человекочитаемое имя сочетания для подписи в настройках. */
		function hotkeyLabel(combo) {
			if (!combo) return "не задана";
			const names = {
				Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Cmd",
				Space: "Пробел", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓",
				ArrowLeft: "←", ArrowRight: "→",
				ControlLeft: "Левый Ctrl", ControlRight: "Правый Ctrl",
				ShiftLeft: "Левый Shift", ShiftRight: "Правый Shift",
				AltLeft: "Левый Alt", AltRight: "Правый Alt",
				MetaLeft: "Левый Cmd", MetaRight: "Правый Cmd",
				OSLeft: "Левый Win", OSRight: "Правый Win"
			};
			return String(combo).split("+").map((part) => names[part] ?? part).join(" + ");
		}

		/**
		 * Причины отказа Web Speech API переводим в человеческий текст.
		 * Браузер отдаёт коды дословно ("network", "not-allowed", …), и без перевода
		 * в подсказке остаётся только «network» — оттуда и ощущение, что плагин сломан.
		 * Самый частый случай — именно "network": Chrome отправляет звук на серверы
		 * Google, и там, где они недоступны, распознавание невозможно, даже если API есть.
		 */
		function browserAsrErrorHint(code) {
			const known = {
				"no-speech": "не услышано речи",
				"audio-capture": "нет доступа к микрофону",
				"not-allowed": "микрофон запрещён (разрешение браузера) либо API отключён политикой",
				"service-not-allowed": "сервис распознавания запрещён для этой страницы (обычно нужно HTTPS)",
				"language-not-supported": "язык не поддерживается сервисом распознавания",
				"aborted": "сеанс прерван",
				"network": "нет связи с серверами распознавания (Chrome передаёт звук в Google)"
			};
			const why = known[String(code || "")] || String(code || "неизвестная ошибка");
			return "Распознавание в браузере не удалось: " + why;
		}

		/** Что можно сказать об окружении без запуска распознавания. */
		function browserAsrSupport() {
			const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
			if (!SR) {
				return { ok: false, reason: "в этом браузере нет SpeechRecognition (Electron, сборки Chromium без Google Speech)" };
			}
			if (typeof window.isSecureContext === "boolean" && !window.isSecureContext) {
				return { ok: false, reason: "страница открыта не по HTTPS — сервис распознавания браузер запрещает" };
			}
			if (typeof navigator !== "undefined" && navigator.mediaDevices
				&& !navigator.mediaDevices.getUserMedia) {
				return { ok: false, reason: "браузер не даёт доступ к микрофону (нужен HTTPS или localhost)" };
			}
			return { ok: true, reason: "API есть; звук уходит на серверы Google — нужна связь с ними" };
		}

		const SECTION_STYLES = {
			wrap: {
				maxWidth: 560, paddingTop: 10, boxSizing: "border-box",
				fontFamily: "inherit", fontSize: 13,
				color: "var(--dsw-alias-label-primary, #f0f0f0)",
				textAlign: "left"
			},
			h: { margin: "0 0 2px", fontSize: 16, fontWeight: 600 },
			sub: { margin: "0 0 14px", fontSize: 12, opacity: 0.6 },
			label: { display: "block", margin: "12px 0 4px", opacity: 0.85 },
			input: {
				width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2, #555)",
				background: "rgba(127,127,127,0.12)", color: "inherit",
				fontSize: 13, outline: "none"
			},

			checkRow: { display: "flex", alignItems: "center", gap: 8, margin: "14px 0 2px", cursor: "pointer" },
			note: { marginTop: 3, fontSize: 11, lineHeight: 1.5, opacity: 0.55 },
			err: { marginTop: 10, color: "#ff8a8a", fontSize: 12 },
			saveRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 18 },
			primary: {
				padding: "6px 18px", borderRadius: 8, border: "none", cursor: "pointer",
				fontSize: 13, background: "#4c7dff", color: "#fff"
			},
			status: { fontSize: 12, opacity: 0.85 },
			secondary: {
				padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12,
				background: "rgba(127,127,127,0.2)", color: "inherit",
				border: "1px solid var(--dsw-alias-border-l2, #555)"
			},
			localBox: {
				marginTop: 12, padding: "10px 12px", borderRadius: 8, fontSize: 12, lineHeight: 1.6,
				background: "rgba(127,127,127,0.1)",
				border: "1px solid var(--dsw-alias-border-l2, #555)"
			}
		};

		/** Размер в человекочитаемом виде: 1.5 ГБ, 482 МБ. */
		function formatBytes(bytes) {
			const n = Number(bytes) || 0;
			if (n <= 0) return "0 МБ";
			if (n >= 1e9) return (n / 1e9).toFixed(2) + " ГБ";
			if (n >= 1e6) return Math.round(n / 1e6) + " МБ";
			if (n >= 1e3) return Math.round(n / 1e3) + " КБ";
			return n + " Б";
		}

		/** Фазы установки локального движка → текст для UI. */
		const LOCAL_INSTALL_STAGES = {
			python: "скачивание Python…",
			venv: "установка зависимостей (faster-whisper, piper-tts) — несколько минут…",
			models: "загрузка моделей (Piper ru_RU-irina-medium, faster-whisper) — до ~2 ГБ…"
		};

		/**
		 * Блок управления локальным движком (faster-whisper + Piper): статус +
		 * кнопки «Установить» / «Запустить» / «Остановить» / «Обновить».
		 * Сервер и так поднимается автоматически перед первым запросом, кнопки нужны
		 * для установки, диагностики и ручного управления. Пока идёт установка или
		 * сервер не отвечает — статус опрашивается раз в 2 с.
		 */
		function LocalEngineBox(props) {
			const [state, setState] = useState(null); // объект статуса от /local/status
			const [busy, setBusy] = useState("");
			const [err, setErr] = useState("");
			const [confirmRemove, setConfirmRemove] = useState(false); // первый клик — спросить, второй — снести
			const [note, setNote] = useState("");

			const refresh = useCallback(async () => {
				try {
					const resp = await window.fetch("/dsh-voice-chat/local/status");
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
					setState(data);
					setErr("");
				} catch (e) {
					setErr("Статус недоступен: " + (e && e.message ? e.message : String(e)));
				}
			}, []);

			const call = useCallback(async (path, label) => {
				setBusy(label);
				setErr("");
				try {
					const resp = await window.fetch("/dsh-voice-chat/local/" + path, { method: "POST" });
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
					setState(data.status || null);
					await refresh();
				} catch (e) {
					setErr((e && e.message ? e.message : String(e)));
				} finally {
					setBusy("");
					await refresh();
				}
			}, [refresh]);

			useEffect(() => { refresh(); }, [refresh]);
			// Сбрасываем подтверждение, если окружение уже удалили или переустановили
			useEffect(() => {
				if (!state) return;
				if (!state.hasFiles && confirmRemove) setConfirmRemove(false);
			}, [state]);
			useEffect(() => { if (!note) return; const t = window.setTimeout(() => setNote(""), 6000); return () => window.clearTimeout(t); }, [note]);
			// Во время установки/отсутствия сервера опрашиваем статус чаще
			useEffect(() => {
				if (!state) return;
				if (!state.installing && state.serverRunning) return;
				const t = window.setInterval(refresh, 2000);
				return () => window.clearInterval(t);
			}, [state, refresh]);

			const installed = !!(state && state.venvReady && state.modelsReady);
			/** Удалять есть что: на диске лежит хоть один из компонентов окружения. */
			const hasFiles = !!(state && state.hasFiles);

			/** Удаление одной скачанной модели (голос Piper или снапшот whisper). */
			const removeOneModel = async (id) => {
				setBusy("model");
				setErr("");
				try {
					const resp = await window.fetch("/dsh-voice-chat/local/remove-model?id=" + encodeURIComponent(id), { method: "POST" });
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
					setNote("Удалено: " + (data.name || id) + " (" + formatBytes(data.freedBytes) + ")");
					setState(data.status || null);
				} catch (e) {
					setErr("Не удалось удалить модель: " + (e && e.message ? e.message : String(e)));
				} finally {
					setBusy("");
					await refresh();
				}
			};

			/** Подпись переключателя сервера: что он сделает при следующем клике. */
			const serverBusyLabel = () => {
				if (busy === "start") return "Запуск…";
				if (busy === "stop") return "Остановка…";
				if (state?.serverRunning) return state.external ? "Сервер запущен вне плагина" : "Остановить сервер";
				return "Запустить сервер";
			};

			/** Переключатель: работает → стоп, не работает → старт. */
			const toggleServer = async () => {
				if (!state) return;
				await call(state.serverRunning ? "stop" : "start", state.serverRunning ? "stop" : "start");
			};

			/** Первый клик спрашивает, второй удаляет — случайно не снесём гигабайты. */
			const removeAll = async () => {
				if (!confirmRemove) { setConfirmRemove(true); return; }
				setBusy("remove");
				setErr("");
				setConfirmRemove(false);
				try {
					const resp = await window.fetch("/dsh-voice-chat/local/remove", { method: "POST" });
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
					const removed = (data.removed || []).join(", ") || "ничего";
					setNote("Удалено: " + removed);
					setState(data.status || null);
				} catch (e) {
					setErr("Не удалось удалить: " + (e && e.message ? e.message : String(e)));
				} finally {
					setBusy("");
					await refresh();
				}
			};
			/**
			 * Докачать выбранную модель faster-whisper. Сервер берёт модель из
			 * настроек, поэтому переключение модели без скачивания означало бы
			 * запрос к модели, которой на диске нет.
			 */
			const downloadCurrentModel = async () => {
				const model = (state && state.whisperModel) || "small";
				setBusy("model");
				setErr("");
				try {
					const resp = await window.fetch("/dsh-voice-chat/local/download-model?model=" + encodeURIComponent(model), { method: "POST" });
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
					setNote(data.alreadyDownloaded
						? "Модель " + model + " уже скачана"
						: "Модель " + model + " скачана");
					setState(data.status || null);
				} catch (e) {
					setErr("Не удалось скачать модель: " + (e && e.message ? e.message : String(e)));
				} finally {
					setBusy("");
					await refresh();
				}
			};

			const lines = [];
			if (state) {
				if (state.installing) {
					lines.push("⏳ Установка: " + (LOCAL_INSTALL_STAGES[state.installStage] || state.installStage || "…"));
				}
				lines.push((state.pythonReady ? "✓" : "✗") + " Python: " + (state.pythonPath || "не найден (нуден python3)"));
				// venv существует и пакеты импортируются — это разные вещи, проверяем обе
				if (!state.venvReady) {
					lines.push("✗ Зависимости: venv не создан");
				} else if (state.depsReady === true) {
					lines.push("✓ Зависимости: venv + faster-whisper + piper-tts импортируются");
				} else if (state.depsReady === false) {
					lines.push("✗ Зависимости: venv есть, но faster-whisper / piper-tts не импортируются"
						+ (state.depsError ? " (" + String(state.depsError).slice(-160) + ")" : ""));
				} else {
					lines.push("… Зависимости: проверка импорта…");
				}
				lines.push((state.modelsReady ? "✓" : "✗") + " Модели: faster-whisper "
				+ (state.whisperModel || (ASR_ENGINE_DEFAULTS.local || {}).model || "small")
				+ ", голос Piper " + (state.piperVoice || "ru_RU-irina-medium"));
				lines.push((state.serverRunning ? "✓" : "✗")
					+ " Сервер: " + (state.serverRunning ? ("работает на порту " + (state.port ?? "—") + (state.pid ? " (pid " + state.pid + ")" : "")) : "не запущен"));
				lines.push("Каталог данных: " + (state.dataDir || "—"));
				if (state.installError) lines.push("Ошибка установки: " + state.installError);
				if (state.error) lines.push("Замечание: " + state.error);
				if (state.logFile) lines.push("Лог установки: " + state.logFile);
			} else if (!err) {
				lines.push("Статус загружается…");
			}

			// Скачанные модели: пользователь мог накачать несколько, и удалять их надо
			// поштучно — показываем, что именно лежит и сколько места занимает каждый пункт
			const models = Array.isArray(state?.models) ? state.models : [];
			const modelsBlock = models.length
				? React.createElement("div", { style: { marginTop: 10 } },
					React.createElement("div", { style: { fontSize: 12, opacity: 0.85, marginBottom: 4 } },
						"Скачанные модели — всего " + formatBytes(state.modelsBytes) + ". Лишние можно удалить здесь:"),
					models.map((m) => React.createElement("div", {
						key: m.id,
						style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginTop: 4 }
					},
						React.createElement("span", {
							style: { fontFamily: "monospace", flex: 1, whiteSpace: "pre-wrap" }
						}, (m.inUse ? "● " : "○ ") + m.name + " · " + formatBytes(m.bytes)),
						React.createElement("span", { style: SECTION_STYLES.note },
							m.inUse ? "используется сейчас" : ""),
						React.createElement("button", {
							type: "button",
							style: { ...SECTION_STYLES.secondary, color: "#ff9a9a", borderColor: "#7a3b3b", padding: "2px 10px" },
							disabled: !!busy,
							onClick: () => removeOneModel(m.id),
							title: "Удалить только " + m.name + " (" + formatBytes(m.bytes) + ")"
						}, "Удалить")
					)),
					React.createElement("div", { style: SECTION_STYLES.note },
						"● — текущая выбранная модель, её удалять смысла нет: движок не запустится, "
						+ "пока не поставите заново. ○ — можно убрать сразу, место освободится.")
				)
				: null;

			return React.createElement("div", { style: SECTION_STYLES.localBox },
				React.createElement("div", { style: { opacity: 0.85, marginBottom: 6 } },
					"Офлайн-движок (Piper + faster-whisper). Всё считается на вашей машине, ключи не нужны. "
					+ "Сервер поднимается сам при первом запросе — кнопка «Установить» нужна один раз."),
				lines.map((line, i) => React.createElement("div", { key: "l" + i, style: { fontFamily: "monospace", whiteSpace: "pre-wrap" } }, line)),
				modelsBlock,
				React.createElement("div", { style: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" } },
					React.createElement("button", {
						type: "button", style: SECTION_STYLES.primary,
						// Во время установки кнопка неактивна: install() и так single-flight,
						// но лишний клик только пугает пользователя
						disabled: !!busy || !!state?.installing || installed,
						onClick: () => call("install", "install")
					}, state?.installing || busy === "install"
						? "Установка…"
						: (installed ? "Установлено" : "Установить локальный движок")),
				// Докачать выбранную модель: переключили модель распознавания уже
				// после установки — без этой кнопки /stt ушёл бы на сервер с моделью,
				// которой на диске нет. Раньше такой кнопки не было вовсе.
				React.createElement("button", {
					type: "button",
					style: SECTION_STYLES.secondary,
					disabled: !!busy || !state?.venvReady || state?.modelsReady === true,
					onClick: downloadCurrentModel,
					title: "Скачать faster-whisper " + (state?.whisperModel || "small")
						+ " (если её ещё нет на диске)"
				}, busy === "model" ? "Скачивание…" : "Докачать модель"),
					// Одна кнопка на состояние: сервер поднимается сам при первом
					// запросе, так что ручное управление — для диагностики и экономии
					React.createElement("button", {
						type: "button",
						style: state?.serverRunning ? SECTION_STYLES.secondary : SECTION_STYLES.primary,
						disabled: !!busy || !installed || (!!state?.serverRunning && !!state?.external),
						onClick: toggleServer,
						title: state?.serverRunning && state?.external
							? "Сервер запущен вне плагина — остановить его нельзя"
							: (state?.serverRunning
								? "Остановить локальный сервер (он поднимется сам при следующем запросе)"
								: "Запустить локальный сервер заранее")
					}, serverBusyLabel()),
					React.createElement("button", {
						type: "button", style: SECTION_STYLES.secondary,
						disabled: !!busy, onClick: refresh
					}, "Обновить"),
					// Удаление — с двойным подтверждением: сносит гигабайты моделей
					React.createElement("button", {
						type: "button",
						style: { ...SECTION_STYLES.secondary, color: "#ff9a9a", borderColor: "#7a3b3b" },
						disabled: !!busy || !hasFiles,
						onClick: removeAll
					}, busy === "remove" ? "Удаление…" : (confirmRemove ? "Точно удалить?" : "Удалить локальный движок"))
				),
				hasFiles && !confirmRemove
					? React.createElement("div", { style: SECTION_STYLES.note },
						"Удаление сносит portable Python, venv и модели ("
						+ (state?.dataDir || "каталог данных") + "), освобождая обычно 1–3 ГБ. "
						+ "Настройки движков и ключи это не затронет, движок потом ставится заново одной кнопкой.")
					: null,
				// Хвост лога установки — там причина сбоя (сеть/прокси/антивирус)
				state && state.logTail
					? React.createElement("details", { style: { marginTop: 8 } },
						React.createElement("summary", { style: { cursor: "pointer", fontSize: 12 } },
							"Последние строки журнала установки"),
						React.createElement("pre", {
							style: {
								margin: "6px 0 0", padding: 8, borderRadius: 6, maxHeight: 220, overflow: "auto",
								background: "rgba(0,0,0,0.25)", fontSize: 11, whiteSpace: "pre-wrap",
								wordBreak: "break-word"
							}
						}, state.logTail)
					)
					: null,
				state && state.serverRunning && state.external
					? React.createElement("div", { style: SECTION_STYLES.note }, "Сервер запущен вне плагина — кнопка «Остановить» недоступна")
					: null,
				note ? React.createElement("div", { style: { ...SECTION_STYLES.status, marginTop: 6 } }, note) : null,
				err ? React.createElement("div", { style: SECTION_STYLES.err }, err) : null
			);
		}

		/**
		 * Тема оформления для нативных выпадающих списков: без color-scheme браузер
		 * рисует системный список (обычно белый), и в тёмной теме выбранный вариант
		 * видно только при подсветке. Цвета полей берём из переменных DSH.
		 */
		function pickColorScheme() {
			try {
				const bg = window.getComputedStyle(document.body).backgroundColor || "";
				const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(bg);
				if (!m) return "dark";                 // тема неизвестна — тёмный список читаем везде
				const lum = Number(m[1]) + Number(m[2]) + Number(m[3]);
				return lum > 384 ? "light" : "dark";
			} catch (err) { return "dark"; }
		}

		/** Стиль <select>: нативный вид + color-scheme, чтобы список был в теме. */
		const selectStyle = (scheme) => ({
			width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l2, #555)",
			background: "var(--dsw-alias-container-bg, #1f2126)",
			color: "var(--dsw-alias-label-primary, inherit)",
			fontSize: 13, outline: "none", cursor: "pointer",
			colorScheme: scheme || "dark"
		});

		// ---------- Шина общих настроек (модульный уровень) ----------
		// Действующие настройки хоста /settings живут в одной копии, которой пользуются и кнопка у поля ввода, и страница настроек:
		// кто угодно из компонентов сохранил — сразу рассылает broadcast, вторая сторона подхватывает без перезагрузки страницы.
		const settingsBus = { current: null, listeners: new Set() };
		/** Запрашивает действующие настройки хоста (GET /settings). */
		function fetchSettings() {
			return window.fetch("/dsh-voice-chat/settings")
				.then((r) => (r.ok ? r.json() : null))
				.catch(() => null);
		}
				/** Рассылает изменение настроек (и обновляет текущий снимок). */
		function emitSettings(value) {
			if (value && typeof value === "object") settingsBus.current = value;
			for (const fn of settingsBus.listeners) {
				try { fn(settingsBus.current); } catch (err) { /* ignore */ }
			}
		}
				/** Подписка на настройки; возвращает функцию отписки. */
		function subscribeSettings(fn) {
			settingsBus.listeners.add(fn);
			return () => settingsBus.listeners.delete(fn);
		}
		/** Hook подписки на настройки: при первом монтировании, если ещё не загружали, один раз подтягивает настройки хоста и обновляется по broadcast. */
		function useSettings() {
			const [value, setValue] = useState(settingsBus.current);
			useEffect(() => {
				if (!settingsBus.current) fetchSettings().then((data) => { if (data) emitSettings(data); });
				return subscribeSettings((v) => setValue(v));
			}, []);
			return value;
		}

		/**
		 * Настройки, дождавшись первой загрузки. Нужна везде, где решение принимается
		 * по движку: если настройки ещё не пришли, движок неизвестен, и кнопка микрофона
		 * уходила не туда (например, в /stt при выбранном «Браузер»).
		 */
		let settingsReadyPromise = null;
		function readySettings() {
			if (settingsBus.current) return Promise.resolve(settingsBus.current);
			if (!settingsReadyPromise) {
				settingsReadyPromise = fetchSettings()
					.then((data) => { if (data) emitSettings(data); return settingsBus.current; })
					.catch(() => null)
					.then((v) => { settingsReadyPromise = null; return v; });
			}
			return settingsReadyPromise;
		}

		/**
		 		 * Создаёт hook, подписанный на выбор модели текущей сессии (сервис modelDirectories).
		 		 * Возвращённый useCurrentModel(sessionId) после чтения сам обновляется при смене модели.
		 */
		function makeUseCurrentModelImpl(modelDirectories) {
			return function useCurrentModel(sessionId) {
				const [current, setCurrent] = useState(() => {
					if (!modelDirectories || !sessionId) return null;
					try {
						const dir = modelDirectories.directoryFor(sessionId);
						const snap = dir.store.getSnapshot();
						return snap ? snap.current : null;
					} catch {
						return null;
					}
				});
				useEffect(() => {
					if (!modelDirectories || !sessionId) {
						setCurrent(null);
						return;
					}
					let dir;
					try { dir = modelDirectories.directoryFor(sessionId); }
					catch { setCurrent(null); return; }
					const apply = () => {
						try { setCurrent(dir.store.getSnapshot().current); }
						catch { setCurrent(null); }
					};
					apply();
					// При первом монтировании, если состояние ещё idle, один раз вызываем load, чтобы получить current
					try {
						const snap = dir.store.getSnapshot();
						if (snap && snap.status === "idle") dir.load().catch(() => { /* ignore */ });
					} catch { /* ignore */ }
					const unsub = dir.store.subscribe(apply);
					return unsub;
				}, [modelDirectories, sessionId]);
				return current; // { provider, model, reasoningEffort? } | null
			};
		}

		/**
		 		 * Форма содержимого категории "voice chat" в левой части диалога настроек DSH
		 		 * (settings.section): интерфейс ASR (Base URL/модель/ключ), автоотправка после
		 		 * распознавания, переключатель пересказа, длительность тишины для автостопа и голос
		 *
		 		 * Главное: у ASR и TTS настройки **разделены по движкам** (asrSlots/ttsSlots),
		 		 * переключение движка лишь меняет то, какую копию мы видим, — Base URL, модель,
		 		 * ключ и голос движков не затирают друг друга (устранено смешение настроек);
		 */
		/**
		 * Диагностика браузерного движка: что есть в окружении + пробный сеанс,
		 * который сразу показывает настоящую причину отказа (иначе в логе остаётся
		 * только код вроде «network»). Ничего не записывает и разрешений не требует.
		 */
		function BrowserAsrCheckBlock() {
			const [state, setState] = useState(() => browserAsrSupport());
			const [busy, setBusy] = useState(false);
			const [result, setResult] = useState(null);

			const probe = () => {
				const support = browserAsrSupport();
				setState(support);
				setResult(null);
				if (!support.ok) { setResult({ ok: false, text: support.reason }); return; }
				const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
				setBusy(true);
				let settled = false;
				const finish = (r) => {
					if (settled) return;
					settled = true;
					setBusy(false);
					setResult(r);
				};
				let rec = null;
				try {
					rec = new SR();
					rec.lang = "ru-RU";
					rec.interimResults = false;
					rec.continuous = false;
					rec.onresult = () => finish({ ok: true, text: "сеанс распознавания запустился — API работает" });
					rec.onerror = (e) => finish({ ok: false, text: browserAsrErrorHint(e && e.error) });
					rec.onend = () => finish({
						ok: false,
						text: "API есть, но сеанс сразу прервался. Обычно это недоступность сервисов "
							+ "Google из этой сети — тогда включите запасной движок ниже"
					});
					rec.start();
					// Закрываем пробный сеанс: он не должен висеть и слушать микрофон
					window.setTimeout(() => { try { rec && rec.stop(); } catch (err) { /* ignore */ } }, 2500);
				} catch (err) {
					finish({ ok: false, text: "не удалось создать сеанс: " + (err && err.message ? err.message : String(err)) });
				}
			};

			return React.createElement("div", { style: { ...SECTION_STYLES.localBox, marginTop: 10 } },
				React.createElement("div", { style: { marginBottom: 6 } }, state.ok ? "✓ " + state.reason : "✗ " + state.reason),
				React.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
					React.createElement("button", {
						type: "button", style: SECTION_STYLES.secondary, disabled: busy, onClick: probe
					}, busy ? "Проверка…" : "Проверить распознавание"),
					React.createElement("button", {
						type: "button", style: SECTION_STYLES.secondary, disabled: busy,
						onClick: () => setState(browserAsrSupport())
					}, "Перепроверить окружение")
				),
				result
					? React.createElement("div", { style: { marginTop: 8, fontSize: 12, color: result.ok ? "#8fe08f" : "#ffb4b4" } },
						(result.ok ? "✓ " : "✗ ") + result.text)
					: null,
				React.createElement("div", { style: SECTION_STYLES.note },
					"Проверка ничего не записывает: браузер получает сеанс распознавания и сразу закрывает его. "
					+ "Если он откажет сразу — включите запасной движок ниже.")
			);
		}

		function VoiceChatSettingsSection(props) {
			const settings = useSettings();
			// Настройки распознавания речи (слоты по движкам)
			const [engine, setEngine] = useState("siliconflow"); // siliconflow | groq | mimo | custom | browser | local
			const [asrSlots, setAsrSlots] = useState(() => emptySlots("asr"));
			const [autoSend, setAutoSend] = useState(true);
			// Постоянный диалог: после ответа AI запись включается снова, речь поверх озвучки сразу её прерывает
			const [continuous, setContinuous] = useState(false);
			const [silenceSec, setSilenceSec] = useState("2.5");
			// Клавиша/сочетание для запуска распознавания (push-to-talk: держишь — пишет, отпустил — отправил)
			const [hotkey, setHotkey] = useState(DEFAULT_HOTKEY);
			// Порт локального сервера: общий для ASR и TTS (сервер поднимается один)
			const [localPort, setLocalPort] = useState(String(DEFAULT_LOCAL_PORT));
			// Запасной ASR на случай отказа браузерного Web Speech API ("" = не переключать)
			const [asrFallback, setAsrFallback] = useState("");
			// Голос Piper: одно из четырёх русских, "custom" — скачать произвольное имя
			const [localVoiceChoice, setLocalVoiceChoice] = useState("ru_RU-irina-medium");
			const [customVoice, setCustomVoice] = useState("");
			const [voiceBusy, setVoiceBusy] = useState(false);
			const [voiceNote, setVoiceNote] = useState("");
			// Настройки озвучки (слоты по движкам)
			const [rewrite, setRewrite] = useState(false); // Пересказ с озвучкой (длинный ответ сначала сжимается, потом читается), по умолчанию выключено
			const [ttsEngine, setTtsEngine] = useState("edge");
			const [ttsSlots, setTtsSlots] = useState(() => emptySlots("tts"));
			const [ratePercent, setRatePercent] = useState(110);
			const [speechLang, setSpeechLang] = useState("ru-RU");
			// Состояние UI
			const [saving, setSaving] = useState(false);
			const [err, setErr] = useState("");
			const [status, setStatus] = useState("");
			// Тема для нативных списков: тёмная по умолчанию, светлая — если фон DSH светлый
			const [scheme] = useState(() => pickColorScheme());
			const filledRef = useRef(false); // Заполняем форму только по данным, пришедшим впервые, чтобы не затереть ввод пользователя
			const touchedRef = useRef(false); // После ручной правки формы автозаполнение запрещено (защита от гонки "сначала отметили, потом пришло отражение")

			// Две редактируемые сейчас копии слотов (переключение движка лишь меняет, какую мы видим; поля не общие)
			const asrSlot = asrSlots[engine] || {};
			const ttsSlot = ttsSlots[ttsEngine] || {};

			/**
			 * Скачанные голоса Piper: список берём из статуса локального движка,
			 * чтобы в выпадающем списке были видны и докачанные голоса
			 * (украинский, английский и т. п.), а не только четыре русских.
			 */
			const [piperVoices, setPiperVoices] = useState([]);
			const refreshLocalVoices = useCallback(() => {
				return window.fetch("/dsh-voice-chat/local/status")
					.then((r) => (r.ok ? r.json() : null))
					.then((data) => {
						const models = (data && Array.isArray(data.models)) ? data.models : [];
						setPiperVoices(models
							.filter((m) => m && m.type === "piper")
							.map((m) => String(m.id || "").replace(/^piper\//, ""))
							.filter(Boolean));
					})
					.catch(() => { /* статус недоступен — остаются базовые голоса */ });
			}, []);
			useEffect(() => { refreshLocalVoices(); }, [refreshLocalVoices]);

			const downloadedPiperVoices = piperVoices;

			const localVoiceOptions = () => {
				const base = LOCAL_TTS_VOICES.map((v) => React.createElement("option", { key: v, value: v },
					v + (v === "ru_RU-irina-medium" ? " — по умолчанию" : "")));
				// Докачанные голоса: их нет в списке по умолчанию, но выбрать их можно
				const extra = downloadedPiperVoices
					.map((id) => String(id).replace(/^piper\//, ""))
					.filter((name) => name && !LOCAL_TTS_VOICES.includes(name))
					.map((name) => React.createElement("option", { key: "dl-" + name, value: name }, name + " — скачан"));
				return [
					...base,
					...extra,
					React.createElement("option", { key: "__custom", value: "custom" }, "Другой голос (скачать)…")
				];
			};

			/** Скачать произвольный голос Piper по имени из репозитория piper-voices. */
			const downloadVoice = async () => {
				if (!customVoice) return;
				setVoiceBusy(true);
				setVoiceNote("");
				try {
					const resp = await window.fetch("/dsh-voice-chat/local/download-voice?voice=" + encodeURIComponent(customVoice), { method: "POST" });
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
					setVoiceNote(data.alreadyDownloaded
						? "Голос " + customVoice + " уже был скачан"
						: "Голос " + customVoice + " скачан, его можно выбрать в списке");
					setSlot("tts", "local", "voice", customVoice);
					refreshLocalVoices();
				} catch (e) {
					setVoiceNote("Не удалось скачать голос: " + (e && e.message ? e.message : String(e)));
				} finally {
					setVoiceBusy(false);
				}
			};

			/**
			 * Поля движка «Локальный»: адрес и ключ не нужны (адрес плагин собирает
			 * сам из порта, ключа у Piper/faster-whisper нет), поэтому спрашиваем
			 * только порт и модель — списком, со значениями по умолчанию.
			 */
			const localEngineFields = () => React.createElement(React.Fragment, null,
				field("Модель распознавания (faster-whisper)",
					React.createElement("select", {
						style: selectStyle(scheme),
						value: LOCAL_ASR_MODELS.includes(asrSlot.model) ? asrSlot.model : "small",
						onChange: (e) => setSlot("asr", "local", "model", e.target.value)
					}, LOCAL_ASR_MODELS.map((m) => React.createElement("option", { key: m, value: m },
						m + (m === "small" ? " — по умолчанию, ~500 МБ" : m === "tiny" ? " — быстрее всего, ~75 МБ" : m === "base" ? " — ~145 МБ" : m === "medium" ? " — точнее, ~1.5 ГБ" : " — максимум качества, ~3 ГБ")))),
				"Модель скачивается один раз и хранится локально. Для быстрого старта хватит tiny или base, "
				+ "для русской речи на ноутбуке обычно лучше small. Сменили модель — нажмите «Докачать модель» "
				+ "в блоке ниже: сама она не скачивается, иначе распознавание вернёт «модель не скачана»."),
				field("Порт локального сервера",
					React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						React.createElement("input", {
							style: { ...SECTION_STYLES.input, flex: 1 }, value: localPort, inputMode: "numeric",
							onChange: (e) => { touchedRef.current = true; setLocalPort(String(e.target.value).replace(/[^0-9]/g, "")); }
						}),
						React.createElement("button", {
							type: "button", style: SECTION_STYLES.secondary,
							onClick: () => { touchedRef.current = true; setLocalPort(String(DEFAULT_LOCAL_PORT)); }
						}, String(DEFAULT_LOCAL_PORT))
					),
					"Адрес собирается автоматически: http://127.0.0.1:" + (localPort || DEFAULT_LOCAL_PORT) + "/v1. "
					+ "Меняйте, только если порт занят другой программой. Один порт на распознавание и озвучку.")
			);
					/** Меняет одно поле в слоте текущего движка (слоты остальных движков не трогаем). */
			const setSlot = (group, engineName, field, value) => {
				touchedRef.current = true;
				const setter = group === "asr" ? setAsrSlots : setTtsSlots;
				setter((prev) => ({
					...prev,
					[engineName]: { ...(prev[engineName] || {}), [field]: value }
				}));
			};

			// После прихода действующих настроек один раз заполняем форму (только если пользователь ещё ничего не менял)
			useEffect(() => {
				if (!settings || filledRef.current || touchedRef.current) return;
				filledRef.current = true;
			// Настройки распознавания речи (отражение движка: URL — эндпоинт chat/completions → показываем как mimo)
			setEngine(settings.asrEngine === "mimo" || /\/chat\/completions\/?$/i.test(String(settings.asrBaseUrl ?? ""))
				? "mimo"
				: (String(settings.asrEngine ?? "siliconflow") || "siliconflow"));
			setAsrSlots(slotsFromSettings(settings, "asr"));
			setAutoSend(settings.autoSend !== false);
			setContinuous(settings.continuousMode === true);
			const ms = Number(settings.silenceMs);
			setSilenceSec(String(Number.isFinite(ms) && ms > 0 ? Math.round(ms / 100) / 10 : 2.5));
			// Настройки озвучки
			setRewrite(settings.rewrite === true);
			setTtsEngine(TTS_ENGINES.includes(settings.ttsEngine) ? settings.ttsEngine : "edge");
			setTtsSlots(slotsFromSettings(settings, "tts"));
			setRatePercent(settings.ratePercent ?? 110);
			setSpeechLang(settings.speechLang ?? "ru-RU");
			// Хост не отдал это поле (старая версия плагина) → берём встроенное значение
			setHotkey(typeof settings.asrHotkey === "string" ? settings.asrHotkey : DEFAULT_HOTKEY);
			const fb = ASR_ENGINES.includes(settings.asrFallback) ? settings.asrFallback : "";
			setAsrFallback(fb === "browser" ? "" : fb);
			// Голос Piper из слота local: пусто = дефолтный irina
			const voice = asText(slotsFromSettings(settings, "tts").local?.voice) || "ru_RU-irina-medium";
			setLocalVoiceChoice(voice);
			setCustomVoice(LOCAL_TTS_VOICES.includes(voice) ? "" : voice);
			// Порт берём из адреса слота local: если он нестандартный, он уже в настройках
			setLocalPort(localPortFromUrl(slotsFromSettings(settings, "asr").local?.baseUrl
				|| slotsFromSettings(settings, "tts").local?.baseUrl));
		}, [settings]);

			// Сообщение об успешном сохранении исчезает через 2.5 с
			useEffect(() => {
				if (!status) return;
				const t = window.setTimeout(() => setStatus(""), 2500);
				return () => window.clearTimeout(t);
			}, [status]);

			const save = () => {
				const sec = Number(silenceSec);
				if (!Number.isFinite(sec) || sec <= 0) {
					setErr("Длительность тишины должна быть положительной (сек, 0.3 ~ 15)");
					return;
				}
				setSaving(true);
				setErr("");
				setStatus("");
				const trim = (v) => String(v ?? "").trim();
				// Отправляем только слот "движка, который редактируется сейчас"; настройки остальных движков в файле не трогаем.
				// Для local адрес и ключ не показываем: собираем адрес из порта, ключ не нужен
				const asrPatch = engine === "local"
					? { baseUrl: localUrlFromPort(localPort), model: trim(asrSlot.model), apiKey: "" }
					: { baseUrl: trim(asrSlot.baseUrl), model: trim(asrSlot.model), apiKey: trim(asrSlot.apiKey) };
				const ttsPatch = ttsEngine === "edge"
					? { voice: trim(ttsSlot.voice) }
					: ttsEngine === "local"
						? { baseUrl: localUrlFromPort(localPort), model: trim(ttsSlot.model), apiKey: "", voice: trim(ttsSlot.voice) }
						: { baseUrl: trim(ttsSlot.baseUrl), model: trim(ttsSlot.model), apiKey: trim(ttsSlot.apiKey), voice: trim(ttsSlot.voice) };
				// Заодно отдаём старые плоские ключи: старый хост (≤0.3.x) знает только их и относит их к текущему движку
				const legacy = {
					asrBaseUrl: asrPatch.baseUrl, asrModel: asrPatch.model, asrApiKey: asrPatch.apiKey,
					ttsBaseUrl: ttsEngine === "edge" ? "" : ttsPatch.baseUrl,
					ttsModel: ttsEngine === "edge" ? "" : ttsPatch.model,
					ttsApiKey: ttsEngine === "edge" ? "" : ttsPatch.apiKey,
					ttsVoice: ttsPatch.voice
				};
			// Оба слота local получают один и тот же порт: сервер поднимается один,
			// иначе ASR ушёл бы на один порт, а TTS — на другой
			const asrSlotsPayload = { [engine]: asrPatch };
			const ttsSlotsPayload = { [ttsEngine]: ttsPatch };
			if (engine === "local" || ttsEngine === "local") {
				const addr = localUrlFromPort(localPort);
				asrSlotsPayload.local = { ...(asrSlotsPayload.local || {}), baseUrl: addr };
				ttsSlotsPayload.local = { ...(ttsSlotsPayload.local || {}), baseUrl: addr };
			}
			window.fetch("/dsh-voice-chat/settings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					// Настройки распознавания речи
					asrEngine: engine,
					asr: asrSlotsPayload,
					autoSend,
					continuousMode: continuous,
					silenceMs: Math.round(sec * 1000),
					asrHotkey: hotkey,
					asrFallback,
					// Настройки озвучки
					rewrite,
					ttsEngine,
					tts: ttsSlotsPayload,
					ratePercent,
					speechLang,
					...legacy
				})
			})
					.then((r) => r.json().then((data) => ({ ok: r.ok, data })).catch(() => ({ ok: r.ok, data: {} })))
					.then(({ ok, data }) => {
						if (!ok || !data || !data.settings) {
							throw new Error((data && data.error) || "Ошибка HTTP");
						}
						emitSettings(data.settings); // Рассылаем: длительность тишины и автоотправка на кнопке микрофона действуют сразу
						setStatus("Сохранено, применяется сразу ✓");
						setSaving(false);
					})
					.catch((e) => {
						setErr("Ошибка сохранения: " + (e && e.message ? e.message : String(e)));
						setSaving(false);
					});
			};

			const field = (label, control, note) => React.createElement("div", { key: label },
				React.createElement("label", { style: SECTION_STYLES.label }, label),
				control,
				note ? React.createElement("div", { style: SECTION_STYLES.note }, note) : null
			);

			return React.createElement("div", { style: SECTION_STYLES.wrap },
				// ========== Настройки распознавания речи ==========
				React.createElement("h4", { style: { ...SECTION_STYLES.h, fontSize: 14, marginTop: 18 } }, "🎤 Настройки распознавания речи"),
				field("Движок ASR",
					React.createElement("select", {
						style: selectStyle(scheme),
						value: engine,
						// Переключение движка лишь меняет, "какую копию слота мы видим": Base URL, модель и ключ каждого движка хранятся отдельно
						onChange: (e) => { touchedRef.current = true; setEngine(e.target.value); }
					},
				React.createElement("option", { value: "siliconflow" }, "SiliconFlow (по умолчанию, рекомендуется)"),
				React.createElement("option", { value: "groq" }, "Groq (Whisper)"),
				React.createElement("option", { value: "mimo" }, "Xiaomi MiMo-V2.5-ASR (chat-протокол)"),
				React.createElement("option", { value: "custom" }, "Пользовательский (OpenAI-совместимый /audio/transcriptions)"),
				React.createElement("option", { value: "browser" }, "Браузер (Web Speech API, без ключа)"),
				React.createElement("option", { value: "local" }, "Локальный (faster-whisper, офлайн)")
					),
					engine === "mimo"
						? "MiMo использует chat/completions протокол, поддерживает только wav/mp3; запись автоматически конвертируется в 16k моно WAV"
						: engine === "local"
							? "Локальный faster-whisper: OpenAI-совместимый /audio/transcriptions на этом же компьютере, ключ не нужен, сервер поднимается автоматически"
							: engine === "browser"
								? "Распознавание выполняет сам браузер (Web Speech API); запись идёт мимо этого плагина, ключ не нужен"
								: "OpenAI-совместимый /audio/transcriptions multipart протокол, запись webm загружается как есть; конфигурация каждого движка хранится отдельно"),
				// browser: адрес/модель/ключ не нужны — распознаёт сам браузер
			// ВАЖНО: это компонент, а не функция-фабрика. Раньше здесь стоял вызов
			// browserAsrCheckBlock() прямо из тела VoiceChatSettingsSection — тогда её
			// три useState принадлежали родителю и появлялись/исчезали вместе с
			// engine === "browser" → React error #310 и серый экран настроек.
			engine === "browser" ? React.createElement(React.Fragment, { key: "browser-asr-note" },
				React.createElement(BrowserAsrCheckBlock, null),
					field("Запасной движок распознавания",
						React.createElement("select", {
							style: selectStyle(scheme),
							value: asrFallback,
							onChange: (e) => { touchedRef.current = true; setAsrFallback(e.target.value); }
						}, [{ value: "", label: "не переключать" }].concat(
							ASR_ENGINES.filter((e) => e !== "browser").map((e) => ({
								value: e, label: ASR_ENGINE_LABELS[e] || e
							}))
						).map((o) => React.createElement("option", { key: o.value, value: o.value }, o.label))),
						"Если браузерное распознавание не сработало (нет сервиса Google, запрещён микрофон, "
						+ "Electron), плагин сам отправит запись через этот движок. Рекомендуется «Локальный» — "
						+ "он работает всегда; для сетевого не забудьте ключ в его настройках.")
				) : null,
				// local: адрес собирается плагином, ключ не нужен, модель — из списка
				engine === "local" ? localEngineFields() : null,
				engine === "browser" || engine === "local" ? null : React.createElement(React.Fragment, null,
					field("ASR Base URL",
						React.createElement("input", {
							style: SECTION_STYLES.input, value: asrSlot.baseUrl || "", spellCheck: false,
							onChange: (e) => setSlot("asr", engine, "baseUrl", e.target.value),
							placeholder: (ASR_ENGINE_DEFAULTS[engine] || {}).baseUrl || "https://api.siliconflow.cn/v1"
						}),
						engine === "mimo"
							? "Укажите полный эндпоинт MiMo, по умолчанию https://api.xiaomimimo.com/v1/chat/completions (если заканчивается на /chat/completions, автоматически используется chat-протокол)"
							: "Базовый адрес OpenAI-совместимого API, автоматически добавляется /audio/transcriptions"),
					field("Модель ASR",
						React.createElement("input", {
							style: SECTION_STYLES.input, value: asrSlot.model || "", spellCheck: false,
							onChange: (e) => setSlot("asr", engine, "model", e.target.value),
							placeholder: (ASR_ENGINE_DEFAULTS[engine] || {}).model || "FunAudioLLM/SenseVoiceSmall"
						}),
						"Оставьте пустым для встроенного значения по умолчанию"),
					field("API-ключ ASR",
						React.createElement("input", {
							style: SECTION_STYLES.input, type: "password", value: asrSlot.apiKey || "", spellCheck: false,
							onChange: (e) => setSlot("asr", engine, "apiKey", e.target.value),
							placeholder: "sk-..."
						}),
						`Действует только для движка ASR «${engine}»; сохраняется в settings.local.json, если пусто — используется ключ сервера для этого же движка`)
				),
				React.createElement("label", { style: SECTION_STYLES.checkRow },
					React.createElement("input", {
						type: "checkbox",
						checked: autoSend,
						onChange: (e) => { touchedRef.current = true; setAutoSend(e.target.checked); }
					}),
				React.createElement("span", null, "Автоматически отправлять после распознавания"),
				React.createElement("span", { style: SECTION_STYLES.note }, "(если отключено, текст добавляется в поле ввода, отправка вручную)")
				),
				React.createElement("label", { style: SECTION_STYLES.checkRow },
					React.createElement("input", {
						type: "checkbox",
						checked: continuous,
						onChange: (e) => { touchedRef.current = true; setContinuous(e.target.checked); }
					}),
					React.createElement("span", null, "Постоянный диалог"),
					React.createElement("span", { style: SECTION_STYLES.note }, "(живое общение: после ответа микрофон снова включается, а речь поверх озвучки сразу прерывает её)")
				),
				// Локальный движок: управление установкой и сервером (нужно, когда выбран local)
				(engine === "local" || ttsEngine === "local") ? React.createElement(LocalEngineBox, null) : null,
				field("Клавиша запуска распознавания",
					React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
						React.createElement("input", {
							style: { ...SECTION_STYLES.input, flex: "1 1 180px", cursor: "pointer" },
							readOnly: true,
							value: hotkeyLabel(hotkey),
							title: hotkey || "горячая клавиша выключена",
							// Клик по полю = «начни вводить»: первое же нажатие запоминается
							onKeyDown: (e) => {
								e.preventDefault();
								e.stopPropagation();
								if (e.key === "Escape") { touchedRef.current = true; setHotkey(DEFAULT_HOTKEY); return; }
								if (e.key === "Delete" || e.key === "Backspace") { touchedRef.current = true; setHotkey(""); return; }
								const combo = hotkeyFromEvent(e);
								if (!combo) return;
								touchedRef.current = true;
								setHotkey(combo);
							},
							onClick: (e) => { try { e.currentTarget.focus(); } catch (err) { /* ignore */ } }
						}),
						React.createElement("button", {
							type: "button", style: SECTION_STYLES.secondary,
							onClick: () => { touchedRef.current = true; setHotkey(DEFAULT_HOTKEY); }
						}, "Правый Ctrl"),
						React.createElement("button", {
							type: "button", style: SECTION_STYLES.secondary,
							onClick: () => { touchedRef.current = true; setHotkey(""); }
						}, "Выключить")
					),
					"Нажмите на поле, затем нужную клавишу или сочетание — оно запомнится (Esc — вернуть «Правый Ctrl», Delete — выключить). "
					+ "Действие — удержание: держите клавишу → идёт запись, отпустите → распознавание и отправка. "
					+ "По умолчанию правый Ctrl: его удобно держать большим пальцем, не мешая Ctrl+C/Ctrl+V."),
				field("Автозавершение при тишине (сек)",
					React.createElement("input", {
						style: SECTION_STYLES.input, value: silenceSec, inputMode: "decimal",
						onChange: (e) => { touchedRef.current = true; setSilenceSec(e.target.value); }
					}),
					"Пауза в речи дольше указанного времени автоматически завершает запись и отправляет на распознавание (0.3 ~ 15 сек)"),
				// ========== Настройки озвучки ==========
				React.createElement("h4", { style: { ...SECTION_STYLES.h, fontSize: 14, marginTop: 24 } }, "🔊 Настройки озвучки"),
				field("Движок TTS",
					React.createElement("select", {
						style: selectStyle(scheme),
						value: ttsEngine,
						// Переключение движка лишь меняет, "какую копию слота мы видим": адрес, модель, ключ и голос каждого движка хранятся отдельно
						onChange: (e) => { touchedRef.current = true; setTtsEngine(e.target.value); }
					},
				React.createElement("option", { value: "edge" }, "Microsoft Edge TTS (бесплатно, рекомендуется)"),
				React.createElement("option", { value: "mimo" }, "Xiaomi MiMo TTS (chat-протокол)"),
				React.createElement("option", { value: "custom" }, "Пользовательский TTS (OpenAI-совместимый)"),
				React.createElement("option", { value: "browser" }, "Браузер (офлайн, speechSynthesis)"),
				React.createElement("option", { value: "local" }, "Локальный (Piper, офлайн)")
					),
					"Конфигурация каждого движка сохраняется отдельно, переключение движков не перезаписывает настройки"),
				// Настройки пользовательского TTS (показываются только при ttsEngine === 'custom')
				ttsEngine === "custom" ? React.createElement(React.Fragment, null,
					field("TTS Base URL",
						React.createElement("input", {
							style: SECTION_STYLES.input, value: ttsSlot.baseUrl || "", spellCheck: false,
							onChange: (e) => setSlot("tts", "custom", "baseUrl", e.target.value),
							placeholder: "https://api.openai.com/v1"
						}),
						"Адрес OpenAI-совместимого API /audio/speech"),
					field("Модель TTS",
						React.createElement("input", {
							style: SECTION_STYLES.input, value: ttsSlot.model || "", spellCheck: false,
							onChange: (e) => setSlot("tts", "custom", "model", e.target.value),
							placeholder: TTS_ENGINE_DEFAULTS.custom.model
						}),
						"Оставьте пустым для встроенного значения по умолчанию tts-1"),
					field("API-ключ TTS",
						React.createElement("input", {
							style: SECTION_STYLES.input, type: "password", value: ttsSlot.apiKey || "", spellCheck: false,
							onChange: (e) => setSlot("tts", "custom", "apiKey", e.target.value),
							placeholder: "sk-..."
						}),
						"Действует только для «Пользовательский TTS»; если пусто — запрос без ключа"),
					field("Голос (Пользовательский TTS)",
						React.createElement("input", {
							style: SECTION_STYLES.input, value: ttsSlot.voice || "", spellCheck: false,
							onChange: (e) => setSlot("tts", "custom", "voice", e.target.value),
							placeholder: TTS_ENGINE_DEFAULTS.custom.voice
						}),
						"Параметр voice API (например alloy / zh-CN-XiaoxiaoNeural / Kokoro); если пусто — alloy")
				) : null,
				// Настройки MiMo TTS (показываются только при ttsEngine === 'mimo')
				ttsEngine === "mimo" ? React.createElement(React.Fragment, null,
					field("TTS Base URL",
						React.createElement("input", {
							style: SECTION_STYLES.input, value: ttsSlot.baseUrl || "", spellCheck: false,
							onChange: (e) => setSlot("tts", "mimo", "baseUrl", e.target.value),
							placeholder: TTS_ENGINE_DEFAULTS.mimo.baseUrl
						}),
						`Базовый адрес MiMo (автоматически добавляется /chat/completions) или полный эндпоинт; если пусто — встроенное значение по умолчанию ${TTS_ENGINE_DEFAULTS.mimo.baseUrl}`),
					field("Модель TTS",
						React.createElement("input", {
							style: SECTION_STYLES.input, value: ttsSlot.model || "", spellCheck: false,
							onChange: (e) => setSlot("tts", "mimo", "model", e.target.value),
							placeholder: TTS_ENGINE_DEFAULTS.mimo.model
						}),
						"Оставьте пустым для встроенного значения по умолчанию mimo-v2.5-tts"),
					field("API-ключ TTS",
						React.createElement("input", {
							style: SECTION_STYLES.input, type: "password", value: ttsSlot.apiKey || "", spellCheck: false,
							onChange: (e) => setSlot("tts", "mimo", "apiKey", e.target.value),
							placeholder: "sk-..."
						}),
						"Действует только для «MiMo TTS»; если пусто — используется ключ от MiMo ASR (тот же провайдер)"),
					field("Голос (MiMo TTS)",
						React.createElement("input", {
							style: SECTION_STYLES.input, list: "dsh-vc-mimo-voices", value: ttsSlot.voice || "", spellCheck: false,
							onChange: (e) => setSlot("tts", "mimo", "voice", e.target.value),
							placeholder: TTS_ENGINE_DEFAULTS.mimo.voice
						}),
						"Если пусто — mimo_default; в списке предустановленные голоса, можно ввести другое допустимое имя голоса")
				) : null,
				// Локальный Piper: голос списком (адрес/ключ не нужны, порт — в блоке ASR)
				ttsEngine === "local" ? React.createElement(React.Fragment, null,
					field("Голос (локальный Piper)",
						React.createElement("select", {
							style: selectStyle(scheme),
							value: localVoiceChoice,
							onChange: (e) => {
								const value = e.target.value;
								setLocalVoiceChoice(value);
								// В слот пишем только конкретное имя голоса: "custom" — это
								// режим ввода, а не значение настройки
								if (value !== "custom") setSlot("tts", "local", "voice", value);
							}
						}, localVoiceOptions()),
						"Русских голосов в Piper всего четыре, и все они качества medium — проверено "
						+ "по репозиторию (low/high/x_low не существуют). Каждый весит около 60 МБ."
					),
					localVoiceChoice !== "custom" ? null : field("Имя голоса",
						React.createElement("div", { style: { display: "flex", gap: 8 } },
							React.createElement("input", {
								style: SECTION_STYLES.input, value: customVoice, spellCheck: false,
								placeholder: "uk_UA-tetiana-high",
								onChange: (e) => { touchedRef.current = true; setCustomVoice(e.target.value.trim()); }
							}),
							React.createElement("button", {
								type: "button", style: SECTION_STYLES.secondary,
								disabled: voiceBusy || !customVoice,
								onClick: downloadVoice
							}, voiceBusy ? "Скачивание…" : "Скачать")
						),
						"Голос скачивается в <dataDir>/models/piper/<имя> (~60–150 МБ) и сразу появляется "
						+ "в списке. Название берётся из voices.json репозитория piper-voices; лишние голоса "
						+ "удаляются в блоке «Скачанные модели» ниже по разделу распознавания."
					)
				) : null,
				// Браузерный TTS: настраивать нечего — speechSynthesis
				ttsEngine === "browser" ? React.createElement("div", { style: SECTION_STYLES.note, key: "browser-tts-note" },
					"Браузерная озвучка (speechSynthesis) ничего не требует: ни адреса, ни ключа. "
					+ "Язык и скорость берутся из общих настроек ниже."
				) : null,
				// Настройки Edge TTS (показываются только при ttsEngine === 'edge')
				ttsEngine === "edge" ? field("Голос (Edge TTS)",
					React.createElement("input", {
						style: SECTION_STYLES.input, list: "dsh-vc-voices", value: ttsSlot.voice || "", spellCheck: false,
						onChange: (e) => setSlot("tts", "edge", "voice", e.target.value),
						placeholder: TTS_ENGINE_DEFAULTS.edge.voice
					}),
					"Действует только для «Edge TTS»; если пусто — встроенный голос по умолчанию Светлана, в списке популярные голоса, можно ввести любое допустимое имя голоса"
				) : null,
				React.createElement("datalist", { id: "dsh-vc-voices" },
					VOICE_PRESETS.map((v) => React.createElement("option", { key: v, value: v }))
				),
			React.createElement("datalist", { id: "dsh-vc-mimo-voices" },
				MIMO_TTS_VOICES.map((v) => React.createElement("option", { key: v, value: v }))
			),
			field("Скорость речи",
				React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
					React.createElement("input", {
						type: "range", min: 50, max: 200, step: 5, value: ratePercent,
						onChange: (e) => { touchedRef.current = true; setRatePercent(Number(e.target.value)); },
						style: { flex: 1 }
					}),
					React.createElement("span", { style: { minWidth: 40, textAlign: "right" } }, `${ratePercent}%`)
				),
				"Скорость озвучки (50–200%, 100% = нормальная)"
			),
			field("Язык речи",
				React.createElement("select", {
					style: selectStyle(scheme),
					value: speechLang,
					onChange: (e) => { touchedRef.current = true; setSpeechLang(e.target.value); }
				},
					React.createElement("option", { value: "ru-RU" }, "Русский (ru-RU)"),
					React.createElement("option", { value: "zh-CN" }, "Китайский (zh-CN)"),
					React.createElement("option", { value: "en-US" }, "Английский (en-US)"),
					React.createElement("option", { value: "ja-JP" }, "Японский (ja-JP)")
				),
				"Язык озвучки и распознавания речи"
			),
			React.createElement("label", { style: SECTION_STYLES.checkRow },
					React.createElement("input", {
						type: "checkbox",
						checked: rewrite,
						onChange: (e) => { touchedRef.current = true; setRewrite(e.target.checked); }
					}),
				React.createElement("span", null, "Сокращать длинные ответы перед озвучкой"),
				React.createElement("span", { style: SECTION_STYLES.note }, "(по умолчанию отключено; при включении длинные ответы сначала сжимаются LLM до разговорного стиля, затем озвучиваются)")
				),
				err ? React.createElement("div", { style: SECTION_STYLES.err }, err) : null,
				React.createElement("div", { style: SECTION_STYLES.saveRow },
					React.createElement("button", {
						type: "button", style: SECTION_STYLES.primary, onClick: save, disabled: saving
					}, saving ? "Сохранение…" : "Сохранить"),
					status ? React.createElement("span", { style: SECTION_STYLES.status }, status) : null
				)
			);
		}

		// ---------- Компоненты ----------
		/**
		 * Сколько ждём ответ /stt, прежде чем отменяем запрос.
		 *
		 * Локальный движок в первый раз читает модель с диска (5–30 с для small,
		 * больше для medium/large-v3), поэтому таймаут щедрый. Но он обязателен:
		 * без него «микрофон жёлтый» неотличимо от «микрофон завис», а запрос
		 * может висеть бесконечно — пользователь не понимает, что делать.
		 */
		const STT_TIMEOUT_MS = 120000;

		function VoiceChatButton(props) {
			const { useSession, inputActions, useCurrentModel, sessionId, useInput } = props;
			const session = typeof useSession === "function" ? useSession((s) => s) : undefined;
			// Подписка на текущее содержимое поля ввода: результат диктовки должен "дописываться", а не затирать черновик
			const inputState = typeof useInput === "function" ? useInput((s) => s) : undefined;
			// Подписка на "реально используемую в текущем диалоге LLM": при пересказе передаём
			// provider/model хосту в /speak, чтобы не застрянуть на умолчании хоста (модель могла быть отключена или ключ неверный).
			const currentModel = typeof useCurrentModel === "function" ? useCurrentModel(sessionId) : null;

			// [DEBUG] Диагностика закончена: по ключам session видно, что списка сообщений нет, — используем схему running + DOM.

			// Состояние, связанное с голосом
			const [recording, setRecording] = useState(false);
			const [busy, setBusy] = useState(false);
			const [hint, setHint] = useState("");
			const [muted, setMuted] = useState(false);      // Переключатель озвучки (без звука)
			const [speaking, setSpeaking] = useState(false); // Идёт озвучка
			const mutedRef = useRef(false);
			const audioRef = useRef(null);
			// Очередь озвучки: фразы не прерывают друг друга, говорятся по очереди до конца
			const queueRef = useRef([]);         // Очередь текстов к озвучке (FIFO)
			const playingRef = useRef(false);    // Идёт ли воспроизведение текущей фразы
			const resetTokenRef = useRef(0);     // Растёт при остановке/заглушке — обесценивает запросы в полёте
			const finishAudioRef = useRef(null); // Хук окончания текущего аудио (срабатывает при stop)

			const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia;
			const recRef = useRef(null);
			const streamRef = useRef(null);
			const chunksRef = useRef([]);
			const silenceRef = useRef(null);
			const silenceMsRef = useRef(2500); // Длительность тишины для автостопа; при старте читается из /settings
			const autoSendRef = useRef(true);  // Отправлять ли распознанное автоматически; при старте читается из /settings
			const chatAsrRef = useRef(false);  // Работает ли ASR по протоколу chat/completions (в стиле MiMo, нужен WAV перед выгрузкой)
			// Постоянный диалог ("живой чат"): после ответа AI запись включается снова, речь поверх озвучки прерывает её
			const continuousRef = useRef(false);
			const bargeRef = useRef(null);     // Дескриптор слушателя перебивания { stop() }
			const restartTimerRef = useRef(null); // Таймер повторного включения записи после ответа
			const startRef = useRef(null);    // Ссылка на start() (для колбэков перебивания/продолжения — во избежание TDZ)
			const startBargeRef = useRef(null); // Ссылка на startBarge() (то же самое)
			const pausedRef = useRef(false);   // Пользователь остановил запись вручную → цикл постоянного диалога сам не продолжится

			// Действующие настройки берём из общей шины (длительность тишины, автоотправка
			// после распознавания); broadcast со страницы настроек обновляет эту сторону сразу, без перезагрузки страницы.
			const settingsValue = useSettings();
			useEffect(() => {
				if (!settingsValue) return;
				if (Number.isFinite(Number(settingsValue.silenceMs)) && Number(settingsValue.silenceMs) > 0) {
					silenceMsRef.current = Math.round(Number(settingsValue.silenceMs));
				}
				autoSendRef.current = settingsValue.autoSend !== false;
				chatAsrRef.current = isChatAsrSettings(settingsValue); // MiMo и прочие chat-протоколы → перед выгрузкой конвертируем в WAV
				continuousRef.current = settingsValue.continuousMode === true;
			}, [settingsValue]);

			// Внимание: массив зависимостей useCallback вычисляется при объявлении, поэтому функция должна быть объявлена раньше первого использования (во избежание TDZ).

		// Останавливаем слушатель перебивания (освобождаем микрофонный поток и AudioContext).
		const stopBarge = useCallback(() => {
			const b = bargeRef.current;
			bargeRef.current = null;
			if (!b) return;
			try { if (b.timer) window.clearInterval(b.timer); } catch (err) { /* ignore */ }
			try { b.stream && b.stream.getTracks().forEach((t) => t.stop()); } catch (err) { /* ignore */ }
			try { b.audioCtx && b.audioCtx.close(); } catch (err) { /* ignore */ }
		}, []);

			// Останавливаем текущую озвучку и очищаем очередь (вызывается кнопкой без звука,
			// горячей клавишей и перед началом записи). Порядок важен: сначала останавливаем
			// звучащий элемент аудио, потом вызываем хук finish — он обнуляет audioRef.current,
			// и если вызвать его раньше, pause не выполнится: «заглушить сразу» перестанет работать.
			const stopPlayback = useCallback(() => {
				resetTokenRef.current += 1; // Обесцениваем запросы озвучки в полёте и саму очередь
				queueRef.current = [];
				stopBarge(); // Слушатель перебивания завершается вместе с озвучкой (при новой записи поднимется заново)
				if (restartTimerRef.current) {
					window.clearTimeout(restartTimerRef.current);
					restartTimerRef.current = null;
				}
				if (audioRef.current) {
					try { audioRef.current.pause(); } catch (err) { /* ignore */ }
					try { audioRef.current.src = ""; } catch (err) { /* ignore */ }
					audioRef.current = null;
				}
				if (finishAudioRef.current) {
					const f = finishAudioRef.current;
					finishAudioRef.current = null;
					try { f(); } catch (err) { /* ignore */ }
				}
				try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (err) { /* ignore */ }
				setSpeaking(false);
			}, [stopBarge]);

		// Проигрывает фрагмент MP3, возвращает Promise: по окончании/ошибке/остановке resolve(true); если проиграть нельзя — resolve(false)
		const playAudioBlob = useCallback((blob) => new Promise((resolve) => {
			if (!blob || blob.size === 0 || mutedRef.current) return resolve(false);
			try {
				if (audioRef.current) {
					try { audioRef.current.pause(); } catch (err) { /* ignore */ }
					audioRef.current = null;
				}
				const url = URL.createObjectURL(blob);
				const audio = new Audio(url);
				// MiMo не поддерживает rate на сервере — применяем через playbackRate
				if (settingsValue?.ttsEngine === "mimo") {
					audio.playbackRate = (settingsValue?.ratePercent ?? 110) / 100;
					audio.preservesPitch = true;
				}
				audioRef.current = audio;
				setSpeaking(true);
				const done = () => {
						if (finishAudioRef.current === done) finishAudioRef.current = null;
						if (audioRef.current === audio) { audioRef.current = null; setSpeaking(false); }
						try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ }
						resolve(true);
					};
					finishAudioRef.current = done;
					audio.onended = done;
					audio.onerror = done;
					audio.play().catch((err) => {
						console.error("[dsh-voice-chat] playback failed", err);
						done();
					});
				} catch (err) {
					console.error("[dsh-voice-chat] playAudioBlob failed", err);
					setSpeaking(false);
					resolve(false);
				}
			}), []);

			/**
			 			 * Короткий сигнал (синтез через Web Audio, без аудиофайлов).
			 			 * @param freq частота в Гц; 880 — высокий, 523 — низкий
			 			 * @param ms длительность (короткая, 100~150 мс)
			 */
			const beep = useCallback((freq, ms) => {
				try {
					const AudioCtx = window.AudioContext || window.webkitAudioContext;
					if (!AudioCtx) return;
					const ctx = new AudioCtx();
					const osc = ctx.createOscillator();
					const gain = ctx.createGain();
					osc.type = "sine";
					osc.frequency.value = freq;
					const dur = Math.max(60, Math.min(150, ms));
					gain.gain.setValueAtTime(0.12, ctx.currentTime);
					gain.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur / 1000);
					osc.connect(gain);
					gain.connect(ctx.destination);
					osc.start();
					osc.stop(ctx.currentTime + dur / 1000);
					osc.onended = () => { try { ctx.close(); } catch (err) { /* ignore */ } };
				} catch (err) { /* Неудачный сигнал не влияет на работу */ }
			}, []);

		// Запасной браузерный TTS (Promise-вариант: resolve после окончания, работает в паре с очередью)
		const fallbackSpeakP = useCallback((text) => new Promise((resolve) => {
			try {
				if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) return resolve(false);
				window.speechSynthesis.cancel();
				const u = new SpeechSynthesisUtterance(text);
				u.lang = settingsValue?.speechLang ?? "ru-RU";
				u.rate = (settingsValue?.ratePercent ?? 110) / 100;
				u.onend = () => resolve(true);
				u.onerror = () => resolve(false);
				window.speechSynthesis.speak(u);
				window.setTimeout(() => resolve(true), 30000); // Запасной вариант: долго нет обратного вызова
			} catch (err) {
				console.error("[dsh-voice-chat] fallback speak failed", err);
				resolve(false);
			}
		}), [settingsValue?.speechLang, settingsValue?.ratePercent]);

		// Проигрывает один текст (пересказ → edge-tts → браузерный TTS с постепенной деградацией), по окончании resolve(true)
		const playOne = useCallback(async (text) => {
			const token = resetTokenRef.current;
			const stillAlive = () => resetTokenRef.current === token && !mutedRef.current;
			// Текст для запасного озвучивания: сначала результат пересказа с сервера (при сбое /speak приходит в теле ошибки), иначе исходный.
			let fallbackText = text;
			// Если и сервер, и локальный движок не сработали, показываем причину (иначе о "тишине" можно узнать только из консоли)
			let failReason = "";
			// Настройки могли ещё не прийти: движок озвучки без них неизвестен
			const settings = settingsValue || await readySettings();
			const ttsEngine = (settings && settings.ttsEngine) || "edge";
			// 0) Движок браузерного TTS: сразу в speechSynthesis
			if (ttsEngine === "browser") {
				const spoken = await fallbackSpeakP(text);
				if (!spoken) setHint("Ошибка озвучки (браузерный TTS недоступен)");
				return spoken;
			}
			// 1) Озвучка пересказа
			try {
				const resp = await window.fetch("/dsh-voice-chat/speak", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						text,
						// Передаём хосту реально используемую в диалоге LLM, чтобы пересказ шёл по текущему диалогу
						llmProvider: currentModel && currentModel.provider,
						llmModel: currentModel && currentModel.model
					})
				});
					if (!stillAlive()) return false;
					if (resp.ok) {
						const blob = await resp.blob();
						if (!stillAlive()) return false;
						if (await playAudioBlob(blob)) return true;
					} else {
						console.warn("[dsh-voice-chat] speak endpoint failed:", resp.status);
						// edge-tts отвалился: сервер кладёт "текст, который надо прочитать" (пересказ или оригинал) в тело ошибки
						const body = await resp.json().catch(() => ({}));
						if (!stillAlive()) return false;
						if (body && typeof body.spoken === "string" && body.spoken.trim()) {
							fallbackText = body.spoken;
						}
						failReason = (body && body.error) ? String(body.error) : `HTTP ${resp.status}`;
					}
				} catch (err) {
					console.warn("[dsh-voice-chat] speak request failed:", err);
					failReason = err && err.message ? err.message : String(err);
				}
			if (!stillAlive()) return false;
			// 2) Деградация: читаем как есть (в первую очередь пересказ).
			//    POST, а не GET ?text=... : длинный ответ целиком в query string
			//    упирался в лимит длины URL и озвучка больших ответов молча падала.
			try {
				const resp = await window.fetch("/dsh-voice-chat/tts", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text: fallbackText })
				});
					if (!stillAlive()) return false;
					if (resp.ok) {
						const blob = await resp.blob();
						if (!stillAlive()) return false;
						if (await playAudioBlob(blob)) return true;
					} else {
						const body = await resp.json().catch(() => ({}));
						if (!failReason) failReason = (body && body.error) ? String(body.error) : `HTTP ${resp.status}`;
					}
				} catch (err) {
					console.warn("[dsh-voice-chat] tts request failed:", err);
					if (!failReason) failReason = err && err.message ? err.message : String(err);
				}
				if (!stillAlive()) return false;
				// 3) Последний откат: браузерный TTS
				const spoken = await fallbackSpeakP(fallbackText);
				const brief = failReason ? failReason.slice(0, 60) : "";
			if (!spoken) setHint(brief ? `Ошибка озвучки: ${brief}` : "Ошибка озвучки (нет звука на сервере и в браузере)");
			else if (brief) setHint(`Деградировано до браузерной озвучки: ${brief}`);
				return spoken;
			// ВАЖНО: settingsValue/currentModel тоже в зависимостях. Раньше их тут
			// не было, и playOne держал ПЕРВЫЙ заclosure снимок настроек: смена
			// движка озвучки/языка/скорости или модели диалога не влияла на playback.
			}, [playAudioBlob, fallbackSpeakP, settingsValue, currentModel]);

			// Насос очереди: одна фраза доиграла — автоматически играет следующая
			const pump = useCallback(async () => {
				if (playingRef.current) return;
				playingRef.current = true;
				const token = resetTokenRef.current;
				let played = false;
				try {
					while (queueRef.current.length > 0) {
						if (resetTokenRef.current !== token || mutedRef.current) break;
						const text = queueRef.current.shift();
						if (!text) continue;
						played = true;
						await playOne(text);
						if (resetTokenRef.current !== token) break;
					}
				} finally {
					playingRef.current = false;
					if (queueRef.current.length === 0) {
						setSpeaking(false);
						stopBarge();
						// Постоянный диалог: очередной ответ озвучен, снова включаем микрофон и ждём продолжения
						if (played && resetTokenRef.current === token && continuousRef.current && !mutedRef.current && !pausedRef.current) {
							if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current);
							restartTimerRef.current = window.setTimeout(() => {
								restartTimerRef.current = null;
								if (continuousRef.current && !mutedRef.current && !pausedRef.current) {
									startRef.current && startRef.current();
								}
							}, 500);
						}
					}
				}
			}, [playOne, stopBarge]);

			/**
			 			 * Озвучка: фразы играют по очереди (озвучка не прерывает друг друга).
			 			 * Уже звучащую даём договорить, новые ответы встают в конец очереди;
			 			 * очередь очищается с немедленной остановкой только в stopPlayback
			 */
			const playTts = useCallback((text) => {
				if (!text || typeof window === "undefined" || mutedRef.current) return;
				queueRef.current.push(text);
				setSpeaking(true); // Есть что озвучивать — значит "идёт озвучка"
				if (continuousRef.current) startBargeRef.current && startBargeRef.current();
				pump();
			}, [pump]);

			// ---------- Детект сообщений в новом DSH (адаптация 0.1.2-rc.1) ----------
			// В session больше нет nodes (сообщения лежат в conversation store,
			// недоступном плагину). Завершение ответа AI ловим по фронту session.running
			// true→false, затем берём текст последнего ответа из DOM; повторы отсекаем по тексту.
			const prevRunningRef = useRef(false);
			const lastSpokenTextRef = useRef("");
			const turnEndTimerRef = useRef(null);
			const runningNowRef = useRef(false);

			useEffect(() => {
				const running = !!(session && session.running);
				const was = prevRunningRef.current;
				prevRunningRef.current = running;
				runningNowRef.current = running;

				if (!was || running) return; // Срабатывает только на фронте true→false (ответ только что закончился)

				// Ждём 800 мс (пока поток допишется в лог сессии), затем просим у хоста последнее сообщение ассистента
				if (turnEndTimerRef.current) window.clearTimeout(turnEndTimerRef.current);
				turnEndTimerRef.current = window.setTimeout(async () => {
					turnEndTimerRef.current = null;
					if (runningNowRef.current || mutedRef.current) return; // Опять пошли или заглушили — не озвучиваем
					// Последнее сообщение ассистента берём из сервиса sessions хоста (надёжно, без обхода DOM)
					let text = "";
					try {
						const sid = encodeURIComponent(session && session.sessionId || "");
						const resp = await window.fetch("/dsh-voice-chat/latest-message?sessionId=" + sid);
						if (resp.ok) {
							const data = await resp.json();
							text = String(data && data.text || "").trim();
						} else {
							console.warn("[dsh-voice-chat] запрос latest-message:", resp.status);
						}
					} catch (err) {
						console.warn("[dsh-voice-chat] запрос latest-message не удался:", err);
					}
					// Запасной вариант при сбое интерфейса: разбор DOM (что получится)
					if (!text) text = extractLatestAssistantText() || "";
					console.log("[dsh-voice-chat] turn завершён, получен текст:", text ? text.slice(0, 80) + (text.length > 80 ? "…" : "") : "(пусто)");
					if (!text || text === lastSpokenTextRef.current) return;
					lastSpokenTextRef.current = text;
					playTts(text);
				}, 800);
			}, [session && session.running, playTts]);

			// При размонтировании чистим таймеры
			useEffect(() => () => {
				if (turnEndTimerRef.current) window.clearTimeout(turnEndTimerRef.current);
			}, []);

			// Кнопка «без звука»/восстановления: при заглушке сразу останавливаем текущую озвучку,
			// очищаем очередь и запрещаем дальнейшую озвучку; повторное нажатие возвращает её (через ref, не завися от слегка отстающего state)
			const toggleMute = useCallback(() => {
				const next = !mutedRef.current;
				mutedRef.current = next;
				setMuted(next);
				if (next) stopPlayback();
			}, [stopPlayback]);

			// Подсказка исчезает через 1.8 с
			useEffect(() => {
				if (!hint) return;
				const t = window.setTimeout(() => setHint(""), 1800);
				return () => window.clearTimeout(t);
			}, [hint]);

		const sendText = useCallback((text) => {
			// Приводим к строке на входе: setDraft у хоста сразу делает text.replace(...),
			// и любой не-строкой (объект распознавания, undefined из сбоя) ронял
			// весь ввод сессии с «text.replace is not a function».
			const spoken = typeof text === "string" ? text.trim() : String(text ?? "").trim();
			if (!spoken) return;
			try {
				if (inputActions && typeof inputActions.setDraft === "function" && typeof inputActions.submit === "function") {
					// Дописываем, а не перезаписываем: уже набранное в поле ввода сохраняется, результат распознавания добавляется в конец
					let current = "";
					if (inputState && typeof inputState.draft === "string") current = inputState.draft;
					const merged = current.trim() ? `${current.trim()} ${spoken}` : spoken;
					inputActions.setDraft(merged);
						// В постоянном диалоге отправка обязательна — иначе никто не нажмёт «отправить» и диалог оборвётся
						if (autoSendRef.current || continuousRef.current) {
							inputActions.submit();
						} else {
							// Автоотправка в настройках выключена: только заполняем поле ввода, отправляет сам пользователь
							setHint("Добавлено в поле ввода, не отправлено автоматически");
						}
					} else {
						console.warn("[dsh-voice-chat] inputActions unavailable, transcript:", text);
						setHint("Распознавание успешно, но канал отправки недоступен");
					}
				} catch (err) {
					console.error("[dsh-voice-chat] send failed", err);
					setHint("Ошибка отправки");
				}
			}, [inputActions, inputState]);

			const clearSilence = useCallback(() => {
				const s = silenceRef.current;
				silenceRef.current = null;
				if (!s) return;
				if (s.timer) window.clearInterval(s.timer);
				try { s.audioCtx && s.audioCtx.close(); } catch (err) { /* ignore */ }
			}, []);

			const stop = useCallback(() => {
				clearSilence();
				const rec = recRef.current;
				recRef.current = null;
				if (rec && rec.state !== "inactive") {
					try { rec.stop(); } catch (err) { /* ignore */ }
				}
			}, [clearSilence]);

			// Детектор тишины: если звука нет дольше 2.5 с, запись останавливается автоматически (дальше срабатывает onstop)
			const startSilenceMonitor = useCallback((stream, rec) => {
				try {
					const AudioCtx = window.AudioContext || window.webkitAudioContext;
					const audioCtx = new AudioCtx();
					const source = audioCtx.createMediaStreamSource(stream);
					const analyser = audioCtx.createAnalyser();
					analyser.fftSize = 1024;
					source.connect(analyser);
					const data = new Uint8Array(analyser.fftSize);
					let lastSound = Date.now();
					const timer = window.setInterval(() => {
						const current = recRef.current;
						if (!current || current.state === "inactive") {
							window.clearInterval(timer);
							return;
						}
						analyser.getByteTimeDomainData(data);
						let sum = 0;
						for (let i = 0; i < data.length; i++) {
							const v = (data[i] - 128) / 128;
							sum += v * v;
						}
						const rms = Math.sqrt(sum / data.length);
						if (rms > 0.01) {
							lastSound = Date.now();
						} else if (Date.now() - lastSound > silenceMsRef.current) {
							window.clearInterval(timer);
							stop();
						}
					}, 200);
					silenceRef.current = { timer, audioCtx };
				} catch (err) {
					console.error("[dsh-voice-chat] silence monitor failed", err);
				}
			}, [stop]);

		/**
		 * Браузерный ASR (Web Speech API).
		 *
		 * Одновременно пишем запись через MediaRecorder: если Web Speech API
		 * откажет (нет сервиса Google, запрет микрофона, Electron), она уйдёт
		 * на /stt с запасным движком. Так кнопка микрофона не «умирает» вместе
		 * с браузерным распознаванием — почти всегда есть чему откатиться.
		 */
		const startBrowserAsr = useCallback(async (settings) => {
			const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
			const support = browserAsrSupport();
			const fallback = asText(settings.asrFallback);
			const fallbackName = (ASR_ENGINE_LABELS[fallback] || fallback) || "—";

			// Подстраховка: параллельная запись, если запасной движок настроен
			let guard = null;
			const stopGuard = () => {
				if (!guard) return;
				try { if (guard.stream) guard.stream.getTracks().forEach((t) => t.stop()); } catch (err) { /* ignore */ }
				try { if (guard.rec && guard.rec.state !== "inactive") guard.rec.stop(); } catch (err) { /* ignore */ }
				guard = null;
			};
			if (support.ok && fallback) {
				try {
					const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					const mime = pickMime();
					const rec = mime
						? new MediaRecorder(stream, { mimeType: mime })
						: new MediaRecorder(stream);
					const chunks = [];
					rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
					guard = { stream, rec, chunks };
					rec.start();
				} catch (err) {
					// Микрофон мог быть занят — тогда подстраховки нет, но это не повод отказывать
					console.warn("[dsh-voice-chat] не удалось включить подстраховку записи:", err);
					guard = null;
				}
			}

			if (!support.ok) {
				stopGuard();
				setHint("Распознавание в браузере недоступно: " + support.reason
					+ ". Надёжный вариант — движок «Локальный» (офлайн) или сетевой ASR");
				return;
			}

			setRecording(true);
			setHint("Слушаю, автозавершение при тишине");
			beep(880, 120);
			const rec = new SR();
			rec.lang = settings.speechLang ?? "ru-RU";
			rec.interimResults = false;
			rec.continuous = false;
			let finished = false;
			// Отказ браузера: отправляем подстраховочную запись запасным движком
			const useFallback = (why) => {
				if (finished) return;
				finished = true;
				setRecording(false);
				const keep = guard;
				stopGuard();
				if (!keep || keep.chunks.length === 0) {
					setHint(browserAsrErrorHint(why) + ". Рабочий вариант — «Локальный» или сетевой ASR");
					return;
				}
				setBusy(true);
				setHint("Браузер не распознал (" + (why || "ошибка") + "), пробую «" + fallbackName + "»…");
				const blob = new Blob(keep.chunks, { type: keep.rec.mimeType || "audio/webm" });
				window.fetch("/dsh-voice-chat/stt?engine=" + encodeURIComponent(fallback), {
					method: "POST", body: blob
				}).then((resp) => resp.json().then((data) => ({ ok: resp.ok, data })).catch(() => ({ ok: false, data: {} })))
					.then(({ ok, data }) => {
						if (!ok) throw new Error((data && data.error) || "ошибка распознавания");
						const text = String((data && data.text) || "").trim();
						if (text) sendText(text);
						else setHint("Не расслышал, повторите");
					})
					.catch((err) => {
						console.error("[dsh-voice-chat] fallback ASR failed:", err);
						setHint("Распознавание не удалось: " + (err && err.message ? err.message : String(err)));
					})
					.finally(() => setBusy(false));
			};
			rec.onresult = (e) => {
				if (finished) return;
				finished = true;
				const text = String(e.results[0][0].transcript || "").trim();
				stopGuard();
				setRecording(false);
				beep(523, 100);
				if (text) sendText(text);
				else setHint("Не расслышал, повторите");
			};
			rec.onerror = (e) => {
				const code = e && e.error;
				console.warn("[dsh-voice-chat] browser ASR error:", code, e);
				// no-speech — это не поломка, а тишина: запасной движок тут не нужен
				if (code === "no-speech") {
					if (finished) return;
					finished = true;
					stopGuard();
					setRecording(false);
					setHint("Не расслышал, повторите");
					return;
				}
				useFallback(code);
			};
			rec.onend = () => {
				stopGuard();
				if (!finished) { finished = true; setRecording(false); }
			};
			try {
				rec.start();
			} catch (err) {
				useFallback("start-failed");
			}
		}, [beep, sendText]);

		const start = useCallback(async () => {
			if (recording || busy) return;
			// Перед началом записи гасим слушатель перебивания и таймер продолжения (микрофон в один момент занимает только одно место)
			stopBarge();
			if (restartTimerRef.current) {
				window.clearTimeout(restartTimerRef.current);
				restartTimerRef.current = null;
			}
			if (!supported) {
				setHint("Браузер не поддерживает запись (рекомендуется Chrome/Edge)");
				return;
			}
			// Движок распознавания известен только из настроек хоста: без них кнопка
			// микрофона не знает, что делать (и раньше уходила в /stt при «Браузере»)
			const settings = await readySettings();
			if (!settings) {
				setHint("Не удалось получить настройки голосового чата");
				return;
			}
			const asrEngine = settings.asrEngine || "siliconflow";
			// Браузерный ASR (Web Speech API)
			if (asrEngine === "browser") return await startBrowserAsr(settings);
			try {
					const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					streamRef.current = stream;
					chunksRef.current = [];
					const mime = pickMime();
					const rec = mime
						? new MediaRecorder(stream, { mimeType: mime })
						: new MediaRecorder(stream);
					rec.ondataavailable = (e) => {
						if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
					};
					rec.onstop = async () => {
						// Сюда попадаем и при ручной остановке, и при автостопе по тишине
						const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
						try {
							stream.getTracks().forEach((t) => t.stop());
						} catch (err) { /* ignore */ }
						streamRef.current = null;
						clearSilence();
						setRecording(false);
						beep(523, 100); // Сигнал окончания (низкий, короткий)
						if (blob.size === 0) return;
						setBusy(true);
						setHint("Распознавание…");
						// Локальный движок в первый раз читает модель с диска — это
						// 5–30 с, и без секундомерa микрофон выглядит зависшим.
						// Показываем, что идёт ожидание, и отменяем его по таймауту.
						const sttStartedAt = Date.now();
						const elapsed = setInterval(() => {
							const secs = Math.round((Date.now() - sttStartedAt) / 1000);
							setHint(secs < 3
								? "Распознавание…"
								: `Распознавание… ${secs} с` + (secs > 8
									? " (локальный движок загружает модель в первый раз)"
									: ""));
						}, 1000);
						// AbortController есть во всех современных браузерах, но в
						// сборках Chromium без него запрос просто уходит без таймаута —
						// хуже, чем отказ, но лучше, чем ReferenceError.
						const canAbort = typeof AbortController === "function";
						const sttController = canAbort ? new AbortController() : null;
						const sttTimeout = canAbort
							? setTimeout(() => sttController.abort(), STT_TIMEOUT_MS)
							: null;
						try {
							// ASR с chat-протоколом (например MiMo) принимает только wav/mp3: сначала конвертируем в WAV 16 кГц моно, потом выгружаем
							let payload = blob;
							if (chatAsrRef.current) {
								try {
									payload = await blobToWav(blob);
								} catch (convErr) {
									console.error("[dsh-voice-chat] wav convert failed", convErr);
									setHint("Ошибка конвертации формата записи, попробуйте снова");
									return;
								}
							}
							const resp = await window.fetch("/dsh-voice-chat/stt", {
								method: "POST",
								body: payload,
								signal: sttController ? sttController.signal : undefined
							});
							const data = await resp.json().catch(() => ({}));
							if (!resp.ok) {
								const msg = (data && data.error) || `HTTP ${resp.status}`;
								console.error("[dsh-voice-chat] stt failed:", msg);
								setHint("Ошибка распознавания: " + msg);
								return;
							}
							const text = (data && data.text || "").trim();
							if (!text) {
								setHint("Не расслышал, повторите");
								return;
							}
							sendText(text);
						} catch (err) {
							console.error("[dsh-voice-chat] stt request failed", err);
							// AbortError = наш таймаут: это не «ошибка сети», и говорить
							// «ошибка запроса» здесь бессмысленно — нужно сказать, что делать.
							setHint(err && err.name === "AbortError" && sttController
								? `Распознавание не ответило за ${Math.round(STT_TIMEOUT_MS / 1000)} с. Проверьте локальный движок: Настройки DSH → голосовой чат → «Локальный»`
								: "Ошибка запроса к сервису распознавания");
						} finally {
							clearInterval(elapsed);
							if (sttTimeout) clearTimeout(sttTimeout);
							setBusy(false);
						}
					};
					rec.onerror = (e) => {
						console.error("[dsh-voice-chat] recorder error", e && e.error);
						clearSilence();
						setRecording(false);
						setHint("Ошибка записи");
					};
					recRef.current = rec;
					setRecording(true);
					setHint("Слушаю, автозавершение при тишине");
					beep(880, 120); // Сигнал начала (высокий, короткий)
					rec.start();
					startSilenceMonitor(stream, rec);
				} catch (err) {
					console.error("[dsh-voice-chat] mic access failed", err);
					setHint("Нет доступа к микрофону (проверьте разрешения браузера)");
				}
			}, [recording, busy, supported, sendText, startSilenceMonitor, beep, stopBarge]);

		// Слушатель перебивания: в постоянном диалоге пользователь заговорил, пока AI ещё
		// говорит → немедленно замолкаем и начинаем записывать речь пользователя. Громкость
		// меряем отдельным потоком getUserMedia; звук дольше ~450 мс считаем перебиванием, чтобы кашель не срабатывал.
		const startBarge = useCallback(async () => {
			if (!continuousRef.current || bargeRef.current || mutedRef.current) return;
			if (recRef.current) return; // Уже идёт запись
			try {
				const AudioCtx = window.AudioContext || window.webkitAudioContext;
				if (!AudioCtx || !navigator.mediaDevices?.getUserMedia) return;
				const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				if (!continuousRef.current || bargeRef.current) {
					try { stream.getTracks().forEach((t) => t.stop()); } catch (err) { /* ignore */ }
					return;
				}
				const audioCtx = new AudioCtx();
				const analyser = audioCtx.createAnalyser();
				analyser.fftSize = 1024;
				audioCtx.createMediaStreamSource(stream).connect(analyser);
				const data = new Uint8Array(analyser.fftSize);
				let loud = 0;
				const timer = window.setInterval(() => {
					analyser.getByteTimeDomainData(data);
					let sum = 0;
					for (let i = 0; i < data.length; i++) {
						const v = (data[i] - 128) / 128;
						sum += v * v;
					}
					const rms = Math.sqrt(sum / data.length);
					loud = rms > 0.02 ? loud + 1 : 0;
					if (loud >= 3) {
						stopPlayback();          // Заткнуть + очистить очередь
						setHint("Перебил, слушаю…");
						startRef.current && startRef.current();
					}
				}, 150);
				bargeRef.current = { timer, stream, audioCtx };
			} catch (err) {
				// Если микрофон для слушателя недоступен (права/занят) — тихо деградируем: перебивание не работает, озвучка остаётся прежней
				console.warn("[dsh-voice-chat] контроль перебивания не запущен:", err);
			}
		}, [stopPlayback]);

		// Для вызова из таймерных колбэков playTts / pump (во избежание TDZ в зависимостях useCallback)
		useEffect(() => { startRef.current = start; }, [start]);
		useEffect(() => { startBargeRef.current = startBarge; }, [startBarge]);

			const toggle = useCallback(() => {
				if (recording) {
					// Ручная остановка: после этого цикл сам микрофон больше не включит (постоянный диалог вернётся по кнопке «начать»)
					pausedRef.current = true;
					stop();
				} else {
					pausedRef.current = false;
					stopPlayback(); // Если идёт озвучка — сразу стоп (один канал), затем начинаем слушать
					start();
				}
			}, [recording, stop, start, stopPlayback]);

			// Горячая клавиша: удержание — запись, отпускание — стоп и распознавание (push-to-talk).
			// Сочетание задаётся панелью настроек (по умолчанию — правый Ctrl), "" — выключено.
			// Слушаем на window, поэтому работает и при наборе текста в поле ввода;
			// preventDefault стоит только на самом совпавшем сочетании.
			const hotkeyCombo = typeof settingsValue?.asrHotkey === "string"
				? settingsValue.asrHotkey
				: DEFAULT_HOTKEY;
			useEffect(() => {
				if (!hotkeyCombo) return;
				const onKeyDown = (e) => {
					if (e.repeat || !hotkeyMatches(e, hotkeyCombo)) return;
					e.preventDefault();
					// Уже идёт запись или распознавание — ждём отпускания клавиши
					if (recording || busy) return;
					pausedRef.current = true;   // push-to-talk: не продолжать диалог самому
					stopPlayback();             // Если идёт озвучка — сразу стоп (один канал), затем начинаем слушать
					start();
				};
				const onKeyUp = (e) => {
					if (!hotkeyMatches(e, hotkeyCombo)) return;
					e.preventDefault();
					// После отпускания, если запись ещё идёт — отправляем на распознавание
					const rec = recRef.current;
					if (rec && rec.state !== "inactive") stop();
				};
				window.addEventListener("keydown", onKeyDown);
				window.addEventListener("keyup", onKeyUp);
				// Уход со страницы без keyup — иначе запись не остановится
				const onBlur = () => {
					const rec = recRef.current;
					if (rec && rec.state !== "inactive") stop();
				};
				window.addEventListener("blur", onBlur);
				return () => {
					window.removeEventListener("keydown", onKeyDown);
					window.removeEventListener("keyup", onKeyUp);
					window.removeEventListener("blur", onBlur);
				};
			}, [hotkeyCombo, recording, busy, start, stop, stopPlayback]);

			// Очистка при размонтировании
			useEffect(() => () => {
				clearSilence();
				stopPlayback();
				if (streamRef.current) {
					try { streamRef.current.getTracks().forEach((t) => t.stop()); } catch (err) { /* ignore */ }
				}
			}, [clearSilence, stopPlayback]);

			const styles = {
				wrap: {
					display: "inline-flex",
					alignItems: "center",
					gap: 6,
					marginRight: 8,
					flex: "none",
					position: "relative"
				},
				mic: {
					width: 32,
					height: 32,
					borderRadius: "50%",
					border: "1px solid var(--dsw-alias-border-l2, #ccc)",
					background: recording ? "#e5484d" : busy ? "#f5b53f" : "transparent",
					color: recording || busy ? "#fff" : "var(--dsw-alias-label-primary, #333)",
					fontSize: 16,
					cursor: "pointer",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					flex: "none"
				},
				mute: {
					width: 32,
					height: 32,
					borderRadius: "50%",
					border: "1px solid var(--dsw-alias-border-l2, #ccc)",
					background: muted ? "#e5484d" : speaking ? "#f5b53f" : "transparent",
					color: muted || speaking ? "#fff" : "var(--dsw-alias-label-primary, #333)",
					fontSize: 16,
					cursor: "pointer",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					flex: "none"
				},
				hint: {
					position: "absolute",
					bottom: "calc(100% + 6px)",
					right: 0,
					// Фиксированный тёмно-серый фон: не уплывает в светло-серый вместе с темой, белый текст контрастнее, подсказка заметнее
					background: "#202026",
					color: "#fff",
					fontSize: 12,
					whiteSpace: "nowrap",
					padding: "4px 8px",
					borderRadius: 6,
					zIndex: 20,
					maxWidth: 260,
					overflow: "hidden",
					textOverflow: "ellipsis",
					boxShadow: "0 2px 10px rgba(0, 0, 0, 0.4)"
				}
			};

			if (!supported) {
				return React.createElement("span", {
					style: { display: "inline-flex", alignItems: "center", marginRight: 8, opacity: 0.5 },
					title: "Браузер не поддерживает запись, рекомендуется Chrome / Edge"
				}, React.createElement(Icon, { paths: ICON_MIC, size: 16 }));
			}

			return React.createElement("span", { style: styles.wrap },
				hint ? React.createElement("span", { style: styles.hint }, hint) : null,
				React.createElement("button", {
					type: "button",
					onClick: toggle,
					style: styles.mic,
					disabled: busy,
					title: recording
						? "Нажмите для завершения и отправки"
						: busy
							? "Распознавание…"
							: "Нажмите для начала прослушивания (автозавершение при тишине)" +
							  (typeof settingsValue?.asrHotkey === "string" && settingsValue.asrHotkey
								? " · удерживайте " + hotkeyLabel(settingsValue.asrHotkey)
								: "")
				}, React.createElement(Icon, { paths: ICON_MIC, size: 16 })),
				React.createElement("button", {
					type: "button",
					onClick: toggleMute,
					style: styles.mute,
					title: muted ? "Без звука, нажмите для включения" : speaking ? "Озвучивается, нажмите для остановки" : "Переключатель озвучки (нажмите для отключения)"
				}, React.createElement(Icon, { paths: muted ? ICON_MUTED : ICON_SPEAKER, size: 16 }))
			);
		}

		// ---------- Плагин ----------
		const inject = ["slots", "modelDirectories"];

		/**
		 * Сторож для чужого (хоста) бага: dsh-client-ui-conversation при монтировании
		 * делает `if (inputState.draft === "" && storedDraft !== "") inputActions.setDraft(storedDraft)`.
		 * Хранилище переигрывает localStorage ЦЕЛИКОМ (attachPersistence делает
		 * setState(JSON.parse(raw)) без слияния с init), поэтому битый/старый блоб
		 * `dsh.conversation[.<sessionId>]` без строкового draft даёт storedDraft === undefined,
		 * условие проходит, а setDraft(undefined) падает в DraftEditorRuntime с
		 * «text.replace is not a function» — и весь ввод сессии уезжает в error boundary.
		 * Чиним до рендера: приводим draft к строке. Своих данных не портим.
		 */
		function repairPersistedDrafts() {
			try {
				if (typeof window === "undefined" || !window.localStorage) return;
				const prefix = "dsh.conversation";
				for (let i = 0; i < window.localStorage.length; i++) {
					const key = window.localStorage.key(i);
					if (!key || (key !== prefix && !key.startsWith(prefix + "."))) continue;
					const raw = window.localStorage.getItem(key);
					if (!raw) continue;
					let data;
					try { data = JSON.parse(raw); } catch { continue; }
					if (!data || typeof data !== "object" || Array.isArray(data)) {
						window.localStorage.setItem(key, JSON.stringify({ draft: "", view: null, viewRequest: null }));
						continue;
					}
					if (typeof data.draft !== "string") {
						data.draft = "";
						window.localStorage.setItem(key, JSON.stringify(data));
					}
				}
			} catch (err) {
				// приватный режим / переполнение — не повод ничего ломать
			}
		}

		function apply(ctx) {
			repairPersistedDrafts();
			// root-scoped: категория voice chat в диалоге настроек DSH (сервисы внутри session не нужны)
			const slots = ctx.get("slots");
			if (slots !== undefined) {
				slots.inject("settings.section", () => slots.register(
					{ name: "settings.section", id: "dsh-voice-chat", order: 400, label: "голосовой чат" },
					(props) => React.createElement(VoiceChatSettingsSection, props)
				));
			}
			// session-scoped: кнопки микрофона и звука справа от поля ввода — нужен сервис
			// modelDirectories, чтобы узнать реально используемую в диалоге LLM
			// (provider+model) и передать её хосту при пересказе, а не жёстко зашитый умолчательный (модель могла быть отключена или ключ неверный).
			ctx.inject(["slots", "modelDirectories"], (scope) => {
				scope.slots.inject("conversation.input.right", () => scope.slots.register(
					{ name: "conversation.input.right", id: "dsh-voice-chat", order: 100 },
					(props) => {
						// Стабилизируем ссылку на hook: scope.modelDirectories стабилен в течение жизни session scope
						const useCurrentModel = React.useMemo(
							() => makeUseCurrentModelImpl(scope.modelDirectories),
							[scope.modelDirectories]
						);
						return React.createElement(VoiceChatButton, {
							...props,
							useCurrentModel
						});
					}
				));
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
