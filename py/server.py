#!/usr/bin/env python3
import argparse
import io
import json
import logging
import os
import re
import struct
import sys
import threading
import time
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

# beam_size=5 — это в разы медленнее на CPU, а на живых записях разница в
# качестве почти незаметна: локальный движок слушает короткие фразы, и задержка
# важнее. Плагин может прислать своё значение полем beam_size.
DEFAULT_BEAM_SIZE = 1
# Голоса по умолчанию. Список НЕ ограничивает выбор: сервер принимает любой голос,
# который реально лежит в <DATA_DIR>/piper/<имя>/<имя>.onnx — пользователь может
# докачать украинский или английский голос и выбрать его в настройках.
SUPPORTED_PIPER_VOICES = {
    "ru_RU-irina-medium",
    "ru_RU-ruslan-medium",
    "ru_RU-dmitri-medium",
    "ru_RU-denis-medium",
}
# Имя каталога модели: только буквы/цифры/дефис/подчёркивание (защита от ../../)
VOICE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class EngineNotInstalledError(RuntimeError):
    """Локальный движок на месте, но его Python-зависимости не установлены."""


class ModelNotDownloadedError(RuntimeError):
    """Запрошенная модель faster-whisper не скачана (и качать её на лету нельзя)."""

    def __init__(self, model_name: str, available):
        self.model_name = model_name
        self.available = available
        have = ", ".join(available) if available else "ни одной"
        super().__init__(
            f"Модель faster-whisper «{model_name}» не скачана. "
            f"Скачана: {have}. Откройте Настройки DSH → голосовой чат → «Локальный» "
            f"и нажмите «Скачать модель»."
        )


def read_request_body(stream, headers, max_body: int = 256 * 1024 * 1024) -> bytes:
    """Читает тело запроса ровно настолько, на сколько оно объявлено.

    Ключевое отличие от «прочитать до конца потока»: браузер шлёт multipart
    через fetch как Transfer-Encoding: chunked и держит соединение живым
    (keep-alive). Обычный read(n) на сокетном файле ждёт ровно n байт или EOF —
    и висел вечно: микрофон желтел, запрос не возвращался никогда.

    Разбираем фрейминг честно:
      * chunked — по заголовкам размера чанков (граница multipart при этом может
        попасть ровно на стык чанков, и поиск по сырым байтам её теряет);
      * Content-Length — ровно указанное число байт;
      * без заголовков — до EOF (HTTP/1.0, соединение закроет клиент).
    """
    encoding = (headers.get("Transfer-Encoding") or "").lower()
    if "chunked" in encoding:
        chunks = []
        total = 0
        while True:
            line = stream.readline(1024)
            if not line:
                break
            size_text = line.split(b";", 1)[0].strip()
            try:
                size = int(size_text, 16)
            except ValueError:
                raise ValueError(f"bad chunk size: {size_text!r}")
            if size == 0:
                # Завершающий CRLF и возможные трейлеры — до пустой строки
                while True:
                    trailer = stream.readline(1024)
                    if trailer in (b"", b"\r\n", b"\n"):
                        break
                break
            total += size
            if total > max_body:
                raise ValueError(f"body exceeds {max_body} bytes")
            data = stream.read(size)
            if len(data) != size:
                break
            chunks.append(data)
            # CRLF после данных чанка по RFC обязателен, но на практике
            # встречаются клиенты, которые его не шлют. peek() смотрит вперёд,
            # не consuming байты, поэтому вслепую глотать два байта нельзя.
            head = stream.peek(2)[:2] if hasattr(stream, "peek") else stream.read(2)
            if head == b"\r\n":
                stream.read(2)
        return b"".join(chunks)

    raw_length = headers.get("Content-Length")
    if raw_length:
        try:
            length = int(raw_length)
        except ValueError:
            raise ValueError(f"bad Content-Length: {raw_length!r}")
        if length > max_body:
            raise ValueError(f"body exceeds {max_body} bytes")
        parts = []
        remaining = length
        read1 = getattr(stream, "read1", None) or stream.read
        while remaining > 0:
            chunk = read1(min(65536, remaining))
            if not chunk:
                break
            parts.append(chunk)
            remaining -= len(chunk)
        return b"".join(parts)

    return stream.read(max_body)


def field_text(value, default: str = "") -> str:
    """Текстовое поле multipart → строка.

    Наш разбор отдаёт все поля байтами (cgi.FieldStorage отдавал строки), а
    дальше по коду имена моделей, языков и голосов сравниваются со строками.
    """
    if value is None:
        return default
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace").strip() or default
    return str(value).strip() or default


