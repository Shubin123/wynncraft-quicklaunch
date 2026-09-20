#!/usr/bin/env python3
"""Wynncraft's item database, and the roll arithmetic the price model needs.

A traded item is not one good. "Idol" is a *family* of goods: every drop rolls
each of its identifications independently, and two Idols can differ in price by
a multiple because one rolled well and the other did not. Every price feature
in `wynn_trade_engine.py` keys off the item name alone, which averages those
together and calls the result a price.

This module supplies the missing half. It reads the official item database -
`https://api.wynncraft.com/v3/item/database?fullResult`, 6,700-odd items - which
publishes, per identification, the range a roll can land in. From that it can
say how good a particular rolled item is, and, more usefully, how *rare* that
roll is.

Two facts about the data, both verified against the whole database in
tests/test_item_db.py rather than assumed:

1. **`max` is always the better roll and `min` always the worse one**, in every
   sign quadrant. Positive stats read `min < max` the obvious way. A penalty
   like `rawHealth: {min: -2340, raw: -1800, max: -1260}` still has the better
   roll in `max`. So does a cost reduction, where the ordering inverts
   numerically: `raw3rdSpellCost: {min: -1, raw: -3, max: -4}`. And so do the
   401 spell-cost *increases* that carry a positive raw with `min > max`.
   So quality is `(rolled - min) / (max - min)` everywhere, with no per-stat
   direction table to get wrong - which is the point, because a direction table
   is exactly the thing that rots silently when Wynncraft adds an identification.

2. **Not every identification rolls.** Of 29,783 identifications, 9,996 are
   plain integers: fixed, and no evidence about anything. Only the 19,787 that
   arrive as `{min, raw, max}` carry information about a particular drop.
"""

from __future__ import annotations

import json
import math
import re
import time
import urllib.request
from pathlib import Path

DATA_DIR = Path.home() / ".local" / "share" / "wynn-dashboard"
ITEM_DB_FILE = DATA_DIR / "item_db.json"
ITEM_DB_URL = "https://api.wynncraft.com/v3/item/database?fullResult"

# Refetch weekly. Wynncraft changes item stats on game updates, not hourly.
ITEM_DB_MAX_AGE_SECONDS = 7 * 24 * 3600


# ---------------------------------------------------------------------------
# Attribute groups
# ---------------------------------------------------------------------------
#
# 96 identifications is far too many to weight one by one: the market has
# nothing like enough observed prices to fit 96 coefficients, and a model that
# tried would fit noise. They are collapsed into ten groups that players
# actually trade on, and it is the group weights the optimizer searches.
#
# Group order is part of the model file format: never reorder, only append.

GROUP_NAMES = [
    "skill_points",   # the five attributes; gate what a build can equip at all
    "damage_pct",     # percentage damage, the usual scaling stat
    "damage_raw",     # flat damage, dominant at low levels and on some builds
    "defence",        # elemental and general damage reduction
    "health",         # health pool, regen, healing efficiency
    "mana",           # mana pool, regen, steal - the binding constraint on spellcasters
    "spell_cost",     # cost reductions; a build-defining stat when it lands
    "sustain",        # life steal and the like
    "mobility",       # walk speed, sprint, jump
    "utility",        # loot, xp, gathering; rarely what an item is bought for
]

_SKILL_POINTS = {"rawStrength", "rawDexterity", "rawIntelligence", "rawDefence", "rawAgility"}
_HEALTH = {"rawHealth", "healthRegen", "healthRegenRaw", "healingEfficiency"}
_MANA = {"manaRegen", "manaSteal", "rawMaxMana"}
_SUSTAIN = {"lifeSteal"}
_MOBILITY = {"walkSpeed", "sprint", "sprintRegen", "jumpHeight"}
_UTILITY = {
    "lootBonus", "lootQuality", "stealing", "combatExperience",
    "gatherSpeed", "gatherXpBonus", "gatheringExperience",
}
_MISC_OFFENCE = {
    "thorns", "reflection", "poison", "exploding", "knockback", "slowEnemy",
    "weakenEnemy", "mainAttackRange", "rawAttackSpeed", "criticalDamageBonus",
}


