#!/usr/bin/env python3
"""External side of the bridge contract.

The game side (test_bridge_contract.js) proves the producer emits what
tests/contracts/market_listing.v1.json promises. This proves the Python
consumers read that shape: the live-ask join in wynn_price_server and the
scan recorder in wynn_market_log.

Both sides read the same file, so a field renamed on one side alone fails
here rather than silently yielding zero listings and stale prices.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import wynn_market_log as market_log  # noqa: E402

CONTRACT = json.loads((REPO / "tests" / "contracts" / "market_listing.v1.json").read_text())
SAMPLE = CONTRACT["sample_window"]

PASSED = 0
FAILED = 0


def test(name):
    def decorator(fn):
        global PASSED, FAILED
        scratch = tempfile.mkdtemp(prefix="wynn-contract-")
        os.environ["WYNN_SCAN_FILE"] = str(Path(scratch) / "market_scans.jsonl")
        market_log.reset_dedupe_state()
        try:
            fn()
            print(f"\033[32m✔ PASS:\033[0m {name}")
            PASSED += 1
        except AssertionError as exc:
            print(f"\033[31m✘ FAIL:\033[0m {name}\n  {exc}")
            FAILED += 1
        except Exception as exc:  # noqa: BLE001
            print(f"\033[31m✘ ERROR:\033[0m {name}\n  {type(exc).__name__}: {exc}")
            FAILED += 1
        finally:
            os.environ.pop("WYNN_SCAN_FILE", None)
        return fn
    return decorator


def cheapest_from(payload):
    """The live-ask join exactly as wynn_price_server.build_state computes it."""
    cheapest = {}
    for listing in payload.get("listings") or []:
        name = listing.get("customName") or listing.get("name")
        price = listing.get("price")
        if not name or not price:
            continue
        key = name.lower()
        if key not in cheapest or price < cheapest[key]["price"]:
            cheapest[key] = {"item": name, "price": price, "slot": listing.get("slot")}
    return cheapest


print("Running bridge contract tests (external side)...")


@test("The consumer finds every listing the contract sends")
def _():
    cheapest = cheapest_from(SAMPLE)
    for listing in SAMPLE["listings"]:
        key = listing["customName"].lower()
        assert key in cheapest, (
            f"{listing['customName']} did not survive the join. This is the silent "
            f"failure the contract exists for: the consumer sees no items and every "
            f"delta quietly falls back to a stale price."
        )
        assert cheapest[key]["price"] == listing["price"]


@test("The join key is the field the contract names, not a lookalike")
def _():
    # `name` is the Minecraft item id ("bow"); `customName` is what the player
    # reads ("Spring"). Joining on the wrong one matches nothing in Wynnventory.
    cheapest = cheapest_from(SAMPLE)
    assert "spring" in cheapest, "joined on the wrong field"
    assert "bow" not in cheapest, "joined on the Minecraft item id instead of the display name"


@test("A renamed field on the game side is caught, not absorbed")
def _():
    broken = json.loads(json.dumps(SAMPLE))
    for listing in broken["listings"]:
        listing["itemName"] = listing.pop("customName")  # the rename that would slip through

    cheapest = cheapest_from(broken)
    # The join falls back to `name`, so it does not crash - it quietly returns
    # the wrong keys, which is precisely why a contract test is needed.
    assert "spring" not in cheapest, "the fixture no longer models the failure"
    assert set(cheapest) == {"bow", "diamond_chestplate"}, cheapest

    required = set(CONTRACT["required_listing_fields"])
    for listing in broken["listings"]:
        missing = required - set(listing)
        assert missing, "a contract check that cannot fail is not a check"


@test("The recorder accepts the contract sample and writes conforming rows")
def _():
    scan = market_log.record_scan(SAMPLE, world="NA3", now=1000.0)
    assert scan is not None, "the recorder rejected a payload the contract says is valid"
    assert scan["listing_count"] == len(SAMPLE["listings"])
    assert scan["distinct_sellers"] == 2

    _, observations = market_log.split_rows(market_log.read_rows())
    assert len(observations) == len(SAMPLE["listings"])
    by_key = {o["item_key"]: o for o in observations}
    for listing in SAMPLE["listings"]:
        observation = by_key[listing["customName"].lower()]
        assert observation["price"] == listing["price"]
        assert observation["amount"] == listing["amount"]
        assert observation["shiny"] is listing["shiny"]


@test("Prices cross the boundary as whole emeralds, never as text")
def _():
    for listing in SAMPLE["listings"]:
        assert isinstance(listing["price"], int), (
            f"{listing['customName']} carries {type(listing['price']).__name__}; "
            "formatted prices must stay on the display side"
        )
        assert listing["price"] > 0
        assert "priceText" not in CONTRACT["required_listing_fields"], \
            "the text form is a convenience, never the number of record"


@test("Partial payloads across the boundary lose nothing they should keep")
def _():
    # A page mid-load, a search that matched one thing, a listing whose lore
    # the server truncated.
    partial = {
        "open": True, "isMarket": True, "title": "Trade Market", "containerSlots": 54,
        "listings": [
            {"slot": 10, "kind": "listing", "name": "bow", "customName": "Spring",
             "price": 9000, "amount": 1},
            {"slot": 11, "kind": "listing", "name": "unknown_item", "customName": "Thing",
             "price": 500, "amount": 1, "seller": None, "tier": None},
        ],
    }
    cheapest = cheapest_from(partial)
    assert set(cheapest) == {"spring", "thing"}, cheapest

    scan = market_log.record_scan(partial, now=2000.0)
    assert scan is not None
    assert scan["distinct_sellers"] == 0, "no seller named is zero sellers counted, not a crash"


@test("Junk crossing the boundary is dropped rather than recorded as a price")
def _():
    junk = {
        "open": True, "isMarket": True, "title": "Trade Market", "containerSlots": 54,
        "listings": [
            {"slot": 1, "customName": "Spring", "price": None, "amount": 1},
            {"slot": 2, "customName": "", "price": 9000, "amount": 1},
            {"slot": 3, "customName": "Real Item", "price": 9000, "amount": 1},
            {"slot": 4, "price": 500, "amount": 1},
        ],
    }
    cheapest = cheapest_from(junk)
    assert set(cheapest) == {"real item"}, cheapest

    market_log.record_scan(junk, now=3000.0)
    _, observations = market_log.split_rows(market_log.read_rows())
    assert [o["item_key"] for o in observations] == ["real item"], observations


@test("Both sides read the same contract file")
def _():
    assert CONTRACT["version"] == 1
    assert "market.js" in CONTRACT["producer"]
    assert any("wynn_price_server" in c for c in CONTRACT["consumers"])
    assert any("wynn_market_log" in c for c in CONTRACT["consumers"])

    js_test = (REPO / "tests" / "test_bridge_contract.js").read_text()
    assert "contracts/market_listing.v1.json" in js_test, \
        "the game side must be held to this same file"


if FAILED:
    print(f"\n\033[1;31mBridge contract tests (external side): {PASSED} passed, {FAILED} failed.\033[0m")
    sys.exit(1)
print(f"\n\033[1;32mBridge contract tests (external side): {PASSED} passed.\033[0m")
