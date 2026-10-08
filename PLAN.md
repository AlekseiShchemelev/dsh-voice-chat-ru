# План: dsh-voice-chat → русский + скорость речи + локальные движки

## Проверенные факты
- **Edge TTS русские голоса**: ровно два — `ru-RU-SvetlanaNeural`, `ru-RU-DmitryNeural`
- **Piper (TTS)**: `piper-tts 1.8.0` на PyPI, wheel `abi3` под linux-x64/aarch64/mac/win, Python ≥3.9, в колесе лежат `piper/download_voices.py` и `espeak-ng-data`. Русские голоса **только `medium`**: `ru_RU-irina`, `ru_RU-ruslan`, `ru_RU-dmitri`, `ru_RU-denis`.
- **faster-whisper**: `1.2.1`, Python ≥3.9.
- **Portable Python**: `astral-sh/python-build-standalone`, тег `20261003`, `cpython-3.12.15-*-install_only_stripped.tar.gz` = 34 МБ linux / 22 МБ win / 25 МБ mac.

---

## Этап 1 — Локализация UI на русский
1. `lib/client.js` (~90 строк): форма настроек, опции движков, примечания, статусы, хинты, тултипы, label сайдбара.
2. `lib/index.js`: все ошибки, всплывающие в баблах → русский.
3. `SPEAK_SYSTEM_PROMPT` → русский промпт + инструкция языка.
4. Инструкция MiMo TTS и все сообщения `lib/edge-tts.js` → русский.
5. **Не трогаем**: идентификаторы голосов `冰糖/茉莉/...`, консольные логи, комментарии в коде.

## Этап 2 — Язык речи + русские голоса
1. Новая настройка **`speechLang`** (select: `ru-RU | zh-CN | en-US | ja-JP`, дефолт `ru-RU`).
2. `VOICE_PRESETS` → `ru-RU-SvetlanaNeural`, `ru-RU-DmitryNeural` первыми.
3. Дефолтный голос → `ru-RU-SvetlanaNeural` в 4 местах.
4. Fallback `xml:lang` в `edge-tts.js`: `zh-CN` → `ru-RU`.

## Этап 3 — Ползунок скорости речи (ко всем движкам)
1. Настройка **`ratePercent`** (50–200, шаг 5, дефолт 110).
2. UI: `<input type="range">` в секции «Настройки озвучки».
3. Применение:
   - **Edge** → SSML rate
   - **custom/OpenAI** → параметр `speed`
   - **браузерный fallback** → `u.rate`
   - **MiMo и остальные** → `audio.playbackRate` (только если движок без нативной скорости)

## Этап 4 — Браузерный движок STT + TTS
1. **ASR `browser`**: `SpeechRecognition|webkitSpeechRecognition` вместо MediaRecorder.
2. **TTS `browser`**: прямой вызов `speechSynthesis`, режим `synthesize:false` в `/speak`.
3. Слот голоса `browser.voice` + datalist из `getVoices()`.

## Этап 5 — Локальный Python-движок (faster-whisper + Piper)
1. Новые движки **`local`** в обоих списках.
2. **`py/server.py`** (stdlib only): OpenAI-совместимый шим.
3. **`lib/local-engine.js`**: менеджер (Python, venv, модели, spawn/kill).
4. Routes: `GET /local/status`, `POST /local/install`, `POST /local/stop`.
5. UI: статус + кнопки установки/запуска.

## Этап 6 — Тесты, документация, версия
- Обновить тесты под русские label'ы и новые настройки.
- Доки: README.md/MANUAL.md → русский, package.json, yml.
- Версия **0.5.0**.

## Риски
1. Портативный Python: тег/URL фиксировать на реализации.
2. pip-зависимости `ctranslate2`/`onnxruntime` — тяжёлые, но wheel'ы есть.
3. spawn процессов из плагина DSH — не проверено.
4. Web Speech API — не везде и не офлайн в Chrome.

## Порядок работ
1 → 2 → 3 → 4 → 5 → 6 (каждый этап самодостаточен и проверяем)

## Статус выполнения
- [x] Этап 1 — Локализация UI на русский
- [x] Этап 2 — Язык речи + русские голоса
- [x] Этап 3 — Ползунок скорости речи
- [x] Этап 4 — Браузерный движок STT + TTS
- [x] Этап 5 — Локальный Python-движок (faster-whisper + Piper)
- [x] Этап 6 — Тесты, документация, версия 0.5.0

## Этап 7 — Живое общение (continuousMode)
1. Настройка `continuousMode` (по умолчанию выключена).
2. Автопродолжение: когда озвучивание закончилось, микрофон включается сам (пауза 0.5 с).
3. Перебивание: пока AI говорит, второй поток микрофона следит за громкостью;
   ~0.45 с непрерывного звука → озвучка замолкает, начинается запись.
4. Ручное нажатие 🎤 / 🔊 останавливает цикл; автоотправка в этом режиме принудительная.
5. Чекбокс «Постоянный диалог» в панели настроек + доки (README/MANUAL 6.5).
- [x] Этап 7
