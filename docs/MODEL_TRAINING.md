# Training the trading model

How the decision layer gets trained, what it can learn from the data that
exists, and what it cannot learn until the recorder is capturing more.

Status: the pipeline runs and produces a model. Its **price response is trained
against a simulator, not against Wynncraft**, and every artifact it writes is
stamped `calibration: "synthetic"`. Section 6 is the honest reading of that.

---

## 1. The problem with the model we had

`wynn_trade_engine.py` builds nine features, and every one of them is a
statistic of a single item's price series: momentum, volatility, spread, trend,
pool size. That is the right model for a fungible good — a barrel of oil is a
barrel of oil — and the wrong one for Wynncraft gear.

A Wynncraft item is not a good. It is a **family** of goods. Every drop rolls
each of its identifications independently, so two copies of the same item are
different products that happen to share a name. The database is explicit about
it: of 29,783 identifications across 6,725 items, 19,787 arrive as
`{min, raw, max}` — a range the drop lands somewhere inside.

Keying every feature off the item's name averages that family together and
calls the average a price. The measured cost of doing so is in §5: on the top
decile of rolls, the name-only model misprices by a median of **112%**, and its
error is one-sided — it **underprices** good rolls by a factor of about 2.3.
Those are exactly the listings worth buying.

## 2. The decomposition

    value(this copy)  =  value(the item)  ×  exp( roll_model(this copy's roll) )
                         └── price series ─┘   └────── new ──────┘

The existing series model keeps its job: what is an Idol worth. The new model
answers what *this* Idol is worth, as a multiple of a median-roll copy.

Keeping the second term **item-relative is what makes it learnable at all**. An
absolute price model needs enough observations per item to pin down each item's
own level, and the market will never supply that for 6,725 items. A multiplier
is shared across every item in the game, so every observation of every item is
evidence about one curve.

It also hands us a free and unusually honest baseline: predicting zero *is* the
current engine. Every number in §5 is measured against what the code does today,
not against a straw man.

## 3. Reading a roll

`scripts/wynn_item_db.py`, against the official database
(`api.wynncraft.com/v3/item/database?fullResult`, cached weekly).

**Quality.** `(rolled - min) / (max - min)` — 0 at the worst possible roll, 1 at
the best. This works because of an invariant that holds across the whole
database and is asserted there rather than assumed: **`max` is always the better
roll and `min` always the worse one**, in all four sign quadrants.

| case | example | `min` | `max` |
|---|---|---|---|
| ordinary bonus | `rawStrength` | worst | best |
| penalty on a good stat | `rawHealth: {-2340, -1800, -1260}` | worst | best (least penalty) |
| cost reduction (order inverts) | `raw3rdSpellCost: {-1, -3, -4}` | worst | best (most reduction) |
| cost increase, positive base | `1stSpellCost: {30, 23, 16}` | worst | best (least cost) |

That is why there is no per-stat "higher is better" table. A direction table is
precisely the thing that rots silently when Wynncraft adds an identification,
and `tests/test_roll_model.py` checks all four quadrants against real entries.

**Fixed identifications are ignored.** A plain integer is identical on every
copy and is evidence about nothing.

**Percentile, not average.** This is the part that matters, and the reason a
plain average of roll percentages misleads. Each attribute rolls roughly
uniformly, so a weighted mean of *k* of them concentrates on 0.5 with a spread
falling like 1/√k:

| same mean quality 0.85, across *k* attributes | percentile |
|---|---|
| k = 1 | 0.850 |
| k = 2 | 0.957 |
| k = 3 | 0.982 |
| k = 5 | 0.997 |
| k = 8 | 0.9997 |

Identical "85%", wildly different scarcity — and scarcity is what gets paid for.
A model fed the mean cannot tell those apart; one fed the percentile can. §5
measures what that is worth.

Exact for one attribute; a normal approximation above that, which is good in the
middle and optimistic in the far tail. It is used to rank, never quoted as a
probability.

**Coverage.** Lore carries colour codes, glyphs and wrapping, and the parser
will miss lines. A missed attribute is recorded as *unobserved*, never as a bad
roll, and the observed fraction is handed to the model as a feature so it can
discount a roll it only half saw.

## 4. Ten groups, not ninety-six

There are 96 distinct identifications. Fitting 96 coefficients against the
number of prices this market will ever yield would fit noise, so they collapse
into ten groups that players actually trade on — skill points, damage %, raw
damage, defence, health, mana, spell cost, sustain, mobility, utility — assigned
by rule rather than by a 96-line table, so an identification added later lands
somewhere sensible instead of vanishing.

**The group weights are what the evolutionary side searches.** A gradient is no
use: the weights enter through a percentile computed by sorting and a normal
CDF, and the objective is a rank correlation, which has no useful derivative.
Ten bounded parameters is exactly the size of problem a small GA is for. Fitness
is Spearman correlation between the percentile a candidate computes and the
realised price — rank correlation, because the *shape* of the premium curve is
the network's job and the weights only have to get the ordering right.

The network then fits the curve: a small tanh MLP over tier, level, observed
count, coverage, weighted quality, best single roll, percentile and its square.
Same hand-written MLP the engine already ships — no numpy, weights serialise to
JSON.

## 5. What the training run measures

`python3 scripts/wynn_train.py` — about 40 seconds, 220 items × 14 listings.

Four models on identical rows, held out **by item** (copies of one item never
straddle the split, or the model learns the item instead of the curve):

| model | what it knows | held-out R² | median error | top-decile error | top-decile bias |
|---|---|---|---|---|---|
| `null` | nothing — **the engine today** | −0.130 | 28.7% | 111.7% | **−0.84** |
| `blind` | tier, level, attribute count | +0.012 | 36.9% | 64.5% | −0.57 |
| `naive_roll` | + mean and best quality | +0.584 | 18.9% | 20.7% | −0.07 |
| `aware` (neutral weights) | + percentile, coverage | +0.602 | 17.8% | 17.9% | −0.07 |
| `aware` (evolved weights) | + searched group weights | **+0.665** | 18.3% | 20.4% | **−0.035** |

Read across four seeds, not one: `aware` R² ranged +0.52…+0.67 and beat
`naive_roll` every time; `null` sat at −0.12…−0.14 throughout.

Three things worth saying plainly:

- **Knowing the item but not the roll is nearly worthless.** `blind` moves R²
  from −0.13 to +0.01 and makes the median error *worse*. Tier and level do not
  substitute for the roll.
- **The percentile earns its place over a plain average**, and the evolved
  weights earn theirs over neutral ones — but the second gain is smaller than
  the first, and it shows up in R² and in tail bias rather than in median error.
  The evolved model trades slightly worse central accuracy for materially less
  bias where the money is. For a buyer that is the right trade; it is also a
  judgement, not a fact the data forced.
- **The tail is where the model is weakest and where the profit is.** Top rolls
  are rare by construction, so the fit is thinnest exactly where it is asked to
  be boldest. Predictions are therefore clamped to the range of log-ratios
  actually seen in training, and `roll_multiplier()` reports `extrapolated: true`
  when it hits that bound.

**Weight recovery.** The simulator hides a set of group weights; the GA is asked
to find them from prices alone. Spearman between recovered and hidden weights
across four seeds: **+0.82, +0.89, +0.86, +0.45**. Consistently positive, not
reliably precise — a ten-parameter search over 30 generations does not always
converge tightly, and the run reports the hidden weights beside the recovered
ones so a reader can judge rather than trust the correlation.

## 6. What this does and does not establish

**It does not establish anything about Wynncraft's prices.** There are none. The
data directory is empty, Wynnventory needs an API key that is not configured,
and the market recorder does not yet read identifications off a listing's lore.

So the run is a **recovery experiment**. The simulator (`wynn_market_sim.py`,
every assumption a named constant) hides a premium curve and a set of weights,
and the pipeline is asked to find them. Recovering them shows the machinery can
learn this shape of thing from this volume of data. It shows nothing about
whether players actually pay a 6× premium for a perfect roll, because that
number is one I chose.

What *is* grounded in real data is the whole roll apparatus: real items, real
ranges, the four-quadrant invariant, the attribute vocabulary, the scarcity
arithmetic. That part does not change when prices arrive.

Concretely, trust the artifact for: ranking two listings of the same item,
wiring, and sizing the work still to do. Do not trust it for: what anything is
worth.

## 7. Getting to a calibrated model

In dependency order.

1. ~~**Record identifications.**~~ **Done.** `record_scan()` now calls
   `parse_identification_lore()` and writes the roll onto
   `listing_observation.identifications`, absent rather than empty when nothing
   was read. Scoring is a derivation (`derive_roll_quality()`), not part of the
   observation, because it depends on the item database and the attribute
   weights and both move.

   One thing said here earlier was wrong: that `item_variant` should carry the
   roll. It should not. `item_variant` is what a price series is grouped by, and
   a variant per roll would make every series exactly one observation long —
   leaving the item with no price level for the multiplier to multiply. The
   decomposition in §2 needs a coarse variant *and* a separate roll dimension,
   which is what it now has.

   The parser is unit-aware, which matters more than it sounds: 29
   identifications come in a percentage form and a flat form sharing one display
   label — "Spell Damage" is `spellDamage` with a `%` and `rawSpellDamage`
   without. Scoring a flat roll against a percentage range would not be a small
   error, since the ranges are different sizes.
2. **Record sales, not just listings.** `listing_lifecycle.resolution` is
   deliberately coarse — a listing that vanishes was sold *or* pulled. For
   training, a vanished listing at a known price and roll is a usable upper
   bound on a sale, and should be labelled as such rather than as a sale.
3. ~~**Retrain on recorded listings.**~~ **Wired, waiting on data.**
   `wynn_train.py --from-log market_scans.jsonl` reads recorded rows via
   `training_rows()`, labels each listing against the median price of its own
   item, and stamps the artifact `calibration: "observed"` with no
   weight-recovery claim, because against real prices there is no hidden answer
   to recover. It refuses to run on fewer than 50 usable listings: a model
   fitted to a handful would still carry the `observed` stamp, and the stamp is
   what anyone downstream reads.

   An item observed at only one price contributes nothing — its own price is the
   median, so the label is zero by construction, and feeding that in would teach
   the model that rolls do not move prices.

   What is still missing is the data. Nothing has been recorded yet, so nothing
   has been trained this way except in tests.
4. **Score the forecasts.** `decision` rows plus later `price_point`s make every
   call checkable after the fact (data dictionary §6). Until that loop closes,
   held-out R² is the only evidence there is, and held-out R² on one's own
   simulator is a weak kind of evidence.

## 8. Open questions

- **Is a roll's value separable from the item's?** The whole decomposition
  assumes the premium curve has one shape, scaled by tier. It may not: a stat
  that is build-defining on one item is filler on another, which a
  ten-group global weighting cannot express. Per-archetype weights would, at
  the cost of far more data.
- **Are two listings of the same item even comparable?** Assumed throughout,
  and the data dictionary already flags variant granularity as unresolved.
- **The premium curve's convexity is a guess.** `PREMIUM_EXPONENT = 3.0` says
  nobody pays for the 60th percentile and everybody bids for the 99th. It is
  plausible for a collectors' market and completely unverified here.
- **Sale price versus asking price.** Everything above trains on asks. What a
  seller asked and what they got are different numbers, and only the second is
  a price.
