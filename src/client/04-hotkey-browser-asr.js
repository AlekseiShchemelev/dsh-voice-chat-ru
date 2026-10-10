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

