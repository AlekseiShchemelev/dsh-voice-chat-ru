#!/usr/bin/env python3
"""
Регрессия: локальный сервер зависал на каждом запросе распознавания.

Браузер отправляет multipart через fetch как Transfer-Encoding: chunked, без
Content-Length, и держит соединение живым (keep-alive). Парсер, который читал
тело до конца потока (stream.read(max_body)), ждал EOF — то есть вечно: микрофон
переключался с красного на жёлтый, и запрос висел до перезагрузки страницы.

Тест поднимает НАСТОЯЩИй ThreadingHTTPServer с обработчиком из py/server.py и
отправляет настоящий chunked-запрос через сырой сокет, намеренно оставляя
соединение открытым. Ответ обязан прийти за секунды.

Запуск: python3 test/py-server-multipart.test.py
"""
import importlib.util
import os
import socket
import sys
import threading
import time
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_PY = os.path.join(ROOT, "py", "server.py")

spec = importlib.util.spec_from_file_location("dsh_voice_server", SERVER_PY)
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
        print(err)
        sys.exit(1)


def start_server(handler_cls):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def read_response(sock):
    """Читает ответ целиком по Content-Length: заголовки и тело приходят
    разными сегментами TCP, одного recv() мало."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            return data
        data += chunk
    head, _, body = data.partition(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n"):
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1])
    while len(body) < length:
        chunk = sock.recv(4096)
        if not chunk:
            break
        body += chunk
    return head + b"\r\n\r\n" + body


def multipart_body(boundary=b"X", model=b"small", audio=b"\x01\x02\x03\x04"):
    return (
        b"--" + boundary + b"\r\n"
        b'Content-Disposition: form-data; name="model"\r\n\r\n' + model + b"\r\n"
        b"--" + boundary + b"\r\n"
        b'Content-Disposition: form-data; name="language"\r\n\r\nru\r\n'
        b"--" + boundary + b"\r\n"
        b'Content-Disposition: form-data; name="file"; filename="recording.webm"\r\n'
        b"Content-Type: audio/webm\r\n\r\n" + audio + b"\r\n"
        b"--" + boundary + b"--\r\n"
    )


def chunked_request(port, body, path="/v1/audio/transcriptions", keep_alive=True):
    """Отправляет запрос как это делает браузер: chunked, без Content-Length."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=6)
    sock.sendall(
        f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n"
        f"Content-Type: multipart/form-data; boundary=X\r\n"
        f"Transfer-Encoding: chunked\r\n\r\n".encode()
    )
    # Тело одним чанком: <размер>\r\n<данные>\r\n, затем «0\r\n\r\n».
    # Соединение при этом ОСТАЁТСЯ открытым — именно этот случай и вешал сервер.
    sock.sendall(b"%x\r\n" % len(body) + body + b"\r\n0\r\n\r\n")
    sock.settimeout(5)
    try:
        data = read_response(sock)
    finally:
        sock.close()
    return data


print("\nmultipart: chunked-запрос не должен висеть (регрессия зависания)")

# Обработчик повторяет то, что делает реальный: разбор тела и ответ.
# Дальше настоящий обработчик упал бы на отсутствии faster_whisper — это неважно,
# важен сам факт, что ответ ДОШЁЛ, а не завис на чтении тела.
import http.server


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        try:
            body = server.read_request_body(self.rfile, self.headers)
            form = server.parse_multipart(body, self.headers.get("Content-Type", ""))
            code = 409
        except Exception as err:  # noqa: BLE001
            print("  ОШИБКА:", type(err).__name__, err, flush=True)
            form, code = {}, 400
        payload = repr({
            "model": form.get("model", b"").decode(),
            "language": form.get("language", b"").decode(),
            "file": len(form.get("file", b"")),
        }).encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = False   # keep-alive, как у настоящего сервера


