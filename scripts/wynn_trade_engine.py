#!/usr/bin/env python3
"""Delta-driven trade planning for the Wynncraft Trade Market.

This joins the three data sources the project already has:

  1. Live asks scraped from the in-game Trade Market by the Mineflayer bot
     (``GET /api/bot/market`` -> parsed listings with real prices).
  2. Wynnventory's point-in-time aggregates (lowest / p50 / average / count).
  3. The local time series in ``history.jsonl``, which is the only actual
     history we have - Wynnventory exposes aggregates, not past points.

From those it computes a per-item *delta* (fair value minus what you can buy
it for right now, after the listing fee) and turns deltas into a liquidity
plan: how to move a fixed amount of capital through the highest edge-per-day
trades, given a limited number of sell slots.

Two learners sit on top, both pure-Python so the project keeps its
stdlib-only footprint:

  * ``MLP`` - a small feed-forward network trained by backprop on walk-forward
    samples (features at time t -> realised forward return at t+h). It is a
    correction term on fair value, not an oracle: with a few dozen local
    points it is deliberately tiny and heavily regularised.
  * ``evolve`` - a genetic algorithm over the allocator's strategy parameters
    (and, optionally, over MLP weights when there is too little data for
    gradients to be meaningful), scored by walk-forward backtest.

Nothing here buys or sells. It produces a plan; executing it is the bot's job
via the market API, and every purchase there needs explicit confirmation.
"""

from __future__ import annotations

import json
import math
import random
import time
from pathlib import Path

DATA_DIR = Path.home() / ".local" / "share" / "wynn-dashboard"
MODEL_FILE = DATA_DIR / "trade_model.json"
STRATEGY_FILE = DATA_DIR / "strategy.json"

MARKET_FEE = 0.05  # keep in sync with wynn_price_server.MARKET_FEE

# Feature order is part of the model file format: never reorder, only append.
FEATURE_NAMES = [
    "log_price",
    "momentum_short",
    "momentum_long",
    "volatility",
    "spread_ratio",
    "sample_density",
    "trend_slope",
    "trend_r2",
    "pool_size",
]

# Defaults for the parameters the evolutionary optimizer searches over.
DEFAULT_STRATEGY = {
    "w_delta": 1.0,          # weight on raw edge
    "w_momentum": 0.0,       # weight on recent price momentum
    "w_liquidity": 0.5,      # weight on how quickly the item turns over
    "w_model": 0.5,          # weight on the neural net's forward-return call
    "risk_aversion": 1.0,    # penalty per unit of volatility
    "min_edge_roi": 0.02,    # ignore trades thinner than this after fees
    "max_concentration": 0.4,  # cap on the share of capital in one item
    "hold_days_cap": 14.0,   # trades expected to take longer are discounted
}

STRATEGY_BOUNDS = {
    "w_delta": (0.0, 3.0),
    "w_momentum": (-2.0, 2.0),
    "w_liquidity": (0.0, 3.0),
    "w_model": (0.0, 3.0),
    "risk_aversion": (0.0, 5.0),
    "min_edge_roi": (0.0, 0.5),
    "max_concentration": (0.05, 1.0),
    "hold_days_cap": (1.0, 60.0),
}


# ---------------------------------------------------------------------------
# Time series features
# ---------------------------------------------------------------------------

def _values(points: list[dict], metric: str) -> list[tuple[float, float]]:
    """(timestamp, value) pairs for one metric, oldest first."""
    series = []
    for point in points:
        value = point.get(metric)
        if value is None:
            continue
        try:
            series.append((float(point["ts"]), float(value)))
        except (KeyError, TypeError, ValueError):
            continue
    series.sort(key=lambda pair: pair[0])
    return series


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _stdev(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _mean(values)
    return math.sqrt(sum((v - mean) ** 2 for v in values) / (len(values) - 1))


def _slope_r2(series: list[tuple[float, float]]) -> tuple[float, float]:
    """Least-squares slope per day and r^2 of a (ts, value) series."""
    if len(series) < 2:
        return 0.0, 0.0
    t0 = series[0][0]
    xs = [(ts - t0) / 86400 for ts, _ in series]
    ys = [value for _, value in series]
    mean_x, mean_y = _mean(xs), _mean(ys)
    ss_xx = sum((x - mean_x) ** 2 for x in xs)
    if ss_xx == 0:
        return 0.0, 0.0
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / ss_xx
    intercept = mean_y - slope * mean_x
    ss_tot = sum((y - mean_y) ** 2 for y in ys)
    if ss_tot == 0:
        return slope, 1.0
    ss_res = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(xs, ys))
    return slope, max(0.0, 1 - ss_res / ss_tot)


