#!/usr/bin/env python3
"""Records Trade Market scans and derives liquidity measurements from them.

Implements four of the events in docs/DATA_DICTIONARY.md: ``market_scan`` and
``listing_observation`` are appended as the bot sees the market, and
``listing_lifecycle`` and ``market_depth`` are derived from them.

The point of the derivations is to replace a guess. ``estimate_hold_days()``
in wynn_trade_engine.py currently infers how long capital stays parked from
pool size and sample density; watching how long listings actually survive
measures it instead.

Scoped to prices. Seller names are needed momentarily to count how many
distinct sellers are competing on an item within one scan, and are discarded
at that point: no row written by this module is keyed to a player.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path

DATA_DIR = Path.home() / ".local" / "share" / "wynn-dashboard"
SCAN_FILE = DATA_DIR / "market_scans.jsonl"

# How often the same market window may be recorded. Lifetime resolution is
# bounded by this, and so is how often we re-read the market at all.
MIN_SCAN_INTERVAL_SECONDS = float(os.environ.get("WYNN_SCAN_INTERVAL", "60"))

# Rows older than this are outside the window seasonality needs.
SCAN_RETENTION_DAYS = float(os.environ.get("WYNN_SCAN_RETENTION_DAYS", "90"))

_write_lock = threading.Lock()
_last_scan: dict = {"signature": None, "ts": 0.0}


def scan_file() -> Path:
    """The log path, read per call so tests can redirect it."""
    return Path(os.environ["WYNN_SCAN_FILE"]) if os.environ.get("WYNN_SCAN_FILE") else SCAN_FILE


def normalise_item_key(name: str) -> str:
    """The join key across every source: lowercased, trimmed, spaces collapsed."""
    return re.sub(r"\s+", " ", str(name or "").strip()).lower()


def item_variant(name: str, tier=None, shiny: bool = False) -> str:
    """Item identity where price depends on tier or shininess."""
    parts = [normalise_item_key(name), normalise_item_key(tier) if tier else "", "shiny" if shiny else ""]
    return "|".join(parts)


def listing_fingerprint(variant: str, price, amount) -> str:
    """Tracks one listing across scans without recording who posted it.

    Two identical listings from different sellers collide by design: what the
    liquidity measurement cares about is that an offer at this price for this
    quantity was on the board, not whose it was.
    """
    raw = f"{variant}|{int(price)}|{int(amount or 1)}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def scan_signature(listings: list[dict]) -> str:
    """Content hash of a window, so an unchanged market is not logged twice."""
    parts = sorted(
        f"{normalise_item_key(l.get('customName') or l.get('name'))}:{l.get('price')}:{l.get('amount')}"
        for l in listings
        if (l.get("customName") or l.get("name")) and l.get("price")
    )
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]


def should_record(signature: str, now: float, last: dict | None = None,
                  min_interval: float | None = None) -> bool:
    """Whether this window is worth a row.

    Skipped when the same contents were logged inside the interval. A changed
    window is always recorded, however recently the last one was: a listing
    appearing and vanishing between scans is exactly the event being measured.
    """
    last = _last_scan if last is None else last
    interval = MIN_SCAN_INTERVAL_SECONDS if min_interval is None else min_interval
    if last.get("signature") != signature:
        return True
    return (now - float(last.get("ts") or 0)) >= interval


def record_scan(market: dict, session_id=None, world=None, now: float | None = None,
                min_interval: float | None = None) -> dict | None:
    """Appends one ``market_scan`` and its ``listing_observation`` rows.

    Returns the scan row, or None when there was nothing worth recording -
    no window open, not a market, or the same contents seen a moment ago.
    """
    if not market or not market.get("open") or not market.get("isMarket"):
        return None

    listings = [l for l in (market.get("listings") or []) if l.get("price")]
    if not listings:
        return None

    now = time.time() if now is None else now
    signature = scan_signature(listings)
    if not should_record(signature, now, min_interval=min_interval):
        return None

    # Counted here, discarded here: distinct_sellers is the aggregate the
    # depth measurement needs, and the names go no further.
    distinct_sellers = len({
        str(l.get("seller")).strip().lower()
        for l in listings
        if l.get("seller") and str(l.get("seller")).strip()
    })

    scan_id = hashlib.sha1(f"{now}|{signature}".encode()).hexdigest()[:16]
    scan = {
        "type": "market_scan",
        "scan_id": scan_id,
        "ts": now,
        "session_id": session_id,
        "world": world,
        "query": market.get("query"),
        "page": market.get("page"),
        "listing_count": len(listings),
        "distinct_sellers": distinct_sellers,
        "container_slots": market.get("containerSlots") or market.get("totalSlots"),
    }

    rows = [scan]
    for listing in listings:
        name = listing.get("customName") or listing.get("name")
        variant = item_variant(name, listing.get("tier"), bool(listing.get("shiny")))
        rows.append({
            "type": "listing_observation",
            "scan_id": scan_id,
            "ts": now,
            "item_key": normalise_item_key(name),
            "item_variant": variant,
            "price": int(listing["price"]),
            "amount": int(listing.get("amount") or 1),
            "tier": listing.get("tier"),
            "shiny": bool(listing.get("shiny")),
            "listing_fingerprint": listing_fingerprint(variant, listing["price"], listing.get("amount")),
        })

    path = scan_file()
    with _write_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        # A process killed mid-write leaves a line with no newline. Appending
        # straight onto it would glue a good row to a broken one and lose both,
        # so close the torn line first.
        if path.exists() and path.stat().st_size:
            with path.open("rb") as handle:
                handle.seek(-1, os.SEEK_END)
                unterminated = handle.read(1) != b"\n"
            if unterminated:
                with path.open("a") as handle:
                    handle.write("\n")
        with path.open("a") as handle:
            for row in rows:
                handle.write(json.dumps(row) + "\n")
        _last_scan["signature"] = signature
        _last_scan["ts"] = now

    return scan


def read_rows(days: float | None = None) -> list[dict]:
    """Every logged row, newest last. The one place that reads the scan log."""
    path = scan_file()
    if not path.exists():
        return []
    cutoff = 0.0 if days is None else time.time() - days * 86400
    rows = []
    with _write_lock:
        lines = path.read_text().splitlines()
    for line in lines:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue  # a torn final line must not lose the rest of the log
        if row.get("ts", 0) >= cutoff and row.get("type"):
            rows.append(row)
    rows.sort(key=lambda r: r.get("ts", 0))
    return rows


def split_rows(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    scans = [r for r in rows if r["type"] == "market_scan"]
    observations = [r for r in rows if r["type"] == "listing_observation"]
    return scans, observations


def derive_lifecycles(rows: list[dict]) -> list[dict]:
    """How long each listing stayed on the board.

    A listing is 'gone' once a later scan that covered its item does not show
    it. Whether it sold or was cancelled is not observable from a client, so
    ``resolution`` says ``sold_or_pulled`` and any sale rate built on this is
    an upper bound.
    """
    scans, observations = split_rows(rows)
    if not scans:
        return []

    scan_ts = {s["scan_id"]: s["ts"] for s in scans}
    ordered_scans = sorted(scans, key=lambda s: s["ts"])

    # Which items each scan covered, so a listing is only judged missing by a
    # scan that would have shown it.
    items_per_scan: dict[str, set] = {s["scan_id"]: set() for s in scans}
    by_fingerprint: dict[str, dict] = {}

    for observation in observations:
        scan_id = observation["scan_id"]
        if scan_id not in scan_ts:
            continue
        items_per_scan.setdefault(scan_id, set()).add(observation["item_key"])
        key = (observation["item_key"], observation["listing_fingerprint"])
        entry = by_fingerprint.setdefault(key, {
            "item_key": observation["item_key"],
            "listing_fingerprint": observation["listing_fingerprint"],
            "price": observation["price"],
            "first_seen_ts": observation["ts"],
            "last_seen_ts": observation["ts"],
            "seen_scans": set(),
        })
        entry["first_seen_ts"] = min(entry["first_seen_ts"], observation["ts"])
        entry["last_seen_ts"] = max(entry["last_seen_ts"], observation["ts"])
        entry["seen_scans"].add(scan_id)

    # The cheapest ask per item per scan, to mark which listing was the floor.
    floor_per_scan: dict[tuple, int] = {}
    for observation in observations:
        key = (observation["scan_id"], observation["item_key"])
        price = observation["price"]
        if key not in floor_per_scan or price < floor_per_scan[key]:
            floor_per_scan[key] = price

    lifecycles = []
    for entry in by_fingerprint.values():
        item = entry["item_key"]
        later_covering = [
            s for s in ordered_scans
            if s["ts"] > entry["last_seen_ts"] and item in items_per_scan.get(s["scan_id"], set())
        ]
        disappeared_ts = later_covering[0]["ts"] if later_covering else None
        was_cheapest = any(
            floor_per_scan.get((scan_id, item)) == entry["price"]
            for scan_id in entry["seen_scans"]
        )
        lifecycles.append({
            "item_key": item,
            "listing_fingerprint": entry["listing_fingerprint"],
            "first_seen_ts": entry["first_seen_ts"],
            "last_seen_ts": entry["last_seen_ts"],
            "disappeared_ts": disappeared_ts,
            "lifetime_seconds": (disappeared_ts - entry["first_seen_ts"]) if disappeared_ts else None,
            "was_cheapest": was_cheapest,
            "resolution": "sold_or_pulled" if disappeared_ts else "still_listed",
        })
    lifecycles.sort(key=lambda l: (l["item_key"], l["first_seen_ts"]))
    return lifecycles


def derive_depth(rows: list[dict]) -> list[dict]:
    """The shape of supply per item per scan, and how the floor moved."""
    scans, observations = split_rows(rows)
    scan_ts = {s["scan_id"]: s["ts"] for s in scans}
    scan_sellers = {s["scan_id"]: s.get("distinct_sellers", 0) for s in scans}

    grouped: dict[tuple, list[dict]] = {}
    for observation in observations:
        if observation["scan_id"] not in scan_ts:
            continue
        grouped.setdefault((observation["scan_id"], observation["item_key"]), []).append(observation)

    depth = []
    for (scan_id, item_key), group in grouped.items():
        prices = sorted(o["price"] for o in group)
        ts = scan_ts[scan_id]
        depth.append({
            "ts": ts,
            "item_key": item_key,
            "ask_min": prices[0],
            "ask_p50": prices[len(prices) // 2],
            "ask_max": prices[-1],
            "listing_count": len(group),
            # Per-scan, so it is the competition visible in that window.
            "distinct_sellers": scan_sellers.get(scan_id, 0),
            "undercut_delta": None,
            "hour_of_day_utc": int(time.gmtime(ts).tm_hour),
        })

    depth.sort(key=lambda d: (d["item_key"], d["ts"]))
    previous_floor: dict[str, int] = {}
    for row in depth:
        item = row["item_key"]
        if item in previous_floor:
            row["undercut_delta"] = row["ask_min"] - previous_floor[item]
        previous_floor[item] = row["ask_min"]
    return depth


def observed_hold_days(rows: list[dict], item_key: str) -> float | None:
    """Measured time on the board for an item, in days.

    The replacement for estimate_hold_days()'s guess. Returns None when no
    listing of this item has been seen to disappear yet - the caller should
    keep its estimate rather than treat silence as speed.
    """
    lifetimes = [
        l["lifetime_seconds"] for l in derive_lifecycles(rows)
        if l["item_key"] == normalise_item_key(item_key) and l["lifetime_seconds"]
    ]
    if not lifetimes:
        return None
    lifetimes.sort()
    median = lifetimes[len(lifetimes) // 2]
    return round(median / 86400, 4)


def prune(days: float | None = None) -> int:
    """Drops rows past the retention window. Returns how many were removed."""
    days = SCAN_RETENTION_DAYS if days is None else days
    path = scan_file()
    if not path.exists():
        return 0
    kept = read_rows(days)
    with _write_lock:
        before = len(path.read_text().splitlines())
        path.write_text("".join(json.dumps(row) + "\n" for row in kept))
    return max(0, before - len(kept))


def reset_dedupe_state() -> None:
    """Forgets the last-seen window. For tests and for a fresh session."""
    _last_scan["signature"] = None
    _last_scan["ts"] = 0.0
