#!/usr/bin/env python3
"""The roll model: reading a rolled item, scoring it, and pricing it.

The claim this rests on is that Wynncraft's item database puts the *better*
roll in `max` and the worse one in `min`, in every sign quadrant - so quality is
`(rolled - min) / (max - min)` with no per-stat direction table. A direction
table is exactly the thing that rots when new identifications appear, so the
invariant is asserted here against real database entries rather than trusted.

tests/fixtures/item_db_sample.json holds 40 real items covering all four
quadrants. When the full database happens to be cached on this machine the
invariant is checked across all of it too; that check is a bonus, never a
requirement, because tests must not need the network.
"""

import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import wynn_item_db as item_db          # noqa: E402
import wynn_market_sim as market_sim    # noqa: E402
import wynn_trade_engine as engine      # noqa: E402

FIXTURE = REPO / "tests" / "fixtures" / "item_db_sample.json"


def load_fixture() -> dict[str, dict]:
    """The sample database, without touching the real cache or the network."""
    payload = json.loads(FIXTURE.read_text())
    return {str(i["displayName"]).strip().lower(): i for i in payload["items"]}


class RollArithmetic(unittest.TestCase):
    def setUp(self):
        self.by_name = load_fixture()
        self.items = list(self.by_name.values())

    def test_max_is_always_the_better_roll(self):
        """The invariant the whole module rests on, over real entries.

        Checked as: scoring the `min` end gives 0 and the `max` end gives 1,
        whichever way the numbers happen to be ordered. Four quadrants exist in
        the data - ordinary positives, penalties with a negative base, cost
        reductions where the ordering inverts, and spell-cost increases with a
        positive base and min > max - and all four must come out the same way.
        """
        quadrants = set()
        checked = 0
        for item in self.items:
            for name, spec in item_db.rolled_specs(item).items():
                self.assertEqual(item_db.roll_quality(spec["min"], spec), 0.0,
                                 f"{item['displayName']}.{name} min should score 0")
                self.assertEqual(item_db.roll_quality(spec["max"], spec), 1.0,
                                 f"{item['displayName']}.{name} max should score 1")
                raw = spec.get("raw") or 0
                quadrants.add(("pos" if raw > 0 else "neg",
                               "lt" if spec["min"] < spec["max"] else "gt"))
                checked += 1
        self.assertGreater(checked, 100, "the fixture should exercise a lot of specs")
        self.assertEqual(len(quadrants), 4,
                         f"the fixture must cover all four sign quadrants, got {sorted(quadrants)}")

    def test_invariant_holds_across_the_full_database_when_cached(self):
        """A bonus pass over all ~6,700 items, when one is already on disk."""
        if not item_db.ITEM_DB_FILE.exists():
            self.skipTest("full item database not cached; fixture covers the invariant")
        cached = json.loads(item_db.ITEM_DB_FILE.read_text())
        bad = []
        for item in cached["items"]:
            for name, spec in item_db.rolled_specs(item).items():
                if item_db.roll_quality(spec["min"], spec) != 0.0 or \
                   item_db.roll_quality(spec["max"], spec) != 1.0:
                    bad.append(f"{item.get('displayName')}.{name}")
        self.assertEqual(bad[:5], [], f"{len(bad)} specs broke the invariant")

    def test_quality_is_clamped_and_ordered(self):
        spec = {"min": 10, "raw": 20, "max": 30}
        self.assertEqual(item_db.roll_quality(10, spec), 0.0)
        self.assertEqual(item_db.roll_quality(30, spec), 1.0)
        self.assertAlmostEqual(item_db.roll_quality(20, spec), 0.5)
        # Wynncraft rounds what it displays, so a real roll can land just
        # outside the published range; that is not a reason to return 1.4.
        self.assertEqual(item_db.roll_quality(999, spec), 1.0)
        self.assertEqual(item_db.roll_quality(-999, spec), 0.0)
        self.assertIsNone(item_db.roll_quality(5, {"min": 7, "max": 7}))
        self.assertIsNone(item_db.roll_quality("nonsense", spec))

    def test_fixed_identifications_are_not_treated_as_rolls(self):
        """A plain integer is the same on every copy and says nothing."""
        item = {"identifications": {"rawStrength": 10,
                                    "walkSpeed": {"min": 1, "raw": 3, "max": 4}}}
        self.assertEqual(list(item_db.rolled_specs(item)), ["walkSpeed"])

    def test_every_identification_lands_in_a_group(self):
        names = {n for i in self.items for n in (i.get("identifications") or {})}
        self.assertGreater(len(names), 40)
        for name in names:
            self.assertIn(item_db.attribute_group(name), item_db.GROUP_NAMES)
        # Spell costs must not be swallowed by the raw-damage rule.
        self.assertEqual(item_db.attribute_group("raw3rdSpellCost"), "spell_cost")
        self.assertEqual(item_db.attribute_group("rawFireDamage"), "damage_raw")
        self.assertEqual(item_db.attribute_group("fireDamage"), "damage_pct")
        self.assertEqual(item_db.attribute_group("rawDefence"), "skill_points")
        self.assertEqual(item_db.attribute_group("fireDefence"), "defence")
        # Something Wynncraft adds later is weighted, not dropped.
        self.assertEqual(item_db.attribute_group("someFutureStat"), "utility")


