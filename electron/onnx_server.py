#!/usr/bin/env python3
"""
onnx_server.py — OGA-OpenAI-Server fuer ModelHarbor.

Startet ein ONNX-Modell ueber ONNXRuntime GenAI (OGA) und bietet die
OpenAI-kompatible Oberflaeche, die die ModelHarbor-UI erwartet:
  GET  /health                       -> 200 (analog llama-server)
  POST /v1/chat/completions          -> JSON (stream=false) oder SSE (stream=true)

CLI:
  --model-dir <ordner mit genai_config.json>
  --port <port>
  --ep <cpu|cuda|dml|openvino>       (default: cpu; andere EP nur wenn installiert)
  --max-tokens <n>                   (default 2048)

Abhaengigkeit: onnxruntime-genai im selben Python (venv), siehe
electron/backends.js (onnx-Backend).
"""
import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

def log(*a, **k):
    print(*a, **k, file=sys.stderr, flush=True)

ARGS = None
OG = None
MODEL = None
TOK = None
LOCK = threading.Lock()

def load_model(model_dir, ep):
    global MODEL, TOK
    import onnxruntime_genai as og
    cfg = og.Config(model_dir)
    if ep and ep.lower() != "cpu":
        # append / clear provider: we append only; onnxruntime-genai keeps cpu-fallback
        cfg.append_provider(ep.lower())
    m = og.Model(cfg)
    t = og.Tokenizer(m)
    return og, m, t

class SseStream:
    """SSE-serialisierter Generator ueber einen Thread-Pipe."""
    pass

def search_options(body, prompt_len, default_max_tokens):
    """OGA-Suchoptionen aus dem Request bauen (rein, ohne OGA testbar).

    WICHTIG: `max_length` ist bei OGA die GESAMTlaenge (Prompt + neue Tokens),
    nicht die Anzahl neuer Tokens. Mit max_length = max_tokens wuerde ein langer
    Prompt die Antwort abschneiden oder ganz verhindern.
    `do_sample` darf nur bei temperature > 0 gesetzt sein, sonst ist das
    deterministische Preset (temp 0) nicht greedy.
    """
    max_new = int(body.get("max_tokens") or default_max_tokens)
    temperature = body.get("temperature")
    opts = {"max_length": int(prompt_len) + max(1, max_new)}  # type: dict
    if temperature is not None:
        opts["temperature"] = float(temperature)
    if body.get("top_p") is not None:
        opts["top_p"] = float(body["top_p"])
    if body.get("top_k") is not None:
        opts["top_k"] = int(body["top_k"])
    opts["do_sample"] = temperature is not None and float(temperature) > 0
    return opts


def run_generation(body):
    """Fuehrt die OGA-Generation aus und liefert Zeichenfragmente + usage."""
    messages = body.get("messages") or []
    if not messages:
        raise ValueError("messages erforderlich")

    msgs_json = json.dumps(messages, ensure_ascii=False)
    prompt = TOK.apply_chat_template(msgs_json, add_generation_prompt=True)
    input_tokens = TOK.encode(prompt)

    p = OG.GeneratorParams(MODEL)
    p.set_search_options(**search_options(body, len(input_tokens), ARGS.max_tokens))

    gen = OG.Generator(MODEL, p)
    gen.append_tokens(input_tokens)
    stream = TOK.create_stream()
    n_in = gen.token_count()
    fragments = []
    while not gen.is_done():
        gen.generate_next_token()
        for tid in gen.get_next_tokens():
            frag = stream.decode(int(tid))
            if frag:
                fragments.append(frag)
    text = "".join(fragments)
    usage = {
        "prompt_tokens": n_in,
        "completion_tokens": gen.token_count() - n_in,
        "total_tokens": gen.token_count(),
    }
    return text, usage, iter(fragments)

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _health(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        body = json.dumps({"ok": True, "engine": "oga"}).encode()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._health()
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        pth = urlparse(self.path).path
        if pth != "/v1/chat/completions":
            self._json(404, {"error": {"message": "not found"}}); return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            self._json(400, {"error": {"message": "bad request: %s" % e}}); return

        stream = bool(body.get("stream"))
        try:
            with LOCK:
                text, usage, fragments = run_generation(body)
        except Exception as e:
            self.log_error("gen error: %s", e)
            self._json(500, {"error": {"message": str(e)}}); return

        if not stream:
            self._json(200, {
                "id": "chatcmpl-oga",
                "object": "chat.completion",
                "created": 0,
                "model": "onnx",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                             "finish_reason": "stop"}],
                "usage": usage,
            })
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        # HTTP/1.1 ohne Content-Length/chunked: nur das Verbindungs-EOF markiert
        # das Stream-Ende. Mit keep-alive haengt der Client nach [DONE] endlos.
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        try:
            for frag in fragments:
                if not frag:
                    continue
                chunk = json.dumps({
                    "id": "chatcmpl-oga", "object": "chat.completion.chunk",
                    "model": "onnx",
                    "choices": [{"index": 0, "delta": {"content": frag}, "finish_reason": None}],
                }, ensure_ascii=False)
                self.wfile.write(("data: %s\n\n" % chunk).encode())
                self.wfile.flush()
            if usage:
                d = json.dumps({"choices": [], "usage": usage}, ensure_ascii=False)
                self.wfile.write(("data: %s\n\n" % d).encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--port", type=int, default=9931)
    ap.add_argument("--ep", default="cpu")
    ap.add_argument("--max-tokens", type=int, default=2048)
    ARGS = ap.parse_args()
    log("Loading OGA model from", ARGS.model_dir, "ep=", ARGS.ep)
    global OG, MODEL, TOK
    try:
        OG, MODEL, TOK = load_model(ARGS.model_dir, ARGS.ep)
    except Exception as e:
        log("FATAL: model load failed:", e)
        sys.exit(2)
    log("Model ready.")
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    log("OGA server on port", ARGS.port)
    srv.serve_forever()

if __name__ == "__main__":
    main()
