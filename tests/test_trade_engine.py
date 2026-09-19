#!/usr/bin/env python3
"""Tests for the delta/liquidity trade engine, its neural net and its GA."""

import math
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from wynn_trade_engine import (  # noqa: E402
    DEFAULT_STRATEGY,
    FEATURE_NAMES,
    MARKET_FEE,
    MLP,
    STRATEGY_BOUNDS,
    backtest_strategy,
    build_features,
    build_training_samples,
    compute_delta,
    estimate_hold_days,
    evolve_model_weights,
    evolve_strategy,
    feature_vector,
    load_strategy,
    plan_liquidity,
    save_strategy,
)

PASSED = 0
FAILED = 0


def test(name):
    def decorator(fn):
        global PASSED, FAILED
        try:
            fn()
            print(f"\033[32m✔ PASS:\033[0m {name}")
            PASSED += 1
        except AssertionError as exc:
            print(f"\033[31m✘ FAIL:\033[0m {name}\n  {exc}")
            FAILED += 1
        except Exception as exc:  # noqa: BLE001 - surface the error, keep going
            print(f"\033[31m✘ ERROR:\033[0m {name}\n  {type(exc).__name__}: {exc}")
            FAILED += 1
        return fn
    return decorator


def series(prices, start=None, step_hours=6):
    """Builds a history.jsonl-shaped series from a list of prices."""
    start = start or (time.time() - len(prices) * step_hours * 3600)
    return [
        {"ts": start + index * step_hours * 3600, "item": "test", "lowest_price": price}
        for index, price in enumerate(prices)
    ]


print("Running trade engine tests...")


@test("Features summarise level, momentum, volatility and trend")
def _():
    rising = series([1000, 1100, 1200, 1300, 1400, 1500])
    features = build_features(rising)
    assert features is not None, "rising series should produce features"
    assert abs(features["log_price"] - math.log(1500)) < 1e-9, features["log_price"]
    assert features["momentum_short"] > 0, "a rising series has positive momentum"
    assert features["trend_slope"] > 0, "a rising series has a positive slope"
    assert features["trend_r2"] > 0.9, f"a clean ramp should fit well, got {features['trend_r2']}"
    assert features["_n_points"] == 6

    flat = build_features(series([1000] * 6))
    assert flat["volatility"] == 0, "a flat series has no volatility"
    assert abs(flat["momentum_short"]) < 1e-12


@test("Features fold in the live aggregate and survive thin history")
def _():
    features = build_features(series([1000, 1010]), {"lowest_price": 900, "p50_price": 1200, "total_count": 40})
    assert features["_last_price"] == 900, "the live ask is the most recent point"
    assert abs(features["spread_ratio"] - 1200 / 900) < 1e-9
    assert features["pool_size"] > 0

    assert build_features([], None) is None, "no data at all cannot produce features"
    assert build_features([], {"lowest_price": 500}) is not None, "a live quote alone is enough"


@test("Feature vectors keep the documented order and length")
def _():
    features = build_features(series([100, 110, 120]))
    vector = feature_vector(features)
    assert len(vector) == len(FEATURE_NAMES), f"{len(vector)} != {len(FEATURE_NAMES)}"
    assert vector[0] == features["log_price"]
    assert vector[FEATURE_NAMES.index("trend_r2")] == features["trend_r2"]


@test("Training samples are walk-forward and never see their own future")
def _():
    prices = [100, 105, 110, 116, 122, 128, 134, 140]  # strictly rising
    samples = build_training_samples(series(prices, step_hours=24), horizon_days=1.0)
    assert samples, "a series this long should yield samples"
    for inputs, target in samples:
        assert len(inputs) == len(FEATURE_NAMES)
        assert isinstance(target, float)

    # The last usable sample is bounded by the horizon: there must be at least
    # one later point, so we can never have a sample per price point.
    assert len(samples) < len(prices), f"{len(samples)} samples for {len(prices)} points implies lookahead"

    # A monotonically rising series has positive forward returns throughout.
    assert all(target > 0 for _, target in samples), "rising prices imply positive targets"


