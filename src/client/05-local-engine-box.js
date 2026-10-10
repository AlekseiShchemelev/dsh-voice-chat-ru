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

