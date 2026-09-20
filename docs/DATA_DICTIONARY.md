# Data Dictionary — Phase 1 Data Foundation

The event schema every downstream forecast depends on. One vocabulary, one set
of identifiers, one clock, so the price pages, the trade engine and the bot all
mean the same thing by the same word.

Status: specification. Sources marked **existing** are already recorded by the
code named; those marked **new** are the additions Phase 1 introduces.

---

## 1. What is recorded, and what is not

This layer records **prices and the market**, plus **your own** play and trades.
It does not build per-player records.

| Recorded | Not recorded |
|---|---|
| Item prices, spreads, listing counts | Any other player's balances, purchases or progression |
| How many *distinct* sellers list an item | Which named player listed which item, retained |
| How long listings survive before vanishing | Per-player session or login patterns |
| Aggregate supply by hour of day | Chat keyed to a speaker |
| Your own sessions, inventory, trades, outcomes | Guild/party membership of others |

Seller names appear in the Trade Market UI and are needed **momentarily** to
count distinct sellers within a single scan. They are counted and discarded:
no event below has a seller-name field, and nothing keyed to a person is
written to disk. Three reasons, in order of how much they bind:

1. Operator-side signals (real balances, purchases, premium conversion) are not
   visible to a client at all, so models over them have no input.
2. A bot logging every observation forever, keyed to a person, is a different
   act from a player noticing something in passing.
3. Automated collection is very likely against Wynncraft's rules.

The aggregate measures below are what the forecasting layer actually needs:
`estimate_hold_days()` in `scripts/wynn_trade_engine.py` currently *guesses*
liquidity from pool size and sample density, and these events replace that
guess with a measurement.

---

## 2. Identifiers and time

| Concept | Rule | Example |
|---|---|---|
| `ts` | Epoch seconds, UTC, float. Matches the existing `history.jsonl`. | `1758291234.512` |
| `item_key` | Lowercased display name, trimmed, spaces collapsed. The join key across every source. | `"boreal-patterned aegis"` |
| `item_variant` | `item_key` plus tier and shiny, when a price depends on them. | `"spring\|legendary\|shiny"` |
| `scan_id` | UUIDv4 per Trade Market window read. Groups listings seen together. | `"b2c1…"` |
| `session_id` | UUIDv4 per bot connection. Groups everything one login produced. | `"7f3a…"` |
| `intent_id` | UUIDv4 per trade *intention*, created before any click. The idempotency key. | `"91de…"` |
| `plan_id` | UUIDv4 per allocation produced by `/api/plan`. | `"4c77…"` |

**Prices are always integers of plain emeralds.** `stx`/`le`/`eb`/`e` notation
is a display format only, parsed by `parseEmeralds()` in
`mineflayer-wynn/src/market.js` and rendered by `formatEmeralds()`. No event
stores a formatted string. 1 stx = 262144, 1 le = 4096, 1 eb = 64.

**Item identity is by name, not slot.** A slot index is a position in a GUI
that repaints; it is never an identifier. (This is the defect the cloud review
caught in the buy path: a purchase keyed to a slot bought whatever later
occupied it.)

---

## 3. Event types

### 3.1 `price_point` — **existing**

Written by `record_snapshot()` in `scripts/wynn_price_server.py` to
`~/.local/share/wynn-dashboard/history.jsonl`, one JSON object per line, on
every successful Wynnventory lookup.

| Field | Type | Notes |
|---|---|---|
| `ts` | float | Epoch seconds |
| `item` | string | Currently the raw query; **Phase 1 change:** normalise to `item_key` |
| `lowest_price` | int\|null | Emeralds |
| `highest_price` | int\|null | |
| `average_price` | int\|null | |
| `p50_price` | int\|null | Median; the engine's preferred fair-value reference |

**Phase 1 additions:** `source` (`"wynnventory"`), `total_count` (listing pool
size, already returned upstream but currently dropped), and `item_variant`.

### 3.2 `market_scan` — **new**

One read of a Trade Market window by the bot. The unit of observation for
everything in §3.3.

