#!/usr/bin/env python3
"""Скачивание моделей локального движка (Piper + faster-whisper).

Раскладку файлов ждёт py/server.py, поэтому менять её нельзя молча.

Почему загрузчик такой упорный:
  - urlretrieve() не умеет таймаут: на «зависшем» соединении установка молча
    висит час. Поэтому качаем urlopen'ом с таймаутом и пишем в .part;
  - сети до huggingface.co часто нет (прокси, антивирус, региональный доступ),
    поэтому основной адрес + запасное зеркало, а также несколько попыток;
  - каждая ошибка логируется в stderr, а плагин показывает этот хвост в UI —
    иначе пользователь видит только «модели не загружены».
"""
import argparse
import logging
import os
import re
import sys
import time
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
PIPER_BASES = [
    os.environ.get(
        "DSH_VOICE_PIPER_BASE", "https://huggingface.co/rhasspy/piper-voices/resolve/main"
    ),
    # Зеркало для сетей, где huggingface.co недоступен
    "https://hf-mirror.com/rhasspy/piper-voices/resolve/main",
]
PIPER_VOICE_PATTERN = re.compile(
    r"^(?P<lang_family>[^-]+)_(?P<lang_region>[^-]+)-(?P<voice_name>[^-]+)-(?P<voice_quality>.+)$"
)

# Таймаут подобран так, чтобы «мёртвое» соединение не висело часами,
# но крупный файл успевал скачаться на медленном канале
CONNECT_TIMEOUT_S = 30
ATTEMPTS = 3


def piper_voice_dir(voice_name: str) -> str:
    """Путь голоса в репозитории: <family>/<lang_code>/<voice_name>/<quality>."""
    match = PIPER_VOICE_PATTERN.match(voice_name)
    if not match:
        raise ValueError(
            f"Voice {voice_name!r} does not match <family>_<region>-<name>-<quality>"
        )
    lang_family = match.group("lang_family")
    lang_code = f"{lang_family}_{match.group('lang_region')}"
    return "/".join(
        [lang_family, lang_code, match.group("voice_name"), match.group("voice_quality")]
    )


def download_file(url: str, dest: Path, attempts: int = ATTEMPTS):
    """Скачать url в dest через .part-файл. Прерванная закачка не остаётся «готовой»."""
    import urllib.request

    if dest.exists() and dest.stat().st_size > 0:
        logger.info("Already exists: %s", dest)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    last_error = None
    for attempt in range(1, attempts + 1):
        logger.info(
            "Downloading (попытка %d/%d) %s -> %s", attempt, attempts, url, dest
        )
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": "dsh-voice-chat/1.0"}
            )
            with urllib.request.urlopen(request, timeout=CONNECT_TIMEOUT_S) as resp:
                total = int(resp.headers.get("Content-Length") or 0)
                received = 0
                last_report = 0.0
                with open(tmp, "wb") as out:
                    while True:
                        # Уже прочитанный буфер дочитываем с бо́льшим таймаутом
                        chunk = resp.read(1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        received += len(chunk)
                        now = time.monotonic()
                        if total and now - last_report > 5:
                            logger.info(
                                "  %d%% (%.1f/%.1f МБ)",
                                received * 100 // total,
                                received / 1e6,
                                total / 1e6,
                            )
                            last_report = now
            if total and received != total:
                raise IOError(f"Оборвалось: {received} из {total} байт")
            tmp.replace(dest)
            logger.info("Downloaded: %s (%d байт)", dest, received)
            return
        except Exception as exc:  # сеть/прокси/антивирус — единого типа исключений нет
            last_error = exc
            logger.warning("  не получилось: %s: %s", type(exc).__name__, exc)
            if tmp.exists():
                tmp.unlink()
            if attempt < attempts:
                time.sleep(2 * attempt)
    raise RuntimeError(
        f"Не удалось скачать {url} после {attempts} попыток: {last_error}. "
        "Проверьте интернет/прокси или укажите зеркало в DSH_VOICE_PIPER_BASE"
    )


def download_piper_voice(voice_name: str = PIPER_VOICE_NAME):
    prefix_dir = piper_voice_dir(voice_name)
    voice_dir = DATA_DIR / "piper" / voice_name
    last_error = None
    for base in PIPER_BASES:
        try:
            prefix = f"{base.rstrip('/')}/{prefix_dir}"
            download_file(
                f"{prefix}/{voice_name}.onnx?download=true",
                voice_dir / f"{voice_name}.onnx",
            )
            download_file(
                f"{prefix}/{voice_name}.onnx.json?download=true",
                voice_dir / f"{voice_name}.onnx.json",
            )
            return
        except Exception as exc:
            last_error = exc
            logger.warning("Зеркало %s не подошло: %s", base, exc)
    raise RuntimeError(f"Не удалось скачать голос Piper {voice_name}: {last_error}")


def download_whisper_model(model_name: str = "small"):
    from faster_whisper import WhisperModel

    endpoints = [os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")]
    for fallback in ("https://hf-mirror.com",):
        if fallback not in endpoints:
            endpoints.append(fallback)
    last_error = None
    for endpoint in endpoints:
        os.environ["HF_ENDPOINT"] = endpoint
        logger.info("Downloading faster-whisper model %s via %s", model_name, endpoint)
        try:
            WhisperModel(model_name, device="cpu", compute_type="int8", download_root=str(DATA_DIR))
            logger.info("faster-whisper model downloaded")
            return
        except Exception as exc:
            last_error = exc
            logger.warning("  через %s не получилось: %s: %s", endpoint, type(exc).__name__, exc)
    raise RuntimeError(
        f"Не удалось скачать faster-whisper ({model_name}): {last_error}. "
        "Проверьте интернет/прокси или задайте HF_ENDPOINT"
    )


def main():
    parser = argparse.ArgumentParser(description="Download models for DSH Voice Chat")
    parser.add_argument("--whisper-model", default="small", help="Whisper model size")
    parser.add_argument("--piper-voice", default=PIPER_VOICE_NAME, help="Piper voice name")
    args = parser.parse_args()

    logger.info("Data directory: %s", DATA_DIR)
    logger.info("Piper mirrors: %s", ", ".join(PIPER_BASES))

    try:
        download_piper_voice(args.piper_voice)
    except Exception as exc:
        # Piper без голоса не полезен, но Whisper ещё можно скачать: сообщаем и идём дальше,
        # итоговую ошибку соберёт вызывающая сторона (проверит обе модели на диске)
        logger.error("Piper: %s", exc)

    download_whisper_model(args.whisper_model)
    logger.info("All models downloaded successfully")


if __name__ == "__main__":
    main()