#!/usr/bin/env python3
"""
onnx_server.py — OGA-OpenAI-Server fuer ModelHarbor.

Startet ein ONNX-Modell ueber ONNXRuntime GenAI (OGA) und bietet die
OpenAI-kompatible Oberflaeche, die die ModelHarbor-UI erwartet:
  GET  /health                       -> 200 (analog llama-server)
  GET  /v1/models                    -> Modellliste (Agenten fragen sie ab)
  POST /v1/chat/completions          -> JSON (stream=false) oder SSE (stream=true)

CLI:
  --model-dir <ordner mit genai_config.json>
  --port <port>
  --ep <cpu|cuda|dml|openvino>        (default: cpu; andere EP nur wenn installiert)
  --max-tokens <n>                    (default 2048; Obergrenze fuer neue Tokens)
  --cors-origins <*|localhost|liste>  (default: localhost, exakte Origin-Pruefung)
  --request-timeout <sekunden>        (Socket-Timeout, default 60)
  --api-key <key>                     (Fallback: Env MH_ONNX_API_KEY)

API-Key: bevorzugt ueber die Env-Variable MH_ONNX_API_KEY. Der Schalter
--api-key existiert fuer Handbaeufe, ist aber unsicherer: /proc/<pid>/cmdline
ist fuer alle lokalen Benutzer lesbar, die Env nur fuer den Eigentuemer.
ModelHarbor setzt deshalb die Env-Variable beim Start des Kindprozesses.

Abhaengigkeit: onnxruntime-genai im selben Python (venv), siehe
electron/backends.js (onnx-Backend).
"""
import argparse
import hmac
import json
import math
import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


def log(*a, **k):
    print(*a, **k, file=sys.stderr, flush=True)


# Modellname, den Agenten aufrufen — identisch zu MODEL_ALIAS in ui/server-snippets.js.
MODEL_ID = "ModelHarbor"
# Absolute Obergrenze fuer neue Tokens je Antwort (Schutz vor 1e6-Anfragen).
SERVER_MAX_NEW_TOKENS = 32768
# Maximaler Request-Body; Chatverlaeufe bleiben deutlich darunter.
MAX_BODY_BYTES = 8 * 1024 * 1024
# CORS-Default: nur echte Loopback-Origins statt '*'.
DEFAULT_CORS_MODE = "localhost"
# Socket-Timeout: haengende Clients blockieren keinen Thread unbegrenzt.
DEFAULT_REQUEST_TIMEOUT = 60.0
LOOPBACK_HOSTS = frozenset(("localhost", "127.0.0.1", "::1"))

ARGS = None
OG = None
MODEL = None
TOK = None
LOCK = threading.Lock()


class GenerationError(ValueError):
    """Fehlerhafte Anfrage -> HTTP 400 (nie 500, nie Traceback im Body)."""


def _as_int(name, value):
    """Ganzzahl erzwingen; alles andere ist ein Client-Fehler (400)."""
    if isinstance(value, bool):
        raise GenerationError("%s muss eine ganze Zahl sein" % name)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise GenerationError("%s muss eine ganze Zahl sein" % name)
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            raise GenerationError("%s muss eine ganze Zahl sein" % name)
    raise GenerationError("%s muss eine ganze Zahl sein" % name)


def _as_number(name, value):
    """Endliche Fliesskommazahl erzwingen (bool/NaN/inf sind ungueltig)."""
    if isinstance(value, bool):
        raise GenerationError("%s muss eine Zahl sein" % name)
    try:
        num = float(value)
    except (TypeError, ValueError):
        raise GenerationError("%s muss eine Zahl sein" % name)
    if not math.isfinite(num):
        raise GenerationError("%s muss eine endliche Zahl sein" % name)
    return num


def limit_max_tokens(default_max_tokens):
    """Serverlimit fuer neue Tokens: Konfiguration, hart auf das Gesamtlimit geklemmt."""
    try:
        limit = int(default_max_tokens)
    except (TypeError, ValueError):
        limit = 2048
    if limit < 1:
        limit = 2048
    return min(limit, SERVER_MAX_NEW_TOKENS)