httpd, port = start_server(Handler)
try:
    def chunked_answers():
        t0 = time.time()
        data = chunked_request(port, multipart_body())
        elapsed = time.time() - t0
        assert data, "сервер не ответил — запрос завис на чтении тела"
        assert elapsed < 4, f"ответ слишком долгий ({elapsed:.1f} с) — вероятен блокирующий read()"
        assert b"409" in data, f"ожидался разобранный ответ 409, получено: {data[:120]!r}"
        assert b"'model': 'small'" in data, f"поле model не разобрано: {data[:200]!r}"
        assert b"'language': 'ru'" in data, f"поле language не разобрано: {data[:200]!r}"
        assert b"'file': 4" in data, f"файл не разобран: {data[:200]!r}"

    check("chunked multipart отвечает сразу, не дожидаясь EOF", chunked_answers)

    def body_larger_than_one_chunk():
        audio = b"\x00" * (700 * 1024)          # больше размера читаемого куска
        t0 = time.time()
        data = chunked_request(port, multipart_body(audio=audio))
        elapsed = time.time() - t0
        assert data, "крупное тело не разобрано"
        assert elapsed < 5, f"крупное тело обработано за {elapsed:.1f} с"
        assert b"'file': 716800" in data, f"файл обрезан: {data[:200]!r}"

    check("тело больше одного читаемого куска разбирается целиком", body_larger_than_one_chunk)

    def split_terminator():
        # Граница завершения может прийти двумя чанками — это обычное дело для
        # TCP, и парсер обязан это пережить, а не ждать «ещё данных».
        body = multipart_body()
        head, tail = body[:-6], body[-6:]     # разрыв попадает внутрь разделителя
        sock = socket.create_connection(("127.0.0.1", port), timeout=6)
        sock.sendall(
            b"POST /v1/audio/transcriptions HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            b"Content-Type: multipart/form-data; boundary=X\r\n"
            b"Transfer-Encoding: chunked\r\n\r\n"
        )
        sock.sendall(b"%x\r\n" % len(head) + head)
        time.sleep(0.2)
        sock.sendall(b"%x\r\n" % len(tail) + tail + b"\r\n0\r\n\r\n")
        sock.settimeout(5)
        data = read_response(sock)
        sock.close()
        assert data, "разорванный разделитель приводит к зависанию"
        assert b"'model': 'small'" in data, f"разорванный разделитель: {data[:200]!r}"

    check("разделитель, разорванный между чанками, не ломает разбор", split_terminator)

    def content_length_still_works():
        body = multipart_body()
        sock = socket.create_connection(("127.0.0.1", port), timeout=6)
        sock.sendall(
            b"POST /v1/audio/transcriptions HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            b"Content-Type: multipart/form-data; boundary=X\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        )
        sock.settimeout(5)
        data = read_response(sock)
        sock.close()
        assert b"'model': 'small'" in data, f"Content-Length-вариант сломан: {data[:200]!r}"

    check("Content-Length (не chunked) тоже разбирается", content_length_still_works)

    def sloppy_client_without_crlf():
        # Некоторые клиенты не шлют CRLF после данных чанка (нарушение RFC, но
        # встречается). Раньше такой запрос уводил сервер в бесконечный read().
        body = multipart_body()
        sock = socket.create_connection(("127.0.0.1", port), timeout=6)
        sock.sendall(
            b"POST /v1/audio/transcriptions HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            b"Content-Type: multipart/form-data; boundary=X\r\n"
            b"Transfer-Encoding: chunked\r\n\r\n"
        )
        sock.sendall(b"%x\r\n" % len(body) + body + b"0\r\n\r\n")  # без CRLF
        sock.settimeout(5)
        data = read_response(sock)
        sock.close()
        assert data, "клиент без CRLF после чанка приводит к зависанию"
        assert b"'model': 'small'" in data, f"разбор не удался: {data[:200]!r}"

    check("клиент без CRLF после чанка тоже разбирается", sloppy_client_without_crlf)

    def two_chunks_normal_framing():
        # Тело двумя чанками с корректным CRLF — обычный случай, когда запись
        # не помещается в один сегмент TCP.
        first, second = multipart_body()[:80], multipart_body()[80:]
        sock = socket.create_connection(("127.0.0.1", port), timeout=6)
        sock.sendall(
            b"POST /v1/audio/transcriptions HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            b"Content-Type: multipart/form-data; boundary=X\r\n"
            b"Transfer-Encoding: chunked\r\n\r\n"
        )
        sock.sendall(b"%x\r\n" % len(first) + first + b"\r\n")
        sock.sendall(b"%x\r\n" % len(second) + second + b"\r\n0\r\n\r\n")
        sock.settimeout(5)
        data = read_response(sock)
        sock.close()
        assert b"'file': 4" in data, f"файл разобран не полностью: {data[:200]!r}"

    check("тело из двух чанков склеивается целиком", two_chunks_normal_framing)