def attribute_group(name: str) -> str:
    """Which economic group an identification belongs to.

    Rules rather than a 96-line table, so an identification Wynncraft adds
    later lands somewhere sensible instead of vanishing. Order matters: spell
    costs are checked before damage, because `raw3rdSpellCost` would otherwise
    match the raw-damage rule.
    """
    if "SpellCost" in name:
        return "spell_cost"
    if name in _SKILL_POINTS:
        return "skill_points"
    if name in _HEALTH:
        return "health"
    if name in _MANA:
        return "mana"
    if name in _SUSTAIN:
        return "sustain"
    if name in _MOBILITY:
        return "mobility"
    if name in _UTILITY:
        return "utility"
    if name.endswith("Defence") or name == "elementalDefence":
        return "defence"
    if name in _MISC_OFFENCE:
        return "damage_pct"
    if name.startswith("raw") and "Damage" in name:
        return "damage_raw"
    if "Damage" in name or name == "damage":
        return "damage_pct"
    # Anything new and unrecognised is treated as utility: present, weighted,
    # but not assumed to be what someone paid for.
    return "utility"


# Neutral until something is learned. These are the optimizer's starting point,
# not a claim about what the market values.
DEFAULT_GROUP_WEIGHTS = {name: 1.0 for name in GROUP_NAMES}


# ---------------------------------------------------------------------------
# Loading the database
# ---------------------------------------------------------------------------

def fetch_item_db(url: str = ITEM_DB_URL, timeout: int = 60) -> list[dict]:
    """One call to the official item database. Raises on failure."""
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "wynncraft-quicklaunch-dashboard/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read())
    if isinstance(payload, dict):
        # The v3 endpoint has returned both a list and a name-keyed object
        # across versions; accept either and normalise to a list.
        payload = list(payload.values())
    if not isinstance(payload, list) or not payload:
        raise ValueError("item database response was not a non-empty list")
    return payload


def load_item_db(path: Path = ITEM_DB_FILE, refresh: bool = False,
                 max_age: float = ITEM_DB_MAX_AGE_SECONDS) -> dict[str, dict]:
    """The item database, keyed by lowercased display name.

    Cached on disk because it is six megabytes and changes on game updates, not
    between trades. A stale cache is preferred to a failed fetch: an item
    database from last week prices a roll far better than no database at all.
    """
    path = Path(path)
    cached = None
    if path.exists():
        try:
            cached = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            cached = None

    fresh_enough = (
        cached is not None
        and not refresh
        and (time.time() - cached.get("fetched_ts", 0)) < max_age
    )
    if not fresh_enough:
        try:
            items = fetch_item_db()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"fetched_ts": time.time(), "items": items}))
            cached = {"fetched_ts": time.time(), "items": items}
        except Exception:
            if cached is None:
                raise
            # Keep using what we have; being offline is not a reason to stop.

    by_name = {}
    for item in cached["items"]:
        name = item.get("displayName") or item.get("internalName")
        if name:
            by_name[str(name).strip().lower()] = item
    return by_name


# ---------------------------------------------------------------------------
# Roll arithmetic
# ---------------------------------------------------------------------------

def rolled_specs(item: dict) -> dict[str, dict]:
    """Only the identifications that actually roll, with their ranges.

    A fixed integer identification is the same on every copy of the item, so it
    says nothing about whether *this* copy is a good one.
    """
    specs = {}
    for name, value in (item.get("identifications") or {}).items():
        if isinstance(value, dict) and value.get("min") is not None and value.get("max") is not None:
            if value["min"] != value["max"]:
                specs[name] = value
    return specs


def roll_quality(rolled: float, spec: dict) -> float | None:
    """Where a rolled value sits in its range: 0.0 worst, 1.0 best.

    `max` is the better roll in every quadrant (see the module docstring), so
    this needs no knowledge of whether the stat is a bonus or a penalty.
    Clamped, because Wynncraft rounds displayed values and a legitimate roll can
    land a hair outside the published range.
    """
    try:
        low, high = float(spec["min"]), float(spec["max"])
        value = float(rolled)
    except (KeyError, TypeError, ValueError):
        return None
    if high == low:
        return None
    return max(0.0, min(1.0, (value - low) / (high - low)))