| Field | Type | Notes |
|---|---|---|
| `scan_id` | uuid | |
| `ts` | float | |
| `session_id` | uuid | |
| `world` | string\|null | e.g. `"NA3"`, from `bot.wynn.currentServer` |
| `query` | string\|null | The search that produced this page, if any |
| `page` | int\|null | From the market window's page label |
| `listing_count` | int | Listings parsed in this window |
| `distinct_sellers` | int | Counted from the window, names discarded |
| `container_slots` | int | Window size, for parser diagnostics |

Source: `parseMarketWindow()` in `mineflayer-wynn/src/market.js`.

### 3.3 `listing_observation` — **new**

One listing as seen in one scan. Append-only; a listing seen across five scans
produces five rows, which is what makes lifetimes measurable.

| Field | Type | Notes |
|---|---|---|
| `scan_id` | uuid | Joins to `market_scan` |
| `ts` | float | |
| `item_key` | string | |
| `item_variant` | string | |
| `price` | int | Emeralds, per unit where the listing says so |
| `amount` | int | Units in the listing |
| `tier` | string\|null | `mythic`…`normal` |
| `shiny` | bool | |
| `listing_fingerprint` | string | `sha1(item_variant + price + amount)`, truncated. Tracks *a listing* across scans without naming who posted it |
| `identifications` | object\|absent | The roll, as displayed: `{apiKey: value}` read off the listing's lore by `parse_identification_lore()`. **Absent** when nothing was read — which is not the same claim as an empty object, and must never be scored as a bad roll |

**Why the roll is recorded raw.** A Wynncraft item is a family of goods: every
drop rolls each identification independently, so a price recorded against a name
alone is an average over that family. `identifications` is the only record of
which member of the family was actually on the board.

It is stored exactly as displayed, and scored nowhere near here. Turning a rolled
value into a quality or a percentile needs the item database (which changes on
game updates) and a set of attribute weights (which the optimizer rewrites on
every retrain); baking either into the log would freeze them and make an old row
incomparable with a new one. Scoring is therefore a derivation —
`derive_roll_quality()` — alongside `listing_lifecycle` and `market_depth`.

**Why the roll is *not* part of `item_variant`.** It is tempting, and it would be
wrong. `item_variant` is the key a price series is grouped by, and a variant that
carried the roll would be unique to a single copy: every series would collapse to
one observation, every item would have no price level, and the roll model has
nothing left to be a multiple *of*. The decomposition needs both — a coarse
variant that says what an Idol costs, and a separate roll dimension that says
what this Idol is worth relative to that. `listing_fingerprint` is left alone for
the same reason plus one more: the parser's coverage varies with what the lore
renders, so a fingerprint that included the roll could change between scans for
one unchanged listing and read as a disappearance, corrupting every lifetime.

### 3.4 `listing_lifecycle` — **new, derived**

Produced by comparing consecutive scans of the same query. This is the real
liquidity measurement.

| Field | Type | Notes |
|---|---|---|
| `item_key` | string | |
| `listing_fingerprint` | string | |
| `first_seen_ts` | float | |
| `last_seen_ts` | float | |
| `disappeared_ts` | float\|null | First scan in which it was absent |
| `lifetime_seconds` | float\|null | `disappeared_ts - first_seen_ts` |
| `was_cheapest` | bool | Whether it was the lowest ask while present |
| `resolution` | enum | `sold_or_pulled` \| `still_listed` \| `unknown` |

`resolution` is deliberately coarse: a listing vanishing means sold **or**
cancelled, and a client cannot tell which. Anything built on this must treat
it as an upper bound on sale rate, not a sale count.

### 3.5 `market_depth` — **new, derived**

Per `item_key` per scan, the aggregate shape of supply.

| Field | Type | Notes |
|---|---|---|
| `ts`, `item_key` | | |
| `ask_min`, `ask_p50`, `ask_max` | int | Emeralds |
| `listing_count` | int | |
| `distinct_sellers` | int | |
| `undercut_delta` | int\|null | `ask_min` now minus `ask_min` at the previous scan; negative means the floor was undercut |
| `hour_of_day_utc` | int | 0–23, for supply seasonality |

### 3.6 `own_session` — **new**

Your bot's own play. No other player appears here.

| Field | Type | Notes |
|---|---|---|
| `session_id` | uuid | |
| `started_ts`, `ended_ts` | float | |
| `account_name` | string | Which account the lock resolved to |
| `character` | string\|null | |
| `worlds` | string[] | Worlds visited |
| `end_reason` | string | `user` \| `kicked` \| `error` \| `crash` |