def build_features(points: list[dict], live: dict | None = None, metric: str = "lowest_price") -> dict | None:
    """Turns a local price history (plus an optional live aggregate) into the
    feature vector the model and the scorer both consume.

    Returns None when there is not even one usable price point: an item we
    have never successfully priced cannot be traded on.
    """
    series = _values(points, metric)
    if not series and not live:
        return None

    if live and live.get(metric) is not None:
        series = series + [(time.time(), float(live[metric]))]
    if not series:
        return None

    values = [value for _, value in series]
    last = values[-1]
    if last <= 0:
        return None

    # Log returns between consecutive samples; the local series is irregular,
    # so these are per-sample, not per-day, and the slope feature carries the
    # per-day trend separately.
    returns = []
    for previous, current in zip(values, values[1:]):
        if previous > 0 and current > 0:
            returns.append(math.log(current / previous))

    span_days = (series[-1][0] - series[0][0]) / 86400 if len(series) > 1 else 0.0
    slope, r2 = _slope_r2(series)

    reference = None
    if live:
        reference = live.get("p50_price") or live.get("average_price")
    spread_ratio = (reference / last) if (reference and last > 0) else 1.0

    pool_size = 0.0
    if live and live.get("total_count") is not None:
        try:
            pool_size = float(live["total_count"])
        except (TypeError, ValueError):
            pool_size = 0.0

    return {
        "log_price": math.log(last),
        "momentum_short": _mean(returns[-3:]) if returns else 0.0,
        "momentum_long": _mean(returns) if returns else 0.0,
        "volatility": _stdev(returns) if len(returns) > 1 else 0.0,
        "spread_ratio": spread_ratio,
        "sample_density": (len(series) / span_days) if span_days > 0.5 else 0.0,
        "trend_slope": slope / last,  # normalised: fraction of price per day
        "trend_r2": r2,
        "pool_size": math.log1p(max(pool_size, 0.0)),
        "_last_price": last,
        "_n_points": len(series),
        "_span_days": span_days,
    }


def feature_vector(features: dict) -> list[float]:
    """Model input, in the fixed FEATURE_NAMES order."""
    return [float(features.get(name, 0.0)) for name in FEATURE_NAMES]


# ---------------------------------------------------------------------------
# Neural network
# ---------------------------------------------------------------------------