@test("The neural net actually learns a nonlinear function")
def _():
    model = MLP([2, 6, 1], seed=7)
    samples = []
    for a in (0.0, 1.0):
        for b in (0.0, 1.0):
            samples.append(([a, b], 1.0 if a != b else 0.0))  # XOR: not linearly separable
    report = model.train(samples, epochs=3000, learning_rate=0.1, weight_decay=0.0, seed=7)
    assert report["trained"]
    assert report["final_mse"] < report["first_mse"] / 10, report
    for inputs, target in samples:
        assert abs(model.predict(inputs) - target) < 0.2, f"XOR({inputs}) = {model.predict(inputs)}"


@test("The neural net round-trips through JSON unchanged")
def _():
    model = MLP([len(FEATURE_NAMES), 4, 1], seed=3)
    features = build_features(series([100, 120, 140, 130]))
    before = model.predict(feature_vector(features))

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "model.json"
        model.save(path)
        restored = MLP.load(path)
    assert restored is not None
    assert abs(restored.predict(feature_vector(features)) - before) < 1e-12

    assert MLP.load(Path("/nonexistent/model.json")) is None


@test("Flat weight views round-trip for neuroevolution")
def _():
    model = MLP([3, 4, 1], seed=1)
    flat = model.get_flat_weights()
    assert len(flat) == 3 * 4 + 4 + 4 * 1 + 1, len(flat)
    shifted = [w + 1.0 for w in flat]
    model.set_flat_weights(shifted)
    assert model.get_flat_weights() == shifted


@test("Deltas price the edge net of the market fee")
def _():
    points = series([1000] * 6)
    live = {"lowest_price": 800, "p50_price": 1000, "average_price": 1000, "total_count": 30}
    delta = compute_delta("test", points, live, live_ask=800, model=None)
    assert delta is not None
    expected = delta["fair_value"] * (1 - MARKET_FEE) - 800
    assert abs(delta["delta"] - round(expected, 2)) < 0.02, delta
    assert delta["roi"] > 0, "buying below fair value is a positive edge"
    assert delta["source"] == "live_listing"
    assert delta["hold_days"] > 0

    # Overpaying is a negative edge, and the fee alone is enough to make
    # buying at exactly fair value a loss.
    at_fair = compute_delta("test", points, live, live_ask=1000)
    assert at_fair["roi"] < 0, at_fair


@test("Deltas fall back to Wynnventory when the bot has no live ask")
def _():
    delta = compute_delta("test", series([500, 520]), {"lowest_price": 480, "p50_price": 600, "total_count": 12})
    assert delta["source"] == "wynnventory"
    assert delta["ask"] == 480

    assert compute_delta("test", [], None) is None, "no data means no trade"

    # With neither a live ask nor a Wynnventory quote, the last recorded price
    # is the only ask available, and the result says so rather than implying
    # the number is fresh.
    stale = compute_delta("test", series([500, 520, 540, 560]), None)
    assert stale is not None and stale["source"] == "local_history", stale
    assert stale["ask"] == 560

    assert compute_delta("test", series([100]), {"lowest_price": 0}) is None, "a zero ask is not tradeable"


@test("Without measurements, a thin listing pool implies a longer hold")
def _():
    features = build_features(series([100, 105, 110]))
    thin, thin_source, thin_samples = estimate_hold_days(features, {"total_count": 1}, DEFAULT_STRATEGY)
    thick, _, _ = estimate_hold_days(features, {"total_count": 200}, DEFAULT_STRATEGY)
    assert thin > thick, f"thin pool {thin} should hold longer than thick pool {thick}"
    assert thick >= 0.25 and thin <= DEFAULT_STRATEGY["hold_days_cap"]
    assert thin_source == "heuristic", "with nothing observed it is still a guess, and says so"
    assert thin_samples == 0