def _normal_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def roll_percentile(qualities: list[float], weights: list[float]) -> float:
    """How rare a roll this good is, among the rolls this item can produce.

    This is the feature that matters, and the reason a plain average of
    percentages misleads. Each attribute rolls roughly uniformly, so a weighted
    mean of k of them concentrates around 0.5 with standard deviation falling
    like 1/sqrt(k). A mean quality of 0.85 on a one-attribute item is simply the
    85th percentile. The same 0.85 across five attributes is about 2.7 standard
    deviations out - better than 99% of that item's drops. Identical "85%",
    wildly different scarcity, and it is scarcity that people pay for.

    Exact for a single attribute. For more it is a normal approximation to a
    weighted sum of uniforms, which is good in the middle and optimistic in the
    extreme tail; it is used as a ranking signal, not as a probability quoted to
    anyone.
    """
    pairs = [(q, w) for q, w in zip(qualities, weights) if w > 0]
    if not pairs:
        return 0.5
    if len(pairs) == 1:
        return pairs[0][0]

    total_weight = sum(w for _, w in pairs)
    mean_quality = sum(q * w for q, w in pairs) / total_weight
    # Var of a weighted mean of independent U(0,1) variables.
    variance = sum((w / total_weight) ** 2 for _, w in pairs) / 12.0
    if variance <= 0:
        return 0.5
    return _normal_cdf((mean_quality - 0.5) / math.sqrt(variance))


def score_roll(item: dict, rolled_values: dict[str, float],
               weights: dict[str, float] | None = None) -> dict:
    """Everything the price model wants to know about one rolled item.

    `rolled_values` is what the listing actually shows, by identification name.
    Attributes the item does not roll are ignored, and attributes it rolls that
    the listing does not mention are treated as unobserved rather than as zero -
    a lore line the parser missed must not read as a terrible roll.
    """
    weights = weights or DEFAULT_GROUP_WEIGHTS
    specs = rolled_specs(item)

    qualities, attr_weights, groups_seen = [], [], {}
    for name, spec in specs.items():
        if name not in rolled_values:
            continue
        quality = roll_quality(rolled_values[name], spec)
        if quality is None:
            continue
        group = attribute_group(name)
        weight = float(weights.get(group, 1.0))
        qualities.append(quality)
        attr_weights.append(weight)
        groups_seen.setdefault(group, []).append(quality)

    observed, rollable = len(qualities), len(specs)
    if not qualities:
        return {
            "quality_weighted": None, "quality_mean": None, "quality_max": None,
            "percentile": None, "n_rolled": rollable, "n_observed": 0,
            "coverage": 0.0, "group_quality": {},
        }

    total_weight = sum(attr_weights) or 1.0
    return {
        "quality_weighted": sum(q * w for q, w in zip(qualities, attr_weights)) / total_weight,
        "quality_mean": sum(qualities) / len(qualities),
        "quality_max": max(qualities),
        "percentile": roll_percentile(qualities, attr_weights),
        "n_rolled": rollable,
        "n_observed": observed,
        # How much of the item we actually got to look at. A roll scored from
        # two of six attributes deserves less confidence than one scored from
        # all six, and the model is given the number rather than left to guess.
        "coverage": observed / rollable if rollable else 0.0,
        "group_quality": {g: sum(v) / len(v) for g, v in groups_seen.items()},
    }


# ---------------------------------------------------------------------------
# Model features
# ---------------------------------------------------------------------------

# Tier order, low to high. Part of the model file format: never renumber.
TIER_ORDINAL = {
    "normal": 0, "unique": 1, "set": 2, "rare": 3,
    "legendary": 4, "fabled": 5, "mythic": 6,
}


