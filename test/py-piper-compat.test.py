#!/usr/bin/env python3
"""
Синтез Piper должен работать с обеими ветками API.

piper-tts переписали в 1.3 (ветка piper1-gpl, сейчас актуальна 1.8.x): метод
synthesize_stream_raw(), на котором держался прежний код, УБРАН, а synth()
начал отдавать объекты AudioChunk. При `piper-tts>=1.2.0` из requirements.txt
pip ставит свежую версию — и озвучка падала в 500, то есть «ничего не играет».

Тест подменяет модуль piper фейком в двух видах и требует, чтобы _synthesize
выдала одинаковый корректный WAV в обоих случаях.

Запуск: python3 test/py-piper-compat.test.py
"""
import importlib.util
import io
import os
import struct
import sys
import types
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Старый код импортировал numpy ради единственной строки и не пользовался им.
# Заглушка нужна, чтобы тест дошёл до проверки блокировок, а не падал на импорте.
sys.modules.setdefault("numpy", types.ModuleType("numpy"))
spec = importlib.util.spec_from_file_location(
    "dsh_voice_server", os.path.join(ROOT, "py", "server.py"))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

passed = 0


def check(name, fn):
    global passed
    try:
        fn()
        passed += 1
        print(f"  ok  {name}")
    except Exception as err:  # noqa: BLE001 — тест-раннер
        print(f"FAIL  {name}")
        print(f"      {type(err).__name__}: {err}")
        sys.exit(1)


SAMPLE_RATE = 22050
PCM = struct.pack("<" + "h" * 8, 0, 1000, -1000, 500, -500, 200, -200, 0)


class FakeConfig:
    sample_rate = SAMPLE_RATE


class OldApiVoice:
    """piper-tts 1.2: synthesize_stream_raw отдаёт байты."""

    def __init__(self):
        self.config = FakeConfig()
        self.calls = []

    def synthesize_stream_raw(self, text, length_scale=1.0):
        self.calls.append(("stream_raw", length_scale))
        yield PCM


class OldSynthVoice:
    """piper-tts 1.2: synthesize(text, length_scale=...) тоже отдаёт байты."""

    def __init__(self):
        self.config = FakeConfig()
        self.calls = []

    def synthesize(self, text, length_scale=1.0):
        self.calls.append(("synth-kw", length_scale))
        yield PCM


class AudioChunk:
    """piper-tts >= 1.3: synth() отдаёт AudioChunk."""

    def __init__(self):
        self.sample_rate = SAMPLE_RATE
        self.sample_width = 2
        self.sample_channels = 1
        self.audio_int16_bytes = PCM
        self.phonemes = ["a"]


class NewApiVoice:
    """piper-tts 1.8: synth() + SynthesisConfig(length_scale=…)."""

    def __init__(self):
        self.config = FakeConfig()
        self.config_seen = []

    def synthesize(self, text, syn_config=None):
        self.config_seen.append(syn_config)
        yield AudioChunk()


class NewApiArrayVoice(NewApiVoice):
    """Вариант, где есть только audio_int16_array, но нет audio_int16_bytes."""

    class Chunk:
        def __init__(self):
            self.audio_int16_array = _as_array(PCM)

    def synthesize(self, text, syn_config=None):
        self.config_seen.append(syn_config)
        yield self.Chunk()


def _as_array(pcm):
    import array
    values = array.array("h")
    values.frombytes(pcm)
    return values


class RecordingSynthesisConfig:
    def __init__(self, length_scale=1.0, **_kwargs):
        self.length_scale = length_scale


def install_fake_piper(voice_cls, *, with_config=True):
    """Подменяет `import piper` на фейковый модуль с заданным голосом."""
    module = types.ModuleType("piper")

    class PiperVoice:
        def __init__(self):
            self._voice = voice_cls()

        @staticmethod
        def load(model_path, config_path=None, use_cuda=False):
            return PiperVoice()._voice

    module.PiperVoice = PiperVoice
    if with_config:
        module.SynthesisConfig = RecordingSynthesisConfig
    sys.modules["piper"] = module
    return module


def clear_fake_piper():
    sys.modules.pop("piper", None)
    server._piper_voices.clear()


def synth_with(voice, speed=1.0, text="Привет"):
    server._piper_voices["ru_RU-irina-medium"] = voice
    return server._synthesize(text, "ru_RU-irina-medium", speed)


def wav_of(data):
    """Разбирает WAV обратно: (sample_rate, channels, sampwidth, frames)."""
    with wave.open(io.BytesIO(data), "rb") as handle:
        return handle.getframerate(), handle.getnchannels(), \
            handle.getsampwidth(), handle.readframes(handle.getnframes())


print("\nСинтез Piper: обе ветки API дают одинаковый корректный WAV")

# --- Регресс, который стоил пользователю всей локальной озвучки -------------

print("\nВложенные блокировки: _synthesize() зовёт _load_piper()")