class MLP:
    """A small feed-forward network with tanh hidden layers and a linear head.

    Written out by hand because the project ships no numpy, and the problem is
    tiny: a handful of features and, realistically, tens to hundreds of local
    samples. Weights live in plain lists so the whole model serialises to JSON.
    """

    def __init__(self, layer_sizes: list[int], seed: int | None = None):
        if len(layer_sizes) < 2:
            raise ValueError("layer_sizes needs at least an input and an output size")
        self.layer_sizes = list(layer_sizes)
        rng = random.Random(seed)
        self.weights = []
        self.biases = []
        for fan_in, fan_out in zip(layer_sizes, layer_sizes[1:]):
            # Xavier-ish init keeps early activations inside tanh's useful range.
            limit = math.sqrt(6.0 / (fan_in + fan_out))
            self.weights.append([[rng.uniform(-limit, limit) for _ in range(fan_in)] for _ in range(fan_out)])
            self.biases.append([0.0 for _ in range(fan_out)])

    # -- inference ----------------------------------------------------------

    def forward(self, inputs: list[float]) -> tuple[float, list[list[float]]]:
        """Returns (output, activations per layer including the input)."""
        activations = [list(inputs)]
        current = list(inputs)
        last_layer = len(self.weights) - 1
        for index, (weight_matrix, bias_vector) in enumerate(zip(self.weights, self.biases)):
            layer_out = []
            for row, bias in zip(weight_matrix, bias_vector):
                total = bias + sum(w * a for w, a in zip(row, current))
                layer_out.append(total if index == last_layer else math.tanh(total))
            current = layer_out
            activations.append(current)
        return current[0], activations

    def predict(self, inputs: list[float]) -> float:
        return self.forward(inputs)[0]

    # -- training -----------------------------------------------------------

    def train(self, samples: list[tuple[list[float], float]], epochs: int = 200,
              learning_rate: float = 0.02, weight_decay: float = 1e-4,
              seed: int | None = None) -> dict:
        """Plain SGD with backprop and L2 decay. Returns a training report."""
        if not samples:
            return {"trained": False, "reason": "no samples", "samples": 0}

        rng = random.Random(seed)
        order = list(range(len(samples)))
        history = []

        for epoch in range(epochs):
            rng.shuffle(order)
            squared_error = 0.0
            for index in order:
                inputs, target = samples[index]
                output, activations = self.forward(inputs)
                error = output - target
                squared_error += error * error

                # Output layer starts with dL/dz = error (linear head, MSE loss).
                deltas = [error]
                for layer in range(len(self.weights) - 1, -1, -1):
                    layer_inputs = activations[layer]
                    next_deltas = [0.0] * len(layer_inputs)
                    for row_index, row in enumerate(self.weights[layer]):
                        delta = deltas[row_index]
                        for col_index, weight in enumerate(row):
                            next_deltas[col_index] += weight * delta
                        for col_index in range(len(row)):
                            gradient = delta * layer_inputs[col_index] + weight_decay * row[col_index]
                            row[col_index] -= learning_rate * gradient
                        self.biases[layer][row_index] -= learning_rate * delta
                    if layer > 0:
                        # tanh'(x) = 1 - tanh(x)^2, and activations hold tanh(x).
                        deltas = [d * (1 - a * a) for d, a in zip(next_deltas, activations[layer])]
            mse = squared_error / len(samples)
            if epoch == 0 or epoch == epochs - 1 or epoch % max(1, epochs // 10) == 0:
                history.append({"epoch": epoch, "mse": round(mse, 8)})

        return {
            "trained": True,
            "samples": len(samples),
            "epochs": epochs,
            "final_mse": history[-1]["mse"] if history else None,
            "first_mse": history[0]["mse"] if history else None,
            "history": history,
        }

    # -- flat weight view, for neuroevolution --------------------------------

    def get_flat_weights(self) -> list[float]:
        flat = []
        for weight_matrix, bias_vector in zip(self.weights, self.biases):
            for row in weight_matrix:
                flat.extend(row)
            flat.extend(bias_vector)
        return flat

    def set_flat_weights(self, flat: list[float]) -> None:
        position = 0
        for weight_matrix, bias_vector in zip(self.weights, self.biases):
            for row in weight_matrix:
                for index in range(len(row)):
                    row[index] = flat[position]
                    position += 1
            for index in range(len(bias_vector)):
                bias_vector[index] = flat[position]
                position += 1

    # -- persistence ---------------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "layer_sizes": self.layer_sizes,
            "features": FEATURE_NAMES,
            "weights": self.weights,
            "biases": self.biases,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "MLP":
        model = cls(data["layer_sizes"])
        model.weights = [[list(row) for row in matrix] for matrix in data["weights"]]
        model.biases = [list(vector) for vector in data["biases"]]
        return model

    def save(self, path: Path = MODEL_FILE) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict()))

    @classmethod
    def load(cls, path: Path = MODEL_FILE) -> "MLP | None":
        if not path.exists():
            return None
        try:
            return cls.from_dict(json.loads(path.read_text()))
        except (json.JSONDecodeError, KeyError, TypeError):
            return None


