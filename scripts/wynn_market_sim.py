#!/usr/bin/env python3
"""A stated generative model of what a rolled item sells for.

Why this exists. Training needs prices of *rolled* items paired with their
rolls, and this project has none: `history.jsonl` is empty, Wynnventory needs
an API key that is not configured, and the market recorder does not yet read
identifications off a listing's lore. So there is no observed answer to "what
is a 95th-percentile Idol worth relative to a median one".

What is done about it. The roll machinery is built and checked against the
*real* item database - real items, real ranges, 6,700 of them - and the price
response is supplied here by an explicit generative model. That makes the
training run a **recovery experiment**: the simulator knows a set of group
weights and a premium curve, hides them, and the optimizer is asked to find
them from prices alone. Recovering them proves the pipeline can learn this
shape of thing. It proves nothing whatsoever about Wynncraft's actual prices,
and the artifact is stamped `calibration: "synthetic"` so nothing downstream
mistakes one for the other.

Every assumption is a named constant below. When real observations arrive the
simulator is not tuned to match them - it is replaced by them.
"""

from __future__ import annotations

import math
import random

import wynn_item_db as item_db


# --- assumptions ----------------------------------------------------------
#
# These are the things a real market would tell us and currently cannot. They
# are guesses, chosen to be plausible rather than precise, and their only job
# is to be hidden from the optimizer and then found again.

# What players actually pay for, by group. The optimizer does not see these.
TRUE_GROUP_WEIGHTS = {
    "skill_points": 2.5,   # gate what a build can equip at all
    "damage_pct": 2.0,
    "spell_cost": 1.8,     # build-defining when it lands
    "mana": 1.5,
    "health": 1.2,
    "sustain": 1.0,
    "damage_raw": 0.9,
    "defence": 0.8,
    "mobility": 0.6,
    "utility": 0.3,        # rarely why anyone buys an item
}

# A perfect roll is worth this multiple of a median roll, before tier scaling.
PERFECT_ROLL_MULTIPLE = 6.0

# How convex the premium is. Above 1 the curve is flat through the middle and
# steepens at the top, which is the shape collectors' markets usually take:
# nobody pays extra for the 60th percentile, everybody bids for the 99th.
PREMIUM_EXPONENT = 3.0

# Rarer items are priced more sharply on their rolls - a mythic's roll is the
# whole conversation, a rare's barely comes up.
TIER_ROLL_SENSITIVITY = {
    "mythic": 1.6, "fabled": 1.25, "legendary": 1.0,
    "rare": 0.6, "unique": 0.4, "set": 0.5, "normal": 0.2,
}

# Sellers are impatient, misprice, and round to convenient numbers. This is the
# irreducible noise the model should not be able to explain away.
PRICE_NOISE_SD = 0.22

# How often a listing's lore is only partly readable. Real lore carries colour
# codes, glyphs and line wrapping, and the parser will miss some of it.
PARTIAL_COVERAGE_RATE = 0.25


def roll_premium(percentile: float, tier: str) -> float:
    """Log premium of a roll over a median roll of the same item.

    Zero at the 50th percentile by construction, so the target is centred and a
    model that learns nothing predicts zero - which is exactly what the current
    engine does when it prices every copy of an item the same.
    """
    scale = math.log(PERFECT_ROLL_MULTIPLE) * TIER_ROLL_SENSITIVITY.get(tier, 0.5)
    shape = lambda p: p ** PREMIUM_EXPONENT
    return scale * (shape(percentile) - shape(0.5)) / (1.0 - shape(0.5))


def tradeable_items(by_name: dict[str, dict], min_rolled: int = 2) -> list[dict]:
    """Items worth simulating: ones that roll enough to have a roll worth paying for."""
    out = []
    for item in by_name.values():
        if item.get("tier") not in TIER_ROLL_SENSITIVITY:
            continue
        if len(item_db.rolled_specs(item)) < min_rolled:
            continue
        if item.get("type") in ("ingredient", "material", "tool"):
            continue
        out.append(item)
    return out


def sample_listing(item: dict, rng: random.Random) -> dict:
    """One dropped-and-listed copy: an independent roll per attribute, a price.

    The roll is uniform per attribute, which is how Wynncraft rolls. The price
    is the premium curve above applied to the *true* percentile - the one
    computed with the weights the optimizer is not allowed to see - plus noise.
    """
    specs = item_db.rolled_specs(item)
    rolled, qualities, weights = {}, [], []
    for name, spec in specs.items():
        quality = rng.random()
        low, high = float(spec["min"]), float(spec["max"])
        rolled[name] = low + quality * (high - low)
        qualities.append(quality)
        weights.append(TRUE_GROUP_WEIGHTS[item_db.attribute_group(name)])

    true_percentile = item_db.roll_percentile(qualities, weights)
    tier = item.get("tier", "unique")
    log_ratio = roll_premium(true_percentile, tier) + rng.gauss(0.0, PRICE_NOISE_SD)

    # What the lore parser actually manages to read. Attributes it misses are
    # absent, not zero, so the model sees a smaller sample and a lower coverage.
    observed = dict(rolled)
    if rng.random() < PARTIAL_COVERAGE_RATE and len(rolled) > 2:
        keep = rng.sample(sorted(rolled), rng.randint(2, len(rolled) - 1))
        observed = {k: rolled[k] for k in keep}

    return {
        "item": item.get("displayName"),
        "tier": tier,
        "level": (item.get("requirements") or {}).get("level", 1) or 1,
        "rolled": observed,
        "n_rolled_true": len(specs),
        "true_percentile": true_percentile,
        # The label: log price of this copy over a median-roll copy of the same
        # item. Item-relative on purpose - the price series model already
        # supplies the item's own level, and this only has to supply the
        # multiplier, which is what makes it learnable across items at all.
        "log_price_ratio": log_ratio,
    }


def build_dataset(by_name: dict[str, dict], n_items: int = 220, per_item: int = 14,
                  seed: int = 7) -> list[dict]:
    """A synthetic market: many items, many rolled copies of each."""
    rng = random.Random(seed)
    pool = tradeable_items(by_name)
    if not pool:
        raise ValueError("no tradeable items in the database")
    pool.sort(key=lambda i: str(i.get("displayName")))
    chosen = rng.sample(pool, min(n_items, len(pool)))

    listings = []
    for item in chosen:
        for _ in range(per_item):
            listings.append(sample_listing(item, rng))
    rng.shuffle(listings)
    return listings