def clamp_max_tokens(value, default_max_tokens):
    """Gewuenschte neue Tokens validieren und auf das Serverlimit klemmen (F12)."""
    limit = limit_max_tokens(default_max_tokens)
    if value is None:
        return limit
    n = _as_int("max_tokens", value)
    if n < 1:
        raise GenerationError("max_tokens muss mindestens 1 sein")
    return min(n, limit)


def normalize_messages(body):
    """messages pruefen; ein leerer Chat ist ein Client-Fehler, kein Serverfehler."""
    messages = body.get("messages")
    if not messages or not isinstance(messages, list):
        raise GenerationError("messages erforderlich")
    return messages


def search_options(body, prompt_len, default_max_tokens):
    """OGA-Suchoptionen aus dem Request bauen (rein, ohne OGA testbar).

    WICHTIG: `max_length` ist bei OGA die GESAMTlaenge (Prompt + neue Tokens),
    nicht die Anzahl neuer Tokens. Mit max_length = max_tokens wuerde ein langer
    Prompt die Antwort abschneiden oder ganz verhindern.
    `do_sample` darf nur bei temperature > 0 gesetzt sein, sonst ist das
    deterministische Preset (temp 0) nicht greedy.
    `max_tokens` wird validiert und geklemmt: `0`, `-5`, `3.9` und `'abc'`
    ergeben einen 400er, `1000000` wird auf das Serverlimit begrenzt.
    """
    max_new = clamp_max_tokens(body.get("max_tokens"), default_max_tokens)
    opts = {"max_length": int(prompt_len) + max_new}  # type: dict

    temperature = body.get("temperature")
    temp = None
    if temperature is not None:
        temp = _as_number("temperature", temperature)
        if temp < 0 or temp > 5:
            raise GenerationError("temperature muss zwischen 0 und 5 liegen")
        opts["temperature"] = temp
    if body.get("top_p") is not None:
        top_p = _as_number("top_p", body["top_p"])
        if not 0 < top_p <= 1:
            raise GenerationError("top_p muss groesser als 0 und hoechstens 1 sein")
        opts["top_p"] = top_p
    if body.get("top_k") is not None:
        top_k = _as_int("top_k", body["top_k"])
        if top_k < 0:
            raise GenerationError("top_k darf nicht negativ sein")
        opts["top_k"] = top_k
    opts["do_sample"] = temp is not None and temp > 0
    return opts


def validate_request(body):
    """Anfrage VOR dem Senden der Kopfzeilen pruefen (F12: 400 statt 500)."""
    if not isinstance(body, dict):
        raise GenerationError("JSON-Objekt erforderlich")
    normalize_messages(body)
    # Prompt-Laenge ist hier egal; geprueft werden nur die Sampling-Parameter.
    search_options(body, 0, getattr(ARGS, "max_tokens", 2048))


def _origin_key(origin):
    """(Schema, Host, Port) eines Origins — fuer den exakten Vergleich."""
    try:
        u = urlparse(origin)
        scheme = (u.scheme or "").lower()
        host = (u.hostname or "").lower()
        port = u.port
    except ValueError:
        return None
    if not scheme or not host:
        return None
    if port is None:
        port = 443 if scheme == "https" else 80 if scheme == "http" else None
    return (scheme, host, port)


def _is_loopback_origin(origin):
    """Nur echte Loopback-Origins: Schema http/https und Host exakt lokal."""
    try:
        u = urlparse(origin)
        scheme = (u.scheme or "").lower()
        host = (u.hostname or "").lower()
    except ValueError:
        return False
    if scheme not in ("http", "https"):
        return False
    return host in LOOPBACK_HOSTS


def origin_allowed(mode, origin):
    """CORS-Pruefung mit exaktem Origin-Vergleich (F10).

    `*` erlaubt alles. `localhost`/leer erlaubt nur Loopback-Origins (Schema
    http/https, Host exakt lokal) — anders als eine Substring-Suche laesst das
    `https://evil-localhost.attacker.example` NICHT durch. Eine eigene Liste
    wird Eintrag fuer Eintrag auf Gleichheit von Schema, Host und Port geprueft.
    Der opake Origin `null` (Sandbox-iframe, file://) wird immer abgelehnt.
    Ohne Origin-Header (CLI-Clients wie curl) gibt es keine CORS-Pruefung.
    """
    mode = (mode or DEFAULT_CORS_MODE).strip()
    if mode == "*":
        return True
    origin = (origin or "").strip()
    if not origin:
        return True
    if origin.lower() == "null":
        return False
    if mode in ("", "localhost"):
        return _is_loopback_origin(origin)
    wanted = _origin_key(origin)
    if wanted is None:
        return False
    for entry in mode.split(","):
        entry = entry.strip().rstrip("/")
        if not entry:
            continue
        if entry == "*":
            return True
        if _origin_key(entry) == wanted:
            return True
    return False


