# dsh-voice-chat (Russian fork)

<p align="center"><a href="README.md">Русский</a> | <b>English</b></p>

A Doubao-style voice chat plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI: click 🎤 and talk — the AI's reply is read back to you aloud. UI, hints and system prompts are in Russian, and the default speech language is `ru-RU`.

> 📖 Full user manual (Russian): [MANUAL.md](MANUAL.md).
>
> Fork of [maoyuching/dsh-voice-chat](https://github.com/maoyuching/dsh-voice-chat) (MIT). Original work © 2026 maoyuching; this fork adds the Russian localization, speech-language and speech-rate controls, browser and fully offline engines, and a continuous live-dialog mode with voice barge-in.

## Features

- **Voice input**: click 🎤 to start listening (ding) → speak → auto-stops after a configurable silence (dong) → transcribed and sent;
- **Voice output**: replies are synthesized with TTS and read aloud, with a **speech-rate slider** (50–200%) and a **speech-language selector** (ru-RU / zh-CN / en-US / ja-JP) in settings, plus an optional **condensed reading** (off by default) that rewrites longer replies into a short spoken summary before speaking — **the rewrite follows the LLM actually selected in the current conversation**;
- **6 ASR engines**: **SiliconFlow** (SenseVoice, free tier), **Groq** (Whisper), **Xiaomi MiMo** (chat/completions protocol), **custom OpenAI-compatible**, **browser** (Web Speech API, no key, no network), **local** (faster-whisper, fully offline);
- **5 TTS engines**: **Edge TTS** (Microsoft, free, no key), **Xiaomi MiMo TTS** (chat/completions, built-in voices), **custom OpenAI-compatible**, **browser** (`speechSynthesis`, offline), **local** (Piper, offline);
- **Isolated engine configs**: every ASR/TTS engine stores its own Base URL / model / API key / voice, so switching engines never overwrites another one (legacy single-slot configs migrate automatically);
- **Offline mode**: the local engine runs faster-whisper + Piper behind a local HTTP server, with portable Python, venv and models managed by the plugin itself under `~/.local/share/dsh-voice-chat/`;
- **Continuous live dialog**: enable the checkbox and the mic reopens by itself after each answer, while speaking over the readout interrupts it immediately; pressing 🎤 again stops the loop;
- **Single-channel playback**: a new reply preempts the previous one; interrupt anytime via hotkey or button — only one voice at a time;
- **No duplicate playback**: which replies were already spoken is remembered per session;
- **Mute toggle** 🔊: click while playing to mute immediately; click again to resume;
- **Settings UI**: everything lives inside **DSH's built-in settings dialog** (gear icon → "voice chat"), applied immediately — no restart needed;
- **Hotkeys**: `Ctrl+Shift+Space` toggles the mic (alternates `Ctrl+M` / `Ctrl+Shift+M`).

## Requirements

- **DeepSeek Harness (dsh)**: installed and running the Web GUI (`dsh web`);
- **Node.js ≥ 22** (the only runtime dependency is `ws` for the inline edge-tts client);
- **Browser**: Chrome / Edge (`MediaRecorder` for recording, `SpeechRecognition` / `speechSynthesis` for the browser engines);
- **API key** — only for cloud engines. Edge TTS needs no key, browser engines need no key, the local engine works offline.

## Install

```bash
# From this fork (git URL):
dsh plugin --profile web add https://github.com/AlekseiShchemelev/dsh-voice-chat-ru.git

# Then restart dsh web
```

The original version is published to npm:

```bash
dsh plugin --profile web add dsh-voice-chat
```

## Configuration

### ⚙️ Settings panel (recommended, highest priority)

Open DSH's settings dialog (gear icon, bottom-left) → "**голосовой чат**" on the left:

**🎤 Speech recognition**
- ASR engine (SiliconFlow / Groq / MiMo / custom / browser / local)
- Per-engine Base URL / model / API key
- Auto-send after transcription
- Continuous live dialog
- Silence auto-stop duration (seconds)

**🔊 Readout**
- TTS engine (Edge TTS / MiMo TTS / custom / browser / local)
- Per-engine Base URL / model / API key / voice
- **Speech rate** slider (50–200%)
- **Speech language** (Russian / Chinese / English / Japanese)
- Condensed reading toggle (off by default)

> 🔒 **Per-engine isolation**: each ASR and TTS engine keeps its own Base URL / model / API key / voice. Switching engines only switches which slot you are looking at — they never overwrite each other, and saving only writes the slot being edited. Legacy (≤0.3.x) single-slot configs migrate automatically on first start.

Saving writes to `settings.local.json` and takes effect immediately.

### 📄 Config file (lower priority)

Override `config` by id in the profile's `~/.dsh/profiles/web/cordis.patch.yml` (all keys optional):

```yaml
- id: dsh-voice-chat
  name: 'dsh-voice-chat'
  config:
    asrEngine: siliconflow          # siliconflow | groq | mimo | custom | browser | local
    asrApiKey: sk-xxxx              # legacy single slot; or env DSH_VOICE_ASR_KEY
    asr:                            # per-engine ASR config (takes precedence over flat keys)
      local:  { baseUrl: http://127.0.0.1:8765/v1, model: small }
      custom: { baseUrl: http://127.0.0.1:8000/v1, model: whisper-v3, apiKey: sk-xxxx }
    llmModel: deepseek-v4-flash     # rewrite model (fallback, follows the current conversation)
    silenceMs: 2500
    continuousMode: false
    rewrite: false                  # condensed reading (default off)
    ttsEngine: edge                 # edge | mimo | custom | browser | local
    tts:                            # per-engine TTS config
      edge:   { voice: ru-RU-SvetlanaNeural }
      local:  { baseUrl: http://127.0.0.1:8765/v1, model: piper, voice: ru_RU-irina-medium }
      mimo:   { baseUrl: https://api.xiaomimimo.com/v1, model: mimo-v2.5-tts, apiKey: sk-xxxx, voice: 冰糖 }
      custom: { baseUrl: https://api.openai.com/v1, model: tts-1, apiKey: sk-xxxx, voice: alloy }
    ratePercent: 110                # speech rate, 50–200 (100 = normal)
    speechLang: ru-RU               # ru-RU | zh-CN | en-US | ja-JP
    shortTextChars: 50
```

Restart `dsh web` after editing. Priority: **settings panel > cordis.patch.yml (`asr.<engine>` / `tts.<engine>` > legacy flat keys) > env vars > defaults**.

Useful env vars: `DSH_VOICE_ASR_ENGINE`, `DSH_VOICE_ASR_KEY`, `DSH_VOICE_ASR_BASE_URL`, `DSH_VOICE_ASR_MODEL`, `DSH_VOICE_LLM_KEY`, `DSH_VOICE_LLM_BASE_URL`, `DSH_VOICE_LLM_MODEL`, plus `DSH_VOICE_PYTHON` (own interpreter instead of portable Python) and `DSH_VOICE_DATA_DIR` for the offline engine.

## Local (offline) engine

The `local` engine serves faster-whisper (ASR) and Piper (TTS) on `127.0.0.1:8765` and needs no keys and no network once the models are downloaded.

- **Data**: `~/.local/share/dsh-voice-chat/` — portable Python, venv and models (Piper `ru_RU-irina-medium`, faster-whisper `small`);
- **Host routes**: `GET /dsh-voice-chat/local/status`, `POST /dsh-voice-chat/local/install`, `POST /dsh-voice-chat/local/start`, `POST /dsh-voice-chat/local/stop`;
- **Models**: faster-whisper `tiny | base | small | medium | large-v3`; Piper `ru_RU-irina-medium`, `ru_RU-ruslan-medium`, `ru_RU-dmitri-medium`, `ru_RU-denis-medium`;
- The first install takes a few minutes (Python, pip packages and model downloads).

## Structure

- `lib/index.js` — host half: `/stt` (ASR, dual protocol: OpenAI multipart + MiMo chat/completions), `/tts` (Edge/MiMo/custom/local), `/speak` (rewrite + synthesize), `/settings`, `/local/*`;
- `lib/client.js` — browser half: mic/mute buttons, silence detection, in-browser recognition, single-channel playback, continuous dialog with barge-in, hotkeys (Ctrl+Shift+Space), WAV conversion, and the settings form injected into DSH's dialog;
- `lib/edge-tts.js` — inline edge-tts protocol client (Microsoft's free read-aloud service);
- `lib/local-engine.js` — offline engine manager: portable Python, venv, models, spawn/stop of `py/server.py`;
- `py/server.py` — stdlib-only OpenAI-compatible shim over faster-whisper and Piper;
- `py/download_models.py` — model preloading (Piper + faster-whisper);
- `test/` — tests: `settings`, `client-settings`, `host-smoke` (host routes), `index-unit`, `local-engine`, `live-dialog`; run with `npm test`;
- `test/diagnose-tts.mjs` — one-command readout diagnostics (`npm run diagnose:tts`);
- `cordis.patch.yml` — inserts the `dsh-voice-chat` line + config examples;
- `settings.local.json` — overrides saved from the settings dialog (generated at runtime, never committed); since v0.4 it stores per-engine slots under `asr.<engine>` / `tts.<engine>`.

## License

MIT — see [LICENSE](LICENSE). Original project: [maoyuching/dsh-voice-chat](https://github.com/maoyuching/dsh-voice-chat) (MIT, © 2026 maoyuching).