def parse_multipart(body: bytes, content_type: str) -> dict:
    """Минимальный разбор multipart/form-data → {имя: значение}.

    Раньше здесь был `cgi.FieldStorage`, а модуль cgi удалён в Python 3.13 —
    на системном python3 3.13+ ВСЁ распознавание падало с ImportError (500).
    Здесь только то, что реально присылает плагин: текстовые поля и один файл.

    Тело приходит уже разобранным из фрейминга (см. read_request_body).
    """
    match = re.search(r'boundary="?([^";]+)"?', content_type)
    if not match:
        raise ValueError("no boundary in Content-Type")
    delimiter = b"--" + match.group(1).encode()

    fields = {}
    for part in body.split(delimiter):
        if part in (b"", b"--", b"--\r\n", b"\r\n"):
            continue
        part = part.lstrip(b"\r\n")
        if part.startswith(b"--"):
            continue
        head, sep, data = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        if data.endswith(b"\r\n"):
            data = data[:-2]
        name = None
        for line in head.split(b"\r\n"):
            decoded = line.decode("utf-8", "replace")
            if decoded.lower().startswith("content-disposition"):
                found = re.search(r'name="([^"]*)"', decoded)
                if found:
                    name = found.group(1)
        if name:
            fields[name] = data
    return fields


_whisper_models = {}
_whisper_lock = threading.Lock()
_piper_voices = {}
_piper_lock = threading.Lock()

# Модели, физически лежащие на диске (снапшоты faster-whisper раскладываются как
# models--<org>--faster-whisper-<size>). Нужны, чтобы НЕ скачивать гигабайты прямо
# на запрос: раньше WhisperModel() умел докачать сам, и /stt молча висел на загрузке
# (или падал 500 без сети), хотя плагин уже показывал «модель установлена».
def _downloaded_whisper_models() -> set:
    found = set()
    try:
        for entry in DATA_DIR.iterdir():
            if entry.is_dir() and entry.name.startswith("models--") and "whisper" in entry.name:
                for size in SUPPORTED_WHISPER_MODELS:
                    if entry.name.endswith("-" + size):
                        found.add(size)
    except OSError:
        pass
    return found


def _load_whisper(model_name: str):
    # Кэш ПО ИМЕНИ: раньше был один глобальный _whisper_model, и первая же загрузка
    # (обычно small) навсегда определяла модель для всех последующих запросов —
    # выбранная в настройках medium/tiny молча игнорировалась.
    if model_name in _whisper_models:
        return _whisper_models[model_name]

    # Сначала проверка наличия модели, потом импорт: иначе на машине без
    # faster_whisper пользователь получал 500 «No module named 'faster_whisper'»
    # вместо понятного 409 «модель не скачана, нажмите кнопку установки».
    available = _downloaded_whisper_models()
    if model_name not in available:
        raise ModelNotDownloadedError(model_name, sorted(available))

    try:
        from faster_whisper import WhisperModel
    except ImportError as err:
        raise EngineNotInstalledError(
            "faster-whisper не установлен. Откройте Настройки DSH → голосовой чат "
            "и нажмите «Установить локальный движок»."
        ) from err

    logger.info("Loading faster-whisper model: %s", model_name)
    model = WhisperModel(
        model_name,
        device="auto",
        compute_type="auto",
        download_root=str(DATA_DIR),
        local_files_only=True,
    )
    logger.info("faster-whisper model loaded: %s", model_name)
    _whisper_models[model_name] = model
    return model


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


SAMPLE_RATE = 16000


def _decode_pcm16_wav(audio_bytes: bytes):
    """Резервный декодер для чистого PCM-WAV (без av): 16-bit → float32 [-1, 1]."""
    import numpy as np

    with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
        channels = wav_file.getnchannels()
        width = wav_file.getsampwidth()
        rate = wav_file.getframerate()
        frames = wav_file.readframes(wav_file.getnframes())
    if width != 2:
        raise ValueError(f"Поддерживается только 16-битный WAV, получено {width * 8} бит")
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE and samples.size:
        # Линейная передискретизация: для распознавания точность не критична
        target_len = max(1, round(samples.size * SAMPLE_RATE / rate))
        samples = np.interp(
            np.linspace(0, samples.size - 1, target_len, dtype=np.float64),
            np.arange(samples.size, dtype=np.float64),
            samples,
        ).astype(np.float32)
    return samples


def _decode_audio(audio_bytes: bytes):
    """Аудио → float32 mono 16 кГц.

    Декодируем сами, а не отдаём файл faster-whisper: в faster-whisper 1.2.1
    внутренний decode_audio зовёт av.open(..., metadata_errors="ignore"), а в
    свежем PyAV (>=14) такого параметра больше нет — из-за этого распознавание
    падало с "open() got an unexpected keyword argument 'metadata_errors'".
    Ставить av не нужно: для PCM-WAV хватает стандартного wave.
    """
    if audio_bytes[:4] == b"RIFF" and audio_bytes[8:12] == b"WAVE":
        try:
            return _decode_pcm16_wav(audio_bytes)
        except Exception as exc:  # битый WAV — пробуем универсальный путь
            logger.warning("WAV-декодер не справился (%s), пробую av", exc)

    import av
    import numpy as np

    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    chunks = []
    with av.open(io.BytesIO(audio_bytes)) as container:
        if not container.streams.audio:
            raise ValueError("В файле нет аудиодорожки (поддерживаются webm/opus, mp3, wav)")
        for frame in container.decode(container.streams.audio[0]):
            for resampled in resampler.resample(frame):
                chunks.append(resampled.to_ndarray())
        # Последний фрейм often остаётся в буфере ресемплера — сливаем его
        for resampled in resampler.resample(None):
            chunks.append(resampled.to_ndarray())
    if not chunks:
        raise ValueError("Не удалось декодировать аудио")
    samples = np.concatenate(chunks, axis=1).reshape(-1).astype(np.float32) / 32768.0
    if samples.size == 0:
        raise ValueError("Аудио пустое")
    return samples


