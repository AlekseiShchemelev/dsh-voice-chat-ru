# 8. Принцип работы (для программистов)

Плагин разделен на **хост-часть** (Node) и **браузерную часть** (React bundle), взаимодействующие через HTTP-маршруты:

```
Браузерная часть (lib/client.js)              Хост-часть (lib/index.js)
┌──────────────────────────┐    ┌─────────────────────────────────────┐
│ 🎤 Кнопка / клавиша запуска    │    │ POST /dsh-voice-chat/stt  речь→текст    │
│ MediaRecorder запись        │───▶│  (siliconflow / groq / mimo ASR)    │
│ blobToWav автоматическая конвертация        │    │ POST /dsh-voice-chat/tts   текст→речь    │
│ Детектирование тишины (AnalyserNode)   │    │ POST /dsh-voice-chat/speak текст→речь    │
│ Одноканальное воспроизведение (механизм поколений)      │◀───│  ① LLM пересказ (следует за фактической моделью текущего диалога)    │
│ sessionStorage защита от повторного воспроизведения      │    │  ② edge-tts / MiMo TTS синтез аудио       │
│ 🔊 Отключение звука / 🔔 Звуковые сигналы        │    │ GET  /dsh-voice-chat/settings предоставление конфигурации  │
│ Браузерный ASR/TTS (Web Speech API)      │    │ GET/POST /dsh-voice-chat/local/* офлайн-движок       │
│ Постоянный диалог + перебивание голосом  │    │ (py/server.py: faster-whisper + Piper)  │
└──────────────────────────┘    └─────────────────────────────────────┘
```

**Двойной протокол ASR**: URL заканчивается на `/chat/completions` → MiMo-подобный chat-протокол (аудио base64 data URL в messages.content.input_audio, поддерживаются только wav/mp3); в противном случае используется стандартный OpenAI протокол `/audio/transcriptions` multipart (webm загружается как есть).

**Конвертация WAV на стороне браузера**: MiMo и другие ASR по chat-протоколу принимают только wav/mp3, но браузерная запись выдаёт webm/ogg/mp4. `blobToWav` использует Web Audio API (`decodeAudioData` → `OfflineAudioContext` передискретизация 16kHz моно → рукописный заголовок PCM16 WAV) для конвертации, без зависимости от ffmpeg.

- **Пересказ** использует встроенный LLM-сервис harness (`ctx.llm.stream`); клиент передаёт provider+model текущего диалога, поэтому пересказ всегда использует ту же LLM, что и текущий диалог;
- **Одноканальность** использует счётчик «поколений воспроизведения», при возврате асинхронного запроса с несоответствующим поколением ответ отбрасывается, что исключает наложение звуков;
- **Браузерные движки** не ходят на сервер: ASR — `SpeechRecognition` с языком `speechLang`, TTS — `speechSynthesis` со скоростью `ratePercent / 100`;
- **Офлайн-движок**: `lib/local-engine.js` управляет portable Python (astral-sh/python-build-standalone), venv с faster-whisper и piper-tts, предзагрузкой моделей и дочерним процессом `py/server.py`; сервер — OpenAI-совместимый шимм (`/v1/audio/transcriptions`, `/v1/audio/speech`, `/health`) на стандартной библиотеке Python, поэтому хост общается с ним тем же кодом, что и с облачным движком;
- **Скорость и язык речи** применяются ко всем движкам: Edge — SSML `rate`, пользовательский TTS — параметр `speed`, локальный и браузерный TTS — параметр скорости synthesis, а для движков без нативной скорости — `audio.playbackRate`.

### 8.1 Устройство кода

```
lib/shared.js          константы движков и чистые функции (общие для сервера и браузера)
lib/settings.js        settings.local.json: чтение/запись, нормализация, миграция, разбор config
lib/net.js             транспорт: исходящие запросы, таймауты, лимиты тел, JSON-ответы
lib/engines/asr.js     распознавание: multipart и chat-протокол
lib/engines/tts.js     синтез у внешних движков: OpenAI-совместимый и MiMo
lib/rewrite.js         разговорный пересказ через LLM harness
lib/edge-tts.js        синтез через Microsoft Edge TTS
lib/local-engine.js    менеджер локального Python-движка (faster-whisper + Piper)
lib/index.js           apply(), HTTP-маршруты и связывание всего вместе
lib/client.js          браузерная половина — ГЕНЕРИРУЕТСЯ из src/client/*.js
```

`lib/client.js` нельзя разбить на runtime-модули: хост грузит его как
`window.__ModuleLoader__.load({factory})`, и `require()` там умеет только
пакеты из графа — относительные импорты не резолвятся. Поэтому исходник
разложен по кускам в `src/client/`, а `scripts/build-client.mjs` их склеивает:

```bash
npm run build:client   # пересобрать lib/client.js из src/client/*
npm run check:client   # только проверить свежесть, ничего не перезаписывая
npm test               # 348 тестов, включая проверку свежести сборки
```

Правку в клиенте всегда завершайте пересборкой: `test/client-build.test.mjs`
падает на разъезде `src/client/*` и `lib/client.js`, иначе забытая
пересборка выглядит как «правильный код, но баг есть».

Константы из `lib/shared.js` клиент **не импортирует** и держит копии; паритет
копий закреплён `test/shared-parity.test.mjs`.
