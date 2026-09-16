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
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DASHBOARD_DIR = Path(__file__).resolve().parent.parent / "dashboard"
KEY_FILE = Path.home() / ".config" / "wynn-dashboard" / "wynnventory.key"
DATA_DIR = Path.home() / ".local" / "share" / "wynn-dashboard"
HISTORY_FILE = DATA_DIR / "history.jsonl"
WATCHLIST_FILE = Path.home() / ".config" / "wynn-dashboard" / "watchlist.json"
API_BASE = "https://www.wynnventory.com/api"
PORT = int(os.environ.get("WYNN_DASHBOARD_PORT", "8123"))

# Trade Market prices don't change fast enough to justify hitting the API on
# every keystroke/retry, and this is a shared personal dev key - being cheap
# with requests keeps it from looking like abuse.
CACHE_TTL_SECONDS = 300
MIN_UPSTREAM_INTERVAL_SECONDS = 1.5
# How often the background watchlist poller refreshes each watched item.
WATCHLIST_POLL_INTERVAL_SECONDS = 15 * 60

_cache: dict[str, tuple[float, int, dict]] = {}
_cache_lock = threading.Lock()
_last_upstream_call = 0.0
_rate_lock = threading.Lock()
_history_lock = threading.Lock()
_watchlist_lock = threading.Lock()


def _throttle():
    global _last_upstream_call
    with _rate_lock:
        wait = _last_upstream_call + MIN_UPSTREAM_INTERVAL_SECONDS - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_upstream_call = time.monotonic()


def load_api_key() -> str | None:
    env_key = os.environ.get("WYNNVENTORY_API_KEY")
    if env_key:
        return env_key.strip()
    if KEY_FILE.exists():
        return KEY_FILE.read_text().strip()
    return None


def _fetch_wynnventory(path: str, key: str):
    """One throttled, cached-free call to a Wynnventory endpoint. Returns (status, body_dict)."""
    url = f"{API_BASE}/{path}"
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Authorization": f"Api-Key {key}",
            "User-Agent": "wynncraft-quicklaunch-dashboard/1.0",
        },
    )
    _throttle()
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return 404, {"error": "not found"}
        return e.code, {"error": f"upstream error ({e.code})"}
    except Exception as e:
        return 502, {"error": f"request to Wynnventory failed: {e}"}


def record_snapshot(item: str, price_body: dict):
    """Append one timestamped price point to the local history log.

    This is the only source of real time-series data we have - Wynnventory's
    API itself only exposes point-in-time aggregates, not a history of past
    points. Every successful lookup (via the dashboard or the watchlist
    poller) grows this dataset a little, which is what the trend/regression
    endpoint below is computed from.
    """
    if not isinstance(price_body, dict) or "lowest_price" not in price_body:
        return
    row = {
        "ts": time.time(),
        "item": item.lower(),
        "lowest_price": price_body.get("lowest_price"),
        "highest_price": price_body.get("highest_price"),
        "average_price": price_body.get("average_price"),
        "p50_price": price_body.get("p50_price"),
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _history_lock:
        with HISTORY_FILE.open("a") as f:
            f.write(json.dumps(row) + "\n")


def read_history(item: str, days: float = 30) -> list[dict]:
    if not HISTORY_FILE.exists():
        return []
    cutoff = time.time() - days * 86400
    item_lower = item.lower()
    points = []
    with _history_lock:
        with HISTORY_FILE.open() as f:
            lines = f.readlines()
    for line in lines:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("item") == item_lower and row.get("ts", 0) >= cutoff:
            points.append(row)
    points.sort(key=lambda r: r["ts"])
    return points


def linear_regression(points: list[dict], metric: str = "lowest_price"):
    """Least-squares fit of `metric` over time. Returns None if too little data."""
    xs = []
    ys = []
    for p in points:
        v = p.get(metric)
        if v is None:
            continue
        xs.append(p["ts"])
        ys.append(v)

    n = len(xs)
    if n < 2:
        return None

    t0 = xs[0]
    xs_days = [(x - t0) / 86400 for x in xs]

    mean_x = sum(xs_days) / n
    mean_y = sum(ys) / n
    ss_xy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs_days, ys))
    ss_xx = sum((x - mean_x) ** 2 for x in xs_days)

    if ss_xx == 0:
        return None

    slope = ss_xy / ss_xx
    intercept = mean_y - slope * mean_x

    ss_tot = sum((y - mean_y) ** 2 for y in ys)
    if ss_tot == 0:
        r_squared = 1.0
    else:
        ss_res = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(xs_days, ys))
        r_squared = max(0.0, 1 - ss_res / ss_tot)

    last_day = xs_days[-1]
    span_days = xs_days[-1] - xs_days[0]

    if n < 5 or span_days < 1:
        confidence = "low"
    elif n < 15 or span_days < 3:
        confidence = "medium"
    else:
        confidence = "high"

    return {
        "metric": metric,
        "n": n,
        "span_days": round(span_days, 2),
        "slope_per_day": round(slope, 4),
        "r_squared": round(r_squared, 4),
        "confidence": confidence,
        "current_estimate": round(slope * last_day + intercept, 2),
        "projected_1d": round(slope * (last_day + 1) + intercept, 2),
        "projected_7d": round(slope * (last_day + 7) + intercept, 2),
    }


