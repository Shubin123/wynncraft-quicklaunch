#!/usr/bin/env python3
"""Legacy standalone price/trade API for offline compatibility and tests.

The supported runtime is the unified Node service in wynn_bot_server.js on
port 8123. This module remains as a Python reference/training harness, but it
never starts or proxies the bot server.

Keeps the Wynnventory API key server-side (never sent to the browser) and
gives the static page a same-origin /api/price endpoint to call, avoiding
Wynnventory's API not returning CORS headers for direct browser fetches.

Key is read, in order, from:
  1. WYNNVENTORY_API_KEY environment variable
  2. ~/.config/wynn-dashboard/wynnventory.key
"""
import json
import math
import os
import random
import sys
import threading
import time
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import wynn_market_log as market_log
import wynn_trade_engine as engine

DASHBOARD_DIR = Path(__file__).resolve().parent.parent / "dashboard"
KEY_FILE = Path.home() / ".config" / "wynn-dashboard" / "wynnventory.key"
DATA_DIR = Path.home() / ".local" / "share" / "wynn-dashboard"
HISTORY_FILE = DATA_DIR / "history.jsonl"
BANDIT_STATE_FILE = DATA_DIR / "bandit_state.json"
WATCHLIST_FILE = Path.home() / ".config" / "wynn-dashboard" / "watchlist.json"
API_BASE = "https://www.wynnventory.com/api"
PORT = int(os.environ.get("WYNN_DASHBOARD_PORT", "8123"))

STATIC_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
}

MARKET_FEE = 0.05  # Trade Market's listing fee, deducted from expected proceeds
# How much we trust a market estimate: variance shrinks as sqrt(total_count),
# so an item with 2 listings gets a much wider (more cautious) uncertainty
# band than one with 200 - this is the "small rarity pool" correction.
CONFIDENCE_REFERENCE_COUNT = 20

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


def get_cached_price(item: str, tier: str = "", shiny: str = ""):
    """Single source of truth for fetching+caching+logging a live price.

    Every caller (manual lookup, trend analysis, watchlist poll) goes
    through this so a burst of requests for the same item within
    CACHE_TTL_SECONDS produces exactly one upstream call and one logged
    history point, not one per call. Returns (status, body, cache_hit).
    """
    key = load_api_key()
    if not key:
        return 503, {"error": "no API key configured", "hint": f"set WYNNVENTORY_API_KEY or create {KEY_FILE}"}, False

    cache_key = f"{item.lower()}|{tier}|{shiny}"
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(cache_key)
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1], cached[2], True

    query = {}
    if tier:
        query["tier"] = tier
    if shiny:
        query["shiny"] = shiny
    encoded_item = urllib.parse.quote(item)
    path = f"trademarket/item/{encoded_item}/price"
    if query:
        path += "?" + urllib.parse.urlencode(query)

    status, body = _fetch_wynnventory(path, key)

    if status == 200:
        with _cache_lock:
            _cache[cache_key] = (now, status, body)
        record_snapshot(item, body)
    return status, body, False


def _get_cached_history_aggregate(item: str):
    key = load_api_key()
    if not key:
        return 503, {"error": "no API key configured"}
    cache_key = f"hist:{item.lower()}"
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(cache_key)
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1], cached[2]
    encoded = urllib.parse.quote(item)
    status, body = _fetch_wynnventory(f"trademarket/history/{encoded}/price", key)
    if status == 200:
        with _cache_lock:
            _cache[cache_key] = (now, status, body)
    return status, body


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


def read_history_rows() -> list[dict]:
    """Every recorded snapshot, parsed. The one place that reads the log."""
    if not HISTORY_FILE.exists():
        return []
    with _history_lock:
        lines = HISTORY_FILE.read_text().splitlines()
    rows = []
    for line in lines:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "item" in row:
            rows.append(row)
    return rows


def read_history(item: str, days: float = 30) -> list[dict]:
    cutoff = time.time() - days * 86400
    item_lower = item.lower()
    points = [row for row in read_history_rows()
              if row.get("item") == item_lower and row.get("ts", 0) >= cutoff]
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