finally:
    httpd.shutdown()


# ---------------------------------------------------------------------------
# Настоящий Handler: лимиты тела, дренаж при ошибке, /warm traversal, локальность.

print("\nРеальный Handler: лимиты, дренаж, /warm traversal, проверка локальности")

import threading

# Тяжёлый инференс не нужен: проверяем HTTP-слой. Заглушки повторяют сигнатуры и
# записывают вызовы, чтобы проверить проброс beam_size/model/language.
_transcribe_calls = []


def _fake_transcribe(audio, model, language, beam_size=None):
    _transcribe_calls.append({"model": model, "language": language, "beam": beam_size})
    return "распознано"


server._transcribe = _fake_transcribe
server._synthesize = lambda text, voice, speed: b"RIFF" + b"\x00" * 40 + b"WAVE"
# Дренаж тела нужен именно для keep-alive (HTTP/1.1): включаем его только в тесте,
# чтобы проверить, что после ошибки соединение не «плывёт».
server.Handler.protocol_version = "HTTP/1.1"

real = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
real_port = real.server_address[1]
threading.Thread(target=real.serve_forever, daemon=True).start()


def request_bytes(method, path, body=b"", headers=None, keep_alive=False):
    hdrs = {"Host": "127.0.0.1", "Connection": "keep-alive" if keep_alive else "close"}
    if headers:
        hdrs.update(headers)
    if body and "Content-Length" not in hdrs:
        hdrs["Content-Length"] = str(len(body))
    head = f"{method} {path} HTTP/1.1\r\n" + "".join(
        f"{k}: {v}\r\n" for k, v in hdrs.items()) + "\r\n"
    return head.encode() + body


def one_shot(method, path, body=b"", headers=None):
    sock = socket.create_connection(("127.0.0.1", real_port), timeout=6)
    sock.sendall(request_bytes(method, path, body, headers, keep_alive=False))
    data = read_response(sock)
    sock.close()
    return data


def multipart_with_beam(boundary=b"X", model=b"small", beam=b"7"):
    return (
        b"--" + boundary + b"\r\n"
        b'Content-Disposition: form-data; name="model"\r\n\r\n' + model + b"\r\n"
        b"--" + boundary + b"\r\n"
        b'Content-Disposition: form-data; name="language"\r\n\r\nru\r\n'
        b"--" + boundary + b"\r\n"
        b'Content-Disposition: form-data; name="beam_size"\r\n\r\n' + beam + b"\r\n"
        b"--" + boundary + b"\r\n"
        b'Content-Disposition: form-data; name="file"; filename="r.webm"\r\n'
        b"Content-Type: audio/webm\r\n\r\n" + b"\x01\x02\x03\x04" + b"\r\n"
        b"--" + boundary + b"--\r\n"
    )