def bearer_matches(header_value, key):
    """Authorization-Header pruefen; das Schema ist case-insensitiv (RFC 6750, F15)."""
    if not key:
        return True
    if not header_value:
        return False
    parts = header_value.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    return hmac.compare_digest(parts[1].strip().encode(), key.encode())


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


def run_generation(body, emit=None):
    """Generation ausfuehren und jedes Fragment per `emit()` rausgeben.

    Der Modellzugriff (Prompt, Generator, Token-Schritt, Decode) laeuft unter
    LOCK und nur fuer einzelne Schritte; `emit` wird AUSSERHALB des Locks
    aufgerufen (F9). So kann ThreadingHTTPServer waehrend eines Streams weitere
    Requests bedienen, statt hinter der kompletten Antwort zu warten.
    Rueckgabe: usage-Dict.
    """
    messages = normalize_messages(body)
    msgs_json = json.dumps(messages, ensure_ascii=False)
    with LOCK:
        prompt = TOK.apply_chat_template(msgs_json, add_generation_prompt=True)
        input_tokens = TOK.encode(prompt)
        p = OG.GeneratorParams(MODEL)
        p.set_search_options(**search_options(body, len(input_tokens), ARGS.max_tokens))
        gen = OG.Generator(MODEL, p)
        gen.append_tokens(input_tokens)
        stream = TOK.create_stream()
        n_in = gen.token_count()
    try:
        while True:
            with LOCK:
                if gen.is_done():
                    break
                gen.generate_next_token()
                tokens = list(gen.get_next_tokens())
                fragments = [stream.decode(int(t)) for t in tokens]
            # Schreiben/Netzwerk ausserhalb des Locks.
            for frag in fragments:
                if frag and emit:
                    emit(frag)
    finally:
        with LOCK:
            total = gen.token_count()
    return {
        "prompt_tokens": n_in,
        "completion_tokens": total - n_in,
        "total_tokens": total,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Socket-Timeout aus der Konfiguration (F13): haengende Clients beenden.
    timeout = DEFAULT_REQUEST_TIMEOUT

    def log_message(self, *a):
        # Zugriffs-Log bewusst still: llama-server loggt Requests ebenfalls nicht.
        pass

    def _cors_mode(self):
        return getattr(ARGS, "cors_origins", DEFAULT_CORS_MODE) or DEFAULT_CORS_MODE

    def _origin_allowed(self):
        """Exakter Origin-Vergleich gegen die Allowlist (F10)."""
        return origin_allowed(self._cors_mode(), self.headers.get("Origin", ""))

    def _authorized(self):
        """Ohne konfigurierten Key ist alles offen — mit Key wird er auf /v1/* erzwungen."""
        return bearer_matches(self.headers.get("Authorization", ""), getattr(ARGS, "api_key", "") or "")

    def _cors_headers(self):
        mode = self._cors_mode()
        origin = (self.headers.get("Origin", "") or "").strip()
        if mode == "*":
            self.send_header("Access-Control-Allow-Origin", "*")
        else:
            self.send_header("Vary", "Origin")
            # Nur erlaubte Origins werden gespiegelt — sonst gar kein CORS-Header.
            if origin and origin_allowed(mode, origin):
                self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self._cors_headers()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError) as e:
            log("Antwort nicht zustellbar (%s): %s" % (code, e))
            self.close_connection = True

    def _error(self, code, message, err_type="invalid_request_error", err_code=None):
        err = {"message": message, "type": err_type}
        if err_code:
            err["code"] = err_code
        self._json(code, {"error": err})

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _health(self):
        body = json.dumps({"ok": True, "engine": "oga"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _models(self):
        """OpenAI-kompatible Modellliste (F15); Agenten fragen sie beim Start ab."""
        self._json(200, {
            "object": "list",
            "data": [{"id": MODEL_ID, "object": "model", "created": 0, "owned_by": "modelharbor"}],
        })

    def do_GET(self):
        pth = urlparse(self.path).path
        if pth == "/health":
            self._health()
            return
        if pth == "/v1/models":
            if not self._origin_allowed():
                self._error(403, "origin not allowed"); return
            if not self._authorized():
                self._error(401, "invalid or missing API key", err_code="invalid_api_key"); return
            self._models()
            return
        self._error(404, "not found")


    def _read_body(self):
        """Request-Body lesen. Rueckgabe (data, fehler) — fehler ist (code, text).

        F11: Es wird ausschliesslich Content-Length unterstuetzt. Bei
        `Transfer-Encoding: chunked` wurde vorher ein leerer Body gelesen und
        der Client bekam ein irrefuehrendes 500 'messages erforderlich';
        jetzt antwortet der Server mit 411 Length Required.
        """
        te = (self.headers.get("Transfer-Encoding") or "").strip().lower()
        if te and te != "identity":
            return None, (411, "Content-Length erforderlich (Transfer-Encoding '%s' wird nicht unterstuetzt)" % te)
        raw_len = self.headers.get("Content-Length")
        if raw_len is None or not raw_len.strip():
            return None, (411, "Content-Length erforderlich")
        try:
            length = int(raw_len.strip())
        except ValueError:
            return None, (400, "Content-Length ist keine Zahl")
        if length < 0:
            return None, (400, "Content-Length ist negativ")
        if length > MAX_BODY_BYTES:
            return None, (413, "Request-Body zu gross (maximal %d Bytes)" % MAX_BODY_BYTES)
        if length == 0:
            return b"", None
        try:
            data = self.rfile.read(length)
        except socket.timeout:
            return None, (408, "Zeitueberschreitung beim Lesen des Request-Body")
        except (BrokenPipeError, ConnectionResetError) as e:
            log("Verbindung beim Lesen des Body abgebrochen: %s" % e)
            return None, (400, "Verbindung abgebrochen")
        if len(data) < length:
            return None, (400, "Request-Body unvollstaendig")
        return data, None

    def do_POST(self):
        pth = urlparse(self.path).path
        if not self._origin_allowed():
            self._error(403, "origin not allowed"); return
        if not self._authorized():
            self._error(401, "invalid or missing API key", err_code="invalid_api_key"); return
        if pth != "/v1/chat/completions":
            self._error(404, "not found"); return
        data, err = self._read_body()
        if err is not None:
            # Body ist nicht gelesen/verworfen -> Verbindung schliessen,
            # damit kein Rest im Keep-Alive-Puffer bleibt.
            self.close_connection = True
            self._error(err[0], err[1]); return
        try:
            body = json.loads(data.decode("utf-8") or "{}")
        except (UnicodeDecodeError, ValueError) as e:
            self._error(400, "ungueltiges JSON: %s" % e); return
        try:
            validate_request(body)
        except GenerationError as e:
            self._error(400, str(e)); return
        if not body.get("stream"):
            self._completion(body)
        else:
            self._stream(body)

    def _completion(self, body):
        """Nicht-Streaming: alle Fragmente sammeln, dann eine JSON-Antwort."""
        parts = []
        try:
            usage = run_generation(body, parts.append)
        except GenerationError as e:
            self._error(400, str(e)); return
        except Exception as e:
            log("gen error: %s" % e)
            self._error(500, "interner Fehler bei der Generierung", err_type="server_error"); return
        self._json(200, {
            "id": "chatcmpl-oga",
            "object": "chat.completion",
            "created": 0,
            "model": MODEL_ID,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(parts)}, "finish_reason": "stop"}],
            "usage": usage,
        })

    def _stream(self, body):
        """Streaming: SSE-Kopfzeilen sofort, dann Fragmente ausserhalb des Locks (F9)."""
        self.close_connection = True  # Streamende per EOF, Client haengt nicht
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self._cors_headers()
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError) as e:
            log("Stream-Kopfzeilen nicht zustellbar: %s" % e)
            return

        def emit(frag):
            payload = json.dumps({
                "id": "chatcmpl-oga",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": MODEL_ID,
                "choices": [{"index": 0, "delta": {"content": frag}, "finish_reason": None}],
            }, ensure_ascii=False)
            self.wfile.write(("data: " + payload + "\n\n").encode("utf-8"))
            self.wfile.flush()

        try:
            usage = run_generation(body, emit)
        except GenerationError as e:
            log("Stream-Anfrage ungueltig: %s" % e)
            return
        except (BrokenPipeError, ConnectionResetError) as e:
            # F15: Abbruch wird protokolliert, nicht stumm verschluckt.
            log("Stream abgebrochen (Client weg): %s" % e)
            return
        except Exception as e:
            log("gen error: %s" % e)
            return
        if usage:
            payload = json.dumps({
                "id": "chatcmpl-oga",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": MODEL_ID,
                "choices": [],
                "usage": usage,
            }, ensure_ascii=False)
            try:
                self.wfile.write(("data: " + payload + "\n\n").encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError) as e:
                log("Stream-Nutzungsblock nicht zustellbar: %s" % e)
                return
        try:
            self.wfile.write(("data: [" + "DONE]" + "\n\n").encode("utf-8"))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError) as e:
            log("Stream-Abschluss nicht zustellbar: %s" % e)