def load_bandit_state() -> dict:
    if not BANDIT_STATE_FILE.exists():
        return {}
    try:
        return json.loads(BANDIT_STATE_FILE.read_text())
    except json.JSONDecodeError:
        return {}


def save_bandit_state(state: dict):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BANDIT_STATE_FILE.write_text(json.dumps(state, indent=2))


def record_outcome(item: str, sold: bool, realized_margin: float | None):
    """Bayesian update of an item's posterior from a real, manually-reported
    outcome (you actually listed it and it either sold or didn't). This is
    the only way the bandit's belief about an item improves beyond the raw
    market snapshot - nothing here is inferred automatically."""
    state = load_bandit_state()
    key = item.lower()
    entry = state.get(key, {"n_outcomes": 0, "n_sold": 0, "margin_sum": 0.0, "margin_sumsq": 0.0})

    entry["n_outcomes"] += 1
    if sold:
        entry["n_sold"] += 1
    if realized_margin is not None:
        entry["margin_sum"] += realized_margin
        entry["margin_sumsq"] += realized_margin ** 2

    state[key] = entry
    save_bandit_state(state)
    return entry


def estimate_item(item: str, price_body: dict, capital_remaining: float):
    """Combine today's market snapshot with any recorded real outcomes into
    one (mean, std, sell_probability) estimate for this item, honestly
    widening uncertainty when the listing pool (total_count) is small."""
    lowest = price_body.get("lowest_price")
    sell_ref = price_body.get("p50_price") or price_body.get("average_price") or lowest
    total_count = price_body.get("total_count") or 0

    if lowest is None or sell_ref is None or lowest <= 0:
        return None

    net_margin = sell_ref * (1 - MARKET_FEE) - lowest
    roi = net_margin / lowest

    # Market-only confidence: more listings seen today = more trust in the
    # snapshot. Capped at 1.0 so a huge pool doesn't imply false certainty.
    market_confidence = min(1.0, total_count / CONFIDENCE_REFERENCE_COUNT)
    base_std = abs(roi) * 0.5 + 0.05  # never fully certain, even at high confidence
    std = base_std / math.sqrt(max(market_confidence, 0.05) * CONFIDENCE_REFERENCE_COUNT)

    sell_probability = 0.5 + 0.4 * market_confidence  # naive prior: more listings, more liquid

    outcomes = load_bandit_state().get(item.lower())
    if outcomes and outcomes["n_outcomes"] > 0:
        n = outcomes["n_outcomes"]
        observed_sell_rate = outcomes["n_sold"] / n
        # Blend market prior with real observed outcomes, weighted by how
        # many real data points we actually have (small n -> mostly prior).
        weight_real = min(1.0, n / 5)
        sell_probability = (1 - weight_real) * sell_probability + weight_real * observed_sell_rate
        if outcomes["n_sold"] > 0 and outcomes["margin_sum"] != 0:
            observed_mean_margin = outcomes["margin_sum"] / outcomes["n_sold"]
            net_margin = (1 - weight_real) * net_margin + weight_real * observed_mean_margin
            std = std * (1 - weight_real * 0.5)  # real outcomes tighten the estimate somewhat

    # For gear items, lowest/p50/average can come from listings with very
    # different stat rolls, not just supply-and-demand - a huge spread often
    # means "someone listed a bad roll cheap and someone else a great roll
    # high," which you can't actually capture by buying low and reselling
    # high (you get whatever roll you bought). Flag it rather than trust it.
    roll_variance_warning = sell_ref > lowest * 3 and total_count < 30

    return {
        "item": item,
        "buy_cost": lowest,
        "sell_estimate": sell_ref,
        "net_margin": round(net_margin, 2),
        "roi": round(net_margin / lowest, 4),
        "total_count": total_count,
        "market_confidence": round(market_confidence, 2),
        "sell_probability": round(sell_probability, 2),
        "roll_variance_warning": roll_variance_warning,
        "_std": std,
        "affordable": lowest <= capital_remaining,
    }