try:
    def real_beam_size_passthrough():
        _transcribe_calls.clear()
        data = one_shot(
            "POST", "/v1/audio/transcriptions", multipart_with_beam(),
            {"Content-Type": "multipart/form-data; boundary=X"},
        )
        assert b" 200 " in data, data[:200]
        assert _transcribe_calls, "обработчик не дошёл до распознавания"
        last = _transcribe_calls[-1]
        assert last["beam"] == "7", f"beam_size не проброшен: {last}"
        assert last["model"] == "small" and last["language"] == "ru", last

    check("beam_size/model/language пробрасываются в распознавание",
          real_beam_size_passthrough)

    def tts_body_limit():
        # Content-Length больше лимита: сервер обязан ответить 400, не читая тело
        sock = socket.create_connection(("127.0.0.1", real_port), timeout=6)
        header = (
            b"POST /v1/audio/speech HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: " + str(server.MAX_TTS_BODY + 1).encode() + b"\r\n\r\n"
        )
        sock.sendall(header)
        data = read_response(sock)
        sock.close()
        assert b" 400 " in data, f"лимит тела TTS не сработал: {data[:200]!r}"

    check("тело больше лимита TTS → 400 без чтения", tts_body_limit)

    def drain_after_error_keeps_connection():
        # Не multipart: обработчик дренирует тело и отвечает 400, после чего
        # то же соединение обязано обслужить следующий запрос (иначе «плывёт»).
        sock = socket.create_connection(("127.0.0.1", real_port), timeout=6)
        body = b"x" * 4096
        sock.sendall(request_bytes(
            "POST", "/v1/audio/transcriptions", body,
            {"Content-Type": "text/plain"}, keep_alive=True,
        ))
        sock.sendall(request_bytes("GET", "/health", keep_alive=False))
        data = b""
        sock.settimeout(4)
        try:
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                data += chunk
        except socket.timeout:
            pass
        sock.close()
        assert b" 400 " in data, f"ожидался 400: {data[:200]!r}"
        assert b" 200 " in data and b'"status": "ok"' in data, \
            f"соединение не дренировано, второй запрос потерян: {data[:300]!r}"

    check("дренаж тела после ошибки сохраняет keep-alive",
          drain_after_error_keeps_connection)

    def drain_chunked_body_keeps_connection():
        # У chunked-тела нет Content-Length: дренаж обязан идти по фреймингу,
        # иначе байты тела разбираются как следующий запрос и соединение «плывёт».
        sock = socket.create_connection(("127.0.0.1", real_port), timeout=6)
        body = b"y" * 3000
        head = (
            b"POST /unknown-path HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Connection: keep-alive\r\n"
            b"Transfer-Encoding: chunked\r\n\r\n"
        )
        # Два чанка, чтобы проверить и многчанковый фрейминг
        chunked = (
            b"%x\r\n" % (len(body) // 2) + body[: len(body) // 2] + b"\r\n"
            b"%x\r\n" % (len(body) - len(body) // 2) + body[len(body) // 2:] + b"\r\n"
            b"0\r\n\r\n"
        )
        sock.sendall(head + chunked)
        sock.sendall(request_bytes("GET", "/health", keep_alive=False))
        data = b""
        sock.settimeout(4)
        try:
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                data += chunk
        except socket.timeout:
            pass
        sock.close()
        assert b" 404 " in data, f"ожидался 404: {data[:200]!r}"
        assert b" 200 " in data and b'"status": "ok"' in data, \
            f"chunked-тело не дренировано, второй запрос потерян: {data[:300]!r}"

    check("дренаж chunked-тела (без Content-Length) сохраняет keep-alive",
          drain_chunked_body_keeps_connection)

    def warm_path_traversal_rejected():
        assert b" 400 " in one_shot("GET", "/warm?model=small&voice=../../etc/passwd"), \
            "voice с / должен отклоняться"
        assert b" 400 " in one_shot("GET", "/warm?model=../../evil&voice=ru_RU-irina-medium"), \
            "неизвестная модель должна отклоняться"
        assert b" 404 " in one_shot("GET", "/warmXYZ"), "/warm должен матчиться строго"

    check("/warm: traversal и неизвестная модель → 400, путь строго", warm_path_traversal_rejected)

    def locality_guard():
        assert b" 403 " in one_shot("GET", "/health", headers={"Host": "evil.com"}), \
            "чужой Host должен отклоняться"
        assert b" 403 " in one_shot(
            "GET", "/health",
            headers={"Host": "127.0.0.1", "Origin": "http://evil.com"}), \
            "чужой Origin должен отклоняться"
        assert b" 403 " in one_shot(
            "GET", "/health",
            headers={"Host": "127.0.0.1", "Sec-Fetch-Site": "cross-site"}), \
            "cross-site должен отклоняться"
        assert b" 200 " in one_shot("GET", "/health", headers={"Host": "127.0.0.1"}), \
            "локальный запрос не должен отклоняться"

    check("Origin/Sec-Fetch-Site/Host: чужое отклоняется, локальное — нет", locality_guard)

    def server_header_hides_python():
        data = one_shot("GET", "/health", headers={"Host": "127.0.0.1"})
        head = data.split(b"\r\n\r\n", 1)[0].lower()
        assert b"python" not in head, f"заголовок Server раскрывает версию Python: {head!r}"

    check("заголовок Server не публикует версию Python", server_header_hides_python)
finally:
    real.shutdown()
    real.server_close()

print(f"\n{passed} пройдено")
