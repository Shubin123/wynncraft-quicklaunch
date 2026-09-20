# Testing Strategy — the game/engine bridge

How this repo tests the round trip: read the in-game market, extract it to the
external decision system, decide, send a trade back in, confirm the game
changed. Written against the code that exists, with the gaps named rather than
implied.

One rule shapes everything below: **the write path cannot be exercised against
Wynncraft.** A buy spends emeralds irreversibly, and automated trading there is
at best a rules question. So every test that issues a command runs against a
stand-in, or against the offline server in Layer 4 — a real protocol, on
localhost, that nobody's emeralds depend on. The live server is only ever read
from, by hand.

---

## Layer 1 — Units

Each module isolated, its collaborators replaced.

| Module | File | Tested by | Mocked |
|---|---|---|---|
| Extractor | `mineflayer-wynn/src/market.js` (`parseMarketWindow`, `classifySlot`) | `test_market.js` | the whole bot: a plain object with `currentWindow` |
| Translator | `parseEmeralds` / `formatEmeralds`, `src/blockstates.js` | `test_market.js`, `test_viewer.js`, `test_translation_properties.js` | nothing — pure functions |
| Decision | `scripts/wynn_trade_engine.py` | `test_trade_engine.py` | no I/O at all: series and quotes passed in |
| Executor | `market.buy` / `market.click` | `test_market.js`, `test_trade_journal.js` | `bot.clickWindow` records instead of clicking; journal path redirected |
| Recorder | `scripts/wynn_market_log.py` | `test_market_log.py` | clock injected (`now=`), log path via `WYNN_SCAN_FILE` |

**What keeps them decoupled.** The engine takes data, never fetches it —
`compute_delta(item, points, live, live_ask, model, strategy, hold_observation)`
has no idea a bot or an HTTP API exists, which is why it tests with no server
running. The extractor never decides anything. The executor never prices
anything; it is handed a name, a ceiling and an intent id.

**Edge cases already covered:** empty windows, windows that are not the market,
unknown items, missing lore, ties (equal prices keep insertion order via a
stable sort), stale data (`source` says `live_listing` / `wynnventory` /
`local_history`), thin histories (one point, two points), zero capital, and
blocks that do not exist in the render version.

---

## Layer 2 — Integration and contracts

| Seam | Test | What it proves |
|---|---|---|
| extractor → translator | `test_market.js` | lore text becomes integer emeralds and typed panes |
| **game → external** | `test_bridge_contract.js` + `test_bridge_contract.py` | both sides agree on the payload |
| translator → decision | `test_trade_api.py` | `/api/deltas` prices from live asks, falling back to history |
| recorder → decision | `test_trade_api.py` | recorded scans become measured hold times |
| decision → executor | `test_round_trip.js` | a plan leg is executable and refused when stale |

**The contract is the important one.** `tests/contracts/market_listing.v1.json`
is read by tests in both languages. Rename `customName` on the JS side and the
Python join finds nothing — no exception, just zero listings and every delta
quietly falling back to a stale price. That silence is the failure mode the
contract exists to break, and the Python test asserts the broken-rename case
explicitly so the check cannot rot into a tautology.

It has already paid: it caught the recorder writing rows with an empty
`item_key` for nameless listings — phantom entries that would have polluted
every lifetime and depth measurement.

**Malformed data crossing the boundary** is tested in both directions: null
windows, missing slots, lore that is a string instead of an array, prices with
no digits, listings with no name, `None` sellers, and hostile text (colour
codes, script tags, nulls, 5000-character names, emoji).

---

## Layer 3 — Round trip

`tests/test_round_trip.js` drives the full cycle against a stand-in game whose
state actually changes: a click removes the listing and debits emeralds, so
"did the world change as expected" is a real question.

| Concern | Test |
|---|---|
| Full cycle | read → extract → decide → buy → confirm the balance and the board both moved |
| **Idempotency** | a retry with the same `intentId` reports success, buys nothing extra, spends nothing extra |
| Staleness | a plan acted on after the board moved is refused, and nothing is clicked |
| Ordering | legs reach the game in the order the plan ranked them, re-reading between each |
| Latency | a slow game is waited for, not raced |
| Reconciliation | a repriced listing is stopped by the ceiling; when allowed, the result reports what was really paid |
| Safety | an unconfirmed or over-ceiling decision never touches the game |

