#!/usr/bin/env python3
"""Trains the roll model: what a particular rolled copy is worth, relative to a
median copy of the same item.

The split of labour matters more than the machinery. The existing engine models
an item's price *series* and answers "what is an Idol worth". It has no way to
ask "what is *this* Idol worth", because every feature it has keys off the name.
This trains the missing multiplier:

    value(this copy) = value(the item)  x  exp(roll_model(this copy's roll))

Keeping the target item-relative is what makes it learnable at all. An absolute
price model would need enough observations per item to pin down each item's own
level; a multiplier is shared across every item in the game, so all of them
contribute evidence to the same curve. It also gives a free and very honest
baseline: predicting zero *is* the current engine, so every number below is
measured against what the code does today.

Runs three models on identical data:

    null    predict 0           - what the engine does now: a roll is a roll
    blind   tier, level, count  - knows what the item is, not how it rolled
    aware   + roll features     - weighted quality, percentile, coverage

and evolves the attribute-group weights that feed `aware`.

On synthetic data this is a recovery experiment: `wynn_market_sim` hides a set
of group weights and a premium curve, and the run reports whether they come
back. See docs/MODEL_TRAINING.md for what that does and does not establish.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import wynn_item_db as item_db
import wynn_market_log as market_log
import wynn_market_sim as market_sim
from wynn_trade_engine import MLP

ROLL_MODEL_FILE = item_db.DATA_DIR / "roll_model.json"

# Feature order is part of the model file format: never reorder, only append.
BLIND_FEATURES = ["tier_ordinal", "log_level", "n_observed", "coverage"]
NAIVE_FEATURES = BLIND_FEATURES + ["quality_mean", "quality_max"]
AWARE_FEATURES = BLIND_FEATURES + ["quality_weighted", "quality_max", "percentile", "percentile_sq"]


# ---------------------------------------------------------------------------
# Features
# ---------------------------------------------------------------------------

def listing_features(listing: dict, item: dict, weights: dict[str, float]) -> dict | None:
    """Everything known about one listing, before choosing a feature set.

    The row itself is built by `item_db.roll_features`, which the engine calls
    too: one definition, so training and prediction cannot drift apart.
    """
    scored = item_db.score_roll(item, listing["rolled"], weights)
    return item_db.roll_features(listing.get("tier"), listing.get("level"), scored)


class Standardizer:
    """Centres and scales features so tanh units see a useful range.

    Stored with the model: a feature vector scaled differently at prediction
    time than at training time is a silent, total failure.
    """

    def __init__(self, names: list[str]):
        self.names = list(names)
        self.mean = [0.0] * len(names)
        self.scale = [1.0] * len(names)

    def fit(self, rows: list[dict]) -> "Standardizer":
        for index, name in enumerate(self.names):
            values = [float(row[name]) for row in rows]
            mean = sum(values) / len(values)
            variance = sum((v - mean) ** 2 for v in values) / max(1, len(values) - 1)
            self.mean[index] = mean
            self.scale[index] = math.sqrt(variance) or 1.0
        return self

    def apply(self, row: dict) -> list[float]:
        return [(float(row[n]) - m) / s for n, m, s in zip(self.names, self.mean, self.scale)]

    def to_json(self) -> dict:
        return {"names": self.names, "mean": self.mean, "scale": self.scale}


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def _mse(pairs: list[tuple[float, float]]) -> float:
    return sum((p - t) ** 2 for p, t in pairs) / len(pairs)


def evaluate(predictions: list[float], targets: list[float],
             percentiles: list[float] | None = None) -> dict:
    """Held-out error, reported in log units and as a price multiple.

    `median_price_error_pct` is the number that means something to a trader: the
    typical amount by which a listing would be mispriced.
    """
    pairs = list(zip(predictions, targets))
    mse = _mse(pairs)
    mean_target = sum(targets) / len(targets)
    variance = sum((t - mean_target) ** 2 for t in targets) / len(targets)
    errors = sorted(abs(p - t) for p, t in pairs)
    median_abs = errors[len(errors) // 2]
    result = {
        "mse": mse,
        "rmse": math.sqrt(mse),
        "r2": 1.0 - (mse / variance) if variance > 0 else 0.0,
        "median_abs_log_error": median_abs,
        "median_price_error_pct": (math.exp(median_abs) - 1.0) * 100.0,
    }

    # The top decile of rolls separately. Averages hide it, and it is the only
    # part that matters: a trader never makes money on a median roll, and by
    # construction the best rolls are the rarest, so the model is thinnest on
    # evidence exactly where it is asked to be boldest.
    if percentiles:
        ranked = sorted(zip(percentiles, predictions, targets))
        tail = ranked[int(len(ranked) * 0.9):]
        if len(tail) >= 3:
            tail_pairs = [(p, t) for _, p, t in tail]
            tail_errors = sorted(abs(p - t) for p, t in tail_pairs)
            result["tail"] = {
                "n": len(tail),
                "from_percentile": round(tail[0][0], 4),
                "rmse": math.sqrt(_mse(tail_pairs)),
                "median_price_error_pct": (math.exp(tail_errors[len(tail_errors) // 2]) - 1.0) * 100.0,
                # Positive means the model systematically overpays for top rolls.
                "bias_log": sum(p - t for p, t in tail_pairs) / len(tail_pairs),
            }
    return result


def _rank(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    index = 0
    while index < len(order):
        stop = index
        while stop + 1 < len(order) and values[order[stop + 1]] == values[order[index]]:
            stop += 1
        shared = (index + stop) / 2.0
        for position in range(index, stop + 1):
            ranks[order[position]] = shared
        index = stop + 1
    return ranks


def spearman(a: list[float], b: list[float]) -> float:
    """Rank correlation. Monotone-invariant, which is what we want when the
    thing being compared is a curve of unknown shape."""
    if len(a) < 3:
        return 0.0
    ra, rb = _rank(a), _rank(b)
    mean_a, mean_b = sum(ra) / len(ra), sum(rb) / len(rb)
    num = sum((x - mean_a) * (y - mean_b) for x, y in zip(ra, rb))
    den = math.sqrt(sum((x - mean_a) ** 2 for x in ra) * sum((y - mean_b) ** 2 for y in rb))
    return num / den if den else 0.0


# ---------------------------------------------------------------------------
# Training one model
# ---------------------------------------------------------------------------

def train_model(rows: list[dict], targets: list[float], feature_names: list[str],
                hidden: int = 10, epochs: int = 120, seed: int = 11,
                split: float = 0.25) -> dict:
    """Trains one feature set and reports held-out error.

    The split is by *item*, not by row. Copies of the same item share an item
    identity, and splitting rows at random would put some of an item's copies on
    both sides - the model could then learn that item rather than the curve, and
    the held-out number would flatter it.
    """
    items = sorted({row["_item"] for row in rows})
    rng = random.Random(seed)
    rng.shuffle(items)
    held_out = set(items[: max(1, int(len(items) * split))])

    standardizer = Standardizer(feature_names).fit(
        [r for r in rows if r["_item"] not in held_out] or rows)

    train_set, test_set = [], []
    for row, target in zip(rows, targets):
        sample = (standardizer.apply(row), target)
        (test_set if row["_item"] in held_out else train_set).append(sample)

    if not train_set or not test_set:
        raise ValueError("item split produced an empty side")

    model = MLP([len(feature_names), hidden, 1], seed=seed)
    report = model.train(train_set, epochs=epochs, learning_rate=0.03,
                         weight_decay=1e-4, seed=seed)

    predictions = [model.predict(x) for x, _ in test_set]
    truth = [t for _, t in test_set]
    test_percentiles = [r["percentile"] for r in rows if r["_item"] in held_out]
    return {
        "features": feature_names,
        "model": model,
        "standardizer": standardizer,
        "train_report": report,
        "held_out": evaluate(predictions, truth, test_percentiles),
        # What the model was actually shown. Prediction is clamped to this, so
        # an odd roll cannot make it extrapolate a premium nobody ever paid.
        "target_range": [min(t for _, t in train_set), max(t for _, t in train_set)],
        "n_train": len(train_set),
        "n_test": len(test_set),
        "n_items_held_out": len(held_out),
    }


# ---------------------------------------------------------------------------
# Evolving the attribute-group weights
# ---------------------------------------------------------------------------

def evolve_group_weights(listings: list[dict], by_name: dict[str, dict],
                         generations: int = 30, population: int = 36,
                         seed: int = 5, sample: int = 1200) -> dict:
    """Searches for the group weights that make roll percentile track price.

    A gradient is no use here. The weights enter through a percentile that is
    computed by sorting and a normal CDF, and what we want to maximise is a rank
    correlation, which has no derivative worth the name. That is what the
    evolutionary side of the engine is for, and it is a ten-parameter search -
    small enough that a population of a few dozen covers it.

    Fitness is Spearman correlation between the percentile a candidate computes
    and the realised price. Rank correlation rather than error, because the
    premium curve's *shape* is the network's job; the weights only have to get
    the ordering right.
    """
    rng = random.Random(seed)
    subset = listings if len(listings) <= sample else rng.sample(listings, sample)
    prepared = []
    for listing in subset:
        item = by_name.get(str(listing["item"]).lower())
        if not item:
            continue
        specs = item_db.rolled_specs(item)
        qualities, groups = [], []
        for name, spec in specs.items():
            if name not in listing["rolled"]:
                continue
            quality = item_db.roll_quality(listing["rolled"][name], spec)
            if quality is None:
                continue
            qualities.append(quality)
            groups.append(item_db.attribute_group(name))
        if qualities:
            prepared.append((qualities, groups, listing["log_price_ratio"]))

    if not prepared:
        raise ValueError("no listings could be prepared for the weight search")

    def fitness(weights: dict[str, float]) -> float:
        percentiles, prices = [], []
        for qualities, groups, price in prepared:
            w = [weights[g] for g in groups]
            percentiles.append(item_db.roll_percentile(qualities, w))
            prices.append(price)
        return spearman(percentiles, prices)

    def random_weights():
        return {g: rng.uniform(0.0, 3.0) for g in item_db.GROUP_NAMES}

    def mutate(parent, rate=0.3, step=0.5):
        child = dict(parent)
        for group in item_db.GROUP_NAMES:
            if rng.random() < rate:
                child[group] = max(0.0, min(3.0, child[group] + rng.gauss(0, step)))
        return child

    def crossover(a, b):
        return {g: (a[g] if rng.random() < 0.5 else b[g]) for g in item_db.GROUP_NAMES}

    # Seed the population with the neutral weights, so the search can never do
    # worse than "every attribute matters equally".
    pool = [dict(item_db.DEFAULT_GROUP_WEIGHTS)] + [random_weights() for _ in range(population - 1)]
    history = []
    best = (fitness(pool[0]), pool[0])

    for generation in range(generations):
        scored = sorted(((fitness(c), c) for c in pool), key=lambda s: s[0], reverse=True)
        if scored[0][0] > best[0]:
            best = scored[0]
        history.append({"generation": generation, "best": round(scored[0][0], 5),
                        "median": round(scored[len(scored) // 2][0], 5)})
        survivors = [c for _, c in scored[: max(2, population // 3)]]
        pool = list(survivors)
        while len(pool) < population:
            a, b = rng.choice(survivors), rng.choice(survivors)
            pool.append(mutate(crossover(a, b)))

    # Scale is arbitrary - only ratios between groups affect a weighted mean -
    # so normalise the largest to 1 to make successive runs comparable.
    top = max(best[1].values()) or 1.0
    normalised = {g: round(w / top, 4) for g, w in best[1].items()}
    return {"weights": normalised, "fitness": best[0], "history": history}


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------

def build_rows(listings: list[dict], by_name: dict[str, dict],
               weights: dict[str, float]) -> tuple[list[dict], list[float]]:
    rows, targets = [], []
    for listing in listings:
        item = by_name.get(str(listing["item"]).lower())
        if not item:
            continue
        features = listing_features(listing, item, weights)
        if not features:
            continue
        features["_item"] = listing["item"]
        rows.append(features)
        targets.append(float(listing["log_price_ratio"]))
    return rows, targets


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--items", type=int, default=220, help="distinct items to simulate")
    parser.add_argument("--per-item", type=int, default=14, help="listings per item")
    parser.add_argument("--epochs", type=int, default=120)
    parser.add_argument("--generations", type=int, default=30)
    parser.add_argument("--population", type=int, default=36)
    parser.add_argument("--hidden", type=int, default=10)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--quick", action="store_true", help="a small, fast run for tests")
    parser.add_argument("--out", type=Path, default=ROLL_MODEL_FILE)
    parser.add_argument("--refresh-db", action="store_true", help="refetch the item database")
    parser.add_argument("--from-log", type=Path, default=None,
                        help="train on recorded listings (market_scans.jsonl) instead of the "
                             "simulator; the artifact is then calibrated 'observed'")
    parser.add_argument("--item-db", type=Path, default=None,
                        help="read the item database from this file instead of the cache "
                             "(tests point it at a fixture so they need no network)")
    args = parser.parse_args(argv)

    if args.quick:
        args.items, args.per_item = 40, 8
        args.epochs, args.generations, args.population, args.hidden = 25, 6, 10, 6

    started = time.time()
    print("Loading the Wynncraft item database...")
    if args.item_db:
        payload = json.loads(args.item_db.read_text())
        by_name = {str(i["displayName"]).strip().lower(): i for i in payload["items"]}
    else:
        by_name = item_db.load_item_db(refresh=args.refresh_db)
    print(f"  {len(by_name)} items")

    if args.from_log:
        print(f"Reading recorded listings from {args.from_log}...")
        rows = []
        for line in args.from_log.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # a line torn by a crash costs itself, not the run
        listings = market_log.training_rows(rows, by_name)
        calibration = "observed"
        if len(listings) < 50:
            # Refusing is the point. A model fitted to a handful of listings
            # would carry an "observed" stamp and be worth less than the
            # simulator it replaced, and the stamp is what people read.
            print(f"Only {len(listings)} usable recorded listings; need at least 50. "
                  "Keep recording, or run without --from-log for the synthetic pipeline.",
                  file=sys.stderr)
            return 1
    else:
        print(f"Simulating a market: {args.items} items x {args.per_item} listings...")
        listings = market_sim.build_dataset(by_name, n_items=args.items,
                                            per_item=args.per_item, seed=args.seed)
        calibration = "synthetic"
    print(f"  {len(listings)} listings")

    print("Evolving attribute-group weights...")
    evolved = evolve_group_weights(listings, by_name, generations=args.generations,
                                   population=args.population, seed=args.seed)
    print(f"  best rank correlation with price: {evolved['fitness']:.4f}")

    # Three feature sets on identical rows. The neutral-weight rows are what
    # `aware` would see without the search, which isolates what the search added.
    neutral_rows, targets = build_rows(listings, by_name, item_db.DEFAULT_GROUP_WEIGHTS)
    evolved_rows, evolved_targets = build_rows(listings, by_name, evolved["weights"])
    if not neutral_rows:
        print("No usable rows; aborting.", file=sys.stderr)
        return 1

    results = {}
    # The null model is not trained: predicting zero is what the engine does
    # today, and it is the number everything else has to beat.
    null_percentiles = [r["percentile"] for r in neutral_rows]
    results["null"] = {"held_out": evaluate([0.0] * len(targets), targets, null_percentiles)}

    for label, rows, names, tgt in [
        ("blind", neutral_rows, BLIND_FEATURES, targets),
        ("naive_roll", neutral_rows, NAIVE_FEATURES, targets),
        ("aware_neutral_weights", neutral_rows, AWARE_FEATURES, targets),
        ("aware", evolved_rows, AWARE_FEATURES, evolved_targets),
    ]:
        print(f"Training '{label}' ({len(names)} features)...")
        results[label] = train_model(rows, tgt, names, hidden=args.hidden,
                                     epochs=args.epochs, seed=args.seed)
        held = results[label]["held_out"]
        print(f"  held-out R2 {held['r2']:+.4f}   median pricing error "
              f"{held['median_price_error_pct']:.1f}%")

    # Did the search find the weights the simulator hid? Only a question when
    # there was a hidden answer: against recorded prices the weights are what
    # the market says they are, and there is nothing to check them against.
    recovered = evolved["weights"]
    if calibration == "synthetic":
        order = item_db.GROUP_NAMES
        true_weights = market_sim.TRUE_GROUP_WEIGHTS
        recovery = spearman([true_weights[g] for g in order], [recovered[g] for g in order])
    else:
        true_weights, recovery = None, None

    best = results["aware"]
    artifact = {
        "version": 1,
        # The single most important field in this file.
        "calibration": calibration,
        "calibration_note": (
            "Trained against wynn_market_sim, not observed Wynncraft prices. The roll "
            "arithmetic uses the real item database; the price response does not. Use for "
            "ranking and for wiring, not as a valuation. Retrain on recorded listings "
            "before trusting a number."
            if calibration == "synthetic" else
            "Trained on listings recorded from the Trade Market. Asking prices, not sale "
            "prices, and the label is each listing against the median of its own item, so "
            "an item observed only at one price contributes nothing."
        ),
        "trained_ts": time.time(),
        "target": "log(price of this copy / price of a median-roll copy of the same item)",
        "group_weights": recovered,
        "features": best["features"],
        # Bounds on what the model may claim, taken from what it was trained on
        # rather than picked. Outside this range there is no evidence, and the
        # tail metrics below show the fit is weakest there.
        "log_ratio_range": best["target_range"],
        "standardizer": best["standardizer"].to_json(),
        "mlp": {
            "layer_sizes": best["model"].layer_sizes,
            "weights": best["model"].weights,
            "biases": best["model"].biases,
        },
        "report": {
            "listings": len(listings),
            "items": args.items,
            "seconds": round(time.time() - started, 1),
            "weight_search": {
                "fitness": evolved["fitness"],
                "recovery_spearman": recovery,
                "recovered": recovered,
                "true_weights_for_comparison": true_weights,
                "history": evolved["history"][-5:],
            },
            "source": "recorded listings" if calibration == "observed" else "wynn_market_sim",
            "models": {
                label: {
                    "features": result.get("features", []),
                    "held_out": result["held_out"],
                    "n_train": result.get("n_train"),
                    "n_test": result.get("n_test"),
                }
                for label, result in results.items()
            },
        },
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(artifact, indent=1))

    print()
    print("=" * 66)
    print(f"{'model':24s} {'held-out R2':>12s} {'median error':>14s}")
    print("-" * 66)
    for label in ["null", "blind", "naive_roll", "aware_neutral_weights", "aware"]:
        held = results[label]["held_out"]
        print(f"{label:24s} {held['r2']:>+12.4f} {held['median_price_error_pct']:>13.1f}%")
    print("=" * 66)
    if recovery is not None:
        print(f"group-weight recovery (Spearman vs the hidden truth): {recovery:+.3f}")
    print(f"written to {args.out}")
    print(f"calibration: {calibration.upper()} - see docs/MODEL_TRAINING.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
