#!/usr/bin/env python3
"""Integration tests for the trade-engine endpoints on the price server.

The server is started in a subprocess with HOME pointed at a temporary
directory, so the real watchlist, history, model and strategy files are never
read or written. Wynnventory is not reachable from the test (no API key is
configured under the temp HOME), which is deliberate: it exercises the path
this runs on when the upstream API is unavailable, where the local time series
has to carry the pipeline on its own.
"""

import http.server
import json
import os
import subprocess
import threading
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("WYNN_TEST_PORT", "8791"))
BOT_STUB_PORT = int(os.environ.get("WYNN_TEST_BOT_STUB_PORT", "8792"))
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


class BotStub(threading.Thread):
    """Answers the two bot endpoints /api/state reads, and nothing else."""

    def __init__(self, port):
        super().__init__(daemon=True)
        self.port = port
        self.connected = True
        handler = self._make_handler()
        self.httpd = http.server.ThreadingHTTPServer(("localhost", port), handler)

    def _make_handler(self):
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path.startswith("/api/bot/status"):
                    payload = {
                        "connected": stub.connected,
                        "status": "connected" if stub.connected else "disconnected",
                        "username": "TestBot",
                        "position": {"x": 1, "y": 2, "z": 3},
                        "viewerActive": True,
                        "viewerUrl": "http://localhost:3000",
                        "viewerRenderVersion": "1.21.4",
                        "viewerBotVersion": "26.1",
                        "account": {"using": {"name": "TestBot"}, "locked": True, "source": "lock"},
                    }
                elif self.path.startswith("/api/bot/market"):
                    payload = {
                        "ok": True,
                        "open": True,
                        "isMarket": True,
                        "title": "Trade Market",
                        "listings": [
                            {"slot": 10, "customName": "Spring", "price": 12000, "amount": 1},
                            {"slot": 11, "customName": "Spring", "price": 9000, "amount": 1},
                            {"slot": 12, "customName": "Wybel Paw", "price": 800, "amount": 3},
                        ],
                    }
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        return Handler

    def run(self):
        self.httpd.serve_forever()

    def stop(self):
        self.httpd.shutdown()


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
        # Recorded locally but not listed in the stub market, so it can only be
        # valued from history - the other half of the join.
        "comet": [21000, 21500, 22000, 21800, 22500, 23000, 23500, 24000,
                  24200, 24500, 25000, 25200, 25500, 26000, 26200, 26500, 27000, 27500],
    })

    env = {
        **os.environ,
        "HOME": str(home),
        "WYNN_DASHBOARD_PORT": str(PORT),
        "WYNN_NO_AUTOSPAWN": "1",
        # A stub stands in for the bot server, so /api/state is hermetic and
        # the real bot (if one is running) is never touched.
        "WYNN_BOT_SERVER_URL": f"http://localhost:{BOT_STUB_PORT}",
    }
    env.pop("WYNNVENTORY_API_KEY", None)

    bot_stub = BotStub(BOT_STUB_PORT)
    bot_stub.start()

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

        @test("Deltas join the live in-game ask with the local history")
        def _():
            status, body = get("/api/deltas")
            assert status == 200, body
            assert body["deltas"], f"expected deltas from the seeded history: {body}"
            by_item = {d["item"]: d for d in body["deltas"]}

            # The bot can see Spring in the market, so its ask is the real one,
            # not the last price we happened to record.
            spring = by_item["spring"]
            assert spring["source"] == "live_listing", spring["source"]
            assert spring["ask"] == 9000, "the cheapest live listing wins"
            # The live ask sets the price we would pay; it is not folded into
            # the recorded series, which stays exactly as long as it was.
            assert spring["n_points"] == 18, spring["n_points"]
            assert spring["live_listing"]["slot"] == 11, spring["live_listing"]

            # Comet is not listed in game, so it falls back to what we recorded.
            comet = by_item["comet"]
            assert comet["source"] == "local_history", comet["source"]
            assert comet["ask"] == 27500, comet
            assert comet["n_points"] == 18, comet

            assert body["live_listings_used"] == 2, body["live_listings_used"]
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
            status, body = get("/api/history_local?item=comet&days=30")
            assert status == 200, body
            assert len(body["points"]) == 18, body

            status, body = get("/api/trend?item=comet&days=30")
            assert status == 200, body
            assert body["regression"]["n"] == 18
            assert body["regression"]["slope_per_day"] > 0, "the seeded series rises"

            status, body = get("/api/watchlist")
            assert status == 200, body
            assert "spring" in body["watchlist"], body

        @test("/api/state is one snapshot of bot, account, market, engine and prices")
        def _():
            status, body = get("/api/state")
            assert status == 200, body
            assert body["ok"] is True
            assert body["services"]["botServer"] is True, body["services"]
            assert body["bot"]["username"] == "TestBot", body["bot"]
            assert body["bot"]["viewer"]["renderVersion"] == "1.21.4"
            assert body["account"]["locked"] is True, body["account"]
            assert body["engine"]["modelLoaded"] in (True, False)
            assert body["engine"]["marketFee"] == 0.05
            assert "spring" in body["prices"]["historyItems"], body["prices"]

        @test("The snapshot carries the cheapest live ask per item")
        def _():
            status, body = get("/api/state")
            assert status == 200, body
            market = body["market"]
            assert market["listingCount"] == 3, market
            cheapest = market["cheapest"]
            # Two Spring listings were sent; only the cheaper one survives.
            assert cheapest["spring"]["price"] == 9000, cheapest["spring"]
            assert cheapest["spring"]["slot"] == 11
            assert cheapest["wybel paw"]["price"] == 800

        @test("A stopped bot server degrades the snapshot instead of failing it")
        def _():
            bot_stub.stop()
            try:
                status, body = get("/api/state")
                assert status == 200, body
                assert body["ok"] is True, "the dashboard must still answer"
                assert body["services"]["botServer"] is False
                assert body["bot"] is None and body["market"] is None
                # The half that does not need the bot is still there.
                assert body["engine"]["features"], body["engine"]
                assert "spring" in body["prices"]["historyItems"]
            finally:
                pass

        @test("Reading the state records the market scan Phase 1 needs")
        def _():
            # /api/state reads the bot's market window; that read is also the
            # observation the liquidity measurements are built from.
            get("/api/state")
            scan_file = home / ".local" / "share" / "wynn-dashboard" / "market_scans.jsonl"
            assert scan_file.exists(), "a scan should have been recorded from the stub market"

            rows = [json.loads(line) for line in scan_file.read_text().splitlines() if line.strip()]
            scans = [r for r in rows if r["type"] == "market_scan"]
            observations = [r for r in rows if r["type"] == "listing_observation"]
            assert len(scans) >= 1, rows
            assert scans[0]["listing_count"] == 3, scans[0]
            assert {o["item_key"] for o in observations} == {"spring", "wybel paw"}, observations

            # The cheapest Spring listing is present with its integer price.
            spring = sorted(o["price"] for o in observations if o["item_key"] == "spring")
            assert spring == [9000, 12000], spring

            # And nothing in the log is keyed to a player.
            assert "seller" not in observations[0], observations[0]

        @test("Polling the state again does not re-log an unchanged market")
        def _():
            scan_file = home / ".local" / "share" / "wynn-dashboard" / "market_scans.jsonl"
            before = len([l for l in scan_file.read_text().splitlines() if '"market_scan"' in l])
            get("/api/state")
            get("/api/state")
            after = len([l for l in scan_file.read_text().splitlines() if '"market_scan"' in l])
            assert after == before, f"unchanged window logged again: {before} -> {after}"

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
        bot_stub.stop()

if FAILED:
    print(f"\n\033[1;31mTrade API tests: {PASSED} passed, {FAILED} failed.\033[0m")
    sys.exit(1)
print(f"\n\033[1;32mTrade API tests: {PASSED} passed.\033[0m")