def build_training_samples(points: list[dict], horizon_days: float = 1.0,
                           metric: str = "lowest_price") -> list[tuple[list[float], float]]:
    """Walk-forward supervised pairs: features known at sample i, paired with
    the realised log return to the first sample at least `horizon_days` later.

    Only past points go into each feature vector, so a sample never sees its
    own future - the same discipline the backtest below relies on.
    """
    series = _values(points, metric)
    if len(series) < 4:
        return []

    rows = [{"ts": ts, metric: value} for ts, value in series]
    samples = []
    for index in range(2, len(series) - 1):
        cutoff_ts, cutoff_price = series[index]
        if cutoff_price <= 0:
            continue
        target_price = None
        for future_ts, future_price in series[index + 1:]:
            if future_ts - cutoff_ts >= horizon_days * 86400 and future_price > 0:
                target_price = future_price
                break
        if target_price is None:
            continue
        features = build_features(rows[: index + 1], None, metric)
        if not features:
            continue
        samples.append((feature_vector(features), math.log(target_price / cutoff_price)))
    return samples


# ---------------------------------------------------------------------------
# Delta pipeline
# ---------------------------------------------------------------------------

def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def estimate_hold_days(features: dict, live: dict | None, strategy: dict) -> float:
    """How long we expect capital to stay parked in this item.

    Liquidity is inferred from how big the listing pool is and how often we
    manage to sample the item at all; both are proxies, and they are treated as
    such - the result is clamped rather than trusted precisely.
    """
    pool = 0.0
    if live and live.get("total_count"):
        try:
            pool = float(live["total_count"])
        except (TypeError, ValueError):
            pool = 0.0
    density = features.get("sample_density", 0.0)

    # A thick pool means the item trades often; a thin one can sit for days.
    from_pool = 14.0 / (1.0 + pool / 5.0)
    from_density = 7.0 / (1.0 + density)
    hold = (from_pool + from_density) / 2
    return _clamp(hold, 0.25, float(strategy.get("hold_days_cap", DEFAULT_STRATEGY["hold_days_cap"])))


def compute_delta(item: str, points: list[dict], live: dict | None,
                  live_ask: float | None = None, model: MLP | None = None,
                  strategy: dict | None = None) -> dict | None:
    """One item's edge: fair value versus what it can actually be bought for.

    ``live_ask`` is the in-game asking price scraped by the bot; without it we
    fall back to Wynnventory's lowest listing, which is the same quantity one
    step removed.
    """
    strategy = {**DEFAULT_STRATEGY, **(strategy or {})}
    features = build_features(points, live)
    if not features:
        return None

    # Ask, in order of freshness: what the bot can see in-game right now, then
    # Wynnventory's cheapest listing, then the last price we ever recorded.
    # The last one is stale by definition, which is why the source is reported.
    ask = live_ask or (live or {}).get("lowest_price") or features["_last_price"]
    if not ask or ask <= 0:
        return None
    if live_ask:
        source = "live_listing"
    elif (live or {}).get("lowest_price"):
        source = "wynnventory"
    else:
        source = "local_history"

    reference = None
    if live:
        reference = live.get("p50_price") or live.get("average_price")
    if not reference:
        reference = features["_last_price"]

    # The local regression is only worth blending in when it actually fits;
    # r^2 does that weighting for us, and with one or two points it is ~0.
    trend_estimate = features["_last_price"] * (1 + features["trend_slope"])
    fit_weight = _clamp(features["trend_r2"], 0.0, 1.0) * _clamp(features["_n_points"] / 10.0, 0.0, 1.0)
    fair_value = (1 - fit_weight) * reference + fit_weight * trend_estimate

    model_return = 0.0
    if model is not None:
        try:
            # Clamp: an undertrained net must not be able to double fair value.
            model_return = _clamp(model.predict(feature_vector(features)), -0.5, 0.5)
        except (ValueError, IndexError):
            model_return = 0.0
    fair_value *= math.exp(model_return * float(strategy["w_model"]))

    proceeds = fair_value * (1 - MARKET_FEE)
    delta = proceeds - ask
    roi = delta / ask
    hold_days = estimate_hold_days(features, live, strategy)
    edge_per_day = roi / hold_days

    risk = features["volatility"] + (0.25 if features["_n_points"] < 3 else 0.0)
    score = (
        float(strategy["w_delta"]) * roi
        + float(strategy["w_momentum"]) * features["momentum_short"]
        + float(strategy["w_liquidity"]) * (roi / max(hold_days, 0.25))
        - float(strategy["risk_aversion"]) * risk * abs(roi)
    )

    return {
        "item": item,
        "ask": round(ask, 2),
        "fair_value": round(fair_value, 2),
        "reference_price": round(reference, 2),
        "model_return": round(model_return, 4),
        "delta": round(delta, 2),
        "roi": round(roi, 4),
        "hold_days": round(hold_days, 2),
        "edge_per_day": round(edge_per_day, 4),
        "risk": round(risk, 4),
        "score": round(score, 6),
        "source": source,
        "n_points": features["_n_points"],
        "span_days": round(features["_span_days"], 2),
        "features": {name: round(features[name], 6) for name in FEATURE_NAMES},
    }