The idempotency check sits **before** the executor looks at the board. That
ordering is not cosmetic: by the time a retry arrives the listing is usually
gone, so any check that inspects the board first fails with "that slot is
empty" and hides the fact that the trade already happened. The round-trip test
caught exactly that.

Intents are persisted. `mineflayer-wynn/src/journal.js` writes a
`trade_intent` before the click and a `trade_outcome` after, so idempotency
survives a restart (`test_trade_journal.js`), and a trade interrupted between
the two stays visible as unresolved rather than being assumed either way -
`GET /api/bot/trades/pending` lists them.

Those are now settled without anyone looking in the game. `reconcileIntent()`
reads the emerald balance against the one recorded before the click and
concludes in exactly two cases - the balance fell by what the listing asked, or
it did not move at all. Everything else stays pending. The tests are mostly
about what it refuses to conclude: a balance that moved by some other amount, an
intent too old for a balance to witness, and more than one intent outstanding
against a single balance, which cannot say which of them moved it. Holding the
item can veto a conclusion but never reach one, since the bot may have owned one
already.

---

## Layer 4 — The wire

`tests/test_protocol_harness.js`, against `tests/harness/wynn_server.js`: a real
`minecraft-protocol` server on localhost, and a real mineflayer bot joined to it
at **26.1** — the version `bot.js` negotiates with `play.wynncraft.com`. The
market is served as real packets, and the server owns its state: a click arrives
as `window_click`, and it is the server that removes the listing and debits the
purse.

Everything under the parser is real here — the socket, the packet schema,
prismarine-item, prismarine-windows, `bot.currentWindow`, `bot.clickWindow`, the
Wynncraft plugin. That is the point. The stand-ins in Layers 1–3 are written by
the same hand as the code they feed, so they agree with it by construction.

| Concern | What it proves |
|---|---|
| Container shape | a six-row window parses as 54 container slots, listings, controls and filler told apart |
| **Wire encoding** | `customName` arrives as a *component*, not a string, and the market code reads through it |
| Emeralds | counted off a real inventory, liquid emeralds included — those are an ordinary item wearing a custom name |
| Buy | the purchase leaves as one `window_click`, with the expected window, slot, button and mode |
| Effect | the server removes the listing and debits the purse, and the bot sees both |
| Reconciliation | `emeralds_before`/`emeralds_after` come from a balance the game reported, so `reconciled` means something |
| Idempotency | a retry puts no second packet on the wire, and spends nothing |
| **Reconciliation after a crash** | a session dies between the intent and the outcome; the next one settles it against the balance the server reports, and a retry of the settled intent buys nothing |
| Reconciliation, the other way | a session that died *before* the click leaves the balance untouched, which settles it as never executed - and does not stand in the way of doing it |
| Refusal | unconfirmed, over-ceiling and wrong-item buys send no packet at all |
| Page turn | a control click is a real packet, and the next page is a real window |
| Title guard | a window that is not the market is not treated as one |

**It paid on the first run.** `countEmeralds()` read
`stripFormatting(item.customName)`, and since 1.20.5 a custom name travels as a
data component carrying an NBT text component, not a string. `stripFormatting`
returns `''` for anything that is not a string, so every liquid emerald — 4096
emeralds each — counted as none: a purse of 3 le read as 0. Nothing failed,
anywhere, because every stand-in in this repo hands over a string. The same
assumption was live in two other places (`repl.js`, and the inventory pane in
`wynn_bot_server.js`); all three read `extractCleanText` now, which takes both
shapes.

That is the argument for this layer in one line. The bug sat on the money path —
it fed `emeralds_before`/`emeralds_after`, and so every reconciliation — and it
was invisible to every test that did not have a socket in it.

**What it is not.** The harness serves what the market code reads: a titled
container of named, lored items, and enough of a join sequence to spawn. It is
not a Wynncraft emulator — no lobby, no character selection, no world gates, and
the plugin's login automation is switched off for it.

---

## Layer 5 — Properties, fuzz, chaos

**Property-based** (`test_translation_properties.js`, seeded so failures
reproduce): emerald formatting round-trips over thousands of values; formatting
is a fixed point; the dashboard and the bot agree on *every* amount, not just
the examples; unit order does not change a total; every block state maps into
the render version's palette.

