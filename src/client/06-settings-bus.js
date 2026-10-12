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