### 3.7 `own_inventory_snapshot` — **new**

| Field | Type | Notes |
|---|---|---|
| `ts`, `session_id` | | |
| `emeralds_total` | int | From `wynn.countEmeralds()` |
| `items` | array | `{item_key, count}`; your own inventory only |

### 3.8 `trade_intent` and `trade_outcome` — **new**

The two halves of a trade, split so an intention exists before anything is
clicked. `intent_id` is the idempotency key: a retry reuses it, and the
executor refuses a second execution of an id it has already completed.

`trade_intent`:

| Field | Type | Notes |
|---|---|---|
| `intent_id` | uuid | |
| `ts`, `session_id`, `plan_id` | | |
| `side` | enum | `buy` \| `sell` |
| `item_key`, `item_variant` | string | What was meant — checked against the pane before clicking (`expectItem`) |
| `units` | int | |
| `limit_price` | int | Ceiling for a buy, floor for a sell |
| `observed_price` | int\|null | What the board actually asked, read off the pane before clicking. Distinct from `limit_price`, which is only what we refused to exceed — reconciliation needs the ask, because "did the balance fall by the price" has no answer without it |
| `expected_fair_value` | int | What the engine thought it was worth |
| `confirmed_by` | enum | `human` \| `dry_run`. No third value exists today |

`trade_outcome`:

| Field | Type | Notes |
|---|---|---|
| `intent_id` | uuid | |
| `ts` | float | |
| `status` | enum | `executed` \| `not_executed` \| `refused_identity` \| `refused_price` \| `refused_unconfirmed` \| `failed` \| `timeout` |
| `actual_price` | int\|null | |
| `emeralds_before`, `emeralds_after` | int\|null | Reconciliation: did the balance move by what was expected |
| `reconciled` | bool\|null | `emeralds_before - emeralds_after == actual_price * units`. Null when there is nothing to reconcile — a trade that never happened has no books to agree |
| `resolution` | enum\|null | `observed` (the buy path watched it) \| `reconciled` (inferred afterwards from the balance). An inferred outcome must never read as a witnessed one |
| `reason` | string\|null | Why reconciliation concluded what it did |
| `age_seconds` | int\|null | How old the intent was when it was settled |
| `error` | string\|null | |

`not_executed` exists only for reconciliation: it is the answer to "the click may
never have gone out", and unlike `executed` it does not refuse a later retry —
a trade that did not happen is one the user may still want to make.

**Settling a pending intent.** An intent with no outcome is a trade whose result
nobody knows. `reconcileIntent()` in `mineflayer-wynn/src/journal.js` reads the
emerald balance against `emeralds_before` and concludes only in two cases: the
balance fell by exactly `observed_price * units` (`executed`), or it did not
move at all (`not_executed`). Everything else — a different amount, a missing
balance, an intent older than an hour, or more than one intent outstanding
against a single balance — stays pending, because a wrong `executed` silently
drops a trade the user meant to make and a wrong `not_executed` buys the same
thing twice.

### 3.9 `decision` — **new**

One run of the engine, so a forecast can be scored later against what happened.

| Field | Type | Notes |
|---|---|---|
| `plan_id`, `ts` | | |
| `strategy` | object | The eight parameters in force (`wynn_trade_engine.DEFAULT_STRATEGY`) |
| `model_version` | string\|null | Hash of the weights used |
| `candidates` | array | Per item: `item_key`, `ask`, `fair_value`, `delta`, `roi`, `hold_days`, `source` |
| `legs` | array | What the plan actually funded |

`source` records which of the three inputs set the ask — `live_listing`,
`wynnventory`, `local_history` — because a forecast built on a stale price
must be scored differently from one built on a live one.

---

## 4. Storage

| Stream | Location | Format | Retention |
|---|---|---|---|
| `price_point` | `~/.local/share/wynn-dashboard/history.jsonl` | JSONL | Indefinite; small |
| `market_scan`, `listing_observation` | `.../market_scans.jsonl` | JSONL, `type` field discriminates | 90 days rolling |
| Derived (`listing_lifecycle`, `market_depth`) | `.../derived/*.jsonl` | JSONL | Rebuildable from the above |
| `own_*`, `trade_*`, `decision` | `.../journal.jsonl` | JSONL | Indefinite; it is your own trading record |