**Fuzz on the boundary parser**: random and hostile lore, names and prices into
`parseEmeralds` and `classifySlot`. The invariants are that nothing throws and
nothing unusable escapes — no NaN, no fraction, no negative price reaching the
engine, and every pane classified as one of the known kinds.

**Chaos / failure injection** — partly covered:

| Failure | Status |
|---|---|
| Bot server stopped | covered — `/api/state` degrades, `services.botServer` false |
| Wynnventory unreachable | covered — deltas fall back to local history |
| Corrupt state files | covered — lock file, scan log torn mid-write, strategy file |
| Unwritable config | covered — reported, not thrown |
| Disconnect mid-trade | covered — the click throws, the outcome records `failed`, nothing is claimed about the balance |
| Process death mid-trade | covered — an intent with no outcome stays pending for reconciliation |
| Server lag / timeout on a click | partly — latency is tested, a hung click is not |

**Load** is a gap. Nothing measures behaviour at high scan or trade frequency,
and the honest reason is that the sensible ceiling here is politeness to the
server, not throughput.

---

## Structure

```
tests/
  contracts/market_listing.v1.json   both languages read this
  harness/wynn_server.js             a real server, offline, on localhost
  test_bridge_contract.{js,py}       one seam, two sides
  test_trade_journal.js              intents on disk: restart, disconnect
  test_round_trip.js                 the cycle, against a stand-in game
  test_protocol_harness.js           the cycle, over the real protocol
  test_trades_api.js                 the trade record over HTTP, own server
  test_translation_properties.js     properties and fuzz
  test_market_log.py                 recorder and derivations
  test_trade_engine.py               decision layer, no I/O
  test_trade_api.py                  HTTP surface, throwaway server + stub bot
  run_all_tests.sh                   everything, in dependency order
mineflayer-wynn/tests/               game-side units
```

Conventions that keep it maintainable:

- **No test touches real state.** Temporary `HOME`, `PRISM_DIR`,
  `WYNN_SCAN_FILE`, `WYNN_BOT_ACCOUNT_FILE`, `WYNN_JOURNAL_FILE`; servers on
  throwaway ports. Adding the journal broke this for one run - the round-trip
  tests wrote real trade rows into the live data directory before the override
  existed - so every new on-disk record needs its redirect from the start.
- **Time and randomness are injected.** `now=` parameters and seeded RNGs, so
  nothing depends on the wall clock or luck.
- **Stand-ins mirror the real shape.** When a stub diverges from reality the
  test passes while the code is broken. Three times here: a three r128 stub
  using prototype methods the real library defines as own properties; drag
  tests that dispatched events straight at elements and skipped hit-testing;
  and market stand-ins handing over `customName` as a string, which the wire
  has not done since 1.20.5. All three now model the real thing — the last one
  only because Layer 4 put a socket in the way.
- **The suite refuses to act on a live bot.** The end-to-end tests detect a
  connected bot and skip the ones that would chat, walk or click in game.

## Gaps, in the order worth closing

1. **The login flow against a real server** — the harness spawns the bot
   straight into a world. Wynncraft does not: there is a lobby, a character
   selection chest and a world gate between login and play, and `wynncraft.js`
   automates all three against windows nothing tests over a socket. It is the
   same class of assumption the emerald bug was.
2. **A hung click** — latency is tested, a click that never comes back is not.
3. **Multi-unit pricing** — the buy path and reconciliation both read a
   listing's price as per unit and multiply by `units`, which is unverified for
   a stack; `classifySlot()` parses a separate `unitPrice` only when the lore
   says "each". A multi-unit trade therefore fails to reconcile and stays
   pending. That is the safe direction, but it is an unanswered question, not a
   decision — see the open questions in the data dictionary.
4. **Load** — only once there is a reason to believe frequency matters.

*Closed:* persistent intents and disconnect-mid-trade, by the trade journal;
the offline server harness, by Layer 4; automatic reconciliation, by
`reconcileIntent()` and `POST /api/bot/trades/reconcile`.

One thing reconciliation deliberately does not do is run itself. It writes to
the trade record, and doing that unprompted on every reconnect would put
inferred outcomes into a journal whose value is that it says what is known. It
is a call the operator makes; what has been removed is the need to go and look
in the game to answer it.
