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

