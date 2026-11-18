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
mod.run_generation = lambda body: (
    "Hallo Welt",
    {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
    iter(["Hallo", " Welt"]),
)

srv = ThreadingHTTPServer(("127.0.0.1", 0), mod.Handler)
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
print()
if fails:
    print("=== %d FEHLER: %s ===" % (len(fails), ", ".join(fails)))
    sys.exit(1)
print("=== alle ONNX-Server-Checks bestanden ===")
sys.exit(0)
