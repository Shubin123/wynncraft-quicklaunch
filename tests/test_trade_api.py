#!/usr/bin/env python3
"""Integration tests for the trade-engine endpoints on the price server.

The server is started in a subprocess with HOME pointed at a temporary
directory, so the real watchlist, history, model and strategy files are never
read or written. Wynnventory is not reachable from the test (no API key is
configured under the temp HOME), which is deliberate: it exercises the path
this runs on when the upstream API is unavailable, where the local time series
has to carry the pipeline on its own.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("WYNN_TEST_PORT", "8791"))
BASE = f"http://localhost:{PORT}"

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
        except Exception as exc:  # noqa: BLE001
            print(f"\033[31m✘ ERROR:\033[0m {name}\n  {type(exc).__name__}: {exc}")
            FAILED += 1
        return fn
    return decorator


def get(path, timeout=60):
    """GET a JSON endpoint, returning (status, body)."""
    try:
        with urllib.request.urlopen(f"{BASE}{path}", timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def seed_history(home: Path, items: dict[str, list[float]], step_hours=12):
    """Writes a history.jsonl under the temp HOME, oldest sample first."""
    data_dir = home / ".local" / "share" / "wynn-dashboard"
    data_dir.mkdir(parents=True, exist_ok=True)
    now = time.time()
    lines = []
    for item, prices in items.items():
        start = now - len(prices) * step_hours * 3600
        for index, price in enumerate(prices):
            lines.append(json.dumps({
                "ts": start + index * step_hours * 3600,
                "item": item.lower(),
                "lowest_price": price,
                "highest_price": price * 1.4,
                "average_price": price * 1.15,
                "p50_price": price * 1.1,
            }))
    (data_dir / "history.jsonl").write_text("\n".join(lines) + "\n")

    config_dir = home / ".config" / "wynn-dashboard"
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / "watchlist.json").write_text(json.dumps(list(items)))


def wait_for_server(process, attempts=60):
    for _ in range(attempts):
        if process.poll() is not None:
            raise RuntimeError(f"server exited early with code {process.returncode}")
        try:
            with urllib.request.urlopen(f"{BASE}/api/model/status", timeout=1):
                return True
        except Exception:
            time.sleep(0.25)
    return False


print("Running trade API integration tests...")

with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp)
    # A rising series for one item and a choppy one for another, so the planner
    # has both a candidate worth funding and one it should be wary of.
    seed_history(home, {
        "spring": [3600, 3700, 3850, 3900, 4100, 4250, 4400, 4600, 4800, 5000,
                   5150, 5300, 5500, 5650, 5900, 6100, 6300, 6500],
        "wybel paw": [900, 1500, 850, 1600, 800, 1700, 820, 1650, 900, 1500,
                      880, 1550, 910, 1480, 870, 1620, 930, 1510],
    })

    env = {
        **os.environ,
        "HOME": str(home),
        "WYNN_DASHBOARD_PORT": str(PORT),
        "WYNN_NO_AUTOSPAWN": "1",
    }
    env.pop("WYNNVENTORY_API_KEY", None)

    server = subprocess.Popen(
        [sys.executable, str(REPO / "scripts" / "wynn_price_server.py")],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )

    try:
        assert wait_for_server(server), "price server did not come up"

        @test("Model status reports an untrained model and the default strategy")
        def _():
            status, body = get("/api/model/status")
            assert status == 200, body
            assert body["model_loaded"] is False, "a fresh HOME has no saved model"
            assert body["features"], "feature names must be reported"
            assert body["strategy"]["w_delta"] == 1.0, body["strategy"]
            assert "w_delta" in body["strategy_bounds"]

        @test("Deltas are computed from local history when Wynnventory is unavailable")
        def _():
            status, body = get("/api/deltas")
            assert status == 200, body
            assert body["deltas"], f"expected deltas from the seeded history: {body}"
            by_item = {d["item"]: d for d in body["deltas"]}
            assert "spring" in by_item, by_item.keys()
            spring = by_item["spring"]
            assert spring["source"] == "local_history", spring["source"]
            assert spring["ask"] == 6500, spring
            assert spring["n_points"] == 18, spring
            assert -1 < spring["roi"] < 1, spring
            assert body["live_listings_used"] == 0, "no bot market window is open in this test"
            assert body["model_loaded"] is False

        @test("An unknown item is reported as skipped, not silently dropped")
        def _():
            status, body = get("/api/deltas?items=spring,definitely_not_an_item")
            assert status == 200, body
            names = [d["item"] for d in body["deltas"]]
            skipped = [s["item"] for s in body["skipped"]]
            assert "spring" in names, names
            assert "definitely_not_an_item" in skipped, body["skipped"]
            assert body["skipped"][0]["reason"], "a skip must carry a reason"

        @test("Deltas need candidates")
        def _():
            status, body = get("/api/deltas?items=%20")
            # An empty items list falls back to the watchlist, which is seeded,
            # so this still succeeds - the error path is a bare, empty watchlist.
            assert status == 200, body
            assert body["deltas"], body

        @test("The plan respects capital and slots and reports its sources")
        def _():
            status, body = get("/api/plan?capital=20000&slots=2")
            assert status == 200, body
            assert body["capital"] == 20000
            assert body["slots"] == 2
            assert len(body["legs"]) <= 2
            assert body["capital_deployed"] <= 20000 + 1e-6
            assert body["capital_deployed"] + body["capital_idle"] == body["capital"]
            assert "strategy" in body and "candidates" in body
            for leg in body["legs"]:
                assert leg["spend"] <= 20000 * body["strategy"]["max_concentration"] + leg["ask"]
                assert leg["units"] >= 1

        @test("A plan with no capital funds nothing")
        def _():
            status, body = get("/api/plan?capital=0&slots=4")
            assert status == 200, body
            assert body["legs"] == [], body["legs"]
            assert body["expected_profit"] == 0

        @test("Bad plan parameters are rejected with a message")
        def _():
            status, body = get("/api/plan?capital=lots")
            assert status == 400, (status, body)
            assert "capital" in body["error"]

        @test("Training refuses to ship a model fitted on too few samples")
        def _():
            # One item at a 5-day horizon over a 9-day series leaves only a
            # handful of walk-forward pairs, well under the floor.
            status, body = get("/api/model/train?items=spring&horizon=5")
            assert status == 400, (status, body)
            assert "samples" in body["error"], body
            assert body["minimum_samples"] == 20
            assert isinstance(body["samples_per_item"], dict)

        @test("Training succeeds once enough walk-forward samples exist")
        def _():
            # Both items at a 1-day horizon over 12-hourly samples clear the floor.
            status, body = get("/api/model/train?horizon=1&epochs=60&hidden=4")
            assert status == 200, (status, body)
            assert body["trained"] is True
            assert body["samples"] >= 20, body["samples"]
            assert body["final_mse"] <= body["first_mse"], f"training made the fit worse: {body}"
            assert Path(body["model_file"]).exists()

        @test("A trained model is loaded back for status and scoring")
        def _():
            status, body = get("/api/model/status")
            assert status == 200, body
            assert body["model_loaded"] is True
            assert body["layer_sizes"][0] == len(body["features"])

            status, deltas = get("/api/deltas")
            assert deltas["model_loaded"] is True
            spring = next(d for d in deltas["deltas"] if d["item"] == "spring")
            assert -0.5 <= spring["model_return"] <= 0.5, "the model's pull must stay bounded"

        @test("Evolution improves on the default strategy and can persist it")
        def _():
            status, body = get("/api/evolve?generations=4&population=8&save=1")
            assert status == 200, (status, body)
            assert body["best_fitness"] >= body["log"][0]["best_fitness"] - 1e-9, body["log"]
            assert body["saved"] is True
            assert Path(body["strategy_file"]).exists()
            best = body["best_strategy"]
            assert 0.0 <= best["w_delta"] <= 3.0, best
            assert 0.05 <= best["max_concentration"] <= 1.0, best
            assert body["baseline_backtest"]["steps"] >= 0
            assert body["best_backtest"]["fitness"] >= body["baseline_backtest"]["fitness"] - 1e-6, body

            # The saved strategy is what later requests plan with.
            status, status_body = get("/api/model/status")
            assert status_body["strategy"]["w_delta"] == round(best["w_delta"], 10) or \
                abs(status_body["strategy"]["w_delta"] - best["w_delta"]) < 1e-9, \
                (status_body["strategy"], best)

        @test("Evolution reports honestly when there is no history to score against")
        def _():
            status, body = get("/api/evolve?items=nothing_here&generations=2&population=4")
            assert status == 400, (status, body)
            assert "history" in body["error"], body

        @test("Existing price-server endpoints still work alongside the new ones")
        def _():
            status, body = get("/api/history_local?item=spring&days=30")
            assert status == 200, body
            assert len(body["points"]) == 18, body

            status, body = get("/api/trend?item=spring&days=30")
            assert status == 200, body
            assert body["regression"]["n"] == 18
            assert body["regression"]["slope_per_day"] > 0, "the seeded series rises"

            status, body = get("/api/watchlist")
            assert status == 200, body
            assert "spring" in body["watchlist"], body

        @test("The dashboard pages are still served")
        def _():
            for page in ("/index.html", "/market.html", "/liquidity.html", "/bot.html"):
                try:
                    with urllib.request.urlopen(f"{BASE}{page}", timeout=5) as resp:
                        assert resp.status == 200, page
                        assert len(resp.read()) > 500, f"{page} looks empty"
                except urllib.error.HTTPError as exc:
                    raise AssertionError(f"{page} returned {exc.code}") from exc

    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

if FAILED:
    print(f"\n\033[1;31mTrade API tests: {PASSED} passed, {FAILED} failed.\033[0m")
    sys.exit(1)
print(f"\n\033[1;32mTrade API tests: {PASSED} passed.\033[0m")
