# Wynncraft Quicklaunch — Agent Memory

## Current state

- Git repository: `wynncraft-quicklaunch`; branch `main` is the source of truth.
- Unified runtime: `scripts/wynn_bot_server.js` serves dashboard, price/trade APIs, bot APIs, SSE, and static files on `127.0.0.1:8123`.
- 3D viewer is the only separate process/service, on port `3000`, started by the bot when requested.
- Do not start `scripts/wynn_price_server.py` as a second backend. It is retained only as a legacy Python reference/training/test harness and no longer auto-spawns Node.
- Start the service visibly in the foreground: `bash scripts/start_all.sh`. Never use `nohup`, detached daemons, or hidden background servers.

## Important features

- Browser manual control: WASD, Space, Shift, mouse capture/look, exit, final-position save, optional sampled movement points, saved-position/path replay and deletion.
- Manual saves always capture the current live bot position; one point is valid.
- Viewer character tracking polls `/api/bot/position` on port `8123`; refresh the viewer after overlay changes.
- Trade Market page shows item type tags, including named gear such as `Pure` and `Depressing Stick`, with hover lore and prices.
- Anti-AFK is opt-in and off by default. It starts only after explicit UI/API enablement (`POST /api/bot/antiafk`).
- Pathfinding should not contain market quick-check UI; market operations belong on the Trade Market page.

## Verification

```bash
npm test
bash scripts/check.sh
```

Focused checks:

```bash
node tests/test_manual_paths.js
node tests/test_optimizer.js
node mineflayer-wynn/tests/test_viewer_overlay.js
node mineflayer-wynn/tests/test_viewer_overlay_render.js
```

Before changing infrastructure, inspect `git status`, pull `origin/main`, preserve the foreground server convention, and push completed work to `main` when requested.