def build_arg_parser():
    """CLI des Servers (eigene Funktion, damit Tests die Flags pruefen koennen)."""
    ap = argparse.ArgumentParser(prog="onnx_server.py", description="ONNX/GenAI-Server fuer ModelHarbor")
    ap.add_argument("--model-dir", required=True, help="Ordner mit genai_config.json")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9931)
    ap.add_argument("--ep", default="cpu", help="execution provider (cpu, cuda, dml, ...)")
    ap.add_argument("--max-tokens", type=int, default=2048, help="Obergrenze fuer neue Tokens je Antwort")
    ap.add_argument("--cors-origins", default=DEFAULT_CORS_MODE,
                    help="'*' = alle Origins, 'localhost' = nur Loopback, sonst exakte Origin-Liste")
    ap.add_argument("--request-timeout", type=float, default=DEFAULT_REQUEST_TIMEOUT,
                    help="Socket-Timeout in Sekunden")
    ap.add_argument("--api-key", default=None,
                    help="API-Key fuer /v1/*; bevorzugt ueber die Env MH_ONNX_API_KEY setzen")
    return ap


def resolve_api_key(cli_key):
    """API-Key aus --api-key oder der Env-Variable MH_ONNX_API_KEY (F13).

    Das Flag fehlte bisher, obwohl die Doku es nannte. Es bleibt gegenueber der
    Env-Variable die schlechtere Wahl: /proc/<pid>/cmdline ist fuer alle lokalen
    Benutzer lesbar, die Env nur fuer den Eigentuemer. ModelHarbor setzt die Env.
    """
    env_key = os.environ.get("MH_ONNX_API_KEY", "") or ""
    if cli_key:
        if cli_key != env_key:
            log("WARNUNG: --api-key steht in der Kommandozeile (/proc/<pid>/cmdline) und ist "
                "fuer andere lokale Benutzer lesbar; MH_ONNX_API_KEY ist der sichere Weg.")
        return cli_key
    return env_key


def main(argv=None):
    global ARGS, OG, MODEL, TOK
    ARGS = build_arg_parser().parse_args(argv)
    ARGS.api_key = resolve_api_key(ARGS.api_key)
    Handler.timeout = ARGS.request_timeout  # F13: Socket-Timeout fuer alle Verbindungen
    if not ARGS.api_key:
        log("WARNUNG: kein API-Key gesetzt — /v1/* ist fuer jeden erreichbaren Client offen.")
    try:
        OG, MODEL, TOK = load_model(ARGS.model_dir, ARGS.ep)
    except Exception as e:
        log("FATAL: model load failed:", e)
        sys.exit(2)
    log("ONNX-Server: model=%s ep=%s cors=%s timeout=%.0fs" % (MODEL_ID, ARGS.ep, ARGS.cors_origins, ARGS.request_timeout))
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