def thompson_sample(estimate: dict) -> float:
    """One posterior draw of expected net margin, used to rank items for
    this run. Wider std (thin listing pool / little real feedback) means a
    noisier draw, so thin-pool items occasionally get explored rather than
    permanently ignored, without being blindly trusted either."""
    sampled_roi = random.gauss(estimate["roi"], estimate["_std"])
    value = sampled_roi * estimate["buy_cost"] * estimate["sell_probability"]
    if estimate.get("roll_variance_warning"):
        # Don't let an unverifiable roll-driven spread dominate the ranking;
        # still eligible to be picked, just not trusted at face value.
        value *= 0.3
    return value


def optimize_slots(estimates: list[dict], capital: float, slots: int) -> dict:
    """Greedy knapsack over one Thompson-sampled ranking: fill up to `slots`
    sell slots with distinct items, without exceeding `capital` total spend.
    This is advisory output only - it recommends what to buy and list, it
    does not buy or list anything itself."""
    scored = []
    for e in estimates:
        if not e["affordable"]:
            continue
        scored.append((thompson_sample(e), e))
    scored.sort(key=lambda pair: pair[0], reverse=True)

    picks = []
    remaining = capital
    for sampled_value, e in scored:
        if len(picks) >= slots:
            break
        if e["buy_cost"] > remaining:
            continue
        picks.append({**e, "sampled_expected_value": round(sampled_value, 2)})
        remaining -= e["buy_cost"]

    return {
        "capital": capital,
        "slots": slots,
        "picks": picks,
        "capital_spent": round(capital - remaining, 2),
        "capital_remaining": round(remaining, 2),
        "slots_filled": len(picks),
    }


# The bot server's address. Configurable so a non-default WYNN_BOT_PORT works,
# and so tests can point the dashboard at a stub (or at nothing at all).
BOT_SERVER_URL = os.environ.get(
    "WYNN_BOT_SERVER_URL",
    f"http://127.0.0.1:{os.environ.get('WYNN_PORT', os.environ.get('WYNN_BOT_PORT', '8123'))}"
).rstrip("/")


def fetch_live_listings(timeout: float = 2.0) -> dict[str, dict]:
    """Cheapest live ask per item, scraped from the bot's open Trade Market window.

    This is the third leg of the data join: Wynnventory tells us what an item is
    worth on average, the local history tells us where it has been going, and
    this tells us what it actually costs to buy right now, in front of the bot.
    Returns {} whenever the bot is offline or has no market window open, which
    is the normal case - callers fall back to Wynnventory's lowest listing.
    """
    try:
        with urllib.request.urlopen(f"{BOT_SERVER_URL}/api/bot/market", timeout=timeout) as resp:
            body = json.loads(resp.read())
    except Exception:
        return {}

    listings = body.get("listings") or []
    cheapest: dict[str, dict] = {}
    for listing in listings:
        name = (listing.get("customName") or listing.get("name") or "").strip()
        price = listing.get("price")
        if not name or not price:
            continue
        key = name.lower()
        current = cheapest.get(key)
        if current is None or price < current["price"]:
            cheapest[key] = {
                "item": name,
                "price": price,
                "amount": listing.get("amount"),
                "seller": listing.get("seller"),
                "slot": listing.get("slot"),
                "tier": listing.get("tier"),
            }
    return cheapest


