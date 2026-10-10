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