class Percentile(unittest.TestCase):
    def test_single_attribute_percentile_is_exact(self):
        self.assertAlmostEqual(item_db.roll_percentile([0.85], [1.0]), 0.85)
        self.assertAlmostEqual(item_db.roll_percentile([0.10], [2.0]), 0.10)

    def test_the_same_quality_is_rarer_across_more_attributes(self):
        """The reason a plain average of roll percentages misleads.

        0.85 on one attribute is the 85th percentile. The same 0.85 held across
        five independent attributes is better than 99% of that item's drops, and
        scarcity is what gets paid for.
        """
        percentiles = [item_db.roll_percentile([0.85] * k, [1.0] * k) for k in (1, 2, 3, 5, 8)]
        self.assertAlmostEqual(percentiles[0], 0.85)
        for earlier, later in zip(percentiles, percentiles[1:]):
            self.assertGreater(later, earlier)
        self.assertGreater(percentiles[-1], 0.99)

    def test_a_median_roll_is_the_median_however_many_attributes(self):
        for k in (1, 2, 4, 7):
            self.assertAlmostEqual(item_db.roll_percentile([0.5] * k, [1.0] * k), 0.5, places=6)

    def test_zero_weighted_groups_drop_out(self):
        """A group weighted to zero must not drag the percentile toward 0.5."""
        both = item_db.roll_percentile([0.9, 0.1], [1.0, 1.0])
        only_first = item_db.roll_percentile([0.9, 0.1], [1.0, 0.0])
        self.assertAlmostEqual(only_first, 0.9)
        self.assertLess(both, only_first)

    def test_no_observations_is_not_a_bad_roll(self):
        self.assertEqual(item_db.roll_percentile([], []), 0.5)


class ScoreRoll(unittest.TestCase):
    def setUp(self):
        self.by_name = load_fixture()
        self.item = max(self.by_name.values(), key=lambda i: len(item_db.rolled_specs(i)))
        self.specs = item_db.rolled_specs(self.item)

    def rolled_at(self, fraction):
        return {n: s["min"] + fraction * (s["max"] - s["min"]) for n, s in self.specs.items()}

    def test_a_full_roll_scores_end_to_end(self):
        worst = item_db.score_roll(self.item, self.rolled_at(0.0))
        best = item_db.score_roll(self.item, self.rolled_at(1.0))
        self.assertAlmostEqual(worst["quality_weighted"], 0.0)
        self.assertAlmostEqual(best["quality_weighted"], 1.0)
        self.assertEqual(best["coverage"], 1.0)
        self.assertGreater(best["percentile"], worst["percentile"])

    def test_unreadable_attributes_lower_coverage_rather_than_quality(self):
        """A lore line the parser missed must not read as a terrible roll."""
        full = self.rolled_at(0.9)
        partial = dict(list(full.items())[:2])
        scored_full = item_db.score_roll(self.item, full)
        scored_partial = item_db.score_roll(self.item, partial)
        self.assertAlmostEqual(scored_partial["quality_weighted"], 0.9, places=6)
        self.assertLess(scored_partial["coverage"], scored_full["coverage"])
        self.assertEqual(scored_partial["n_observed"], 2)
        self.assertEqual(scored_partial["n_rolled"], scored_full["n_rolled"])

    def test_nothing_readable_scores_nothing(self):
        scored = item_db.score_roll(self.item, {})
        self.assertIsNone(scored["quality_weighted"])
        self.assertIsNone(scored["percentile"])
        self.assertEqual(scored["coverage"], 0.0)

    def test_weights_move_the_weighted_quality(self):
        rolled = {}
        groups = {}
        for name, spec in self.specs.items():
            group = item_db.attribute_group(name)
            groups.setdefault(group, []).append(name)
        # Give one group a good roll and everything else a bad one, then show
        # that weighting that group up raises the score.
        favoured = max(groups, key=lambda g: len(groups[g]))
        for name, spec in self.specs.items():
            good = item_db.attribute_group(name) == favoured
            rolled[name] = spec["min"] + (0.95 if good else 0.05) * (spec["max"] - spec["min"])

        low = item_db.score_roll(self.item, rolled, {**item_db.DEFAULT_GROUP_WEIGHTS, favoured: 0.1})
        high = item_db.score_roll(self.item, rolled, {**item_db.DEFAULT_GROUP_WEIGHTS, favoured: 3.0})
        self.assertGreater(high["quality_weighted"], low["quality_weighted"])