def load_watchlist() -> list[str]:
    with _watchlist_lock:
        if not WATCHLIST_FILE.exists():
            return []
        try:
            return json.loads(WATCHLIST_FILE.read_text())
        except json.JSONDecodeError:
            return []


def save_watchlist(items: list[str]):
    WATCHLIST_FILE.parent.mkdir(parents=True, exist_ok=True)
    with _watchlist_lock:
        WATCHLIST_FILE.write_text(json.dumps(sorted(set(items))))


def watchlist_poll_loop():
    """Background thread: periodically refresh each watched item so history
    accumulates even when nobody's actively using the dashboard. Reuses the
    same cache/throttle path as manual lookups, so it never adds pressure
    beyond one request per item per poll interval."""
    while True:
        time.sleep(WATCHLIST_POLL_INTERVAL_SECONDS)
        key = load_api_key()
        if not key:
            continue
        for item in load_watchlist():
            encoded = urllib.parse.quote(item)
            status, body = _fetch_wynnventory(f"trademarket/item/{encoded}/price", key)
            if status == 200:
                record_snapshot(item, body)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep request logs quiet; nothing sensitive is logged anyway

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        routes = {
            "/api/price": self._handle_price,
            "/api/trend": self._handle_trend,
            "/api/history_local": self._handle_history_local,
            "/api/watchlist": self._handle_watchlist_get,
            "/api/watch/add": self._handle_watch_add,
            "/api/watch/remove": self._handle_watch_remove,
        }
        handler = routes.get(parsed.path)
        if handler:
            handler(parsed)
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

        cache_key = f"{item.lower()}|{query.get('tier','')}|{query.get('shiny','')}"
        now = time.monotonic()
        with _cache_lock:
            cached = _cache.get(cache_key)
        if cached and now - cached[0] < CACHE_TTL_SECONDS:
            self._json(cached[1], cached[2], cache_hit=True)
            return

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
        _throttle()
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                body = json.loads(resp.read())
                status = resp.status
        except urllib.error.HTTPError as e:
            if e.code == 404:
                status, body = 404, {"error": f"no listings found for '{item}'"}
            else:
                status, body = e.code, {"error": f"upstream error ({e.code})"}
        except Exception as e:
            status, body = 502, {"error": f"request to Wynnventory failed: {e}"}

        if status == 200:
            with _cache_lock:
                _cache[cache_key] = (now, status, body)
            record_snapshot(item, body)
        self._json(status, body)

    def _handle_history_local(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        item = (params.get("item") or [""])[0].strip()
        if not item:
            self._json(400, {"error": "missing 'item' query param"})
            return
        days = float((params.get("days") or ["30"])[0])
        self._json(200, {"item": item, "points": read_history(item, days)})

    def _handle_trend(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        item = (params.get("item") or [""])[0].strip()
        if not item:
            self._json(400, {"error": "missing 'item' query param"})
            return
        metric = (params.get("metric") or ["lowest_price"])[0]
        days = float((params.get("days") or ["30"])[0])

        points = read_history(item, days)
        regression = linear_regression(points, metric)

        result = {"item": item, "regression": regression}

        # Wynnventory's own two aggregates (today vs a rolled-up recent
        # window) give an immediate directional signal even with zero local
        # history yet, while the regression above needs accumulated samples.
        key = load_api_key()
        if key:
            encoded = urllib.parse.quote(item)
            live_status, live_body = _fetch_wynnventory(f"trademarket/item/{encoded}/price", key)
            hist_status, hist_body = _fetch_wynnventory(f"trademarket/history/{encoded}/price", key)
            if live_status == 200:
                record_snapshot(item, live_body)
            if live_status == 200 and hist_status == 200:
                result["wynnventory_comparison"] = {
                    "today_avg": live_body.get("average_price"),
                    "recent_history_avg": hist_body.get("average_price"),
                    "recent_history_documents": hist_body.get("document_count"),
                }

        if regression is None and "wynnventory_comparison" not in result:
            self._json(404, {"error": f"no data available for '{item}' yet"})
            return

        self._json(200, result)

    def _handle_watchlist_get(self, parsed):
        self._json(200, {"watchlist": load_watchlist()})

    def _handle_watch_add(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        item = (params.get("item") or [""])[0].strip()
        if not item:
            self._json(400, {"error": "missing 'item' query param"})
            return
        items = load_watchlist()
        items.append(item)
        save_watchlist(items)
        self._json(200, {"watchlist": load_watchlist()})

    def _handle_watch_remove(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        item = (params.get("item") or [""])[0].strip().lower()
        items = [i for i in load_watchlist() if i.lower() != item]
        save_watchlist(items)
        self._json(200, {"watchlist": load_watchlist()})

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

    def _json(self, status, payload, cache_hit=False):
        if cache_hit and isinstance(payload, dict):
            payload = {**payload, "_cached": True}
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
    threading.Thread(target=watchlist_poll_loop, daemon=True).start()
    ThreadingHTTPServer(("localhost", PORT), Handler).serve_forever()