@test("Observed lifetimes replace the guess, in proportion to the evidence")
def _():
    features = build_features(series([100, 105, 110]))
    live = {"total_count": 1}  # the heuristic would call this slow to sell
    heuristic, _, _ = estimate_hold_days(features, live, DEFAULT_STRATEGY)
    assert heuristic > 3, f"a one-listing pool should look slow: {heuristic}"

    # One observation of a fast sale nudges, but does not take over.
    nudged, source, samples = estimate_hold_days(
        features, live, DEFAULT_STRATEGY, {"days": 0.5, "samples": 1})
    assert source == "blended" and samples == 1
    assert nudged < heuristic, "evidence of a fast sale should shorten the estimate"
    assert nudged > 0.5, "a single observation must not fully displace the prior"

    # Enough observations and the measurement stands on its own.
    measured, source, samples = estimate_hold_days(
        features, live, DEFAULT_STRATEGY, {"days": 0.5, "samples": 12})
    assert source == "measured" and samples == 12
    assert abs(measured - 0.5) < 1e-9, measured

    # More evidence moves further from the guess, monotonically.
    previous = heuristic
    for count in [1, 2, 3, 4, 5]:
        value, _, _ = estimate_hold_days(features, live, DEFAULT_STRATEGY,
                                         {"days": 0.5, "samples": count})
        assert value <= previous + 1e-9, f"{count} samples moved back toward the guess"
        previous = value

    # An observation of a slow sale lengthens it just the same.
    slow, _, _ = estimate_hold_days(features, {"total_count": 200}, DEFAULT_STRATEGY,
                                    {"days": 9.0, "samples": 12})
    assert slow > 5, f"a measured slow seller should read slow: {slow}"

    # Junk measurements are ignored rather than trusted.
    for junk in [{"days": None, "samples": 9}, {"days": 2.0, "samples": 0}, {}, None]:
        value, source, _ = estimate_hold_days(features, live, DEFAULT_STRATEGY, junk)
        assert source == "heuristic", f"{junk} should not count as evidence"
        assert abs(value - heuristic) < 1e-9


@test("A delta reports whether its hold time was measured or guessed")
def _():
    points = series([1000] * 6)
    live = {"lowest_price": 800, "p50_price": 1000, "total_count": 2}

    guessed = compute_delta("test", points, live, live_ask=800)
    assert guessed["hold_source"] == "heuristic"
    assert guessed["hold_samples"] == 0

    measured = compute_delta("test", points, live, live_ask=800,
                             hold_observation={"days": 0.4, "samples": 20})
    assert measured["hold_source"] == "measured"
    assert measured["hold_samples"] == 20
    assert measured["hold_days"] < guessed["hold_days"], \
        "a measured fast seller should beat the pessimistic default"
    # Edge per day is hold time in the denominator, so the plan sees it too.
    assert measured["edge_per_day"] > guessed["edge_per_day"]


@test("The model's influence on fair value is bounded")
def _():
    class Runaway:
        def predict(self, _inputs):
            return 100.0  # an untrained net can output anything

    live = {"lowest_price": 1000, "p50_price": 1000, "total_count": 10}
    delta = compute_delta("test", series([1000] * 4), live, 1000, Runaway(), DEFAULT_STRATEGY)
    assert delta["model_return"] == 0.5, delta["model_return"]
    assert delta["fair_value"] < 1000 * math.exp(0.5 * DEFAULT_STRATEGY["w_model"]) + 1, delta