class LoreParsing(unittest.TestCase):
    def test_reads_identifications_and_ignores_the_rest(self):
        lore = [
            "§7Legendary Item",
            "§a+55 Strength",
            "§c-12% Walk Speed",
            "§a+8 Mana Regen [73%]",
            "§aPrice: 2 le 30 eb",
            "§8Seller: Someone",
            "§7Combat Lv. Min: 103",
            "flavour text with no number",
        ]
        found = item_db.parse_identification_lore(lore)
        self.assertEqual(found["rawStrength"], 55.0)
        self.assertEqual(found["walkSpeed"], -12.0)
        self.assertEqual(found["manaRegen"], 8.0)
        # Anything with a colon is a label, not a stat.
        self.assertNotIn("price", {k.lower() for k in found})
        self.assertEqual(len(found), 3)

    def test_hostile_lore_does_not_throw_or_invent_stats(self):
        for lore in ([], None, [""], ["§§§"], ["+999999999 Nonsense"], ["x" * 5000],
                     [None], [{"not": "a string"}], ["+ Strength"], ["12"]):
            found = item_db.parse_identification_lore(lore)
            self.assertIsInstance(found, dict)
            for value in found.values():
                self.assertIsInstance(value, float)
                self.assertFalse(math.isnan(value))


class EnginePricing(unittest.TestCase):
    """The roll model reaching an actual trading decision."""

    def setUp(self):
        self.by_name = load_fixture()
        self.item = max(self.by_name.values(), key=lambda i: len(item_db.rolled_specs(i)))
        self.specs = item_db.rolled_specs(self.item)
        now = 1_700_000_000
        self.points = [{"ts": now - 86400 * d, "lowest_price": 10000} for d in range(8, 0, -1)]
        self.live = {"lowest_price": 11000, "p50_price": 10000, "total_count": 12}

    def rolled_at(self, fraction):
        return {n: s["min"] + fraction * (s["max"] - s["min"]) for n, s in self.specs.items()}

    def test_no_model_means_the_engine_behaves_exactly_as_before(self):
        missing = Path(tempfile.gettempdir()) / "definitely-not-a-roll-model.json"
        self.assertIsNone(engine.load_roll_model(missing))
        self.assertIsNone(engine.roll_multiplier(None, self.item, self.rolled_at(0.9)))

        delta = engine.compute_delta("X", self.points, self.live, live_ask=11000)
        self.assertIsNotNone(delta)
        self.assertIsNone(delta["roll"])

    def test_a_corrupt_model_file_is_ignored_rather_than_raised(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            handle.write("{ not json")
            path = Path(handle.name)
        try:
            self.assertIsNone(engine.load_roll_model(path))
        finally:
            os.unlink(path)

    def test_an_unreadable_roll_is_not_priced_as_a_bad_one(self):
        model = self._tiny_model()
        self.assertIsNone(engine.roll_multiplier(model, self.item, {}))
        self.assertIsNone(engine.roll_multiplier(model, None, self.rolled_at(0.9)))

    def _tiny_model(self):
        """A model file built here, so the test needs no training run."""
        names = ["tier_ordinal", "log_level", "n_observed", "coverage",
                 "quality_weighted", "quality_max", "percentile", "percentile_sq"]
        # A single linear layer computing `2 * percentile - 1`, so the arithmetic
        # is checkable by hand: zero at a median roll, positive above it,
        # negative below. A hidden tanh layer here would clamp the output to
        # [0, 1] and quietly make a bad roll look like an average one.
        row = [0.0] * len(names)
        row[names.index("percentile")] = 2.0
        return {
            "version": 1, "calibration": "synthetic",
            "group_weights": item_db.DEFAULT_GROUP_WEIGHTS,
            "features": names,
            "log_ratio_range": [-0.8, 2.0],
            "standardizer": {"names": names, "mean": [0.0] * len(names),
                             "scale": [1.0] * len(names)},
            "mlp": {"layer_sizes": [len(names), 1], "weights": [[row]],
                    "biases": [[-1.0]]},
        }

    def test_the_hand_built_model_means_what_the_tests_assume(self):
        """Guards the fixture itself: a median roll must price at exactly 1x."""
        model = self._tiny_model()
        median = engine.roll_multiplier(model, self.item, self.rolled_at(0.5))
        self.assertAlmostEqual(median["log_ratio"], 0.0, places=6)
        self.assertAlmostEqual(median["multiplier"], 1.0, places=6)

    def test_a_good_roll_raises_fair_value_and_a_bad_one_lowers_it(self):
        model = self._tiny_model()
        good = engine.roll_multiplier(model, self.item, self.rolled_at(0.97))
        bad = engine.roll_multiplier(model, self.item, self.rolled_at(0.03))
        self.assertGreater(good["multiplier"], 1.0)
        self.assertLess(bad["multiplier"], 1.0)
        self.assertEqual(good["calibration"], "synthetic")

        priced_good = engine.compute_delta("X", self.points, self.live, live_ask=11000,
                                           roll_adjustment=good)
        priced_bad = engine.compute_delta("X", self.points, self.live, live_ask=11000,
                                          roll_adjustment=bad)
        blind = engine.compute_delta("X", self.points, self.live, live_ask=11000)

        self.assertGreater(priced_good["fair_value"], blind["fair_value"])
        self.assertLess(priced_bad["fair_value"], blind["fair_value"])
        # The point of the whole exercise: the same ask is a buy or a pass
        # depending on the roll, where before it was one answer for both.
        self.assertGreater(priced_good["roi"], priced_bad["roi"])
        self.assertEqual(priced_good["roll"]["calibration"], "synthetic")

    def test_prediction_is_bounded_by_what_the_model_was_trained_on(self):
        """An unbounded net asked about a roll better than anything it saw will
        invent a multiple nobody ever paid."""
        model = self._tiny_model()
        model["log_ratio_range"] = [-0.1, 0.2]
        capped = engine.roll_multiplier(model, self.item, self.rolled_at(1.0))
        self.assertLessEqual(capped["log_ratio"], 0.2 + 1e-9)
        self.assertTrue(capped["extrapolated"])

        inside = engine.roll_multiplier(model, self.item, self.rolled_at(0.5))
        self.assertFalse(inside["extrapolated"])


class Simulator(unittest.TestCase):
    def test_premium_is_zero_at_the_median_and_rises_with_the_roll(self):
        for tier in ("mythic", "legendary", "rare"):
            self.assertAlmostEqual(market_sim.roll_premium(0.5, tier), 0.0, places=9)
            self.assertGreater(market_sim.roll_premium(0.99, tier),
                               market_sim.roll_premium(0.75, tier))
            self.assertLess(market_sim.roll_premium(0.10, tier), 0.0)

    def test_rarer_tiers_are_priced_more_sharply_on_their_rolls(self):
        self.assertGreater(market_sim.roll_premium(0.95, "mythic"),
                           market_sim.roll_premium(0.95, "rare"))

    def test_a_generated_listing_is_internally_consistent(self):
        import random
        by_name = load_fixture()
        item = max(by_name.values(), key=lambda i: len(item_db.rolled_specs(i)))
        listing = market_sim.sample_listing(item, random.Random(1))
        self.assertEqual(listing["n_rolled_true"], len(item_db.rolled_specs(item)))
        self.assertLessEqual(len(listing["rolled"]), listing["n_rolled_true"])
        self.assertTrue(0.0 <= listing["true_percentile"] <= 1.0)
        for name, value in listing["rolled"].items():
            spec = item_db.rolled_specs(item)[name]
            self.assertTrue(min(spec["min"], spec["max"]) - 1e-9 <= value <= max(spec["min"], spec["max"]) + 1e-9)


if __name__ == "__main__":
    print("Running roll model tests...")
    unittest.main(verbosity=2)
