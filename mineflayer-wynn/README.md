# Mineflayer Wynncraft Setup

A complete [Mineflayer](https://github.com/PrismarineJS/mineflayer) setup linked to the local **Prism Launcher** Wynncraft instance (`Wynncraft-1.21.11`), Minecraft account session, and the local `wynncraft-quicklaunch` environment.

---

## Features

- **Prism Launcher Instance Linking**:
  - Automatically detects instance directory (`~/.local/share/PrismLauncher/instances/Wynncraft-1.21.11`).
  - Reads Minecraft version (`1.21.11`), Fabric configuration, and target server (`play.wynncraft.com:25565`) from `instance.cfg` and `mmc-pack.json`.
- **Prism Account & Session Reuse**:
  - Extracts the active Microsoft account (`boredfrom0`) and valid Yggdrasil session token from `~/.local/share/PrismLauncher/accounts.json`.
  - Authenticates seamlessly without prompting for browser OAuth while the cached Prism session is valid.
  - Supports `--auth microsoft` (standalone device code auth) and `--auth offline` (local/test servers).
- **Wynntils & Quicklaunch Integration**:
  - Reads Wynntils player storage and profiles (`storage/<uuid>.data.json`).
  - Connects to the local `wynncraft-quicklaunch` trade market price proxy (`http://localhost:8123`) to provide live in-terminal `.price <item>` lookups.
- **Wynncraft Plugin Features**:
  - **Auto-Resource Pack**: Handles Wynncraft custom resource packs on login and server transfers.
  - **Character Selection**: Detects character GUI and auto-selects via slot index or class name.
  - **Dialogue & Chat Cleaner**: Strips formatting codes, formats NPC conversations in color, and can auto-advance dialogues (`[Press SHIFT to continue]`).
  - **Anti-AFK**: Smooth micro-movement and look rotation to prevent Wynncraft 15-minute AFK kicks.
  - **Emerald Accounting**: Scans inventory and computes total currency in Liquid Emeralds (LE), Emerald Blocks (EB), and Emeralds (E).
- **3D World Web Visualizer**:
  - Embedded `prismarine-viewer` web interface (`--viewer 3000`) for viewing what the bot sees directly in your web browser at `http://localhost:3000`.
- **Pathfinding & Survival**:
  - `mineflayer-pathfinder` integrated for 3D coordinate pathfinding (`.goto <x> <y> <z>`).
  - `mineflayer-auto-eat` loaded for auto-healing/eating.

---

## Quick Start

### 1. Check Status

Verify the Prism Launcher instance, account session, and local price proxy:

```bash
mineflayer-wynn status
```

### 2. Ping Wynncraft Server

```bash
mineflayer-wynn ping
```

### 3. Connect Bot to Wynncraft

To launch the bot using the active Prism account session:

```bash
mineflayer-wynn run
```

Or with the 3D web visualizer on port 3000 and anti-AFK enabled:

```bash
mineflayer-wynn run --viewer 3000 --anti-afk
```

From the `wynncraft-quicklaunch` directory:

```bash
cd ~/wynncraft-quicklaunch
./scripts/launch_mineflayer.sh --viewer 3000
```

---

## CLI Options

```
Usage: mineflayer-wynn [command] [options]

Commands:
  run [options]      Launch bot and connect to Wynncraft (default command)
  status [options]   Show Prism instance, account validity, and quicklaunch proxy status
  ping [options]     Ping server and report latency and player count

Options:
  -i, --instance <name>    Prism instance name (default: "Wynncraft-1.21.11")
  -s, --host <host>        Server host (default: "play.wynncraft.com")
  -p, --port <port>        Server port (default: 25565)
  -v, --version <version>  Minecraft version (default: "1.21.11")
  -a, --auth <mode>        "prism" (default), "microsoft", or "offline"
  -u, --username <name>    Username override
  -c, --character <slot>   Auto-select character slot (e.g. 1-5 or class name)
  --viewer [port]          Start 3D web visualizer (default: 3000)
  --anti-afk               Enable periodic anti-AFK movements
  --no-repl                Disable interactive terminal REPL
```

---

## Trade Market (auction house)

`src/market.js` attaches a Trade Market controller as `bot.market`. It walks to
a market location, opens the auction window and reads or clicks its panes:

```js
await bot.market.walkTo('detlas');        // pathfind to the market NPC
const opened = await bot.market.open();   // walk (if needed), interact, wait for the window
bot.market.scan();                        // { listings, controls, slots, page, isMarket }
await bot.market.search('Spring');        // clicks the search pane, answers the chat prompt
await bot.market.nextPage();
await bot.market.buy({ slot: 10 }, { confirm: true, maxPrice: 16 * 4096 });
bot.market.close();
```

Panes are classified by item name and lore text, never by fixed slot number:
Wynncraft moves market controls between updates, and a stale slot hint would
silently click the wrong pane. A pane is a `listing` when its lore quotes a
price, a `control` when its name matches a known role (`search`, `next_page`,
`sell`, `confirm`, ...), and `filler` otherwise.

Prices parse from Wynncraft's `stx`/`le`/`eb`/`e` notation into plain emeralds
(`parseEmeralds`, `formatEmeralds`), so listings can be compared against
Wynnventory data directly.

Buying spends real in-game emeralds and cannot be undone, so `click` on a
listing and `buy` both refuse without `confirm: true`, and `buy` also honours an
optional `maxPrice` ceiling.

REPL: `.market [location]`, `.listings`, `.find <item>`.
Bot server: `GET /api/bot/market` plus `POST /api/bot/market/{walk,open,close,search,next_page,prev_page,click,buy}`.
Dashboard: the **Trade market** tab renders the auction panes as a grid.

Run `node tests/test_market.js` to verify the pane parsing and the guards.

## 3D Viewer Rendering Version

Wynncraft (WynnProxy) speaks protocol 775, which Mineflayer knows as Minecraft
`26.1`. The `prismarine-viewer` browser bundle does not: its supported version
list stops at `1.21.4` and its bundled `minecraft-data` has no `26.1` entry. When
the viewer is handed `26.1` it aborts `setVersion()`, the chunk worker is never
started, and the page renders an empty world.

`src/viewer.js` therefore renders with the newest version the viewer does
support (`1.21.4` by default) and translates block state ids on the way out:

- Block state ids are matched by block name + properties, not by number, because
  the two versions disagree from block id 133 onwards. ~93% of states map
  exactly; the rest fall back to the block's default state, and blocks that do
  not exist in the render version become stone (full cubes) or air.
- Chunk sections using a `direct` palette are re-encoded as `indirect`, because
  `prismarine-chunk` drops the bit array when deserializing a direct container
  from JSON.

Override the render version with `WYNN_VIEWER_MC_VERSION`. It must stay in sync
with `scripts/apply_wynn_textures.py`, which patches the texture atlas of that
same version with the official Wynncraft resource pack art.

Run `node tests/test_viewer.js` to verify the translation layer.

## Interactive Terminal REPL

When the bot connects, you get an interactive prompt:

```
wynn> .help
```

| Command | Description |
|---|---|
| `.status` | Display health, food, current coordinates, and server (e.g. WC5) |
| `.class [slot/name]` | Open character selection or select a character slot |
| `.server <wc>` | Switch world (e.g. `.server 3` sends `/server WC3`) |
| `.hub` | Return to Wynncraft hub / lobby |
| `.price <item>` | Check market price via quicklaunch proxy (`localhost:8123`) |
| `.inventory` | List items and total emeralds formatted in LE / EB / E |
| `.goto <x> <y> <z>` | Pathfind autonomously to world coordinates |
| `.stop` | Stop active pathfinding navigation |
| `.antiafk [on/off]` | Toggle anti-AFK keepalive |
| `.say <message>` | Send a chat message (or just type directly at the prompt) |
| `.exit` / `.quit` | Disconnect and close bot |

---

## Using as a Node.js Library

You can also use this setup in your own scripts:

```javascript
const { createWynnBot, getWynnInstance, getActiveAccount } = require('mineflayer-wynn');

const { bot } = createWynnBot({
  instance: 'Wynncraft-1.21.11',
  auth: 'prism',
  viewer: 3000,
  antiAfk: true
});

bot.on('spawn', () => {
  console.log('Bot is in world!');
});
```
