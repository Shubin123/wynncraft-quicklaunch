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
