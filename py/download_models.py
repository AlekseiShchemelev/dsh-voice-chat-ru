#!/usr/bin/env python3
import argparse
import logging
import os
import re
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("dsh-voice-download")

DATA_DIR = Path(
    os.environ.get("DSH_VOICE_DATA_DIR", Path.home() / ".local/share/dsh-voice-chat/models")
)
DATA_DIR.mkdir(parents=True, exist_ok=True)

PIPER_VOICE_NAME = "ru_RU-irina-medium"
# Раскладка репозитория rhasspy/piper-voices:
#   <family>/<locale>/<voice_name>/<quality>/<locale>-<voice_name>-<quality>.onnx
# (раньше здесь стоял путь без voice_name/quality — HuggingFace отдавал 404)
PIPER_VOICES_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
PIPER_VOICE_PATTERN = re.compile(
    r"^(?P<lang_family>[^-]+)_(?P<lang_region>[^-]+)-(?P<voice_name>[^-]+)-(?P<voice_quality>.+)$"
)


def piper_voice_urls(voice_name: str):
    match = PIPER_VOICE_PATTERN.match(voice_name)
    if not match:
        raise ValueError(
            f"Voice {voice_name!r} does not match <family>_<region>-<name>-<quality>"
        )
    lang_family = match.group("lang_family")
    lang_code = f"{lang_family}_{match.group('lang_region')}"
    base = (
        f"{PIPER_VOICES_BASE}/{lang_family}/{lang_code}"
        f"/{match.group('voice_name')}/{match.group('voice_quality')}/{lang_code}"
    )
    return base, voice_name


def download_file(url: str, dest: Path):
    import urllib.request

    if dest.exists() and dest.stat().st_size > 0:
        logger.info("Already exists: %s", dest)
        return
    logger.info("Downloading %s -> %s", url, dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Пишем во временный файл: прерванная закачка не должна остаться «готовой»
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        urllib.request.urlretrieve(url, tmp)
        tmp.replace(dest)
    finally:
        if tmp.exists():
            tmp.unlink()
    logger.info("Downloaded: %s", dest)


def download_piper_voice(voice_name: str = PIPER_VOICE_NAME):
    voice_dir = DATA_DIR / "piper" / voice_name
    base, code = piper_voice_urls(voice_name)

    download_file(f"{base}/{code}.onnx?download=true", voice_dir / f"{code}.onnx")
    download_file(
        f"{base}/{code}.onnx.json?download=true", voice_dir / f"{code}.onnx.json"
    )


def download_whisper_model(model_name: str = "small"):
    from faster_whisper import WhisperModel

    logger.info("Downloading faster-whisper model: %s", model_name)
    WhisperModel(model_name, device="cpu", compute_type="int8", download_root=str(DATA_DIR))
    logger.info("faster-whisper model downloaded")


def main():
    parser = argparse.ArgumentParser(description="Download models for DSH Voice Chat")
    parser.add_argument("--whisper-model", default="small", help="Whisper model size")
    parser.add_argument("--piper-voice", default=PIPER_VOICE_NAME, help="Piper voice name")
    args = parser.parse_args()

    logger.info("Data directory: %s", DATA_DIR)

    download_piper_voice(args.piper_voice)
    download_whisper_model(args.whisper_model)

    logger.info("All models downloaded successfully")


if __name__ == "__main__":
    main()
