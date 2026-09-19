const readline = require('readline');
const { goals } = require('mineflayer-pathfinder');

/**
 * Starts an interactive terminal REPL for the Wynncraft bot.
 */
function startRepl(botContext) {
  const { bot } = botContext;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[35mwynn>\x1b[0m '
  });

  function safeLog(...args) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    console.log(...args);
    rl.prompt(true);
  }

  // Print Wynncraft chat cleanly
  bot.on('wynn:chat', (cleanText) => {
    if (cleanText) {
      safeLog(`\x1b[90m[Chat]\x1b[0m ${cleanText}`);
    }
  });

  // Print Wynncraft NPC dialogue in color
  bot.on('wynn:dialogue', (d) => {
    safeLog(`\x1b[33m[Dialogue]\x1b[0m \x1b[1m${d.npc}:\x1b[0m ${d.speech}`);
  });

  // Print quest updates in cyan
  bot.on('wynn:quest', (q) => {
    safeLog(`\x1b[36m[Quest]\x1b[0m ${q}`);
  });

  // Print market updates
  bot.on('wynn:market', (m) => {
    safeLog(`\x1b[32m[Market]\x1b[0m ${m}`);
  });

  // Print detected characters
  bot.on('wynn:characters', (chars) => {
    safeLog(`\x1b[34m[Characters Detected]\x1b[0m`);
    chars.forEach((c, idx) => {
      safeLog(`  [${idx + 1}] Slot ${c.slot}: ${c.name}`);
    });
    safeLog(`  \x1b[90mType '.class <number>' to select\x1b[0m`);
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Commands starting with . or /
    if (input.startsWith('.')) {
      const parts = input.slice(1).trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      switch (cmd) {
        case 'help':
          safeLog(`\x1b[1mAvailable REPL Commands:\x1b[0m`);
          safeLog(`  .status              Show health, hunger, coordinates, and current server`);
          safeLog(`  .class [slot|name]   Open character menu or select a character`);
          safeLog(`  .server <wc>         Switch server (e.g. .server 1 for WC1)`);
          safeLog(`  .hub                 Return to Wynncraft lobby/hub`);
          safeLog(`  .price <item>        Look up market price via quicklaunch price proxy`);
          safeLog(`  .inventory           List inventory and total emeralds`);
          safeLog(`  .goto <x> <y> <z>    Pathfind to coordinates`);
          safeLog(`  .stop                Stop pathfinding navigation`);
          safeLog(`  .antiafk [on|off]    Toggle anti-AFK movement`);
          safeLog(`  .say <msg>           Send in-game chat message (or just type directly)`);
          safeLog(`  .exit / .quit        Disconnect bot and exit`);
          break;

        case 'status': {
          const pos = bot.entity?.position;
          const posStr = pos ? `(${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})` : 'unknown';
          safeLog(`\x1b[1mBot Status:\x1b[0m`);
          safeLog(`  Account:     ${bot.username}`);
          safeLog(`  Health:      ${Math.round(bot.health || 0)} / 20`);
          safeLog(`  Food:        ${Math.round(bot.food || 0)} / 20`);
          safeLog(`  Position:    ${posStr}`);
          safeLog(`  Server:      ${bot.wynn?.currentServer || 'Unknown'}`);
          break;
        }

        case 'class':
          if (args.length === 0) {
            safeLog(`Opening character selection...`);
            bot.wynn.openClassMenu();
          } else {
            const arg = isNaN(args[0]) ? args[0] : parseInt(args[0], 10);
            safeLog(`Selecting character: ${arg}...`);
            bot.wynn.selectCharacter(arg).then(success => {
              if (success) safeLog(`Selected character successfully.`);
              else safeLog(`Could not find matching character.`);
            }).catch(e => safeLog(`Error: ${e.message}`));
          }
          break;

        case 'server':
          if (args.length === 0) {
            safeLog(`Usage: .server <wc_number> (e.g. .server 5)`);
          } else {
            safeLog(`Switching to WC${args[0]}...`);
            bot.wynn.switchServer(args[0]);
          }
          break;

        case 'hub':
          safeLog(`Returning to hub...`);
          bot.wynn.goToHub();
          break;

        case 'price':
          if (args.length === 0) {
            safeLog(`Usage: .price <item_name>`);
          } else {
            const itemName = args.join(' ');
            safeLog(`Looking up price for "${itemName}"...`);
            const p = await bot.wynn.getPrice(itemName);
            if (p && !p.error) {
              safeLog(`\x1b[1mPrice for ${itemName}:\x1b[0m`);
              safeLog(`  Estimate:    ${p.sell_estimate || p.average_price || 'N/A'} emeralds`);
              safeLog(`  Lowest:      ${p.lowest_price || 'N/A'} emeralds`);
              safeLog(`  Listings:    ${p.total_count || 'N/A'}`);
            } else {
              safeLog(`No price data found (ensure quicklaunch proxy is running on :8123 or check item name).`);
            }
          }
          break;

        case 'inventory': {
          const items = bot.inventory?.items() || [];
          safeLog(`\x1b[1mInventory (${items.length} slots used):\x1b[0m`);
          items.forEach(i => {
            const name = i.customName ? require('./wynncraft').stripFormatting(i.customName) : i.name;
            safeLog(`  - ${i.count}x ${name}`);
          });
          const emeralds = bot.wynn.countEmeralds();
          safeLog(`  \x1b[32mEmeralds: ${emeralds.formatted} (${emeralds.total} total)\x1b[0m`);
          break;
        }

        case 'goto': {
          if (args.length < 3) {
            safeLog(`Usage: .goto <x> <y> <z>`);
          } else {
            const x = parseFloat(args[0]);
            const y = parseFloat(args[1]);
            const z = parseFloat(args[2]);
            if (isNaN(x) || isNaN(y) || isNaN(z)) {
              safeLog(`Invalid coordinates.`);
            } else {
              safeLog(`Pathfinding to (${x}, ${y}, ${z})...`);
              bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z));
            }
          }
          break;
        }

        case 'stop':
          bot.pathfinder.stop();
          safeLog(`Pathfinding stopped.`);
          break;

        case 'antiafk':
          if (args[0] === 'off') {
            bot.wynn.stopAntiAfk();
            safeLog(`Anti-AFK disabled.`);
          } else {
            bot.wynn.startAntiAfk();
            safeLog(`Anti-AFK enabled.`);
          }
          break;

        case 'say':
          bot.chat(args.join(' '));
          break;

        case 'exit':
        case 'quit':
          safeLog(`Disconnecting and exiting...`);
          bot.quit();
          rl.close();
          process.exit(0);
          break;

        default:
          safeLog(`Unknown command: .${cmd}. Type .help for a list.`);
          break;
      }
    } else {
      // Normal chat or in-game command (/...)
      bot.chat(input);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    bot.quit();
    process.exit(0);
  });

  return rl;
}

module.exports = {
  startRepl
};