def _transcribe(audio_bytes: bytes, model_name: str, language: str | None,
                beam_size: int | None = None) -> str:
    with _whisper_lock:
        load_started = time.monotonic()
        model = _load_whisper(model_name)
        load_seconds = time.monotonic() - load_started
        audio = _decode_audio(audio_bytes)
        logger.info("Decoded %d samples @ %d Hz", audio.size, SAMPLE_RATE)
        if load_seconds > 1:
            # Первая загрузка модели — обычно 5–30 с. Без этого в логе не видно,
            # что «подвисание» — это не зависание, а чтение весов с диска.
            logger.info("Model %s loaded in %.1f s", model_name, load_seconds)
        started = time.monotonic()
        segments, _ = model.transcribe(
            audio,
            language=language,
            beam_size=beam_size if beam_size and beam_size > 0 else DEFAULT_BEAM_SIZE,
            vad_filter=True,
            # Без этого whisper на коротких ответах способен «зациклиться» и
            # дописать начало фразы в конец.
            condition_on_previous_text=False,
        )
        logger.info("Transcribed %.1f s of audio in %.1f s",
                    audio.size / SAMPLE_RATE, time.monotonic() - started)
        text = " ".join(seg.text.strip() for seg in segments)
        return text.strip()


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
                    "whisper": sorted(_downloaded_whisper_models()),
                    "piper": list(SUPPORTED_PIPER_VOICES),
                },
            })
        elif self.path in ("/v1/models", "/models"):
            # То, что ждёт любой OpenAI-совместимый клиент: что реально доступно
            self._send_json(200, {
                "object": "list",
                "data": [
                    {"id": f"whisper-{m}", "object": "model", "owned_by": "faster-whisper"}
                    for m in sorted(_downloaded_whisper_models())
                ],
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
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._send_json(400, {"error": "expected multipart/form-data"})
            return

        try:
            body = read_request_body(self.rfile, self.headers)
            form = parse_multipart(body, content_type)
        except ValueError as e:
            self._send_json(400, {"error": f"cannot parse multipart: {e}"})
            return

        if "file" not in form:
            self._send_json(400, {"error": "missing 'file' field"})
            return

        audio_bytes = form["file"]

        # Текстовые поля приходят из multipart байтами: cgi.FieldStorage отдавал их
        # строками, наш парсер — сырыми. Без декодирования `model` не совпал бы
        # со списком поддерживаемых и давал 400 «unsupported model: b'small'».
        model_name = field_text(form.get("model"), "small")
        if model_name not in SUPPORTED_WHISPER_MODELS:
            self._send_json(400, {"error": f"unsupported model: {model_name}"})
            return

        language = field_text(form.get("language"), "") or None

        try:
            text = _transcribe(
            audio_bytes, model_name, language,
            beam_size=field_text(form.get("beam_size"), ""),
        )
            self._send_json(200, {"text": text})
        except ModelNotDownloadedError as e:
            # 409: не 500 — модель не скачана, это исправляемое состояние, а не сбой
            self._send_json(409, {"error": str(e), "model": model_name, "downloaded": e.available})
        except EngineNotInstalledError as e:
            # Тоже исправляемое состояние (не установлены зависимости), не сбой
            self._send_json(409, {"error": str(e), "model": model_name})
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

        voice_name = str(data.get("voice", "ru_RU-irina-medium"))
        # Принимаем любой скачанный голос, но только из каталога моделей:
        # иначе через voice: "../../.." можно было бы уйти из DATA_DIR
        if not VOICE_NAME_RE.match(voice_name):
            self._send_json(400, {"error": f"invalid voice name: {voice_name}"})
            return
        voice_dir = DATA_DIR / "piper" / voice_name
        if voice_name not in SUPPORTED_PIPER_VOICES and not (voice_dir / f"{voice_name}.onnx").exists():
            self._send_json(400, {
                "error": f"voice not downloaded: {voice_name}. "
                "Скачайте его в настройках (движок «Локальный» → Голос) "
                f"или используйте один из: {', '.join(sorted(SUPPORTED_PIPER_VOICES))}"
            })
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
