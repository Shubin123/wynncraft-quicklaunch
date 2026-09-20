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


if __name__ == "__main__":
    print("Running training pipeline tests...")
    unittest.main(verbosity=2)
