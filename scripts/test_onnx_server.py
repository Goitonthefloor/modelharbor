#!/usr/bin/env python3
"""Tests fuer electron/onnx_server.py — ohne OGA-Modell/Onnxruntime.

1) search_options: max_length ist Prompt + neue Tokens; do_sample nur bei temp > 0.
2) SSE-Antwort muss das Stream-Ende framing-seitig markieren (Connection: close),
   sonst haengt der Client nach [DONE] endlos (HTTP/1.1 ohne Content-Length/chunked).

Ausfuehrung: python3 scripts/test_onnx_server.py  (Exit 0 = ok)
"""
import importlib.util
import json
import socket
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("onnx_server", ROOT / "electron" / "onnx_server.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (" - " + str(detail) if detail else ""))
    if not cond:
        fails.append(name)


# --- 1) search_options ---
o = mod.search_options({"max_tokens": 100}, 1500, 2048)
check("max_length = Prompt + neue Tokens", o["max_length"] == 1600, o)

o = mod.search_options({}, 10, 2048)
check("max_length nutzt Default-max_tokens", o["max_length"] == 2058, o)

o = mod.search_options({"temperature": 0.0, "top_k": 1}, 10, 512)
check("temp 0 -> do_sample False (greedy)", o["do_sample"] is False, o)
check("temp 0 wird durchgereicht", o["temperature"] == 0.0, o)

o = mod.search_options({"temperature": 0.7, "top_p": 0.9, "top_k": 40}, 10, 512)
check("temp > 0 -> do_sample True", o["do_sample"] is True, o)
check("top_p/top_k durchgereicht", o["top_p"] == 0.9 and o["top_k"] == 40, o)

o = mod.search_options({}, 10, 512)
check("ohne temperature -> do_sample False", o["do_sample"] is False, o)


# --- 2) SSE-Framing (run_generation gestubbt) ---
class Args:
    max_tokens = 2048


mod.ARGS = Args()
# Echtes run_generation fuer die Lock-Pruefung (F9) aufbewahren, bevor es gestubbt wird.
real_run_generation = mod.run_generation


def stub_generation(body, emit=None):
    """Ersetzt das echte Modell: liefert zwei Fragmente und eine usage."""
    for frag in ("Hallo", " Welt"):
        if emit:
            emit(frag)
    return {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}


mod.run_generation = stub_generation

class QuietServer(ThreadingHTTPServer):
    """Absichtlich still: kaputte Test-Clients (411/400) sind Teil der Pruefung."""

    def handle_error(self, request, client_address):
        pass


srv = QuietServer(("127.0.0.1", 0), mod.Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

payload = json.dumps({"stream": True, "messages": [{"role": "user", "content": "hi"}]}).encode()
s = socket.create_connection(("127.0.0.1", port), timeout=5)
s.sendall(
    b"POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n"
    b"Content-Type: application/json\r\nContent-Length: " + str(len(payload)).encode() + b"\r\n\r\n" + payload
)
s.settimeout(3)
data = b""
eof = False
try:
    while True:
        chunk = s.recv(4096)
        if not chunk:
            eof = True
            break
        data += chunk
        if b"[DONE]" in data:
            s.settimeout(2)
except socket.timeout:
    pass
s.close()

check("SSE enthaelt [DONE]", b"[DONE]" in data)
check("SSE-Stream endet mit EOF (Client haengt nicht)", eof)
check("Connection: close gesetzt", b"connection: close" in data.lower())
check("beide Deltas uebertragen", b"Hallo" in data and b" Welt" in data)
check("usage-Block uebertragen", b'"completion_tokens": 2' in data or b'"completion_tokens":2' in data)

# --- 3) Nicht-Stream-Pfad bleibt JSON mit Content-Length ---
s = socket.create_connection(("127.0.0.1", port), timeout=5)
payload2 = json.dumps({"stream": False, "messages": [{"role": "user", "content": "hi"}]}).encode()
s.sendall(
    b"POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n"
    b"Content-Type: application/json\r\nContent-Length: " + str(len(payload2)).encode() + b"\r\n\r\n" + payload2
)
resp = b""
s.settimeout(3)
try:
    while b"\r\n\r\n" not in resp:
        resp += s.recv(4096)
    head, _, rest = resp.partition(b"\r\n\r\n")
    clen = int([l.split(b":")[1] for l in head.split(b"\r\n") if l.lower().startswith(b"content-length")][0])
    while len(rest) < clen:
        rest += s.recv(4096)
    body = json.loads(rest[:clen])
    check("JSON-Antwort vollstaendig", body["choices"][0]["message"]["content"] == "Hallo Welt", body)
except Exception as e:
    check("JSON-Antwort vollstaendig", False, e)
s.close()

srv.shutdown()


# --- 4) API-Key-Pflicht und CORS (LAN-Schalter auch fuer ONNX) ---
def request(port, method="POST", path="/v1/chat/completions", key=None, origin=None):
    payload = json.dumps({"stream": False, "messages": [{"role": "user", "content": "hi"}]}).encode()
    hdr = "%s %s HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n" % (method, path)
    if key:
        hdr += "Authorization: Bearer %s\r\n" % key
    if origin:
        hdr += "Origin: %s\r\n" % origin
    raw = hdr.encode() + b"Content-Length: " + str(len(payload)).encode() + b"\r\n\r\n" + payload
    sk = socket.create_connection(("127.0.0.1", port), timeout=5)
    sk.sendall(raw)
    sk.settimeout(3)
    resp = b""
    try:
        while b"\r\n\r\n" not in resp:
            c = sk.recv(4096)
            if not c:
                break
            resp += c
        head, _, rest = resp.partition(b"\r\n\r\n")
        lines = head.split(b"\r\n")
        status = int(lines[0].split()[1])
        headers = {}
        for l in lines[1:]:
            if b":" in l:
                k, v = l.split(b":", 1)
                headers[k.decode().lower()] = v.decode().strip()
        clen = int(headers.get("content-length", "0") or 0)
        while len(rest) < clen:
            c = sk.recv(4096)
            if not c:
                break
            rest += c
        return status, headers, rest[:clen]
    except (socket.timeout, IndexError, ValueError):
        return 0, {}, b""
    finally:
        sk.close()


def serve_with(args):
    mod.ARGS = args
    sv = QuietServer(("127.0.0.1", 0), mod.Handler)
    threading.Thread(target=sv.serve_forever, daemon=True).start()
    return sv, sv.server_address[1]


class KeyArgs:
    max_tokens = 2048
    api_key = "mh-onnx-test-key"
    cors_origins = "*"


sv2, port2 = serve_with(KeyArgs())
st, _, _ = request(port2)
check("ONNX: ohne Key 401", st == 401, st)
st, _, body = request(port2, key="mh-onnx-test-key")
check("ONNX: mit Key 200 und Antwort", st == 200 and b"Hallo Welt" in body, st)
st, _, _ = request(port2, key="falscher-key")
check("ONNX: falscher Key 401", st == 401, st)
st, _, _ = request(port2, method="GET", path="/health")
check("ONNX: /health bleibt ohne Key offen (Monitoring)", st == 200, st)
st, hd, _ = request(port2, key="mh-onnx-test-key", origin="http://example.com")
check("ONNX: CORS * bedient fremde Origin", hd.get("access-control-allow-origin") == "*",
      hd.get("access-control-allow-origin"))
sv2.shutdown()


class CorsArgs:
    max_tokens = 2048
    api_key = "mh-onnx-test-key"
    cors_origins = "localhost"


sv3, port3 = serve_with(CorsArgs())
st, _, _ = request(port3, key="mh-onnx-test-key", origin="http://example.com")
check("ONNX: CORS localhost blockt fremde Origin (403)", st == 403, st)
st, _, body = request(port3, key="mh-onnx-test-key")
check("ONNX: ohne Origin weiter bedient (Gegenprobe)", st == 200 and b"Hallo Welt" in body, st)
st, _, _ = request(port3, method="OPTIONS", key="mh-onnx-test-key")
check("ONNX: OPTIONS-Preflight 204", st == 204, st)
sv3.shutdown()

# --- 5) F12: max_tokens/Sampling-Parameter werden validiert statt 500 ---
def raises_generation(fn):
    try:
        fn()
    except mod.GenerationError:
        return True
    return False


check("F12: max_tokens 0 -> Client-Fehler", raises_generation(lambda: mod.clamp_max_tokens(0, 2048)))
check("F12: max_tokens -5 -> Client-Fehler", raises_generation(lambda: mod.clamp_max_tokens(-5, 2048)))
check("F12: max_tokens 3.9 -> Client-Fehler", raises_generation(lambda: mod.clamp_max_tokens(3.9, 2048)))
check("F12: max_tokens 'abc' -> Client-Fehler", raises_generation(lambda: mod.clamp_max_tokens("abc", 2048)))
check("F12: max_tokens True (bool) -> Client-Fehler", raises_generation(lambda: mod.clamp_max_tokens(True, 2048)))
check("F12: max_tokens 1000000 auf Serverlimit geklemmt",
      mod.clamp_max_tokens(1000000, 2048) == 2048, mod.clamp_max_tokens(1000000, 2048))
check("F12: Serverlimit hart auf 32768 gedeckelt",
      mod.clamp_max_tokens(1000000, 1000000) == mod.SERVER_MAX_NEW_TOKENS,
      mod.clamp_max_tokens(1000000, 1000000))
check("F12: max_tokens fehlt -> Default", mod.clamp_max_tokens(None, 512) == 512)
check("F12: temperature 6 -> Client-Fehler",
      raises_generation(lambda: mod.search_options({"temperature": 6}, 10, 512)))
check("F12: temperature 'heiss' -> Client-Fehler",
      raises_generation(lambda: mod.search_options({"temperature": "heiss"}, 10, 512)))
check("F12: top_p 0 -> Client-Fehler",
      raises_generation(lambda: mod.search_options({"top_p": 0}, 10, 512)))
check("F12: top_p 1.5 -> Client-Fehler",
      raises_generation(lambda: mod.search_options({"top_p": 1.5}, 10, 512)))
check("F12: top_k -1 -> Client-Fehler",
      raises_generation(lambda: mod.search_options({"top_k": -1}, 10, 512)))
check("F12: leere messages -> Client-Fehler",
      raises_generation(lambda: mod.normalize_messages({"messages": []})))
check("F12: request ohne messages -> Client-Fehler",
      raises_generation(lambda: mod.validate_request({"max_tokens": 10})))

# --- 6) F10: Origin-Pruefung vergleicht exakt statt per Substring ---
check("F10: Loopback-Origin erlaubt",
      mod.origin_allowed("localhost", "http://localhost:5173") is True)
check("F10: 127.0.0.1 erlaubt", mod.origin_allowed("localhost", "http://127.0.0.1:8080") is True)
check("F10: getarnte Origin wird abgelehnt",
      mod.origin_allowed("localhost", "https://evil-localhost.attacker.example") is False)
check("F10: fremde Origin wird abgelehnt",
      mod.origin_allowed("localhost", "http://example.com") is False)
check("F10: 'null' (file://-Sandbox) wird abgelehnt",
      mod.origin_allowed("localhost", "null") is False)
check("F10: ohne Origin-Header keine CORS-Pruefung (curl)",
      mod.origin_allowed("localhost", "") is True)
check("F10: '*' erlaubt fremde Origin",
      mod.origin_allowed("*", "http://example.com") is True)
check("F10: exakte Liste erlaubt genau diese Origin",
      mod.origin_allowed("http://localhost:5173", "http://localhost:5173") is True)
check("F10: exakte Liste blockt anderen Port",
      mod.origin_allowed("http://localhost:5173", "http://localhost:9999") is False)
check("F10: exakte Liste blockt anderen Host",
      mod.origin_allowed("http://localhost:5173", "http://127.0.0.1:5173") is False)
check("F10: Liste mit mehreren Eintraegen",
      mod.origin_allowed("http://a.example,http://b.example", "http://b.example") is True)

# --- 7) F15: Authorization-Schema case-insensitiv, /v1/models vorhanden ---
check("F15: 'bearer' klein wird akzeptiert", mod.bearer_matches("bearer abc", "abc") is True)
check("F15: 'BEARER' gross wird akzeptiert", mod.bearer_matches("BEARER abc", "abc") is True)
check("F15: falsches Schema wird abgelehnt", mod.bearer_matches("Basic abc", "abc") is False)
check("F15: falscher Key wird abgelehnt", mod.bearer_matches("Bearer xyz", "abc") is False)
check("F15: fehlender Header wird abgelehnt", mod.bearer_matches("", "abc") is False)
check("F15: ohne konfigurierten Key offen", mod.bearer_matches("", "") is True)


class ModelsArgs:
    max_tokens = 2048
    api_key = "mh-onnx-test-key"
    cors_origins = "localhost"


sv4, port4 = serve_with(ModelsArgs())
st, _, body = request(port4, method="GET", path="/v1/models", key="mh-onnx-test-key")
ok_models = False
try:
    listing = json.loads(body)
    ok_models = st == 200 and listing["object"] == "list" and listing["data"][0]["id"] == mod.MODEL_ID
except Exception:
    listing = body
check("F15: GET /v1/models liefert die Modellliste", ok_models, (st, listing))
st, _, _ = request(port4, method="GET", path="/v1/models")
check("F15: GET /v1/models ohne Key 401", st == 401, st)
sv4.shutdown()

# --- 8) F13: CLI-Flags, Defaults und Key-Aufloesung ---
import os

ap = mod.build_arg_parser()
defaults = ap.parse_args(["--model-dir", "/tmp/model"])
check("F13: --cors-origins Default ist localhost (nicht '*')",
      defaults.cors_origins == "localhost", defaults.cors_origins)
check("F13: --request-timeout Default 60s", defaults.request_timeout == 60.0, defaults.request_timeout)
check("F13: --api-key ist ein bekanntes Flag",
      ap.parse_args(["--model-dir", "/tmp/m", "--api-key", "k"]).api_key == "k")
check("F13: Handler-Timeout kommt aus der Konfiguration",
      mod.Handler.timeout == mod.DEFAULT_REQUEST_TIMEOUT, mod.Handler.timeout)

os.environ.pop("MH_ONNX_API_KEY", None)
check("F13: ohne Key und ohne Env leer", mod.resolve_api_key(None) == "")
os.environ["MH_ONNX_API_KEY"] = "env-key"
check("F13: Env-Variable wird gelesen", mod.resolve_api_key(None) == "env-key")
check("F13: --api-key hat Vorrang", mod.resolve_api_key("cli-key") == "cli-key")
os.environ.pop("MH_ONNX_API_KEY", None)

# --- 9) F11: kaputte/unvollstaendige Bodies ergeben 4xx statt 500 ---
def raw_exchange(port, raw, head_only=False, read_timeout=3.0):
    """Rohrequest senden und (Status, Body) zurueckgeben — ohne urllib-Magie."""
    sk = socket.create_connection(("127.0.0.1", port), timeout=5)
    try:
        sk.sendall(raw)
    except (BrokenPipeError, ConnectionResetError):
        pass
    sk.settimeout(read_timeout)
    resp = b""
    try:
        while b"\r\n\r\n" not in resp:
            c = sk.recv(4096)
            if not c:
                break
            resp += c
        head, _, rest = resp.partition(b"\r\n\r\n")
        clen = 0
        for line in head.split(b"\r\n")[1:]:
            if line.lower().startswith(b"content-length:"):
                clen = int(line.split(b":", 1)[1].strip() or 0)
        if not head_only:
            while len(rest) < clen:
                c = sk.recv(4096)
                if not c:
                    break
                rest += c
        status = int(head.split(b"\r\n")[0].split()[1])
        return status, rest[:clen]
    except (socket.timeout, IndexError, ValueError):
        return 0, b""
    finally:
        sk.close()


POST_MSG = json.dumps({"stream": False, "messages": [{"role": "user", "content": "hi"}]}).encode()
BASE_HDR = b"POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"

sv5, port5 = serve_with(ModelsArgs())
AUTH = b"Authorization: " + b"Bearer" + b" mh-onnx-test-key\r\n"

st, body = raw_exchange(port5, BASE_HDR + AUTH + b"Transfer-Encoding: chunked\r\n\r\n"
                        + b"%x\r\n" % len(POST_MSG) + POST_MSG + b"\r\n0\r\n\r\n")
check("F11: Transfer-Encoding chunked -> 411 statt 500", st == 411, (st, body[:120]))

st, body = raw_exchange(port5, BASE_HDR + AUTH + b"\r\n")
check("F11: fehlendes Content-Length -> 411", st == 411, (st, body[:120]))

st, body = raw_exchange(port5, BASE_HDR + AUTH + b"Content-Length: abc\r\n\r\n")
check("F11: nicht-numerisches Content-Length -> 400", st == 400, (st, body[:120]))

st, body = raw_exchange(port5, BASE_HDR + AUTH + b"Content-Length: -1\r\n\r\n")
check("F11: negatives Content-Length -> 400", st == 400, (st, body[:120]))

too_big = b"Content-Length: %d\r\n\r\n" % (mod.MAX_BODY_BYTES + 1)
st, body = raw_exchange(port5, BASE_HDR + AUTH + too_big, head_only=True)
check("F11: Body ueber MAX_BODY_BYTES -> 413", st == 413, (st, body[:120]))
sv5.shutdown()


class SlowArgs:
    max_tokens = 2048
    api_key = "mh-onnx-test-key"
    cors_origins = "localhost"


_orig_timeout = mod.Handler.timeout
mod.Handler.timeout = 0.5  # damit der Timeout-Test nicht 60s wartet
sv6, port6 = serve_with(SlowArgs())
st, body = raw_exchange(port6, BASE_HDR + AUTH + b"Content-Length: 200\r\n\r\n" + b"{\"a\":")
check("F11: angefangener Body -> 408 statt Haenger", st == 408, (st, body[:120]))
sv6.shutdown()
mod.Handler.timeout = _orig_timeout


# --- 10) F9: emit() laeuft ausserhalb des Modell-Locks ---
import types


class FakeStream:
    def decode(self, token_id):
        return "tok%d" % token_id


class FakeParams:
    def __init__(self, model):
        self.opts = {}

    def set_search_options(self, **kw):
        self.opts = kw


class FakeGenerator:
    def __init__(self, model, params):
        self.params = params
        self.generated = 0
        self.appended = 0

    def append_tokens(self, tokens):
        self.appended = len(tokens)

    def token_count(self):
        return self.appended + self.generated

    def is_done(self):
        return self.generated >= 3

    def generate_next_token(self):
        self.generated += 1

    def get_next_tokens(self):
        return [100 + self.generated]


_keep = (mod.OG, mod.MODEL, mod.TOK)
mod.OG = types.SimpleNamespace(GeneratorParams=FakeParams, Generator=FakeGenerator)
mod.MODEL = object()
mod.TOK = types.SimpleNamespace(
    apply_chat_template=lambda msgs, add_generation_prompt=True: "prompt",
    encode=lambda prompt: [1, 2, 3],
    create_stream=lambda: FakeStream(),
)
mod.ARGS = ModelsArgs()

seen = []


def collecting_emit(frag):
    """Prueft im Callback, ob der Modell-Lock gerade frei ist."""
    free = mod.LOCK.acquire(blocking=False)
    if free:
        mod.LOCK.release()
    seen.append((frag, free))


usage = real_run_generation({"messages": [{"role": "user", "content": "hi"}]}, collecting_emit)
check("F9: emit bekommt alle Fragmente", "".join(f for f, _ in seen) == "tok101tok102tok103",
      [f for f, _ in seen])
check("F9: emit laeuft ausserhalb des Locks", all(free for _, free in seen) and len(seen) == 3,
      seen)
check("F9: usage zaehlt Prompt- und neue Tokens",
      usage == {"prompt_tokens": 3, "completion_tokens": 3, "total_tokens": 6}, usage)
check("F9: Lock ist nach der Generation wieder frei", mod.LOCK.acquire(blocking=False) is True
      and (mod.LOCK.release() or True))

mod.OG, mod.MODEL, mod.TOK = _keep

print()
if fails:
    print("=== %d FEHLER: %s ===" % (len(fails), ", ".join(fails)))
    sys.exit(1)
print("=== alle ONNX-Server-Checks bestanden ===")
sys.exit(0)