def plan_liquidity(deltas: list[dict], capital: float, slots: int = 6,
                   strategy: dict | None = None) -> dict:
    """Moves capital through the highest-scoring positive-edge trades.

    Greedy by score, subject to three constraints: the number of sell slots,
    the capital on hand, and a per-item concentration cap so one expensive
    mythic cannot swallow the whole bankroll.
    """
    strategy = {**DEFAULT_STRATEGY, **(strategy or {})}
    min_roi = float(strategy["min_edge_roi"])
    max_per_item = capital * float(strategy["max_concentration"])

    eligible = [d for d in deltas if d and d["roi"] >= min_roi and d["ask"] <= capital]
    eligible.sort(key=lambda d: d["score"], reverse=True)

    legs = []
    remaining = capital
    skipped = []
    for delta in eligible:
        if len(legs) >= slots:
            skipped.append({"item": delta["item"], "reason": "no sell slots left"})
            continue
        if delta["ask"] > remaining:
            skipped.append({"item": delta["item"], "reason": "not enough capital left"})
            continue
        units = max(1, int(min(max_per_item, remaining) // delta["ask"]))
        spend = units * delta["ask"]
        if spend > remaining:
            units = int(remaining // delta["ask"])
            spend = units * delta["ask"]
        if units < 1:
            skipped.append({"item": delta["item"], "reason": "concentration cap"})
            continue
        legs.append({
            **delta,
            "units": units,
            "spend": round(spend, 2),
            "expected_proceeds": round(units * delta["fair_value"] * (1 - MARKET_FEE), 2),
            "expected_profit": round(units * delta["delta"], 2),
        })
        remaining -= spend

    deployed = capital - remaining
    expected_profit = sum(leg["expected_profit"] for leg in legs)
    # Capital-weighted turnaround: how long the whole plan takes to clear.
    if deployed > 0:
        turnover_days = sum(leg["spend"] * leg["hold_days"] for leg in legs) / deployed
    else:
        turnover_days = 0.0

    return {
        "capital": capital,
        "slots": slots,
        "strategy": strategy,
        "legs": legs,
        "skipped": skipped,
        "capital_deployed": round(deployed, 2),
        "capital_idle": round(remaining, 2),
        "expected_profit": round(expected_profit, 2),
        "expected_roi": round(expected_profit / capital, 4) if capital > 0 else 0.0,
        "turnover_days": round(turnover_days, 2),
        "expected_profit_per_day": round(expected_profit / turnover_days, 2) if turnover_days > 0 else 0.0,
    }


# ---------------------------------------------------------------------------
# Backtest + evolutionary optimizer
# ---------------------------------------------------------------------------

def backtest_strategy(series_by_item: dict[str, list[dict]], strategy: dict,
                      model: MLP | None = None, capital: float = 32768.0,
                      slots: int = 6, horizon_days: float = 1.0,
                      metric: str = "lowest_price") -> dict:
    """Walk-forward replay of the plan over the local history.

    At each step the planner only sees points up to that timestamp, then the
    realised price `horizon_days` later decides what each leg actually made.
    Fills are assumed at the observed price, which flatters a real market where
    your own order moves the book - so treat the number as a ranking signal
    between strategies, not as a forecast of profit.
    """
    timelines = {}
    for item, points in series_by_item.items():
        values = _values(points, metric)
        if len(values) >= 4:
            timelines[item] = values
    if not timelines:
        return {"steps": 0, "total_profit": 0.0, "roi": 0.0, "fitness": 0.0}

    timestamps = sorted({ts for values in timelines.values() for ts, _ in values})
    if len(timestamps) < 4:
        return {"steps": 0, "total_profit": 0.0, "roi": 0.0, "fitness": 0.0}

    start_index = max(2, len(timestamps) // 4)
    total_profit = 0.0
    total_deployed = 0.0
    steps = 0
    wins = 0
    trades = 0

    for cutoff in timestamps[start_index:]:
        deltas = []
        for item, values in timelines.items():
            past = [(ts, value) for ts, value in values if ts <= cutoff]
            if len(past) < 2:
                continue
            rows = [{"ts": ts, metric: value} for ts, value in past]
            live = {"lowest_price": past[-1][1], "p50_price": _mean([v for _, v in past[-5:]])}
            delta = compute_delta(item, rows, live, None, model, strategy)
            if delta:
                deltas.append(delta)
        if not deltas:
            continue

        plan = plan_liquidity(deltas, capital, slots, strategy)
        if not plan["legs"]:
            continue
        steps += 1

        for leg in plan["legs"]:
            values = timelines[leg["item"]]
            realised = None
            for ts, value in values:
                if ts >= cutoff + horizon_days * 86400:
                    realised = value
                    break
            if realised is None:
                continue
            trades += 1
            profit = leg["units"] * (realised * (1 - MARKET_FEE) - leg["ask"])
            total_profit += profit
            total_deployed += leg["spend"]
            if profit > 0:
                wins += 1

    roi = (total_profit / total_deployed) if total_deployed > 0 else 0.0
    # Fitness favours return per unit of capital actually put at risk, and
    # mildly rewards strategies that trade often enough to be measurable.
    fitness = roi * (1 - 1 / (1 + trades / 10)) if trades else 0.0

    return {
        "steps": steps,
        "trades": trades,
        "wins": wins,
        "win_rate": round(wins / trades, 4) if trades else 0.0,
        "total_profit": round(total_profit, 2),
        "capital_deployed": round(total_deployed, 2),
        "roi": round(roi, 4),
        "fitness": round(fitness, 6),
    }


def _random_strategy(rng: random.Random) -> dict:
    return {key: rng.uniform(low, high) for key, (low, high) in STRATEGY_BOUNDS.items()}


def _clamp_strategy(strategy: dict) -> dict:
    return {key: _clamp(float(strategy.get(key, DEFAULT_STRATEGY[key])), low, high)
            for key, (low, high) in STRATEGY_BOUNDS.items()}


def evolve_strategy(series_by_item: dict[str, list[dict]], generations: int = 12,
                    population_size: int = 16, model: MLP | None = None,
                    capital: float = 32768.0, slots: int = 6,
                    mutation_rate: float = 0.3, elite_count: int = 2,
                    seed: int | None = None, fitness_fn=None) -> dict:
    """Genetic search over the allocator's strategy parameters.

    Tournament selection, uniform crossover, Gaussian mutation scaled to each
    parameter's range, and elitism so the best genome is never lost. The
    default fitness is the walk-forward backtest above; `fitness_fn` exists so
    tests can drive the same machinery with a known objective.
    """
    rng = random.Random(seed)

    def fitness_of(strategy: dict) -> float:
        if fitness_fn is not None:
            return fitness_fn(strategy)
        return backtest_strategy(series_by_item, strategy, model, capital, slots)["fitness"]

    population = [DEFAULT_STRATEGY.copy()] + [_random_strategy(rng) for _ in range(population_size - 1)]
    scored = [(fitness_of(genome), genome) for genome in population]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    generation_log = [{
        "generation": 0,
        "best_fitness": round(scored[0][0], 6),
        "mean_fitness": round(_mean([f for f, _ in scored]), 6),
    }]

    for generation in range(1, generations + 1):
        elites = [genome for _, genome in scored[:elite_count]]
        children = list(elites)

        while len(children) < population_size:
            parent_a = _tournament(scored, rng)
            parent_b = _tournament(scored, rng)
            child = {}
            for key, (low, high) in STRATEGY_BOUNDS.items():
                child[key] = parent_a[key] if rng.random() < 0.5 else parent_b[key]
                if rng.random() < mutation_rate:
                    child[key] += rng.gauss(0, (high - low) * 0.15)
            children.append(_clamp_strategy(child))

        scored = [(fitness_of(genome), genome) for genome in children]
        scored.sort(key=lambda pair: pair[0], reverse=True)
        generation_log.append({
            "generation": generation,
            "best_fitness": round(scored[0][0], 6),
            "mean_fitness": round(_mean([f for f, _ in scored]), 6),
        })

    best_fitness, best_strategy = scored[0]
    return {
        "best_strategy": _clamp_strategy(best_strategy),
        "best_fitness": round(best_fitness, 6),
        "generations": generations,
        "population_size": population_size,
        "log": generation_log,
    }


def _tournament(scored: list[tuple[float, dict]], rng: random.Random, size: int = 3) -> dict:
    contenders = [rng.choice(scored) for _ in range(min(size, len(scored)))]
    contenders.sort(key=lambda pair: pair[0], reverse=True)
    return contenders[0][1]


def evolve_model_weights(model: MLP, samples: list[tuple[list[float], float]],
                         generations: int = 20, population_size: int = 20,
                         sigma: float = 0.2, elite_count: int = 2,
                         seed: int | None = None) -> dict:
    """Neuroevolution of the network's weights.

    Backprop is the better tool whenever there are enough samples; this exists
    for the case the local history is so short that gradient steps just chase
    noise, and as a way to escape a bad initialisation.
    """
    if not samples:
        return {"evolved": False, "reason": "no samples"}

    rng = random.Random(seed)
    base = model.get_flat_weights()

    def loss_of(flat: list[float]) -> float:
        model.set_flat_weights(flat)
        return sum((model.predict(x) - y) ** 2 for x, y in samples) / len(samples)

    population = [list(base)] + [[w + rng.gauss(0, sigma) for w in base] for _ in range(population_size - 1)]
    scored = sorted(((loss_of(genome), genome) for genome in population), key=lambda pair: pair[0])
    log = [{"generation": 0, "best_mse": round(scored[0][0], 8)}]

    for generation in range(1, generations + 1):
        elites = [genome for _, genome in scored[:elite_count]]
        children = list(elites)
        while len(children) < population_size:
            parent_a = rng.choice(elites)
            parent_b = rng.choice(scored[: max(elite_count, population_size // 2)])[1]
            child = [a if rng.random() < 0.5 else b for a, b in zip(parent_a, parent_b)]
            child = [w + rng.gauss(0, sigma) if rng.random() < 0.2 else w for w in child]
            children.append(child)
        scored = sorted(((loss_of(genome), genome) for genome in children), key=lambda pair: pair[0])
        log.append({"generation": generation, "best_mse": round(scored[0][0], 8)})

    model.set_flat_weights(scored[0][1])
    return {
        "evolved": True,
        "samples": len(samples),
        "first_mse": log[0]["best_mse"],
        "final_mse": log[-1]["best_mse"],
        "generations": generations,
        "log": log,
    }


# ---------------------------------------------------------------------------
# Strategy persistence
# ---------------------------------------------------------------------------

def load_strategy(path: Path = STRATEGY_FILE) -> dict:
    if not path.exists():
        return DEFAULT_STRATEGY.copy()
    try:
        return _clamp_strategy(json.loads(path.read_text()))
    except (json.JSONDecodeError, TypeError, ValueError):
        return DEFAULT_STRATEGY.copy()


def save_strategy(strategy: dict, path: Path = STRATEGY_FILE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_clamp_strategy(strategy), indent=2))
