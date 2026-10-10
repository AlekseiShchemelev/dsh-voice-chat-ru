		// ---------- Компоненты ----------
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