@test("Plans respect capital, slots and the concentration cap")
def _():
    deltas = []
    for index, ask in enumerate([100, 200, 400, 800, 1600, 3200, 6400]):
        deltas.append({
            "item": f"item{index}", "ask": ask, "fair_value": ask * 1.5,
            "reference_price": ask * 1.5, "model_return": 0.0,
            "delta": ask * 1.5 * (1 - MARKET_FEE) - ask, "roi": 0.42,
            "hold_days": 2.0, "edge_per_day": 0.21, "risk": 0.1,
            "score": 1.0 / (index + 1), "source": "test", "n_points": 5,
            "span_days": 3.0, "features": {},
        })

    plan = plan_liquidity(deltas, capital=5000, slots=3, strategy=DEFAULT_STRATEGY)
    assert len(plan["legs"]) <= 3, "the slot limit must hold"
    assert plan["capital_deployed"] <= 5000 + 1e-9, plan["capital_deployed"]
    assert plan["capital_idle"] >= 0
    cap = 5000 * DEFAULT_STRATEGY["max_concentration"]
    for leg in plan["legs"]:
        assert leg["spend"] <= cap + leg["ask"], f"{leg['item']} breached the concentration cap"
    assert plan["expected_profit"] > 0
    assert plan["turnover_days"] > 0

    # Highest score first.
    assert plan["legs"][0]["item"] == "item0", plan["legs"]


@test("Plans drop trades thinner than the minimum edge")
def _():
    thin = {
        "item": "thin", "ask": 100, "fair_value": 101, "reference_price": 101,
        "model_return": 0.0, "delta": 1, "roi": 0.005, "hold_days": 1.0,
        "edge_per_day": 0.005, "risk": 0.0, "score": 10.0, "source": "test",
        "n_points": 5, "span_days": 2.0, "features": {},
    }
    plan = plan_liquidity([thin], capital=1000, slots=4, strategy=DEFAULT_STRATEGY)
    assert plan["legs"] == [], "a 0.5% edge is below the 2% floor"
    assert plan["capital_idle"] == 1000

    generous = plan_liquidity([thin], capital=1000, slots=4,
                              strategy={**DEFAULT_STRATEGY, "min_edge_roi": 0.001})
    assert len(generous["legs"]) == 1, "lowering the floor should admit the trade"


@test("Unaffordable items are skipped with a reason")
def _():
    expensive = {
        "item": "mythic", "ask": 100000, "fair_value": 200000, "reference_price": 200000,
        "model_return": 0.0, "delta": 90000, "roi": 0.9, "hold_days": 5.0,
        "edge_per_day": 0.18, "risk": 0.2, "score": 5.0, "source": "test",
        "n_points": 5, "span_days": 4.0, "features": {},
    }
    plan = plan_liquidity([expensive], capital=1000, slots=4, strategy=DEFAULT_STRATEGY)
    assert plan["legs"] == []
    assert plan["capital_deployed"] == 0


@test("The backtest replays history without lookahead and scores a strategy")
def _():
    # A deep sawtooth: the dips are wide enough to clear the 5% listing fee
    # and the 2% minimum edge, so the planner has something to act on.
    prices = [1200, 700, 1250, 720, 1300, 740, 1350, 760, 1400, 780, 1450]
    result = backtest_strategy({"saw": series(prices, step_hours=24)}, DEFAULT_STRATEGY)
    assert result["steps"] > 0, result
    assert result["trades"] > 0, f"the planner never traded: {result}"
    assert isinstance(result["fitness"], float)
    assert 0.0 <= result["win_rate"] <= 1.0

    # A shallow sawtooth offers no edge after fees, and must produce no trades
    # rather than manufacturing them.
    flat = backtest_strategy({"flat": series([1000, 995, 1005, 998, 1002, 1000, 1001], step_hours=24)},
                             DEFAULT_STRATEGY)
    assert flat["trades"] == 0, flat

    empty = backtest_strategy({}, DEFAULT_STRATEGY)
    assert empty["steps"] == 0 and empty["fitness"] == 0.0