def roll_features(tier: str | None, level: float | None, scored: dict) -> dict | None:
    """The feature row for one rolled listing.

    Lives here, next to the arithmetic it summarises, because both the trainer
    and the engine build it. Two copies of this function that drifted apart
    would train on one set of numbers and predict on another, which fails
    silently and looks like a bad model.
    """
    if scored.get("quality_weighted") is None:
        return None
    percentile = scored["percentile"]
    return {
        "tier_ordinal": TIER_ORDINAL.get(tier, 1),
        "log_level": math.log1p(float(level or 1)),
        "n_observed": float(scored["n_observed"]),
        "coverage": scored["coverage"],
        "quality_mean": scored["quality_mean"],
        "quality_max": scored["quality_max"],
        "quality_weighted": scored["quality_weighted"],
        "percentile": percentile,
        # The premium is convex in percentile, and a small tanh net fits a
        # convex curve far more readily when handed the square as well.
        "percentile_sq": percentile * percentile,
    }


# ---------------------------------------------------------------------------
# Reading rolls off a listing
# ---------------------------------------------------------------------------

# Wynncraft writes identifications into item lore as lines like
#   "+55 Strength", "-12% Walk Speed", "1200 Health", "+8/3s Mana Regen"
# The display names differ from the API's camelCase keys, so they are mapped
# back here. Only the ones that actually roll are worth the mapping.
_LORE_NAMES = {
    "strength": "rawStrength", "dexterity": "rawDexterity", "intelligence": "rawIntelligence",
    "defence": "rawDefence", "defense": "rawDefence", "agility": "rawAgility",
    "health": "rawHealth", "health regen": "healthRegen", "health regeneration": "healthRegen",
    "mana regen": "manaRegen", "mana regeneration": "manaRegen", "mana steal": "manaSteal",
    "life steal": "lifeSteal", "max mana": "rawMaxMana",
    "walk speed": "walkSpeed", "sprint": "sprint", "sprint regen": "sprintRegen",
    "jump height": "jumpHeight",
    "spell damage": "spellDamage", "main attack damage": "mainAttackDamage",
    "earth damage": "earthDamage", "thunder damage": "thunderDamage",
    "water damage": "waterDamage", "fire damage": "fireDamage", "air damage": "airDamage",
    "earth defence": "earthDefence", "thunder defence": "thunderDefence",
    "water defence": "waterDefence", "fire defence": "fireDefence", "air defence": "airDefence",
    "elemental defence": "elementalDefence", "elemental damage": "elementalDamage",
    "loot bonus": "lootBonus", "loot quality": "lootQuality", "stealing": "stealing",
    "xp bonus": "combatExperience", "combat xp bonus": "combatExperience",
    "poison": "poison", "thorns": "thorns", "reflection": "reflection",
    "exploding": "exploding", "healing efficiency": "healingEfficiency",
    "1st spell cost": "raw1stSpellCost", "2nd spell cost": "raw2ndSpellCost",
    "3rd spell cost": "raw3rdSpellCost", "4th spell cost": "raw4thSpellCost",
}

_LORE_LINE = re.compile(
    r"^\s*([+-]?\d+(?:\.\d+)?)\s*(%|/\d+s|/3s)?\s+(.+?)\s*$"
)


def parse_identification_lore(lines: list[str]) -> dict[str, float]:
    """Pulls rolled identifications out of a listing's lore.

    Deliberately forgiving: lore carries colour codes, glyphs, requirement
    lines, flavour text and the price, and anything that is not recognisably
    "<number> <known stat name>" is skipped rather than guessed at. A missed
    line costs coverage, which `score_roll` reports; a misread line would
    poison a price.
    """
    found: dict[str, float] = {}
    for line in lines or []:
        text = re.sub(r"§[0-9a-fk-or]", "", str(line)).strip()
        # Drop the bracketed roll percentage Wynncraft appends, e.g. "[73%]".
        text = re.sub(r"\[[^\]]*\]", "", text).strip()
        if not text or ":" in text:
            continue  # "Price: ...", "Seller: ..." and similar are not stats
        match = _LORE_LINE.match(text)
        if not match:
            continue
        number, _unit, label = match.groups()
        key = _LORE_NAMES.get(label.strip().lower())
        if not key:
            continue
        try:
            found[key] = float(number)
        except ValueError:
            continue
    return found
