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

print(f"\n{passed} пройдено")
