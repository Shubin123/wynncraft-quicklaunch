#!/usr/bin/env node

const { Command } = require('commander');
const prism = require('../src/prism');
const { createWynnBot } = require('../src/bot');
const { startRepl } = require('../src/repl');
const mc = require('minecraft-protocol');

const program = new Command();

program
  .name('mineflayer-wynn')
  .description('Mineflayer bot linked to Prism Launcher Wynncraft instance and accounts')
  .version('1.0.0');

// -------------------------------------------------------------
// Command: run (Default)
// -------------------------------------------------------------
program
  .command('run', { isDefault: true })
  .description('Launch the Mineflayer bot and connect to Wynncraft')
  .option('-i, --instance <name>', 'Prism Launcher instance name', 'Wynncraft-1.21.11')
  .option('-s, --host <host>', 'Server host (default: from Prism instance, e.g. play.wynncraft.com)')
  .option('-p, --port <number>', 'Server port (default: 25565)', parseInt)
  .option('-v, --version <version>', 'Minecraft version (default: from Prism instance, e.g. 1.21.11)')
  .option('-a, --auth <mode>', 'Auth mode: "prism" (use cached Prism session), "microsoft", or "offline"', 'prism')
  .option('-u, --username <name>', 'Player username override')
  .option('--account <name|uuid>', 'Use this Prism account for this run, whichever one Prism has active')
  .option('-c, --character <slot>', 'Auto-select character slot or class on login')
  .option('--viewer [port]', 'Start 3D web visualizer on specified port (default: 3000)')
  .option('--anti-afk', 'Enable anti-AFK movements', false)
  .option('--no-repl', 'Disable interactive terminal REPL')
  .action(async (options) => {
    try {
      console.log(`\x1b[1;35m========================================\x1b[0m`);
      console.log(`\x1b[1;35m       Mineflayer Wynncraft Link        \x1b[0m`);
      console.log(`\x1b[1;35m========================================\x1b[0m`);

      // Format viewer port if flag is present without number
      if (options.viewer === true) {
        options.viewer = 3000;
      } else if (typeof options.viewer === 'string') {
        options.viewer = parseInt(options.viewer, 10) || 3000;
      }

      const botContext = createWynnBot(options);

      if (options.repl) {
        botContext.bot.once('spawn', () => {
          console.log(`\x1b[32m[REPL]\x1b[0m Starting interactive REPL. Type '.help' for commands or type to chat.`);
          startRepl(botContext);
        });
      }
    } catch (err) {
      console.error(`\x1b[31m[Error]\x1b[0m ${err.message}`);
      process.exit(1);
    }
  });

// -------------------------------------------------------------
// Command: status
// -------------------------------------------------------------
program
  .command('status')
  .description('Show status of Prism Launcher setup, active account, and quicklaunch integration')
  .option('-i, --instance <name>', 'Prism instance name to check', 'Wynncraft-1.21.11')
  .action(async (options) => {
    console.log(`\x1b[1;34m--- Prism Launcher & Wynncraft Status ---\x1b[0m`);
    console.log(`Prism Base Directory: ${prism.getPrismDir()}`);

    // Instances
    const instances = prism.getInstances();
    console.log(`\n\x1b[1mDetected Instances (${instances.length}):\x1b[0m`);
    instances.forEach(inst => {
      console.log(`  - \x1b[36m${inst.name}\x1b[0m (${inst.path})`);
    });

    // Wynncraft Instance
    console.log(`\n\x1b[1mSelected Instance:\x1b[0m`);
    try {
      const wynn = prism.getWynnInstance(options.instance);
      console.log(`  Name:               ${wynn.name}`);
      console.log(`  Minecraft Version:  ${wynn.minecraftVersion}`);
      console.log(`  Fabric Loader:      ${wynn.fabricVersion || 'None'}`);
      console.log(`  Target Server:      ${wynn.host}:${wynn.port}`);
      console.log(`  Auto-Join on start: ${wynn.joinOnLaunch}`);
      console.log(`  Instance Path:      ${wynn.instanceDir}`);
    } catch (err) {
      console.log(`  \x1b[31mError:\x1b[0m ${err.message}`);
    }

    // Accounts
    const accounts = prism.getPrismAccounts();
    console.log(`\n\x1b[1mPrism Accounts (${accounts.length}):\x1b[0m`);
    accounts.forEach(acc => {
      const status = acc.isTokenValid
        ? `\x1b[32mVALID\x1b[0m (${Math.round(acc.validSecondsRemaining / 60)} min left)`
        : `\x1b[31mEXPIRED\x1b[0m`;
      const activeMark = acc.active ? ' \x1b[33m[ACTIVE]\x1b[0m' : '';
      console.log(`  - \x1b[1m${acc.name}\x1b[0m (UUID: ${acc.uuid}) [${acc.type}]${activeMark}: Token ${status}`);
    });

    // Wynntils Storage
    const active = prism.getActiveAccount();
    if (active) {
      const wynntils = prism.getWynntilsData(active.uuid, options.instance);
      console.log(`\n\x1b[1mWynntils Integration:\x1b[0m`);
      console.log(`  Player Storage:     ${wynntils ? '\x1b[32mFound\x1b[0m' : '\x1b[33mNot found\x1b[0m'}`);
    }

    // Quicklaunch Proxy Check
    const quicklaunchRunning = await prism.checkQuicklaunchServer(8123);
    console.log(`\n\x1b[1mQuicklaunch Price Proxy (:8123):\x1b[0m`);
    console.log(`  Status:             ${quicklaunchRunning ? '\x1b[32mOnline (Running)\x1b[0m' : '\x1b[90mOffline (Run "python3 ~/wynncraft-quicklaunch/scripts/wynn_price_server.py" to start)\x1b[0m'}`);
    console.log(``);
  });

// -------------------------------------------------------------
// Command: ping
// -------------------------------------------------------------
program
  .command('ping')
  .description('Ping Wynncraft server and display player counts and latency')
  .option('-s, --host <host>', 'Host to ping', 'play.wynncraft.com')
  .option('-p, --port <number>', 'Port to ping', parseInt, 25565)
  .action((options) => {
    console.log(`Pinging ${options.host}:${options.port}...`);
    const start = Date.now();
    mc.ping({ host: options.host, port: options.port }, (err, res) => {
      const latency = Date.now() - start;
      if (err) {
        console.error(`\x1b[31mPing failed:\x1b[0m`, err.message);
        process.exit(1);
      } else {
        console.log(`\x1b[32mPing successful!\x1b[0m (${latency}ms)`);
        console.log(`  Version:  ${res.version?.name || 'Unknown'} (protocol ${res.version?.protocol})`);
        console.log(`  Players:  ${res.players?.online || 0} / ${res.players?.max || 0}`);
        process.exit(0);
      }
    });
  });

program.parse(process.argv);
