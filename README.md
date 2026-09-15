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
