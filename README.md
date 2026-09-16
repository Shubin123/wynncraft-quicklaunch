# Wynncraft Quick Launch

A Prism Launcher instance + quick-launch shortcut for playing Wynncraft with
[Wynntils](https://wynntils.com) and [Wynnventory](https://www.wynnventory.com)
(trade market price tooltips), without going through Prism Launcher's full UI
every time.

## Why Wynnventory instead of Salt Road

"Salt Road" (a Wynnventory fork) is locked to Minecraft `>=1.21 <=1.21.1` and
hasn't been updated since October 2024. Wynncraft currently requires Minecraft
**1.21.4+**, so Salt Road can no longer connect to the live server. Wynnventory
is the actively maintained original and currently ships for **1.21.11**, which
is what this setup uses.

## What's here

- `instance/` - a Prism Launcher instance definition (`mmc-pack.json`,
  `instance.cfg`) targeting Minecraft 1.21.11 + Fabric Loader, configured to
  auto-join `play.wynncraft.com` on launch.
- `desktop/wynncraft-quicklaunch.desktop` - a Linux desktop entry that launches
  directly into the instance and server, bypassing Prism's instance picker.
- `scripts/install.sh` - sets everything up from scratch: creates the instance,
  downloads the mod jars, installs the desktop entry.
- `dashboard/index.html` - a read-only, static price-reference page for the
  Trade Market (see note below on data access).

## Setup

Prerequisites: [Prism Launcher](https://prismlauncher.org) installed and a
Microsoft/Minecraft account already added to it.

```bash
git clone <this repo>
cd wynncraft-quicklaunch
./scripts/install.sh
```

Then, once:

1. Open Prism Launcher and click into the **Wynncraft-1.21.11** instance once.
   This lets Prism download the actual Minecraft/Fabric files and prompts you
   to accept Mojang's EULA. You only need to do this the first time.
2. Launch a session for your Microsoft account inside Prism at least once so
   it's cached (Account menu -> Manage Accounts).

After that, use the **"Wynncraft (Quick Launch)"** entry in your application
launcher, or run:

```bash
prismlauncher -l "Wynncraft-1.21.11" -s play.wynncraft.com
```

This skips Prism's main window and launches Minecraft straight into the
Wynncraft server, with Wynntils/Wynnventory already loaded.

## Mods installed

| Mod | Version | Purpose |
|---|---|---|
| Fabric API | 0.141.6+1.21.11 | Required by the mods below |
| Cloth Config | 21.11.153 | Config screens |
| Mod Menu | 17.0.1-beta.1 | In-game mod config UI |
| Wynntils | v4.2.11 | Core Wynncraft gameplay enhancements |
| Wynnventory | v2.2.4 | Trade Market price tooltips |

## Trading

There is no automated or headless way to place Trade Market orders in this
setup, by design. Wynncraft's rules prohibit unofficial clients or scripts
performing game actions on a player's behalf, so all trading happens by hand
in the actual Minecraft window this instance launches. Wynntils/Wynnventory
speed this up by showing live price tooltips directly on items while you
browse the market in-game.

## Price dashboard

`dashboard/index.html` is a read-only reference page for Trade Market prices.
Wynnventory's API requires a developer key from their team (Discord:
`@Aruloci` / `@Sirop`), and their API doesn't send CORS headers, so a plain
static page can't call it directly from the browser. Instead,
`scripts/wynn_price_server.py` runs a small local proxy: it holds the API key
server-side and gives the page a same-origin `/api/price` endpoint to call.
**The key never reaches the browser or gets committed to this repo.**

Put your key in one of these (checked in this order):

```bash
export WYNNVENTORY_API_KEY="..."
# or
mkdir -p ~/.config/wynn-dashboard
echo "..." > ~/.config/wynn-dashboard/wynnventory.key
chmod 600 ~/.config/wynn-dashboard/wynnventory.key
```

Then run:

```bash
python3 scripts/wynn_price_server.py
# then visit http://localhost:8123
```

The static copy published to GitHub Pages (`docs/index.html`) is informational
only - it can't run the proxy, so it just links to
[wynnventory.com](https://www.wynnventory.com) and to these instructions.
In-game tooltips from the Wynntils/Wynnventory mods remain the fastest way to
check a price while actually trading.

## Trend / prediction page

`dashboard/predict.html` fits a linear regression to price data over time.
Important caveat: Wynnventory's API only exposes two point-in-time aggregates
per item (today's live stats, and a rolled-up recent-history aggregate) -
there is no per-day time series to regress against. So the proxy builds its
own: every successful `/api/price` lookup (and every watchlist poll, every 15
minutes) appends a timestamped snapshot to
`~/.local/share/wynn-dashboard/history.jsonl`. The regression is computed
from whatever's accumulated there, and its confidence badge (`low` / `medium`
/ `high`) reflects sample count and time span honestly - it starts `low` and
earns `high` only after enough real data exists.

Add an item to the watchlist from the trend page (or `GET
/api/watch/add?item=NAME`) so it keeps collecting data in the background even
when you're not actively looking things up. This is read-only analysis only -
no orders are placed or suggested for automated execution.

## Sell slot optimizer

`dashboard/optimize.html` ranks your watchlist and recommends which items to
buy and list to fill a given number of sell slots within a capital budget
(defaults: 6 slots, 8 LE / 32,768 emeralds). It's a Thompson-sampling bandit
over each item's estimated net margin (`sell_estimate * 0.95 - buy_cost`,
approximating the Trade Market's listing fee), greedily packed into a
knapsack under the slot and capital constraints.

Two things this deliberately gets right rather than glossing over:

- **Small listing pools get wide uncertainty, not false confidence.** An
  item's variance is scaled by `1/sqrt(total_count)`, so an item with 2
  listings can still be picked (bandits should occasionally explore), but
  won't dominate the ranking the way a 200-listing item's estimate will.
- **Roll-variance warning.** For gear items, `lowest_price` and
  `sell_estimate` can come from wildly different stat rolls, not real market
  inefficiency - you can't buy a bad roll and resell it as a good one. Any
  item where the sell estimate is 3x+ the buy cost on a thin pool (<30
  listings) gets flagged `roll_variance_warning: true` and is discounted
  3x in the ranking rather than trusted at face value.

Record what actually happens after you list something with `GET
/api/record_outcome?item=NAME&sold=true&margin=123` (or `sold=false` if it
expired unsold). This is the only way the model improves beyond the raw
market snapshot - a real, manually-reported outcome, Bayesian-blended into
that item's estimate for next time (weighted by how many real outcomes have
been recorded, so early guesses don't overreact to one data point).

This is advisory output only. It recommends what to buy and list; you still
do the buying and listing yourself, in the real Minecraft client.