def nested_lock_deadlock():
    """ГЛАВНЫЙ регресс.

    _synthesize() берёт _piper_lock и внутри вызывает _load_piper(), который
    берёт его же. С обычным threading.Lock это вечная блокировка: первая же
    озвучка Piper не возвращалась НИКОГДА — ни звука, ни ошибки. Живо с v0.5.0.

    Проверяем на настоящем пути (создаём голос на диске, подменяем только
    piper) и с настоящим таймаутом: зависание должно проявляться как
    «сигнал по таймеру», а не как молчаливое зависание теста.
    """
    import signal
    import tempfile
    import threading

    voice_dir = os.path.join(tempfile.mkdtemp(), "piper", "ru_RU-irina-medium")
    os.makedirs(voice_dir)
    open(os.path.join(voice_dir, "ru_RU-irina-medium.onnx"), "wb").write(b"stub")
    open(os.path.join(voice_dir, "ru_RU-irina-medium.onnx.json"), "w").write("{}")
    from pathlib import Path
    server.DATA_DIR = Path(os.path.dirname(os.path.dirname(voice_dir)))

    clear_fake_piper()
    install_fake_piper(NewApiVoice)

    finished = threading.Event()
    result = {}

    def run():
        try:
            result["data"] = server._synthesize("Привет", "ru_RU-irina-medium", 1.0)
        except Exception as err:  # noqa: BLE001
            result["error"] = err
        finally:
            finished.set()

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(timeout=6)

    assert finished.is_set(), (
        "_synthesize() не вернулся за 6 с — deadlock на _piper_lock "
        "(вложенные блокировки должны сниматься RLock)"
    )
    if "error" in result:
        import traceback
        raise AssertionError("синтез упал:\n" + "".join(
            traceback.format_exception(type(result["error"]), result["error"], result["error"].__traceback__)))
    assert result["data"][:4] == b"RIFF", "ожидался WAV"
    clear_fake_piper()


check("полный путь _synthesize → _load_piper возвращает WAV (не виснет)", nested_lock_deadlock)


REFERENCE = None


def record_reference():
    global REFERENCE
    clear_fake_piper()
    install_fake_piper(OldApiVoice)
    REFERENCE = synth_with(OldApiVoice())
    assert REFERENCE, "эталонный WAV пуст"


check("API 1.2: synthesize_stream_raw() → корректный WAV", record_reference)

check("API 1.2: synthesize(text, length_scale=…) → тот же WAV", lambda: (
    clear_fake_piper(),
    install_fake_piper(OldSynthVoice),
    (lambda voice: (
        (lambda data: (
            (wav_of(data) == wav_of(REFERENCE)) or (_fail("WAV отличается от эталонного")),
            (voice.calls == [("synth-kw", 1.0)]) or _fail(f"скорость не передана: {voice.calls}")
        ))(synth_with(voice))
    ))(OldSynthVoice())
))


def new_api_case():
    clear_fake_piper()
    install_fake_piper(NewApiVoice)
    voice = NewApiVoice()
    data = synth_with(voice)
    assert wav_of(data) == wav_of(REFERENCE), "WAV отличается от эталонного"
    assert len(voice.config_seen) == 1, "SynthesisConfig не создан"
    assert voice.config_seen[0] is not None, "синтез пошёл без конфигурации"
    assert abs(voice.config_seen[0].length_scale - 1.0) < 1e-6, \
        f"length_scale не передан: {voice.config_seen[0].length_scale}"


check("API >= 1.3: synth() + AudioChunk + SynthesisConfig → тот же WAV", new_api_case)


def speed_becomes_length_scale():
    clear_fake_piper()
    install_fake_piper(NewApiVoice)
    voice = NewApiVoice()
    synth_with(voice, speed=2.0)
    assert abs(voice.config_seen[0].length_scale - 0.5) < 1e-6, \
        f"speed=2 должен давать length_scale=0.5, получено {voice.config_seen[0].length_scale}"


check("скорость речи доезжает до нового API (speed → length_scale)", speed_becomes_length_scale)


def array_only_variant():
    clear_fake_piper()
    install_fake_piper(NewApiArrayVoice)
    voice = NewApiArrayVoice()
    data = synth_with(voice)
    assert wav_of(data) == wav_of(REFERENCE), "ветка audio_int16_array отличается"


check("API >= 1.3 с audio_int16_array вместо байтов", array_only_variant)


def without_synthesis_config():
    """Старая сборка без SynthesisConfig: синтез должен идти, просто без скорости."""
    clear_fake_piper()
    install_fake_piper(NewApiVoice, with_config=False)
    voice = NewApiVoice()
    data = synth_with(voice, speed=2.0)
    assert wav_of(data) == wav_of(REFERENCE), "без SynthesisConfig WAV отличается"
    assert all(cfg is None for cfg in voice.config_seen), "конфиг не должен подставляться"


check("нет SynthesisConfig в piper — синтез всё равно работает", without_synthesis_config)


def empty_audio_is_reported():
    """Пустое аудио должно быть явной ошибкой, а не «файлом» без звука."""
    clear_fake_piper()
    install_fake_piper(OldApiVoice)

    class Silent(OldApiVoice):
        def synthesize_stream_raw(self, text, length_scale=1.0):
            return iter(())

    server._piper_voices["ru_RU-irina-medium"] = Silent()
    try:
        server._synthesize("Привет", "ru_RU-irina-medium", 1.0)
    except RuntimeError as err:
        assert "пустое аудио" in str(err), f"непонятная ошибка: {err}"
        return
    finally:
        server._piper_voices.clear()
    raise AssertionError("пустое аудио должно поднимать ошибку, а не отдаваться браузеру")


check("пустое аудио Piper не отдаётся как валидный файл", empty_audio_is_reported)

clear_fake_piper()
print(f"\n{passed} пройдено")