def fetch_bot(path: str, timeout: float = 2.0):
    """One call to the bot server, or None when it is not running.

    Everything that reads the bot goes through here so a stopped bot server
    degrades the dashboard gracefully instead of failing a page.
    """
    try:
        with urllib.request.urlopen(f"{BOT_SERVER_URL}{path}", timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def build_state() -> dict:
    """One cheap snapshot of the whole system, for every dashboard page.

    Cheap is the constraint: this is polled every few seconds by whichever
    tabs are open, so it only reads local files and the local bot server.
    Anything that would call Wynnventory (prices, deltas, plans) stays on its
    own on-demand endpoint.
    """
    status = fetch_bot("/api/bot/status")
    market = fetch_bot("/api/bot/market")
    model = engine.MLP.load()
    watchlist = load_watchlist()

    bot = None
    if status:
        bot = {
            "connected": status.get("connected", False),
            "status": status.get("status"),
            "statusMessage": status.get("statusMessage"),
            "username": status.get("username"),
            "position": status.get("position"),
            "server": status.get("server"),
            "worldState": status.get("worldState"),
            "health": status.get("health"),
            "food": status.get("food"),
            "emeralds": status.get("emeralds"),
            "viewer": {
                "active": status.get("viewerActive", False),
                "url": status.get("viewerUrl"),
                "renderVersion": status.get("viewerRenderVersion"),
                "botVersion": status.get("viewerBotVersion"),
                "tracking": status.get("viewerTracking"),
            },
            "window": {
                "open": status.get("hasOpenWindow", False),
                "title": status.get("currentWindowTitle"),
                "id": status.get("currentWindowId"),
            },
        }

    market_state = None
    if market:
        listings = market.get("listings") or []
        # Record the window as Phase 1's market_scan / listing_observation.
        # Deduped and interval-limited inside the recorder, so polling /api/state
        # from several tabs does not fill the log. Never allowed to break the
        # snapshot: observation is a side benefit of the read, not its purpose.
        try:
            market_log.record_scan(market, world=(status or {}).get("server"))
        except Exception:
            pass
        # The cheapest live ask per item: the join key between what the bot can
        # see in game and what the price pages and the engine know about.
        cheapest: dict[str, dict] = {}
        for listing in listings:
            name = listing.get("customName") or listing.get("name")
            price = listing.get("price")
            if not name or not price:
                continue
            key = name.lower()
            if key not in cheapest or price < cheapest[key]["price"]:
                cheapest[key] = {
                    "item": name,
                    "price": price,
                    "slot": listing.get("slot"),
                    "amount": listing.get("amount"),
                    "seller": listing.get("seller"),
                    "tier": listing.get("tier"),
                }

        market_state = {
            "open": market.get("open", False),
            "isMarket": market.get("isMarket", False),
            "title": market.get("title"),
            "page": market.get("page"),
            "distance": market.get("distance"),
            "walking": market.get("walking", False),
            "locations": market.get("locations") or {},
            "listingCount": len(listings),
            "cheapest": cheapest,
            "listings": listings,
        }

    return {
        "ok": True,
        "ts": time.time(),
        "services": {
            "botServer": status is not None,
            "priceApi": load_api_key() is not None,
        },
        "bot": bot,
        "account": (status or {}).get("account"),
        "market": market_state,
        "engine": {
            "modelLoaded": model is not None,
            "layerSizes": model.layer_sizes if model else None,
            "features": engine.FEATURE_NAMES,
            "strategy": engine.load_strategy(),
            "marketFee": engine.MARKET_FEE,
        },
        "prices": {
            "watchlist": watchlist,
            "historyItems": sorted({row["item"] for row in read_history_rows()}),
        },
    }


def build_deltas(items: list[str], use_live: bool = True, days: float = 30,
                 model=None, strategy: dict | None = None) -> tuple[list[dict], list[dict]]:
    """Computes one delta per item, joining all three data sources."""
    live_listings = fetch_live_listings() if use_live else {}
    # One pass over the scan log for every item being priced, rather than
    # re-deriving every lifecycle per item.
    try:
        hold_stats = market_log.hold_statistics_by_item(market_log.read_rows(days))
    except Exception:
        hold_stats = {}
    deltas = []
    skipped = []
    for item in items:
        status, price_body, _ = get_cached_price(item)
        aggregate = price_body if status == 200 else None
        points = read_history(item, days)
        live_listing = live_listings.get(item.lower())
        live_ask = live_listing["price"] if live_listing else None

        if aggregate is None and not points and live_ask is None:
            skipped.append({"item": item, "reason": (price_body or {}).get("error", f"status {status}")})
            continue

        delta = engine.compute_delta(item, points, aggregate, live_ask, model, strategy,
                                     hold_stats.get(market_log.normalise_item_key(item)))
        if delta is None:
            skipped.append({"item": item, "reason": "not enough price data to value this item"})
            continue
        if live_listing:
            delta["live_listing"] = live_listing
        deltas.append(delta)
    return deltas, skipped


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
        if not load_api_key():
            continue
        for item in load_watchlist():
            get_cached_price(item)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep request logs quiet; nothing sensitive is logged anyway

    def _forward_to_bot_server(self, method, parsed):
        bot_url = f"{BOT_SERVER_URL}{self.path}"
        body = None
        if method == "POST":
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                if content_length > 0:
                    body = self.rfile.read(content_length)
            except Exception:
                body = None

        headers = {
            "Content-Type": self.headers.get("Content-Type", "application/json"),
            "Accept": self.headers.get("Accept", "*/*")
        }
        req = urllib.request.Request(bot_url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            # Bot server may be starting up
            self._json(503, {
                "ok": False,
                "error": f"WynnBot server unreachable at {BOT_SERVER_URL}",
                "details": str(e)
            })

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        safe_path = os.path.normpath(parsed.path).lstrip("/") or "index.html"
        file_path = (DASHBOARD_DIR / safe_path).resolve()
        if file_path.is_file() and (DASHBOARD_DIR.resolve() in file_path.parents or file_path == DASHBOARD_DIR.resolve()):
            content_type = "text/html" if file_path.suffix == ".html" else "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(file_path.stat().st_size))
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path.startswith("/api/bot/"):
            self._forward_to_bot_server("GET", parsed)
            return

        routes = {
            "/api/price": self._handle_price,
            "/api/trend": self._handle_trend,
            "/api/history_local": self._handle_history_local,
            "/api/watchlist": self._handle_watchlist_get,
            "/api/watch/add": self._handle_watch_add,
            "/api/watch/remove": self._handle_watch_remove,
            "/api/optimize": self._handle_optimize,
            "/api/state": self._handle_state,
            "/api/deltas": self._handle_deltas,
            "/api/plan": self._handle_plan,
            "/api/model/train": self._handle_model_train,
            "/api/model/status": self._handle_model_status,
            "/api/evolve": self._handle_evolve,
            "/api/record_outcome": self._handle_record_outcome,
        }
        handler = routes.get(parsed.path)
        if handler:
            handler(parsed)
            return

        self._serve_static(parsed.path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/bot/"):
            self._forward_to_bot_server("POST", parsed)
            return
        self.send_response(404)
        self.end_headers()

    def _handle_price(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        item = (params.get("item") or [""])[0].strip()
        if not item:
            self._json(400, {"error": "missing 'item' query param"})
            return

        tier = (params.get("tier") or [""])[0]
        shiny = (params.get("shiny") or [""])[0]
        status, body, cache_hit = get_cached_price(item, tier, shiny)
        self._json(status, body, cache_hit=cache_hit)

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
        # Both go through the same cache as manual lookups (get_cached_price
        # for live, a matching cache for the history aggregate) so repeated
        # /api/trend calls within CACHE_TTL_SECONDS don't hit the upstream API
        # or log duplicate snapshots each time.
        live_status, live_body, _ = get_cached_price(item)
        hist_status, hist_body = _get_cached_history_aggregate(item)
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

    def _candidate_items(self, params) -> list[str]:
        raw = (params.get("items") or [""])[0]
        items = [item.strip() for item in raw.split(",") if item.strip()]
        return items or load_watchlist()

    def _handle_state(self, parsed):
        """The shared snapshot every dashboard page reads."""
        self._json(200, build_state())

    def _handle_deltas(self, parsed):
        """Per-item edge: fair value (Wynnventory + local trend + model) vs the ask."""
        params = urllib.parse.parse_qs(parsed.query)
        items = self._candidate_items(params)
        if not items:
            self._json(400, {"error": "no candidate items - pass ?items=a,b,c or populate the watchlist"})
            return

        days = float((params.get("days") or ["30"])[0])
        use_live = (params.get("live") or ["1"])[0] != "0"
        model = engine.MLP.load()
        strategy = engine.load_strategy()

        deltas, skipped = build_deltas(items, use_live, days, model, strategy)
        deltas.sort(key=lambda d: d["score"], reverse=True)
        live_count = sum(1 for d in deltas if d["source"] == "live_listing")
        self._json(200, {
            "deltas": deltas,
            "skipped": skipped,
            "strategy": strategy,
            "model_loaded": model is not None,
            "live_listings_used": live_count,
            "market_fee": engine.MARKET_FEE,
        })

    def _handle_plan(self, parsed):
        """Turns the deltas into a capital allocation across sell slots."""
        params = urllib.parse.parse_qs(parsed.query)
        try:
            capital = float((params.get("capital") or ["32768"])[0])
            slots = int((params.get("slots") or ["6"])[0])
            days = float((params.get("days") or ["30"])[0])
        except ValueError:
            self._json(400, {"error": "capital must be a number (emeralds), slots an integer"})
            return

        items = self._candidate_items(params)
        if not items:
            self._json(400, {"error": "no candidate items - pass ?items=a,b,c or populate the watchlist"})
            return

        use_live = (params.get("live") or ["1"])[0] != "0"
        model = engine.MLP.load()
        strategy = engine.load_strategy()

        deltas, skipped = build_deltas(items, use_live, days, model, strategy)
        plan = engine.plan_liquidity(deltas, capital, slots, strategy)
        plan["skipped"] = plan["skipped"] + skipped
        plan["model_loaded"] = model is not None
        plan["live_listings_used"] = sum(1 for d in deltas if d["source"] == "live_listing")
        plan["candidates"] = len(deltas)
        self._json(200, plan)

    def _handle_model_train(self, parsed):
        """Trains the forward-return net on walk-forward samples from local history."""
        params = urllib.parse.parse_qs(parsed.query)
        try:
            horizon = float((params.get("horizon") or ["1"])[0])
            epochs = int((params.get("epochs") or ["300"])[0])
            hidden = int((params.get("hidden") or ["6"])[0])
            days = float((params.get("days") or ["90"])[0])
        except ValueError:
            self._json(400, {"error": "horizon/days must be numbers, epochs/hidden integers"})
            return

        items = self._candidate_items(params)
        samples = []
        per_item = {}
        for item in items:
            item_samples = engine.build_training_samples(read_history(item, days), horizon)
            per_item[item] = len(item_samples)
            samples.extend(item_samples)

        # Under ~20 samples a net this size just memorises noise; say so instead
        # of shipping a model that looks trained.
        if len(samples) < 20:
            self._json(400, {
                "error": f"only {len(samples)} walk-forward samples available; "
                         "keep the watchlist poller running to accumulate history first",
                "samples_per_item": per_item,
                "minimum_samples": 20,
            })
            return

        model = engine.MLP([len(engine.FEATURE_NAMES), hidden, 1], seed=1337)
        report = model.train(samples, epochs=epochs, learning_rate=0.02, seed=1337)
        model.save()
        self._json(200, {
            "ok": True,
            "model_file": str(engine.MODEL_FILE),
            "samples_per_item": per_item,
            "horizon_days": horizon,
            **report,
        })

    def _handle_model_status(self, parsed):
        model = engine.MLP.load()
        self._json(200, {
            "model_loaded": model is not None,
            "model_file": str(engine.MODEL_FILE),
            "layer_sizes": model.layer_sizes if model else None,
            "features": engine.FEATURE_NAMES,
            "strategy": engine.load_strategy(),
            "strategy_file": str(engine.STRATEGY_FILE),
            "strategy_bounds": engine.STRATEGY_BOUNDS,
        })

    def _handle_evolve(self, parsed):
        """Evolves the allocator's strategy parameters against a walk-forward backtest."""
        params = urllib.parse.parse_qs(parsed.query)
        try:
            generations = min(int((params.get("generations") or ["10"])[0]), 50)
            population = min(int((params.get("population") or ["12"])[0]), 40)
            capital = float((params.get("capital") or ["32768"])[0])
            slots = int((params.get("slots") or ["6"])[0])
            days = float((params.get("days") or ["90"])[0])
        except ValueError:
            self._json(400, {"error": "generations/population/slots must be integers"})
            return

        items = self._candidate_items(params)
        series_by_item = {item: read_history(item, days) for item in items}
        series_by_item = {item: points for item, points in series_by_item.items() if len(points) >= 4}
        if not series_by_item:
            self._json(400, {
                "error": "no item has at least 4 local history points yet; "
                         "the evolutionary search has nothing to score against",
                "items_checked": items,
            })
            return

        model = engine.MLP.load()
        result = engine.evolve_strategy(series_by_item, generations, population, model,
                                        capital, slots, seed=int(time.time()))
        baseline = engine.backtest_strategy(series_by_item, engine.DEFAULT_STRATEGY, model, capital, slots)
        best = engine.backtest_strategy(series_by_item, result["best_strategy"], model, capital, slots)

        saved = (params.get("save") or ["0"])[0] == "1"
        if saved:
            engine.save_strategy(result["best_strategy"])

        self._json(200, {
            **result,
            "items": list(series_by_item),
            "baseline_backtest": baseline,
            "best_backtest": best,
            "saved": saved,
            "strategy_file": str(engine.STRATEGY_FILE),
        })

    def _handle_optimize(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        try:
            capital = float((params.get("capital") or ["32768"])[0])  # default 8 LE
            slots = int((params.get("slots") or ["6"])[0])
        except ValueError:
            self._json(400, {"error": "capital must be a number (emeralds), slots an integer"})
            return

        items_param = (params.get("items") or [""])[0]
        candidates = [i.strip() for i in items_param.split(",") if i.strip()] or load_watchlist()
        if not candidates:
            self._json(400, {"error": "no candidate items - pass ?items=a,b,c or populate the watchlist first"})
            return

        estimates = []
        skipped = []
        for item in candidates:
            status, body, _ = get_cached_price(item)
            if status != 200:
                skipped.append({"item": item, "reason": body.get("error", f"status {status}")})
                continue
            est = estimate_item(item, body, capital)
            if est is None:
                skipped.append({"item": item, "reason": "incomplete price data"})
                continue
            estimates.append(est)

        result = optimize_slots(estimates, capital, slots)
        result["skipped"] = skipped
        result["candidates_considered"] = len(estimates)
        # drop the internal-only std field before returning
        for pick in result["picks"]:
            pick.pop("_std", None)
        self._json(200, result)

    def _handle_record_outcome(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        item = (params.get("item") or [""])[0].strip()
        if not item:
            self._json(400, {"error": "missing 'item' query param"})
            return
        sold = (params.get("sold") or ["false"])[0].lower() == "true"
        margin_param = (params.get("margin") or [None])[0]
        margin = float(margin_param) if margin_param not in (None, "") else None
        entry = record_outcome(item, sold, margin)
        self._json(200, {"item": item, "state": entry})

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

        try:
            # Browsers refuse to run a script served as application/octet-stream,
            # so the dashboard's own .js/.css need their real types.
            content_type = STATIC_CONTENT_TYPES.get(file_path.suffix.lower(), "application/octet-stream")
            payload = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status, payload, cache_hit=False):
        try:
            if cache_hit and isinstance(payload, dict):
                payload = {**payload, "_cached": True}
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    key_present = load_api_key() is not None
    print(f"Serving {DASHBOARD_DIR} on http://localhost:{PORT}")
    print(f"API key configured: {key_present}" + ("" if key_present else f" (create {KEY_FILE} or set WYNNVENTORY_API_KEY)"))

    threading.Thread(target=watchlist_poll_loop, daemon=True).start()
    ThreadingHTTPServer(("localhost", PORT), Handler).serve_forever()
