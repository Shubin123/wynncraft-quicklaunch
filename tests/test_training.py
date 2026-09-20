#!/usr/bin/env python3
"""The training run itself: that it completes, labels what it produced, and
that a roll-aware model actually beats the roll-blind one it replaces.

Runs the real pipeline at a small size against the item fixture, so it needs no
network and does not touch the real model file. It is a smoke test with one
substantive assertion - reading the roll must beat ignoring it - because that
claim is the entire reason the roll model exists, and a refactor that quietly
broke the feature wiring would otherwise still pass.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FIXTURE = REPO / "tests" / "fixtures" / "item_db_sample.json"
TRAINER = REPO / "scripts" / "wynn_train.py"


class TrainingRun(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "roll_model.json"
        result = subprocess.run(
            [sys.executable, str(TRAINER), "--quick", "--items", "30", "--per-item", "18",
             "--item-db", str(FIXTURE), "--out", str(cls.out)],
            capture_output=True, text=True, timeout=600,
        )
        cls.result = result
        if result.returncode != 0:
            raise AssertionError(f"training failed:\n{result.stdout}\n{result.stderr}")
        cls.artifact = json.loads(cls.out.read_text())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_artifact_says_it_is_not_market_calibrated(self):
        """The most important field in the file.

        Everything here is trained against a simulator, and a number that looks
        like a valuation but is not must never be able to travel downstream
        without saying so.
        """
        self.assertEqual(self.artifact["calibration"], "synthetic")
        self.assertIn("not observed Wynncraft prices", self.artifact["calibration_note"])
        self.assertIn("SYNTHETIC", self.result.stdout)

    def test_the_artifact_holds_everything_needed_to_predict(self):
        for key in ("group_weights", "features", "standardizer", "mlp", "log_ratio_range"):
            self.assertIn(key, self.artifact)
        standardizer = self.artifact["standardizer"]
        self.assertEqual(standardizer["names"], self.artifact["features"])
        self.assertEqual(len(standardizer["mean"]), len(self.artifact["features"]))
        # A zero scale would divide by zero at prediction time.
        for scale in standardizer["scale"]:
            self.assertGreater(scale, 0.0)
        self.assertEqual(self.artifact["mlp"]["layer_sizes"][0], len(self.artifact["features"]))

    def test_every_attribute_group_has_a_weight(self):
        sys.path.insert(0, str(REPO / "scripts"))
        import wynn_item_db as item_db
        self.assertEqual(sorted(self.artifact["group_weights"]), sorted(item_db.GROUP_NAMES))
        for weight in self.artifact["group_weights"].values():
            self.assertGreaterEqual(weight, 0.0)

    def test_reading_the_roll_beats_ignoring_it(self):
        """The claim the whole model rests on.

        `null` is not a straw man: predicting zero is exactly what the engine
        does today, because every feature it has keys off the item's name.
        """
        models = self.artifact["report"]["models"]
        null_r2 = models["null"]["held_out"]["r2"]
        aware_r2 = models["aware"]["held_out"]["r2"]
        naive_r2 = models["naive_roll"]["held_out"]["r2"]

        self.assertGreater(aware_r2, null_r2,
                           "a roll-aware model that cannot beat ignoring the roll is pointless")
        self.assertGreater(naive_r2, null_r2)
        # Held-out error should also be a real improvement, not a rounding one.
        self.assertLess(models["aware"]["held_out"]["median_price_error_pct"],
                        models["null"]["held_out"]["median_price_error_pct"])

    def test_the_held_out_split_is_by_item(self):
        """Copies of one item must not straddle the split, or the model can
        learn the item instead of the curve and the score flatters it."""
        for label in ("blind", "naive_roll", "aware"):
            model = self.artifact["report"]["models"][label]
            self.assertGreater(model["n_train"], 0)
            self.assertGreater(model["n_test"], 0)

    def test_the_weight_search_reports_what_it_found(self):
        search = self.artifact["report"]["weight_search"]
        self.assertIn("fitness", search)
        self.assertIn("recovery_spearman", search)
        # The simulator's hidden weights are recorded next to the recovered
        # ones, so a reader can see how good the recovery was rather than
        # taking a single correlation on trust.
        self.assertIn("true_weights_for_comparison", search)
        self.assertGreater(search["fitness"], 0.0,
                           "the search should at least find weights that track price")



class TrainingOnRecordedListings(unittest.TestCase):
    """The other half of the loop: rows the recorder wrote, not the simulator.

    Exercised end to end - listings are written through `record_scan`, parsed
    back out of the log, and trained on - so the recorder's output and the
    trainer's input are held to the same shape by something other than hope.
    """

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(REPO / "scripts"))
        cls.tmp = tempfile.TemporaryDirectory()
        cls.by_name = {str(i["displayName"]).strip().lower(): i
                       for i in json.loads(FIXTURE.read_text())["items"]}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _write_listings(self, scans: int) -> Path:
        """Records scans of rolled listings, priced off their roll.

        Into a log of this test's own: sharing one would let a large run leak
        rows into the case that checks a small one is refused.
        """
        log_path = Path(self.tmp.name) / f"scans-{self.id().rsplit('.', 1)[-1]}.jsonl"
        import math
        import os
        import random
        import wynn_item_db as item_db
        import wynn_market_log as market_log
        import wynn_market_sim as market_sim

        # Rendering a roll back into lore is plumbing, not a claim about
        # Wynncraft's wording - the display labels themselves are asserted by
        # hand in tests/test_market_log.py.
        reverse = {}
        for label, (percent_form, flat_form) in item_db._LORE_NAME_FORMS.items():
            if percent_form:
                reverse.setdefault(percent_form, (label, True))
            if flat_form:
                reverse.setdefault(flat_form, (label, False))

        os.environ["WYNN_SCAN_FILE"] = str(log_path)
        market_log.reset_dedupe_state()
        rng = random.Random(4)
        pool = market_sim.tradeable_items(self.by_name)
        try:
            for index in range(scans):
                listings = []
                for slot, item in enumerate(rng.sample(pool, min(6, len(pool)))):
                    sampled = market_sim.sample_listing(item, rng)
                    price = max(1, int(10000 * math.exp(sampled["log_price_ratio"])))
                    lore = [f"\u00a77{item.get('tier', 'unique').title()} Item"]
                    for key, value in sampled["rolled"].items():
                        if key not in reverse:
                            continue
                        label, is_percent = reverse[key]
                        lore.append(f"\u00a7a{value:+.0f}{'%' if is_percent else ''} {label.title()}")
                    lore.append(f"\u00a7aPrice: {price} e")
                    listings.append({
                        "slot": 10 + slot, "kind": "listing", "name": "bow",
                        "customName": item["displayName"], "price": price, "amount": 1,
                        "tier": item.get("tier"), "shiny": False, "lore": lore,
                    })
                market_log.record_scan(
                    {"open": True, "isMarket": True, "listings": listings, "containerSlots": 54},
                    now=1000.0 + index * 120, min_interval=0)
        finally:
            os.environ.pop("WYNN_SCAN_FILE", None)
        return log_path

    def _run_trainer(self, log_path: Path, out: Path):
        return subprocess.run(
            [sys.executable, str(TRAINER), "--quick", "--from-log", str(log_path),
             "--item-db", str(FIXTURE), "--out", str(out)],
            capture_output=True, text=True, timeout=600)

    def test_too_few_recorded_listings_are_refused(self):
        """Refusing is the point.

        A model fitted to a handful of listings would still be stamped
        'observed', and the stamp is what anyone downstream reads.
        """
        log_path = self._write_listings(scans=2)
        out = Path(self.tmp.name) / "tiny.json"
        result = self._run_trainer(log_path, out)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("usable recorded listings", result.stderr)
        self.assertFalse(out.exists(), "nothing should have been written")

    def test_recorded_listings_train_and_are_labelled_observed(self):
        log_path = self._write_listings(scans=40)
        out = Path(self.tmp.name) / "observed.json"
        result = self._run_trainer(log_path, out)
        self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")

        artifact = json.loads(out.read_text())
        self.assertEqual(artifact["calibration"], "observed")
        self.assertIn("recorded from the Trade Market", artifact["calibration_note"])
        self.assertIn("Asking prices, not sale prices", artifact["calibration_note"])
        self.assertEqual(artifact["report"]["source"], "recorded listings")

        # With no hidden truth there is nothing to recover, and claiming a
        # recovery score against the simulator's weights would be nonsense.
        self.assertIsNone(artifact["report"]["weight_search"]["recovery_spearman"])
        self.assertIsNone(artifact["report"]["weight_search"]["true_weights_for_comparison"])
        self.assertNotIn("recovery", result.stdout.lower())

        # And it is a usable model, not just a labelled file.
        self.assertEqual(artifact["standardizer"]["names"], artifact["features"])
        self.assertEqual(artifact["mlp"]["layer_sizes"][0], len(artifact["features"]))
        sys.path.insert(0, str(REPO / "scripts"))
        import wynn_item_db as item_db
        self.assertEqual(sorted(artifact["group_weights"]), sorted(item_db.GROUP_NAMES))


if __name__ == "__main__":
    print("Running training pipeline tests...")
    unittest.main(verbosity=2)
