#!/usr/bin/env python3
import argparse
import io
import json
import logging
import os
import struct
import sys
import tempfile
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("dsh-voice-server")

DATA_DIR = Path(
    os.environ.get("DSH_VOICE_DATA_DIR", Path.home() / ".local/share/dsh-voice-chat/models")
)
DATA_DIR.mkdir(parents=True, exist_ok=True)

SUPPORTED_WHISPER_MODELS = {"tiny", "base", "small", "medium", "large-v3"}
SUPPORTED_PIPER_VOICES = {
    "ru_RU-irina-medium",
    "ru_RU-ruslan-medium",
    "ru_RU-dmitri-medium",
    "ru_RU-denis-medium",
}

_whisper_model = None
_whisper_lock = threading.Lock()
_piper_voices = {}
_piper_lock = threading.Lock()


def _load_whisper(model_name: str):
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model
    from faster_whisper import WhisperModel

    logger.info("Loading faster-whisper model: %s", model_name)
    _whisper_model = WhisperModel(
        model_name,
        device="auto",
        compute_type="auto",
        download_root=str(DATA_DIR),
    )
    logger.info("faster-whisper model loaded: %s", model_name)
    return _whisper_model


def _load_piper(voice_name: str):
    with _piper_lock:
        if voice_name in _piper_voices:
            return _piper_voices[voice_name]
        from piper import PiperVoice

        voice_dir = DATA_DIR / "piper" / voice_name
        model_path = voice_dir / f"{voice_name}.onnx"
        config_path = voice_dir / f"{voice_name}.onnx.json"

        if not model_path.exists():
            raise FileNotFoundError(
                f"Piper voice not found: {model_path}. Run download_models.py first."
            )

        logger.info("Loading Piper voice: %s", voice_name)
        voice = PiperVoice.load(str(model_path), config_path=str(config_path), use_cuda=False)
        _piper_voices[voice_name] = voice
        logger.info("Piper voice loaded: %s", voice_name)
        return voice


def _transcribe(audio_bytes: bytes, model_name: str, language: str | None) -> str:
    import numpy as np

    with _whisper_lock:
        model = _load_whisper(model_name)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            segments, _ = model.transcribe(
                tmp_path,
                language=language,
                beam_size=5,
                vad_filter=True,
            )
            text = " ".join(seg.text.strip() for seg in segments)
            return text.strip()
        finally:
            os.unlink(tmp_path)


def _synthesize(text: str, voice_name: str, speed: float) -> bytes:
    import numpy as np

    with _piper_lock:
        voice = _load_piper(voice_name)
        length_scale = 1.0 / speed if speed > 0 else 1.0

        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(voice.config.sample_rate)

            for audio_bytes in voice.synthesize_stream_raw(text, length_scale=length_scale):
                wav_file.writeframes(audio_bytes)

        return wav_buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logger.info("%s - %s", self.address_string(), format % args)

    def _send_json(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "models": {
                    "whisper": list(SUPPORTED_WHISPER_MODELS),
                    "piper": list(SUPPORTED_PIPER_VOICES),
                },
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/v1/audio/transcriptions":
            self._handle_transcription()
        elif self.path == "/v1/audio/speech":
            self._handle_speech()
        else:
            self._send_json(404, {"error": "not found"})

    def _handle_transcription(self):
        import cgi

        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._send_json(400, {"error": "expected multipart/form-data"})
            return

        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type},
        )

        if "file" not in form:
            self._send_json(400, {"error": "missing 'file' field"})
            return

        file_item = form["file"]
        audio_bytes = file_item.file.read()

        model_name = form.getfirst("model", "small")
        if model_name not in SUPPORTED_WHISPER_MODELS:
            self._send_json(400, {"error": f"unsupported model: {model_name}"})
            return

        language = form.getfirst("language", None)
        if language == "":
            language = None

        try:
            text = _transcribe(audio_bytes, model_name, language)
            self._send_json(200, {"text": text})
        except Exception as e:
            logger.exception("Transcription failed")
            self._send_json(500, {"error": str(e)})

    def _handle_speech(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON"})
            return

        text = data.get("input", "")
        if not text:
            self._send_json(400, {"error": "missing 'input' field"})
            return

        voice_name = data.get("voice", "ru_RU-irina-medium")
        if voice_name not in SUPPORTED_PIPER_VOICES:
            self._send_json(400, {"error": f"unsupported voice: {voice_name}"})
            return

        try:
            speed = float(data.get("speed", 1.0))
        except (TypeError, ValueError):
            self._send_json(400, {"error": "invalid 'speed' field"})
            return
        if speed <= 0:
            self._send_json(400, {"error": "'speed' must be > 0"})
            return

        try:
            wav_bytes = _synthesize(text, voice_name, speed)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav_bytes)))
            self.end_headers()
            self.wfile.write(wav_bytes)
        except Exception as e:
            logger.exception("Synthesis failed")
            self._send_json(500, {"error": str(e)})


def main():
    parser = argparse.ArgumentParser(description="DSH Voice Chat local TTS/STT server")
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    logger.info("Starting server on %s:%d", args.host, args.port)
    logger.info("Data directory: %s", DATA_DIR)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