JSONL throughout, matching what the project already does: append-only, greppable,
survives a crash mid-write, no database to run. One reader per file
(`read_history_rows()` is the existing pattern).

---

## 5. Where each field comes from today

| Event | Producer | Status |
|---|---|---|
| `price_point` | `record_snapshot()`, `scripts/wynn_price_server.py` | existing, needs `item_key` normalisation |
| `market_scan`, `listing_observation` | `record_scan()`, `scripts/wynn_market_log.py`, fed by `/api/state` | **implemented**, rolls included |
| `listing_observation.identifications` | `parse_identification_lore()`, `scripts/wynn_item_db.py` | **implemented** |
| roll quality / percentile | `derive_roll_quality()`, `scripts/wynn_market_log.py` | **implemented**, derived not recorded |
| `market_depth`, `listing_lifecycle` | `derive_depth()` / `derive_lifecycles()`, same module | **implemented** |
| `own_inventory_snapshot` | `wynn.countEmeralds()`, `getInventory()` | available, not persisted |
| `trade_intent`/`trade_outcome` | `market.buy()` + `/api/bot/market/buy` | guards exist (`confirm`, `maxPrice`, `expectItem`); journal is new |
| reconciled outcomes | `market.reconcilePending()` + `POST /api/bot/trades/reconcile` | **implemented**; lists what it could not settle |
| `decision` | `/api/plan`, `wynn_trade_engine.plan_liquidity()` | computed already, not persisted |

---

## 6. What this unlocks downstream

- **A measured hold time.** *(done)* `estimate_hold_days()` now takes the
  median observed lifetime when there is one, blended against the old pool-size
  proxy in proportion to how many lifetimes back it — full weight at
  `HOLD_CONFIDENCE_SAMPLES` (5), so evidence earns its influence instead of one
  lucky observation swinging a plan. Every delta carries `hold_source`
  (`measured` / `blended` / `heuristic`) and `hold_samples`, and the liquidity
  page marks a measured hold with `*`.
- **Scoreable forecasts.** `decision` plus later `price_point`s makes every
  prediction checkable after the fact, which is what Phase 2's calibration
  tracking needs and what the GA's fitness currently approximates in-sample.
- **Honest reconciliation.** `trade_outcome.reconciled` answers "did the game
  agree with what we thought we did", which is the backbone of the round-trip
  tests.
- **Supply seasonality.** `market_depth.hour_of_day_utc` over weeks shows when
  an item is cheap, without reference to any individual.

## 7. Open questions

1. Scan cadence: currently 60s between repeats of an *unchanged* window
   (`WYNN_SCAN_INTERVAL`); a changed window is always recorded. Lifetime
   resolution is bounded by how often the market is actually read, which today
   is whenever a dashboard tab polls `/api/state` with a market window open.
   Worth revisiting once the bot scans on a schedule of its own.
2. ~~Variant granularity: are rolled gear stats worth a separate
   `item_variant`?~~ **Settled: no.** The roll is recorded as its own field and
   `item_variant` stays name+tier+shiny, because a variant per roll would leave
   every price series one observation long. See §3.3. What remains open is
   whether tier and shiny are the right *coarse* split, which is a different
   and much smaller question.
3. Retention of `listing_observation` at 90 days — long enough for seasonality,
   short enough to stay small. Adjustable.
4. Whether Wynncraft's lore already states the roll percentage directly. If it
   does, reading it would beat recovering it from the value and the published
   range, and would not depend on the item database being current. The parser
   strips bracketed text today, so if a `[73%]` is in there it is being thrown
   away. Worth one look at real lore.
5. Whether a listing's `price` is per unit or for the lot. Both the buy path and
   reconciliation read it as per unit and multiply by `units`, which is right
   for the single-unit listings the market mostly shows and unverified for a
   stack. `classifySlot()` parses a separate `unitPrice` when the lore says
   "each", so the two disagree for any listing that does not. Until it is
   settled, a multi-unit trade simply fails to reconcile and stays pending —
   the safe direction, but a gap rather than an answer.
