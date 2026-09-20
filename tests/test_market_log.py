#!/usr/bin/env python3
"""Tests the Phase 1 market recorder against docs/DATA_DICTIONARY.md.

Three things are held hardest, because each is a promise the dictionary makes:
the rows conform to the documented schema, no row is keyed to a player, and
the derived liquidity numbers are measurements rather than the guess they
replace.
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import wynn_market_log as log  # noqa: E402

PASSED = 0
FAILED = 0


def test(name):
    def decorator(fn):
        global PASSED, FAILED
        scratch = tempfile.mkdtemp(prefix="wynn-scan-")
        os.environ["WYNN_SCAN_FILE"] = str(Path(scratch) / "market_scans.jsonl")
        log.reset_dedupe_state()
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


def listing(name, price, amount=1, seller=None, tier=None, shiny=False):
    return {
        "customName": name, "price": price, "amount": amount,
        "seller": seller, "tier": tier, "shiny": shiny,
    }


def market(listings, **extra):
    payload = {
        "open": True, "isMarket": True, "title": "Trade Market",
        "containerSlots": 54, "listings": listings,
    }
    payload.update(extra)
    return payload


print("Running market recorder tests...")


@test("A scan writes one market_scan and one observation per listing")
def _():
    scan = log.record_scan(market([
        listing("Spring", 12000, seller="Alice"),
        listing("Spring", 9000, seller="Bob"),
        listing("Wybel Paw", 800, amount=3, seller="Alice"),
    ]), session_id="s1", world="NA3", now=1000.0)

    assert scan is not None, "a market window with listings must be recorded"
    rows = log.read_rows()
    scans, observations = log.split_rows(rows)
    assert len(scans) == 1, scans
    assert len(observations) == 3, observations

    # Every field the dictionary promises, with the documented types.
    for field in ["scan_id", "ts", "session_id", "world", "query", "page",
                  "listing_count", "distinct_sellers", "container_slots"]:
        assert field in scans[0], f"market_scan is missing {field}"
    assert scans[0]["listing_count"] == 3
    assert scans[0]["distinct_sellers"] == 2, "Alice and Bob, counted once each"
    assert scans[0]["world"] == "NA3"

    for observation in observations:
        for field in ["scan_id", "ts", "item_key", "item_variant", "price",
                      "amount", "tier", "shiny", "listing_fingerprint"]:
            assert field in observation, f"listing_observation is missing {field}"
        assert isinstance(observation["price"], int), "prices are integer emeralds"
        assert isinstance(observation["amount"], int)
        assert observation["scan_id"] == scans[0]["scan_id"]


@test("No row is keyed to a player")
def _():
    log.record_scan(market([
        listing("Spring", 9000, seller="SomePlayer"),
        listing("Comet", 21000, seller="AnotherPlayer"),
    ]), now=1000.0)

    raw = Path(os.environ["WYNN_SCAN_FILE"]).read_text()
    assert "SomePlayer" not in raw, "a seller name reached the log"
    assert "AnotherPlayer" not in raw
    for row in log.read_rows():
        assert "seller" not in row, f"{row['type']} carries a seller field"
        # A fingerprint must not be a reversible stand-in for a name either.
        assert "SomePlayer".lower() not in json.dumps(row).lower()

    # The aggregate the depth measurement actually needs did survive.
    scans, _ = log.split_rows(log.read_rows())
    assert scans[0]["distinct_sellers"] == 2


@test("Item keys and variants normalise consistently")
def _():
    assert log.normalise_item_key("  Boreal-Patterned   Aegis ") == "boreal-patterned aegis"
    assert log.normalise_item_key("SPRING") == "spring"
    assert log.normalise_item_key(None) == ""
    assert log.item_variant("Spring", "Legendary", True) == "spring|legendary|shiny"
    assert log.item_variant("Spring") == "spring||"

    # The same listing fingerprints the same way; a different price does not.
    variant = log.item_variant("Spring", "Legendary", False)
    assert log.listing_fingerprint(variant, 9000, 1) == log.listing_fingerprint(variant, 9000, 1)
    assert log.listing_fingerprint(variant, 9000, 1) != log.listing_fingerprint(variant, 9001, 1)
    assert log.listing_fingerprint(variant, 9000, 1) != log.listing_fingerprint(variant, 9000, 2)


@test("An unchanged window is not logged twice, a changed one always is")
def _():
    window = market([listing("Spring", 9000, seller="Alice")])
    assert log.record_scan(window, now=1000.0) is not None
    assert log.record_scan(window, now=1005.0, min_interval=60) is None, \
        "the same contents moments later add nothing"
    assert log.record_scan(window, now=1100.0, min_interval=60) is not None, \
        "past the interval it is worth a fresh sample"

    changed = market([listing("Spring", 8500, seller="Alice")])
    assert log.record_scan(changed, now=1101.0, min_interval=60) is not None, \
        "a changed board is the event being measured, however recent the last scan"


@test("Nothing is recorded when there is no market to read")
def _():
    assert log.record_scan(None, now=1000.0) is None
    assert log.record_scan({"open": False}, now=1000.0) is None
    assert log.record_scan(market([], isMarket=True), now=1000.0) is None
    assert log.record_scan({"open": True, "isMarket": False, "listings": [
        listing("Spring", 9000)]}, now=1000.0) is None, "a bank is not a market"
    assert log.read_rows() == []


@test("Listing lifetimes are measured, and a vanished listing is bounded not counted")
def _():
    spring = listing("Spring", 9000, seller="Alice")
    other = listing("Spring", 12000, seller="Bob")
    day = 86400.0

    # Both on the board for three scans; the cheap one then vanishes.
    log.record_scan(market([spring, other]), now=day * 1)
    log.record_scan(market([spring, other, listing("Spring", 13000, seller="Cara")]), now=day * 2)
    log.record_scan(market([other]), now=day * 3)

    lifecycles = log.derive_lifecycles(log.read_rows())
    by_price = {l["listing_fingerprint"]: l for l in lifecycles}
    variant = log.item_variant("Spring")
    gone = by_price[log.listing_fingerprint(variant, 9000, 1)]
    stayed = by_price[log.listing_fingerprint(variant, 12000, 1)]

    assert gone["disappeared_ts"] == day * 3
    assert gone["lifetime_seconds"] == day * 2, gone
    assert gone["resolution"] == "sold_or_pulled", \
        "a client cannot tell a sale from a cancellation, and must not claim to"
    assert gone["was_cheapest"] is True

    assert stayed["disappeared_ts"] is None
    assert stayed["lifetime_seconds"] is None
    assert stayed["resolution"] == "still_listed"
    assert stayed["was_cheapest"] is True, \
        "it became the floor once the cheaper listing went, which is the point of tracking it"

    # Cara's listing was never the cheapest and never left.
    never_floor = by_price[log.listing_fingerprint(variant, 13000, 1)]
    assert never_floor["was_cheapest"] is False
    assert never_floor["first_seen_ts"] == day * 2


@test("A listing is only judged missing by a scan that would have shown it")
def _():
    day = 86400.0
    log.record_scan(market([listing("Spring", 9000)], query="Spring"), now=day)
    # A later scan of a different item says nothing about Spring.
    log.record_scan(market([listing("Comet", 21000)], query="Comet"), now=day * 2)

    spring = [l for l in log.derive_lifecycles(log.read_rows()) if l["item_key"] == "spring"][0]
    assert spring["disappeared_ts"] is None, \
        "scanning another item must not be read as Spring having sold"
    assert spring["resolution"] == "still_listed"


@test("Depth records the shape of supply and how the floor moved")
def _():
    log.record_scan(market([
        listing("Spring", 9000, seller="Alice"),
        listing("Spring", 12000, seller="Bob"),
        listing("Spring", 15000, seller="Cara"),
    ]), now=3600.0)
    log.record_scan(market([
        listing("Spring", 8000, seller="Dan"),
        listing("Spring", 12000, seller="Bob"),
    ]), now=7200.0)

    depth = [d for d in log.derive_depth(log.read_rows()) if d["item_key"] == "spring"]
    assert len(depth) == 2, depth
    first, second = depth

    assert (first["ask_min"], first["ask_p50"], first["ask_max"]) == (9000, 12000, 15000)
    assert first["listing_count"] == 3
    assert first["distinct_sellers"] == 3
    assert first["undercut_delta"] is None, "nothing to compare the first scan against"
    assert first["hour_of_day_utc"] == 1

    assert second["ask_min"] == 8000
    assert second["undercut_delta"] == -1000, "the floor was undercut by 1000"
    assert second["hour_of_day_utc"] == 2


@test("Observed hold time is measured, and absent rather than invented")
def _():
    day = 86400.0
    assert log.observed_hold_days(log.read_rows(), "Spring") is None, \
        "with nothing seen to sell, the caller must keep its own estimate"

    # Three listings that lasted one, two and three days.
    for index, price in enumerate([9000, 9100, 9200], start=1):
        log.record_scan(market([listing("Spring", price)]), now=day * index)
    log.record_scan(market([listing("Spring", 9999)]), now=day * 4)

    held = log.observed_hold_days(log.read_rows(), "Spring")
    assert held is not None and held > 0, held
    assert held <= 3.0, f"a hold time longer than the observation window is nonsense: {held}"
    assert log.observed_hold_days(log.read_rows(), "  SPRING  ") == held, \
        "the lookup normalises like every other item key"
    assert log.observed_hold_days(log.read_rows(), "Comet") is None


@test("A torn line does not cost the rest of the log")
def _():
    log.record_scan(market([listing("Spring", 9000)]), now=1000.0)
    with Path(os.environ["WYNN_SCAN_FILE"]).open("a") as handle:
        handle.write('{"type": "listing_observation", "ts": 10')  # crash mid-write
    log.reset_dedupe_state()
    log.record_scan(market([listing("Comet", 21000)]), now=2000.0)

    rows = log.read_rows()
    scans, observations = log.split_rows(rows)
    assert len(scans) == 2, "both good scans survive the broken line"
    assert {o["item_key"] for o in observations} == {"spring", "comet"}


@test("Retention prunes old rows and keeps recent ones")
def _():
    now = time.time()
    log.record_scan(market([listing("Old", 100)]), now=now - 120 * 86400)
    log.reset_dedupe_state()
    log.record_scan(market([listing("Fresh", 200)]), now=now - 86400)

    removed = log.prune(days=90)
    assert removed == 2, f"the old scan and its observation should go, removed={removed}"
    remaining = {o["item_key"] for o in log.split_rows(log.read_rows())[1]}
    assert remaining == {"fresh"}, remaining


@test("Reading a log that does not exist yet is empty, not an error")
def _():
    os.environ["WYNN_SCAN_FILE"] = "/nonexistent/dir/market_scans.jsonl"
    assert log.read_rows() == []
    assert log.derive_lifecycles([]) == []
    assert log.derive_depth([]) == []
    assert log.prune(days=1) == 0



# ---------------------------------------------------------------------------
# Rolls: what was actually on the board, not just what it was called
# ---------------------------------------------------------------------------
#
# A Wynncraft item is a family of goods - every drop rolls its identifications
# independently - so a price recorded against a name alone is an average over
# that family. These cover the recorder reading the roll off the listing's lore.

FIXTURE_DB = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "item_db_sample.json").read_text())
BY_NAME = {str(i["displayName"]).strip().lower(): i for i in FIXTURE_DB["items"]}


def market_with(lore, name="Idol", price=10000):
    return {
        "open": True, "isMarket": True, "containerSlots": 54,
        "listings": [{
            "slot": 10, "kind": "listing", "name": "bow", "customName": name,
            "price": price, "amount": 1, "tier": "Legendary", "shiny": False,
            "lore": lore,
        }],
    }


def only_observation(rows):
    return [r for r in rows if r["type"] == "listing_observation"][0]


@test("A listing's rolls are recorded from its lore")
def _():
    # Written out by hand, in the shape Wynncraft displays, so the labels are
    # an independent assertion rather than whatever the parser's own table says.
    scan = log.record_scan(market_with([
        "\u00a77Legendary Item",
        "\u00a78Combat Lv. Min: 103",
        "\u00a7a+55 Strength",
        "\u00a7c-12% Walk Speed",
        "\u00a7a+8/5s Mana Regen",
        "\u00a7a+1200 Health",
        "\u00a7aPrice: 1 le",
        "\u00a78Seller: Someone",
    ]), now=1000.0, min_interval=0)
    assert scan is not None

    observation = only_observation(log.read_rows())
    rolled = observation.get("identifications")
    assert rolled, "the roll was not recorded"
    assert rolled["rawStrength"] == 55.0, rolled
    assert rolled["walkSpeed"] == -12.0, rolled
    assert rolled["manaRegen"] == 8.0, rolled
    assert rolled["rawHealth"] == 1200.0, rolled
    # The price and the seller are not identifications.
    assert len(rolled) == 4, rolled


@test("The percentage and flat forms of one stat are not confused")
def _():
    # 29 identifications come in both forms sharing a display label. Scoring a
    # flat roll against a percentage range would not be a small error - the
    # ranges are different sizes, so the quality would be meaningless.
    log.record_scan(market_with([
        "\u00a7a+15% Spell Damage",
        "\u00a7a+240 Spell Damage",
        "\u00a7a+15% Health Regen",
        "\u00a7a+35 Health Regen",
    ]), now=1000.0, min_interval=0)

    rolled = only_observation(log.read_rows())["identifications"]
    assert rolled["spellDamage"] == 15.0, rolled
    assert rolled["rawSpellDamage"] == 240.0, rolled
    assert rolled["healthRegen"] == 15.0, rolled
    assert rolled["healthRegenRaw"] == 35.0, rolled


@test("Lore that yields no identifications leaves the field absent, not empty")
def _():
    # Absent means "nothing was read". An empty object would read as "we looked
    # and the item has no rolls", which is a different and wrong claim.
    log.record_scan(market_with([
        "\u00a77Legendary Item", "\u00a7aPrice: 1 le", "\u00a78Seller: Someone",
    ]), now=1000.0, min_interval=0)
    assert "identifications" not in only_observation(log.read_rows())


@test("Hostile or missing lore does not stop the scan being recorded")
def _():
    # The price log is the more important record: losing it because a lore line
    # was strange would be a far worse failure than losing the roll.
    for lore in ([], None, ["\u00a7\u00a7\u00a7"], ["x" * 5000], ["+ Strength"],
                 ["12"], ["+999999999999 Strength"]):
        log.reset_dedupe_state()
        scan = log.record_scan(market_with(lore, price=10000), now=1000.0, min_interval=0)
        assert scan is not None, f"a scan was dropped over lore: {lore!r}"


@test("Rolls are recorded raw; quality is only ever derived")
def _():
    # Scoring at record time would freeze the item database and the attribute
    # weights into the log, and both change underneath it.
    log.record_scan(market_with(["\u00a7a+55 Strength"]), now=1000.0, min_interval=0)
    observation = only_observation(log.read_rows())
    assert "identifications" in observation
    for derived in ("percentile", "quality_weighted", "quality_mean", "coverage"):
        assert derived not in observation, f"{derived} does not belong in an observation"


@test("Derived roll quality scores what it can and skips what it cannot")
def _():
    known = next(iter(BY_NAME.values()))
    name = known["displayName"]
    stat, spec = next(iter(
        (n, s) for n, s in __import__("wynn_item_db").rolled_specs(known).items()))

    import wynn_item_db as item_db
    label = next(lab for lab, forms in item_db._LORE_NAME_FORMS.items() if stat in forms)
    is_percent = item_db._LORE_NAME_FORMS[label][0] == stat
    value = spec["max"]
    lore = [f"\u00a7a{value:+g}{'%' if is_percent else ''} {label.title()}"]

    log.record_scan(market_with(lore, name=name), now=1000.0, min_interval=0)
    log.reset_dedupe_state()
    log.record_scan(market_with(lore, name="No Such Item Exists"), now=1100.0, min_interval=0)

    rows = log.read_rows()
    scored = log.derive_roll_quality(rows, BY_NAME)
    assert len(scored) == 1, f"only the known item should score: {scored}"
    assert scored[0]["item_key"] == name.strip().lower()
    # The best possible value for that stat, so quality is at the top.
    assert scored[0]["quality_max"] == 1.0, scored[0]
    assert scored[0]["n_rolled"] >= scored[0]["n_observed"] >= 1


@test("Training rows label each listing against its own item's median")
def _():
    known = next(iter(BY_NAME.values()))
    name = known["displayName"]
    for index, price in enumerate([8000, 10000, 12000]):
        log.reset_dedupe_state()
        log.record_scan(market_with(["\u00a7a+55 Strength"], name=name, price=price),
                        now=1000.0 + index * 100, min_interval=0)

    dataset = log.training_rows(log.read_rows(), BY_NAME)
    assert len(dataset) == 3, dataset
    labels = sorted(round(row["log_price_ratio"], 6) for row in dataset)
    import math as _math
    assert labels[0] == round(_math.log(0.8), 6), labels
    assert labels[1] == 0.0, labels
    assert labels[2] == round(_math.log(1.2), 6), labels
    assert all(row["rolled"] for row in dataset)


@test("An item seen at only one price teaches nothing and is left out")
def _():
    # Its own price is the median, so the label is zero by construction, and
    # feeding that in would teach the model that rolls do not move prices.
    known = next(iter(BY_NAME.values()))
    log.record_scan(market_with(["\u00a7a+55 Strength"], name=known["displayName"]),
                    now=1000.0, min_interval=0)
    assert log.training_rows(log.read_rows(), BY_NAME) == []


if FAILED:
    print(f"\n\033[1;31mMarket recorder tests: {PASSED} passed, {FAILED} failed.\033[0m")
    sys.exit(1)
print(f"\n\033[1;32mMarket recorder tests: {PASSED} passed.\033[0m")
