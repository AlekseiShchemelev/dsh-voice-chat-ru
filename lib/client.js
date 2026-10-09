window.__ModuleLoader__.load({
	id: "dsh-voice-chat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let React = require("react");
		const { useState, useEffect, useRef, useCallback } = React;

		// ---------- 模块级 helpers ----------
		/** 从内容块里提取纯文本（兼容 wire 层 {type:'text'} 与 UI 层 {kind:'text'}）。 */
		function extractText(blocks) {
			if (!Array.isArray(blocks)) return "";
			return blocks
				.filter((b) => b && (b.type === "text" || b.kind === "text") && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n")
				.trim();
		}

		/** 选一个可用的录音 mimeType。 */
		function pickMime() {
			if (typeof MediaRecorder === "undefined") return "";
			const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
			for (const m of candidates) {
				if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
			}
			return "";
		}

	/** ASR 引擎内置默认（与服务端 ASR_ENGINE_DEFAULTS 保持一致；仅用于占位符/切引擎联动）。 */
	const ASR_ENGINE_DEFAULTS = {
		siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall" },
		groq: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
		mimo: { baseUrl: "https://api.xiaomimimo.com/v1/chat/completions", model: "mimo-v2.5-asr" },
		custom: { baseUrl: "", model: "" },
		browser: { baseUrl: "", model: "" },
		local: { baseUrl: "http://127.0.0.1:8765/v1", model: "small" }
	};
	const ASR_ENGINES = ["siliconflow", "groq", "mimo", "custom", "browser", "local"];
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
	/** TTS 引擎内置默认（与服务端 TTS_ENGINE_DEFAULTS 保持一致；用于占位符/字段提示）。 */
	const TTS_ENGINE_DEFAULTS = {
		edge: { baseUrl: "", model: "", voice: "ru-RU-SvetlanaNeural" },
		mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", voice: "mimo_default" },
		custom: { baseUrl: "", model: "tts-1", voice: "alloy" },
		browser: { baseUrl: "", model: "", voice: "" },
		local: { baseUrl: "http://127.0.0.1:8765/v1", model: "piper", voice: "ru_RU-irina-medium" }
	};
	const TTS_ENGINES = ["edge", "mimo", "custom", "browser", "local"];
		/** 各引擎在设置面板里可编辑的字段（ASR/TTS 都是"每引擎一份"，互不串味）。 */
		const SLOT_FIELDS = {
			asr: ["baseUrl", "model", "apiKey"],
			tts: ["baseUrl", "model", "apiKey", "voice"]
		};

		/** 生成"每引擎一份"的空槽结构。 */
		function emptySlots(group) {
			const engines = group === "asr" ? ASR_ENGINES : TTS_ENGINES;
			const out = {};
			for (const engine of engines) out[engine] = {};
			return out;
		}

		/**
		 * 从宿主 /settings 回显里读出"每引擎一份"的槽：
		 *   新版宿主给 asrConfig/ttsConfig（每个引擎自己的配置）；
		 *   旧版宿主（无该字段）则把扁平键(ttsBaseUrl…)当作当前引擎的槽值兜底。
		 * 这样切换引擎时表单只会看到该引擎自己的值，不会看到别的引擎的配置。
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
					// 旧宿主兜底：扁平键只归"当前选中的那个引擎"，避免误当成所有引擎共用
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

		/** 判断生效设置是否走 chat/completions 协议 ASR（MiMo 式，仅支持 wav/mp3）。 */
		function isChatAsrSettings(s) {
			if (!s || typeof s !== "object") return false;
			if (s.asrEngine === "mimo") return true;
			return /\/chat\/completions\/?$/i.test(String(s.asrBaseUrl || ""));
		}

		/**
		 * 浏览器端把录音(webm/ogg/mp4)转成 16kHz 单声道 16bit WAV：
		 * MiMo 等 chat 协议 ASR 只吃 wav/mp3；解码/重采样全用 Web Audio 原生 API，
		 * 不依赖任何外部库。失败抛错，由调用方提示用户重试。
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
		 * 新版 DSH(0.1.2-rc.1)适配:session 里没有消息列表,消息在专用
		 * conversation store(插件 slot 拿不到)。从 DOM 提取最新一条回复文本:
		 * 聊天界面按文档序渲染,越靠下越新;排除输入区/侧栏/含编辑器的容器,
		 * 取"最后一个有实质文本的块"作为 AI 最新回复。
		 */
		function extractLatestAssistantText() {
			try {
				const all = document.querySelectorAll("div,article,section,p");
				let last = null;
				for (const el of all) {
					const t = (el.textContent || "").trim();
					if (t.length < 2 || t.length > 6000) continue;    // 只排除空文本/超大容器
					if (el.children.length > 15) continue;
					if (el.offsetHeight < 10) continue;
					// 排除输入区(含编辑器/文本框)与导航/侧栏
					if (el.querySelector("textarea,input,[contenteditable='true'],[role='textbox']")) continue;
					const cls = String(el.className || "") + " " + String(el.id || "");
					if (/composer|inputBar|input-bar|sidebar|settings|toolbar|header|footer|hero|nav/i.test(cls)) continue;
					last = el;
				}
				if (!last) return null;
				return (last.textContent || "").trim().slice(0, 5000);
			} catch (err) {
				console.warn("[dsh-voice-chat] DOM 提取失败:", err);
				return null;
			}
		}

		// ---------- 扁平 SVG 图标（Feather 风格，线性描边，随 currentColor 变色） ----------
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
		/** 渲染一个 24x24 线性 SVG 图标。 */
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

		// ---------- 设置页（嵌入 DSH 自带设置弹窗的 settings.section 类目） ----------
	// 常用 Edge TTS 音色候选（可自由手输任意 voice 名）
	const VOICE_PRESETS = [
		"ru-RU-SvetlanaNeural",   // Светлана（女，默认）
		"ru-RU-DmitryNeural",     // Дмитрий（男）
		"zh-CN-XiaoxiaoNeural",   // 晓晓（女）
		"zh-CN-YunxiNeural",      // 云希（男）
		"zh-CN-YunyangNeural",    // 云扬（男，新闻）
		"zh-CN-YunjianNeural",    // 云健（男）
		"zh-CN-XiaoyiNeural",     // 晓伊（女）
		"zh-HK-HiuMaanNeural",    // 粤语 曉曼
		"zh-TW-HsiaoChenNeural",  // 台湾 曉臻
		"en-US-AriaNeural",
		"en-US-GuyNeural",
		"ja-JP-NanamiNeural"
	];
		// MiMo TTS 预置音色（mimo-v2.5-tts 可选值；留空走 mimo_default）
		const MIMO_TTS_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];

		// ---------- 启动识别的按键/组合键 ----------
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
				lines.push((state.modelsReady ? "✓" : "✗") + " Модели (Piper ru_RU-irina-medium, faster-whisper " + ((ASR_ENGINE_DEFAULTS.local || {}).model || "small") + ")");
				lines.push((state.serverRunning ? "✓" : "✗")
					+ " Сервер: " + (state.serverRunning ? ("работает на порту " + (state.port ?? "—") + (state.pid ? " (pid " + state.pid + ")" : "")) : "не запущен"));
				lines.push("Каталог данных: " + (state.dataDir || "—"));
				if (state.installError) lines.push("Ошибка установки: " + state.installError);
				if (state.error) lines.push("Замечание: " + state.error);
				if (state.logFile) lines.push("Лог установки: " + state.logFile);
			} else if (!err) {
				lines.push("Статус загружается…");
			}

			return React.createElement("div", { style: SECTION_STYLES.localBox },
				React.createElement("div", { style: { opacity: 0.85, marginBottom: 6 } },
					"Офлайн-движок (Piper + faster-whisper). Всё считается на вашей машине, ключи не нужны. "
					+ "Сервер поднимается сам при первом запросе — кнопка «Установить» нужна один раз."),
				lines.map((line, i) => React.createElement("div", { key: "l" + i, style: { fontFamily: "monospace", whiteSpace: "pre-wrap" } }, line)),
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
					React.createElement("button", {
						type: "button", style: SECTION_STYLES.secondary,
						disabled: !!busy || !installed || !!state?.serverRunning,
						onClick: () => call("start", "start")
					}, busy === "start" ? "Запуск…" : "Запустить сервер"),
					React.createElement("button", {
						type: "button", style: SECTION_STYLES.secondary,
						disabled: !!busy || !state?.serverRunning || !!state?.external,
						onClick: () => call("stop", "stop")
					}, busy === "stop" ? "Остановка…" : "Остановить сервер"),
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

		// ---------- 设置共享总线（模块级） ----------
		// 宿主 /settings 的生效设置由 输入框按钮 与 设置页 共享同一份数据：
		// 任一组件保存后立即广播，另一侧无需刷新页面即可生效。
		const settingsBus = { current: null, listeners: new Set() };
		/** 拉取宿主生效设置（GET /settings）。 */
		function fetchSettings() {
			return window.fetch("/dsh-voice-chat/settings")
				.then((r) => (r.ok ? r.json() : null))
				.catch(() => null);
		}
		/** 广播设置变更（同时更新 current 快照）。 */
		function emitSettings(value) {
			if (value && typeof value === "object") settingsBus.current = value;
			for (const fn of settingsBus.listeners) {
				try { fn(settingsBus.current); } catch (err) { /* ignore */ }
			}
		}
		/** 订阅设置；返回退订函数。 */
		function subscribeSettings(fn) {
			settingsBus.listeners.add(fn);
			return () => settingsBus.listeners.delete(fn);
		}
		/** 设置订阅 hook：首次挂载若还没加载过就拉一次宿主，并随广播刷新。 */
		function useSettings() {
			const [value, setValue] = useState(settingsBus.current);
			useEffect(() => {
				if (!settingsBus.current) fetchSettings().then((data) => { if (data) emitSettings(data); });
				return subscribeSettings((v) => setValue(v));
			}, []);
			return value;
		}

		/**
		 * 构造一个订阅当前会话模型选择的 hook（modelDirectories 服务）。
		 * 返回的 useCurrentModel(sessionId) 读取后会跟随用户切换模型自动刷新。
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
					// 首次挂载若还在 idle，主动 load 一次把 current 拉下来
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
		 * DSH 设置弹窗左侧"voice chat"类目（settings.section）的内容表单：
		 * ASR 接口(Base URL/模型/Key)、识别后是否自动发送、转述朗读开关、
		 * 静音自动结束时长、朗读音色。保存到宿主 settings.local.json 并立即广播生效。
		 *
		 * 关键：ASR/TTS 都是**每个引擎一份独立的槽**（asrSlots/ttsSlots），切换引擎
		 * 只切"看哪一份"，各引擎的 Base URL/模型/密钥/音色互不覆盖（修掉配置串味）。
		 * 保存时只提交当前正在编辑的那一份，其它引擎的配置原样保留。
		 */
		function VoiceChatSettingsSection(props) {
			const settings = useSettings();
			// 语音识别设置（按引擎分槽）
			const [engine, setEngine] = useState("siliconflow"); // siliconflow | groq | mimo | custom | browser | local
			const [asrSlots, setAsrSlots] = useState(() => emptySlots("asr"));
			const [autoSend, setAutoSend] = useState(true);
			// 持续对话：AI 答完后自动重新开录，AI 说话时插话即打断
			const [continuous, setContinuous] = useState(false);
			const [silenceSec, setSilenceSec] = useState("2.5");
			// 启动识别的按键/组合键（push-to-talk：держишь — пишет, отпустил — отправил)
			const [hotkey, setHotkey] = useState(DEFAULT_HOTKEY);
			// Порт локального сервера: общий для ASR и TTS (сервер поднимается один)
			const [localPort, setLocalPort] = useState(String(DEFAULT_LOCAL_PORT));
			// 朗读设置（按引擎分槽）
			const [rewrite, setRewrite] = useState(false); // 转述朗读（长回复先精简再播），默认关闭
			const [ttsEngine, setTtsEngine] = useState("edge");
			const [ttsSlots, setTtsSlots] = useState(() => emptySlots("tts"));
			const [ratePercent, setRatePercent] = useState(110);
			const [speechLang, setSpeechLang] = useState("ru-RU");
			// UI 状态
			const [saving, setSaving] = useState(false);
			const [err, setErr] = useState("");
			const [status, setStatus] = useState("");
			// Тема для нативных списков: тёмная по умолчанию, светлая — если фон DSH светлый
			const [scheme] = useState(() => pickColorScheme());
			const filledRef = useRef(false); // 只按首次到达的数据回填表单，避免覆盖用户输入
			const touchedRef = useRef(false); // 用户改过表单后禁止自动回填覆盖（防"先勾选、后回填"竞态）

			// 当前正在编辑的两份槽（切引擎只换取哪一份，不共用字段）
			const asrSlot = asrSlots[engine] || {};
			const ttsSlot = ttsSlots[ttsEngine] || {};

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
					+ "для русской речи на ноутбуке обычно лучше small"),
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
			/** 改当前引擎槽里的一个字段（其它引擎的槽一律不动）。 */
			const setSlot = (group, engineName, field, value) => {
				touchedRef.current = true;
				const setter = group === "asr" ? setAsrSlots : setTtsSlots;
				setter((prev) => ({
					...prev,
					[engineName]: { ...(prev[engineName] || {}), [field]: value }
				}));
			};

			// 生效设置到达后回填一次表单（仅当用户尚未手动改动时）
			useEffect(() => {
				if (!settings || filledRef.current || touchedRef.current) return;
				filledRef.current = true;
			// 语音识别设置（引擎回显：URL 是 chat/completions 端点 → 按 mimo 显示）
			setEngine(settings.asrEngine === "mimo" || /\/chat\/completions\/?$/i.test(String(settings.asrBaseUrl ?? ""))
				? "mimo"
				: (String(settings.asrEngine ?? "siliconflow") || "siliconflow"));
			setAsrSlots(slotsFromSettings(settings, "asr"));
			setAutoSend(settings.autoSend !== false);
			setContinuous(settings.continuousMode === true);
			const ms = Number(settings.silenceMs);
			setSilenceSec(String(Number.isFinite(ms) && ms > 0 ? Math.round(ms / 100) / 10 : 2.5));
			// 朗读设置
			setRewrite(settings.rewrite === true);
			setTtsEngine(TTS_ENGINES.includes(settings.ttsEngine) ? settings.ttsEngine : "edge");
			setTtsSlots(slotsFromSettings(settings, "tts"));
			setRatePercent(settings.ratePercent ?? 110);
			setSpeechLang(settings.speechLang ?? "ru-RU");
			// 宿主没回显该字段（旧版插件）→ 用内置默认值
			setHotkey(typeof settings.asrHotkey === "string" ? settings.asrHotkey : DEFAULT_HOTKEY);
			// Порт берём из адреса слота local: если он нестандартный, он уже в настройках
			setLocalPort(localPortFromUrl(slotsFromSettings(settings, "asr").local?.baseUrl
				|| slotsFromSettings(settings, "tts").local?.baseUrl));
		}, [settings]);

			// 保存成功提示 2.5s 后消失
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
				// 只提交"当前编辑的引擎"这一份槽；其余引擎的配置留在文件里不动。
				// Для local адрес и ключ не показываем: собираем адрес из порта, ключ не нужен
				const asrPatch = engine === "local"
					? { baseUrl: localUrlFromPort(localPort), model: trim(asrSlot.model), apiKey: "" }
					: { baseUrl: trim(asrSlot.baseUrl), model: trim(asrSlot.model), apiKey: trim(asrSlot.apiKey) };
				const ttsPatch = ttsEngine === "edge"
					? { voice: trim(ttsSlot.voice) }
					: ttsEngine === "local"
						? { baseUrl: localUrlFromPort(localPort), model: trim(ttsSlot.model), apiKey: "", voice: trim(ttsSlot.voice) }
						: { baseUrl: trim(ttsSlot.baseUrl), model: trim(ttsSlot.model), apiKey: trim(ttsSlot.apiKey), voice: trim(ttsSlot.voice) };
				// 同时带上旧版扁平键：老宿主（≤0.3.x）只认这些键，读到就归当前引擎
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
					// 语音识别设置
					asrEngine: engine,
					asr: asrSlotsPayload,
					autoSend,
					continuousMode: continuous,
					silenceMs: Math.round(sec * 1000),
					asrHotkey: hotkey,
					// 朗读设置
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
						emitSettings(data.settings); // 广播：麦克风按钮的静音时长/自动发送等立即生效
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
				// ========== 语音识别设置 ==========
				React.createElement("h4", { style: { ...SECTION_STYLES.h, fontSize: 14, marginTop: 18 } }, "🎤 Настройки распознавания речи"),
				field("Движок ASR",
					React.createElement("select", {
						style: selectStyle(scheme),
						value: engine,
						// 切引擎只是"换看哪一份槽"：各引擎的 Base URL/模型/密钥各自独立保存
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
				engine === "browser" ? React.createElement("div", { style: SECTION_STYLES.note, key: "browser-asr-note" },
					"Браузерный движок никуда не обращается через плагин: ни адрес, ни модель, "
					+ "ни ключ не настраиваются. Аудио уходит в Web Speech API самого браузера (в Chrome — "
					+ "на серверы Google, поэтому нужен интернет; в Electron и сборках Chromium без Google "
					+ "Speech движок не работает вовсе — тогда выбирайте «Локальный» или сетевой движок)."
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
				// ========== 朗读设置 ==========
				React.createElement("h4", { style: { ...SECTION_STYLES.h, fontSize: 14, marginTop: 24 } }, "🔊 Настройки озвучки"),
				field("Движок TTS",
					React.createElement("select", {
						style: selectStyle(scheme),
						value: ttsEngine,
						// 切引擎只是"换看哪一份槽"：各引擎的地址/模型/密钥/音色各自独立保存
						onChange: (e) => { touchedRef.current = true; setTtsEngine(e.target.value); }
					},
				React.createElement("option", { value: "edge" }, "Microsoft Edge TTS (бесплатно, рекомендуется)"),
				React.createElement("option", { value: "mimo" }, "Xiaomi MiMo TTS (chat-протокол)"),
				React.createElement("option", { value: "custom" }, "Пользовательский TTS (OpenAI-совместимый)"),
				React.createElement("option", { value: "browser" }, "Браузер (офлайн, speechSynthesis)"),
				React.createElement("option", { value: "local" }, "Локальный (Piper, офлайн)")
					),
					"Конфигурация каждого движка сохраняется отдельно, переключение движков не перезаписывает настройки"),
				// 自定义 TTS 设置（仅当 ttsEngine === 'custom' 时显示）
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
				// MiMo TTS 设置（仅当 ttsEngine === 'mimo' 时显示）
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
				ttsEngine === "local" ? field("Голос (локальный Piper)",
					React.createElement("select", {
						style: selectStyle(scheme),
						value: LOCAL_TTS_VOICES.includes(ttsSlot.voice) ? ttsSlot.voice : "ru_RU-irina-medium",
						onChange: (e) => setSlot("tts", "local", "voice", e.target.value)
					}, LOCAL_TTS_VOICES.map((v) => React.createElement("option", { key: v, value: v },
						v + (v === "ru_RU-irina-medium" ? " — по умолчанию" : "")))),
					"Русские голоса Piper существуют только в качестве medium. Модель выбранного голоса "
					+ "скачивается при установке; остальные можно добавить позже, положив их в "
					+ "<dataDir>/models/piper/<имя>/ и указав имя здесь."
				) : null,
				// Браузерный TTS: настраивать нечего — speechSynthesis
				ttsEngine === "browser" ? React.createElement("div", { style: SECTION_STYLES.note, key: "browser-tts-note" },
					"Браузерная озвучка (speechSynthesis) ничего не требует: ни адреса, ни ключа. "
					+ "Язык и скорость берутся из общих настроек ниже."
				) : null,
				// Edge TTS 设置（仅当 ttsEngine === 'edge' 时显示）
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

		// ---------- 组件 ----------
		function VoiceChatButton(props) {
			const { useSession, inputActions, useCurrentModel, sessionId, useInput } = props;
			const session = typeof useSession === "function" ? useSession((s) => s) : undefined;
			// 订阅输入框当前内容：语音听写结果要"追加"而不是覆盖已有草稿
			const inputState = typeof useInput === "function" ? useInput((s) => s) : undefined;
			// 订阅"当前对话实际在用的 LLM 选择"，转述朗读时把 provider/model
			// 透传给宿主 /speak，避免一直用宿主默认（可能已被关闭/密钥不对）。
			const currentModel = typeof useCurrentModel === "function" ? useCurrentModel(sessionId) : null;

			// [DEBUG] 诊断已结束:session keys 确认无消息列表,采用 running+DOM 方案。

			// 语音相关状态
			const [recording, setRecording] = useState(false);
			const [busy, setBusy] = useState(false);
			const [hint, setHint] = useState("");
			const [muted, setMuted] = useState(false);      // 朗读开关（静音）
			const [speaking, setSpeaking] = useState(false); // 正在播报
			const mutedRef = useRef(false);
			const audioRef = useRef(null);
			// 播放队列：播报不打断，按顺序一条条讲完
			const queueRef = useRef([]);         // 待播放文本队列（FIFO）
			const playingRef = useRef(false);    // 是否正在播放某一条
			const resetTokenRef = useRef(0);     // 停止/静音时递增，作废在途请求
			const finishAudioRef = useRef(null); // 结束当前音频的钩子（stop 时触发）

			const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia;
			const recRef = useRef(null);
			const streamRef = useRef(null);
			const chunksRef = useRef([]);
			const silenceRef = useRef(null);
			const silenceMsRef = useRef(2500); // 静音自动停止时长，启动时从 /settings 读取
			const autoSendRef = useRef(true);  // 识别完成后是否自动点发送，启动时从 /settings 读取
			const chatAsrRef = useRef(false);  // ASR 是否走 chat/completions 协议（MiMo 式，需转 WAV 上传）
			// 持续对话（"活的聊天"）：AI 答完自动重新开录 + 说话时插话打断
			const continuousRef = useRef(false);
			const bargeRef = useRef(null);     // 插话监听句柄 { stop() }
			const restartTimerRef = useRef(null); // 答完后重新开录的延时句柄
			const startRef = useRef(null);    // start() 的引用（供插话/续听回调调用，避免 TDZ）
			const startBargeRef = useRef(null); // startBarge() 的引用（同上）
			const pausedRef = useRef(false);   // 用户手动停了录音 → 持续对话循环不再自己续上

			// 从共享设置总线读取生效设置（静音自动结束时长、识别后是否自动发送）；
			// 设置页保存后广播过来会即时刷新本侧，无需刷新页面。
			const settingsValue = useSettings();
			useEffect(() => {
				if (!settingsValue) return;
				if (Number.isFinite(Number(settingsValue.silenceMs)) && Number(settingsValue.silenceMs) > 0) {
					silenceMsRef.current = Math.round(Number(settingsValue.silenceMs));
				}
				autoSendRef.current = settingsValue.autoSend !== false;
				chatAsrRef.current = isChatAsrSettings(settingsValue); // MiMo 等 chat 协议 → 上传前转 WAV
				continuousRef.current = settingsValue.continuousMode === true;
			}, [settingsValue]);

			// 注意：useCallback 的依赖数组在定义时求值，函数必须先定义后引用（避免 TDZ）。

		// 停止插话监听（关掉监听用的麦克风流与 AudioContext）。
		const stopBarge = useCallback(() => {
			const b = bargeRef.current;
			bargeRef.current = null;
			if (!b) return;
			try { if (b.timer) window.clearInterval(b.timer); } catch (err) { /* ignore */ }
			try { b.stream && b.stream.getTracks().forEach((t) => t.stop()); } catch (err) { /* ignore */ }
			try { b.audioCtx && b.audioCtx.close(); } catch (err) { /* ignore */ }
		}, []);

			// 停止当前播报并清空队列（静音按钮/快捷键/开始录音时调用）。
			// 顺序很关键：必须先暂停正在发声的音频元素，再触发 finish 钩子——
			// done 钩子会把 audioRef.current 置空，若先调钩子，后面的 pause 永远
			// 执行不到，声音会继续播完当前片段，"按喇叭立刻静音"就失效了。
			const stopPlayback = useCallback(() => {
				resetTokenRef.current += 1; // 作废在途的异步播报请求与排队
				queueRef.current = [];
				stopBarge(); // 插话监听随播报一起结束（重新开录时会再挂上）
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

		// 播放一段 MP3，返回 Promise：播放结束/失败/被停止时 resolve(true)；不可播 resolve(false)
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
			 * 短促提示音（Web Audio 合成，无需音频文件）。
			 * @param freq 频率 Hz；start=880 高音，end=523 低音
			 * @param ms 时长（短促，100~150ms）
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
				} catch (err) { /* 提示音失败不影响功能 */ }
			}, []);

		// 浏览器 TTS 兜底（Promise 版：播完才 resolve，配合队列泵）
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
				window.setTimeout(() => resolve(true), 30000); // 兜底：长时间无回调
			} catch (err) {
				console.error("[dsh-voice-chat] fallback speak failed", err);
				resolve(false);
			}
		}), [settingsValue?.speechLang, settingsValue?.ratePercent]);

		// 播放一条文本（转述 → edge-tts → 浏览器 TTS 逐级降级），播完 resolve(true)
		const playOne = useCallback(async (text) => {
			const token = resetTokenRef.current;
			const stillAlive = () => resetTokenRef.current === token && !mutedRef.current;
			// 兜底朗读用文本：优先服务端转述结果（/speak 失败时随错误带回），否则原文。
			let fallbackText = text;
			// 服务端与本地都失败时，把原因显示出来（否则"没声音"只能靠翻控制台）
			let failReason = "";
			// 0) 浏览器 TTS движок：直接 в speechSynthesis
			if (settingsValue?.ttsEngine === "browser") {
				const spoken = await fallbackSpeakP(text);
				if (!spoken) setHint("Ошибка озвучки (браузерный TTS недоступен)");
				return spoken;
			}
			// 1) 转述式朗读
			try {
				const resp = await window.fetch("/dsh-voice-chat/speak", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						text,
						// 把当前对话实际在用的 LLM 透传给宿主，让转述跟当前对话走
						llmProvider: currentModel && currentModel.provider,
						llmModel: currentModel && current.model
					})
				});
					if (!stillAlive()) return false;
					if (resp.ok) {
						const blob = await resp.blob();
						if (!stillAlive()) return false;
						if (await playAudioBlob(blob)) return true;
					} else {
						console.warn("[dsh-voice-chat] speak endpoint failed:", resp.status);
						// edge-tts 挂了：服务端把"实际要读的台词"（转述版或原文）放在错误 body 里
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
				// 2) 降级：原样朗读（优先读转述版）
				try {
					const resp = await window.fetch("/dsh-voice-chat/tts?text=" + encodeURIComponent(fallbackText));
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
				// 3) 最后回退：浏览器 TTS
				const spoken = await fallbackSpeakP(fallbackText);
				const brief = failReason ? failReason.slice(0, 60) : "";
			if (!spoken) setHint(brief ? `Ошибка озвучки: ${brief}` : "Ошибка озвучки (нет звука на сервере и в браузере)");
			else if (brief) setHint(`Деградировано до браузерной озвучки: ${brief}`);
				return spoken;
			}, [playAudioBlob, fallbackSpeakP]);

			// 队列泵：一条播完自动播下一条
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
						// 持续对话：这一轮说完了就把麦克风重新打开，等用户接着说
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
			 * 朗读：入队顺序播放（播报不打断）。
			 * 正在播的让它播完，新回复排到队尾依次讲；只有 stopPlayback
			 * （静音/停止/开始录音）才会清空队列立即停止。
			 */
			const playTts = useCallback((text) => {
				if (!text || typeof window === "undefined" || mutedRef.current) return;
				queueRef.current.push(text);
				setSpeaking(true); // 有排队即算"播报中"
				if (continuousRef.current) startBargeRef.current && startBargeRef.current();
				pump();
			}, [pump]);

			// ---------- 新版 DSH 消息检测(0.1.2-rc.1 适配) ----------
			// session 里已无 nodes(消息在插件拿不到的 conversation store)。
			// 改用 session.running 的 true→false 边沿检测"AI 回复完成",
			// 再从 DOM 提取最新回复文本播报;按文本内容去重防重播。
			const prevRunningRef = useRef(false);
			const lastSpokenTextRef = useRef("");
			const turnEndTimerRef = useRef(null);
			const runningNowRef = useRef(false);

			useEffect(() => {
				const running = !!(session && session.running);
				const was = prevRunningRef.current;
				prevRunningRef.current = running;
				runningNowRef.current = running;

				if (!was || running) return; // 只在 true→false 边沿触发(回复刚结束)

				// 等 800ms(流式写入会话日志完成),再向宿主要最新 assistant 消息
				if (turnEndTimerRef.current) window.clearTimeout(turnEndTimerRef.current);
				turnEndTimerRef.current = window.setTimeout(async () => {
					turnEndTimerRef.current = null;
					if (runningNowRef.current || mutedRef.current) return; // 中途又跑起来/静音:不播
					// 从宿主 sessions 服务拿最新 assistant 消息(可靠,不扫 DOM)
					let text = "";
					try {
						const sid = encodeURIComponent(session && session.sessionId || "");
						const resp = await window.fetch("/dsh-voice-chat/latest-message?sessionId=" + sid);
						if (resp.ok) {
							const data = await resp.json();
							text = String(data && data.text || "").trim();
						} else {
							console.warn("[dsh-voice-chat] latest-message 接口:", resp.status);
						}
					} catch (err) {
						console.warn("[dsh-voice-chat] latest-message 请求失败:", err);
					}
					// 接口失败时兜底:DOM 提取(尽力而为)
					if (!text) text = extractLatestAssistantText() || "";
					console.log("[dsh-voice-chat] turn 结束,拿到文本:", text ? text.slice(0, 80) + (text.length > 80 ? "…" : "") : "(空)");
					if (!text || text === lastSpokenTextRef.current) return;
					lastSpokenTextRef.current = text;
					playTts(text);
				}, 800);
			}, [session && session.running, playTts]);

			// 卸载时清理定时器
			useEffect(() => () => {
				if (turnEndTimerRef.current) window.clearTimeout(turnEndTimerRef.current);
			}, []);

			// 静音/恢复按钮：静音时立刻停止当前播报、清空待播队列，并禁止后续自动播报；
			// 再按一次恢复正常播报（基于 ref 切换，连点两下也准确，不依赖暂时滞后的 state）
			const toggleMute = useCallback(() => {
				const next = !mutedRef.current;
				mutedRef.current = next;
				setMuted(next);
				if (next) stopPlayback();
			}, [stopPlayback]);

			// 提示 1.8s 后消失
			useEffect(() => {
				if (!hint) return;
				const t = window.setTimeout(() => setHint(""), 1800);
				return () => window.clearTimeout(t);
			}, [hint]);

			const sendText = useCallback((text) => {
				if (!text) return;
				try {
					if (inputActions && typeof inputActions.setDraft === "function" && typeof inputActions.submit === "function") {
						// 追加而非覆盖：保留输入框里已有的内容，听写结果拼在后面
						let current = "";
						if (inputState && typeof inputState.draft === "string") current = inputState.draft;
						const merged = current.trim() ? `${current.trim()} ${text.trim()}` : text.trim();
						inputActions.setDraft(merged);
						// 持续对话必须自动发出去，否则没人点发送、对话就断了
						if (autoSendRef.current || continuousRef.current) {
							inputActions.submit();
						} else {
							// 设置里关掉了自动发送：只填入输入框，由用户手动点发送
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

			// 静音检测：持续无声超过 2.5s 自动停止（停止后走 onstop 发送）
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

		const start = useCallback(async () => {
			if (recording || busy) return;
			// 开始录音前先收掉插话监听与续听定时器（麦克风同一时刻只被一处占用）
			stopBarge();
			if (restartTimerRef.current) {
				window.clearTimeout(restartTimerRef.current);
				restartTimerRef.current = null;
			}
			if (!supported) {
				setHint("Браузер не поддерживает запись (рекомендуется Chrome/Edge)");
				return;
			}
			// Браузерный ASR (Web Speech API)
			if (settingsValue?.asrEngine === "browser") {
				const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
				if (!SR) {
					// В Chromium без Google-ключа (Electron, сборки без Speech Services) API нет вовсе.
					// Подсказываем рабочий путь, а не «обновите браузер».
					setHint("Браузер не поддерживает SpeechRecognition (Chrome/Edge с Google-сервисами). Используйте движок «Локальный» или сетевой ASR");
					return;
				}
				setRecording(true);
				setHint("Слушаю, автозавершение при тишине");
				beep(880, 120);
				const rec = new SR();
				rec.lang = settingsValue?.speechLang ?? "ru-RU";
				rec.interimResults = false;
				rec.continuous = false;
				rec.onresult = (e) => {
					const text = e.results[0][0].transcript.trim();
					setRecording(false);
					beep(523, 100);
					if (text) sendText(text);
					else setHint("Не расслышал, повторите");
				};
				rec.onerror = (e) => {
					setRecording(false);
					setHint("Ошибка распознавания: " + (e.error || "unknown"));
				};
				rec.onend = () => {
					setRecording(false);
				};
				rec.start();
				return;
			}
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
						// 手动停或静音自动停都走这里发送
						const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
						try {
							stream.getTracks().forEach((t) => t.stop());
						} catch (err) { /* ignore */ }
						streamRef.current = null;
						clearSilence();
						setRecording(false);
						beep(523, 100); // 结束提示音（低音短促）
						if (blob.size === 0) return;
						setBusy(true);
						setHint("Распознавание…");
						try {
							// chat 协议 ASR（如 MiMo）只吃 wav/mp3：先转 16k 单声道 WAV 再上传
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
								body: payload
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
							setHint("Ошибка запроса к сервису распознавания");
						} finally {
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
					beep(880, 120); // 开始提示音（高音短促）
					rec.start();
					startSilenceMonitor(stream, rec);
				} catch (err) {
					console.error("[dsh-voice-chat] mic access failed", err);
					setHint("Нет доступа к микрофону (проверьте разрешения браузера)");
				}
			}, [recording, busy, supported, sendText, startSilenceMonitor, beep, stopBarge]);

		// 插话监听：持续对话时，AI 还在说话用户就开口 → 立刻闭嘴并开始录用户的话。
		// 用独立的 getUserMedia 流做音量判定（不干扰正在进行的录音/播放），
		// 连续约 450ms 有声才认定是"用户在插话"，避免咳嗽/键盘声误触发。
		const startBarge = useCallback(async () => {
			if (!continuousRef.current || bargeRef.current || mutedRef.current) return;
			if (recRef.current) return; // 已经在录了
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
						stopPlayback();          // 闭嘴 + 清空待播队列
						setHint("Перебил, слушаю…");
						startRef.current && startRef.current();
					}
				}, 150);
				bargeRef.current = { timer, stream, audioCtx };
			} catch (err) {
				// 监听拿不到麦克风（权限/占用）时静默降级：只是没有插话功能，朗读照常
				console.warn("[dsh-voice-chat] 插话监听未启动:", err);
			}
		}, [stopPlayback]);

		// 供 playTts / pump 里的定时回调调用（避开 useCallback 依赖里的 TDZ）
		useEffect(() => { startRef.current = start; }, [start]);
		useEffect(() => { startBargeRef.current = startBarge; }, [startBarge]);

			const toggle = useCallback(() => {
				if (recording) {
					// 手动点停：这次说完不再自动续上麦克风（下次点开始才恢复持续对话）
					pausedRef.current = true;
					stop();
				} else {
					pausedRef.current = false;
					stopPlayback(); // 正在播报则立刻停（单信道），然后开始聆听
					start();
				}
			}, [recording, stop, start, stopPlayback]);

			// 快捷键：按住 = 录音，松开 = 停止并识别（push-to-talk）。
			// 组合键由设置面板决定（по умолчанию — правый Ctrl)，"" = 关闭。
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
					stopPlayback();             // 正在播报则立刻停（单信道），然后开始聆听
					start();
				};
				const onKeyUp = (e) => {
					if (!hotkeyMatches(e, hotkeyCombo)) return;
					e.preventDefault();
					// 松开后 если запись ещё идёт — отправляем на распознавание
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

			// 卸载时清理
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
					// 固定深灰底：不随主题变量漂成浅灰，白字对比更强、气泡更显眼
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

		// ---------- 插件 ----------
		const inject = ["slots", "modelDirectories"];

		function apply(ctx) {
			// root-scoped：DSH 设置弹窗的 voice chat 类目（不需要 session 内服务）
			const slots = ctx.get("slots");
			if (slots !== undefined) {
				slots.inject("settings.section", () => slots.register(
					{ name: "settings.section", id: "dsh-voice-chat", order: 400, label: "голосовой чат" },
					(props) => React.createElement(VoiceChatSettingsSection, props)
				));
			}
			// session-scoped：输入框右侧的麦克风/静音按钮——需要 modelDirectories 服务
			// 拿到当前对话实际在用的 LLM（provider+model），转述朗读时透传给宿主，
			// 而不是用宿主硬编码默认（默认模型可能被关或密钥不对）。
			ctx.inject(["slots", "modelDirectories"], (scope) => {
				scope.slots.inject("conversation.input.right", () => scope.slots.register(
					{ name: "conversation.input.right", id: "dsh-voice-chat", order: 100 },
					(props) => {
						// 稳定化 hook 引用：scope.modelDirectories 在 session scope 生命周期内稳定
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