@test("The genetic algorithm improves fitness and honours bounds")
def _():
    # A known objective with an interior optimum the GA has to find.
    target = {"w_delta": 2.0, "w_liquidity": 1.5, "risk_aversion": 0.5}

    def fitness(strategy):
        return -sum((strategy[key] - value) ** 2 for key, value in target.items())

    result = evolve_strategy({}, generations=25, population_size=20,
                             seed=11, fitness_fn=fitness)
    best = result["best_strategy"]
    assert result["best_fitness"] > fitness(DEFAULT_STRATEGY), "the GA should beat the default genome"
    assert result["log"][-1]["best_fitness"] >= result["log"][0]["best_fitness"], "best fitness must not regress"
    for key, value in target.items():
        assert abs(best[key] - value) < 0.5, f"{key} converged to {best[key]}, wanted ~{value}"
    for key, (low, high) in STRATEGY_BOUNDS.items():
        assert low <= best[key] <= high, f"{key}={best[key]} escaped [{low}, {high}]"


@test("Elitism means a run is reproducible for a given seed")
def _():
    def fitness(strategy):
        return -abs(strategy["w_delta"] - 1.234)

    first = evolve_strategy({}, generations=6, population_size=10, seed=99, fitness_fn=fitness)
    second = evolve_strategy({}, generations=6, population_size=10, seed=99, fitness_fn=fitness)
    assert first["best_strategy"] == second["best_strategy"]
    assert first["best_fitness"] == second["best_fitness"]


@test("Neuroevolution lowers the network's error")
def _():
    model = MLP([2, 5, 1], seed=5)
    samples = [([a, b], 1.0 if a != b else 0.0) for a in (0.0, 1.0) for b in (0.0, 1.0)]
    report = evolve_model_weights(model, samples, generations=40, population_size=24, seed=5)
    assert report["evolved"]
    assert report["final_mse"] < report["first_mse"], report
    assert evolve_model_weights(model, [], seed=1)["evolved"] is False


@test("Strategies persist and are clamped back into their bounds")
def _():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "strategy.json"
        assert load_strategy(path) == DEFAULT_STRATEGY, "a missing file yields the defaults"

        save_strategy({**DEFAULT_STRATEGY, "w_delta": 99.0, "risk_aversion": -5.0}, path)
        restored = load_strategy(path)
        assert restored["w_delta"] == STRATEGY_BOUNDS["w_delta"][1], restored["w_delta"]
        assert restored["risk_aversion"] == STRATEGY_BOUNDS["risk_aversion"][0], restored["risk_aversion"]

        path.write_text("{ not json")
        assert load_strategy(path) == DEFAULT_STRATEGY, "corrupt state must not break planning"


@test("End to end: live listings plus history produce a fundable plan")
def _():
    history = {
        "spring": series([4000, 4100, 4200, 4150, 4300, 4250], step_hours=12),
        "aegis": series([100000, 102000, 101000, 103000], step_hours=12),
    }
    live_quotes = {
        "spring": {"lowest_price": 3200, "p50_price": 4300, "average_price": 4250, "total_count": 45},
        "aegis": {"lowest_price": 99000, "p50_price": 103000, "average_price": 102000, "total_count": 3},
    }
    live_asks = {"spring": 3200, "aegis": 99000}

    model = MLP([len(FEATURE_NAMES), 4, 1], seed=2)
    samples = []
    for points in history.values():
        samples.extend(build_training_samples(points, horizon_days=0.5))
    if samples:
        model.train(samples, epochs=50, learning_rate=0.01, seed=2)

    deltas = [compute_delta(item, history[item], live_quotes[item], live_asks[item], model)
              for item in history]
    deltas = [d for d in deltas if d]
    assert len(deltas) == 2

    plan = plan_liquidity(deltas, capital=40000, slots=4)
    assert plan["legs"], "a 25% discount to fair value should be worth trading"
    assert all(leg["item"] != "aegis" for leg in plan["legs"]), "an unaffordable mythic cannot be a leg"
    assert plan["capital_deployed"] <= 40000
    assert plan["expected_profit_per_day"] > 0


if FAILED:
    print(f"\n\033[1;31mTrade engine tests: {PASSED} passed, {FAILED} failed.\033[0m")
    sys.exit(1)
print(f"\n\033[1;32mTrade engine tests: {PASSED} passed.\033[0m")
