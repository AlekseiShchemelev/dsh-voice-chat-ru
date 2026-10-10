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

