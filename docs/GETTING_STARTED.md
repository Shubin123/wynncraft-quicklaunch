# Getting Started with Wynncraft Quick Launch & Bot Controller

Welcome to the **Wynncraft Quick Launch + Mineflayer Bot Controller** environment. This guide is written for humans—players, developers, and testers—who want to play Wynncraft with Wynntils/Wynnventory or run and control an automated Mineflayer bot via a local Web Dashboard.

---

## 1. What's Included

This project connects three key layers:
1. **Prism Launcher Wynncraft Instance (`Wynncraft-1.21.11`)**:
   - Fabric Loader + Fabric API.
   - [Wynntils](https://wynntils.com) (core gameplay overlays, map, quest tracking).
   - [Wynnventory](https://wynnventory.com) (in-game Trade Market price tooltips).
   - Desktop quick-launch shortcut bypassing Prism's UI directly into `play.wynncraft.com`.
2. **Trade Market Dashboard (`http://localhost:8123`)**:
   - Price Lookup (`index.html`).
   - Trend & Linear Regression Predictor (`predict.html`).
   - Thompson-Sampling Sell Slot Optimizer (`optimize.html`).
   - Local proxy keeping your Wynnventory API key securely on your machine.
3. **Mineflayer Web Bot Controller (`http://localhost:8123/bot.html`)**:
   - Web-based controller linked directly to your Prism account and instance.
   - Autonomous 3D coordinate pathfinding with pre-set city waypoints.
   - Real-time in-game chat and NPC dialogue streamer.
   - Anti-AFK keepalive.
   - Embedded 3D browser visualizer (`prismarine-viewer`).

---

## 2. Prerequisites

1. **Prism Launcher**: Installed on your system (e.g. `pacman -S prismlauncher`).
2. **Microsoft / Minecraft Account**:
   - Must own a valid Minecraft Java Edition license.
   - Must be logged into Prism Launcher at least once under **Manage Accounts** so your session token is cached.
3. **Node.js & Python**:
   - Node.js `v22+` (v26 is currently installed).
   - Python 3.10+.

---

## 3. Quick Start (Web App)

The easiest way to use the bot is through the unified web dashboard.

### Step 1: Ensure the Unified Server is Running
Run the single service in a visible foreground terminal:
```bash
npm start
# or: bash scripts/start_all.sh
```

### Step 2: Open the Web App
Open your browser and navigate to:
👉 **[http://localhost:8123/bot.html](http://localhost:8123/bot.html)**

### Step 3: Connect
1. The **Prism Instance & Connection** card will automatically detect your account (`boredfrom0`) and verify your token validity.
2. Select your desired character class or slot from the dropdown (or leave as *Manual* to select in-game).
3. Toggle **Anti-AFK** and **3D View** as desired.
4. Click **Connect**.
5. Once logged in, the badge will turn green (`Connected`), vitals and emerald counts will update, and in-game chat will begin streaming!

---

## 4. Web Dashboard Features

### Vitals & Live Telemetry
- **Health & Hunger**: Monitored in real-time.
- **Coordinates**: Displays your exact X, Y, Z, and rotation yaw/pitch.
- **World / Server**: Displays which Wynncraft world you are connected to (e.g. `WC3`, `WC12`, or `Hub`).
- **Emerald Balance**: Automatically tallies total emeralds into Liquid Emeralds (LE), Emerald Blocks (EB), and Emeralds (E).
- **Quick World Switcher**: Switch servers on the fly (`Hub`, `WC1`, `WC2`, `WC5`, `WC10`, etc.).

### Class Selection, Auto-Lock & Container UI Manipulation
- **Auto-Lock Class**: When enabled (default), the bot automatically detects Wynncraft's 54-slot Character Selection container (`󏿕`) and clicks your target character card to transition directly into the playable `WORLD`.
- **Target Selection**: Pick `(Auto) First Available Character` (recommended), a specific character card (`Card 1` through `Card 6`), or a class archetype (`Archer`, `Warrior`, `Mage`, `Assassin`, `Shaman`).
- **Manual Pane & Slot Override**:
  - Wynncraft container layout: Row 0 (slots 0–8) and borders are stained glass panes. Character cards are located at slots `[9, 10, 11, 18, 19, 20, 27, 28, 29, 36, 37, 38, 45, 46, 47]`.
  - When **Manual Pane Override** is checked, auto-lock is paused and you can target any specific raw container slot index (e.g., container slot 1, a glass pane) without automatic remapping.
  - Quick buttons allow clicking **Slot 1 (Glass Pane)** or **Slot 9 (Card 1)** with a single click.
- **Direct UI Manipulation**: Click any slot in the 9x6 container grid to Left-Click, Right-Click, or Shift-Click directly from your web browser. A checkbox allows toggling between instant clicking on tap or inspection mode.
- **"E" Inventory Inspector**: Click **Inspect "E" Inventory** to inspect or reorganize the bot's 45-slot player inventory.
- **ESC / Close**: Click **Close (ESC)** to close any active container window.

### Wynncraft 2.0+ Lobby Actions & Physical Bot Controls
- **Hitbox Interaction**: In Wynncraft 2.0+, joining `play.wynncraft.com` spawns the player in the Character Selection Lobby where the Action Bar streams: `Left-Click to play | Right-Click to switch`. An `interaction` entity is positioned directly in front of the player.
- **Physical Controls**:
  - `🖱️ Left-Click: Connect & Play`: Attacks the interaction entity in front of the bot or swings arm to enter the world immediately on the active character.
  - `🪟 Right-Click: Open Window Panes`: Interacts with the lobby interaction entity or uses the held item to open the 54-slot chest container where decorative glass panes and character cards are rendered.
  - `Shift (Sneak)` & `Space (Jump)`: Triggers physical player gestures directly from the web interface.
  - `Open Class GUI`: Summons the character selection container menu.
- **Auto-Window Summoning**: If you click any container slot (0–53) or glass pane while no container window is currently open, the bot automatically interacts with the hitbox to summon the window before dispatching the slot click.

### Informed Decisions & Session Conflict Guard
- All chat messages, dialogues, screen titles, action bars, and server kick reasons are parsed into clean, human-readable text (Mojang NBT/JSON compound trees are automatically converted).
- If kicked with `"You are already logged on to Wynncraft"`, the system alerts you that another game instance (e.g., your open Prism Launcher instance) is running with account `boredfrom0`, or the proxy session is clearing. Wait ~5–10 seconds before reconnecting.

### In-Game Chat & Dialogue Feed
- **NPC Dialogue**: NPC conversations are parsed and color-coded in gold.
- **Auto-Advance**: The bot automatically crouches/sneaks when Wynncraft prompts `[Press SHIFT to continue]` to advance NPC conversations.
- **Chat Input**: Type any message or command (`/msg`, `/party`, `/guild`, `/class`, `/hub`) and press **Enter** or click **Send**.

### Autonomous 3D Pathfinding
- Enter custom coordinates (X, Y, Z) and click **Go** to have the bot pathfind around obstacles and terrain.
- Click any **City Waypoint chip** to instantly fill in the destination:
  - **Detlas** (Main Trading Hub)
  - **Trade Market** (Marketplace in Detlas)
  - **Ragni** (Starting Province)
  - **Almuj** (Desert City)
  - **Nesaak** (Snow Realm)
  - **Llevigar** (Gavel Portal City)
  - **Cinfras** (Gavel Capital)
  - **Lutho** (Silent Expanse Entry)
- Click **Stop** at any time to abort navigation.

### 3D World Visualizer
- When enabled, an interactive 3D browser view (`prismarine-viewer`) renders the blocks, mobs, and players around your bot in real time.
- You can also open the viewer in a dedicated tab at [http://localhost:3000](http://localhost:3000).

### Trade Market Price Check
- Look up real-time prices for any weapon, armor, or accessory without leaving the bot screen.

---

## 5. Command-Line / Terminal REPL Usage

If you prefer using the terminal or want to run automated CLI scripts:

### Check Status
```bash
mineflayer-wynn status
```
Displays Prism instances, accounts, session token remaining minutes, and proxy status.

### Ping Wynncraft
```bash
mineflayer-wynn ping
```

### Launch Interactive CLI Bot
```bash
mineflayer-wynn run --viewer 3000 --anti-afk
# Or via quicklaunch script:
./scripts/launch_mineflayer.sh --viewer 3000
```

#### REPL Dot Commands:
- `.status` &mdash; Show health, food, position, server
- `.class <slot|name>` &mdash; Open character menu or choose character
- `.server <wc_number>` &mdash; Switch world (e.g. `.server 5`)
- `.hub` &mdash; Return to hub
- `.price <item>` &mdash; Look up market price via quicklaunch proxy
- `.inventory` &mdash; List items and total currency
- `.goto <x> <y> <z>` &mdash; Pathfind to coordinates
- `.stop` &mdash; Stop pathfinding
- `.antiafk [on|off]` &mdash; Toggle anti-AFK
- `.exit` / `.quit` &mdash; Gracefully disconnect

---

## 6. Troubleshooting & FAQs

#### "Token Expired" Warning
- **Cause**: Minecraft Yggdrasil tokens typically expire after 24 hours of inactivity.
- **Fix**: Simply open Prism Launcher and launch the `Wynncraft-1.21.11` instance once (or go to Account Menu &rarr; Refresh). Prism will refresh the token in `accounts.json`, and the bot will immediately pick up the fresh session.

#### Port Conflicts
- Default Price Dashboard & Bot Proxy: `8123` (configure via `WYNN_DASHBOARD_PORT`).
- Unified Dashboard and Bot Server: `8123` (configure via `WYNN_PORT`).
- Default 3D Web Visualizer: `3000` (configure via `WYNN_VIEWER_PORT`).

#### Wynncraft Anti-Cheat / Hades
- The bot handles Wynncraft's resource-pack negotiation packets automatically upon logging in.
- The anti-AFK module uses smooth, non-disruptive rotation to avoid tripping AFK kickers.
- Use autonomous pathfinding responsibly and adhere to Wynncraft server rules.
