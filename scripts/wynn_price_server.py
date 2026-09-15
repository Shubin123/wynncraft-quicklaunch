#!/usr/bin/env python3
"""Local proxy + static server for the Wynncraft price dashboard.

Keeps the Wynnventory API key server-side (never sent to the browser) and
gives the static page a same-origin /api/price endpoint to call, avoiding
Wynnventory's API not returning CORS headers for direct browser fetches.

Key is read, in order, from:
  1. WYNNVENTORY_API_KEY environment variable
  2. ~/.config/wynn-dashboard/wynnventory.key
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DASHBOARD_DIR = Path(__file__).resolve().parent.parent / "dashboard"
KEY_FILE = Path.home() / ".config" / "wynn-dashboard" / "wynnventory.key"
API_BASE = "https://www.wynnventory.com/api"
PORT = int(os.environ.get("WYNN_DASHBOARD_PORT", "8123"))


def load_api_key() -> str | None:
    env_key = os.environ.get("WYNNVENTORY_API_KEY")
    if env_key:
        return env_key.strip()
    if KEY_FILE.exists():
        return KEY_FILE.read_text().strip()
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep request logs quiet; nothing sensitive is logged anyway

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/price":
            self._handle_price(parsed)
            return

        self._serve_static(parsed.path)

    def _handle_price(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        item = (params.get("item") or [""])[0].strip()
        if not item:
            self._json(400, {"error": "missing 'item' query param"})
            return

        key = load_api_key()
        if not key:
            self._json(
                503,
                {
                    "error": "no API key configured",
                    "hint": f"set WYNNVENTORY_API_KEY or create {KEY_FILE}",
                },
            )
            return

        query = {}
        if params.get("tier"):
            query["tier"] = params["tier"][0]
        if params.get("shiny"):
            query["shiny"] = params["shiny"][0]

        encoded_item = urllib.parse.quote(item)
        url = f"{API_BASE}/trademarket/item/{encoded_item}/price"
        if query:
            url += "?" + urllib.parse.urlencode(query)

        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "Authorization": f"Api-Key {key}",
                # Wynnventory's edge (Cloudflare) blocks the default
                # "Python-urllib/x.y" user agent as a bot signature.
                "User-Agent": "wynncraft-quicklaunch-dashboard/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                body = resp.read()
                self._json(resp.status, json.loads(body))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                self._json(404, {"error": f"no listings found for '{item}'"})
            else:
                self._json(e.code, {"error": f"upstream error ({e.code})"})
        except Exception as e:
            self._json(502, {"error": f"request to Wynnventory failed: {e}"})

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        safe_path = os.path.normpath(path).lstrip("/")
        file_path = (DASHBOARD_DIR / safe_path).resolve()

        if DASHBOARD_DIR.resolve() not in file_path.parents and file_path != DASHBOARD_DIR.resolve():
            self.send_response(403)
            self.end_headers()
            return

        if not file_path.is_file():
            self.send_response(404)
            self.end_headers()
            return

        content_type = "text/html" if file_path.suffix == ".html" else "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.end_headers()
        self.wfile.write(file_path.read_bytes())

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    key_present = load_api_key() is not None
    print(f"Serving {DASHBOARD_DIR} on http://localhost:{PORT}")
    print(f"API key configured: {key_present}" + ("" if key_present else f" (create {KEY_FILE} or set WYNNVENTORY_API_KEY)"))
    ThreadingHTTPServer(("localhost", PORT), Handler).serve_forever()
