const mineflayer = require('mineflayer');
const path = require('path');
const os = require('os');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const autoEat = require('mineflayer-auto-eat');
const prism = require('./prism');
const { wynncraftPlugin } = require('./wynncraft');
const { attachViewer } = require('./viewer');
const { attachMarket } = require('./market');

/**
 * Creates and initializes a Mineflayer bot linked to the Prism Wynncraft setup.
 */
function createWynnBot(userOptions = {}) {
  // 1. Resolve Prism Wynncraft instance configuration
  const instanceName = userOptions.instance || 'Wynncraft-1.21.11';
  let wynnInstance = null;
  try {
    wynnInstance = prism.getWynnInstance(instanceName);
  } catch (err) {
    console.warn(`[Prism] Note: Could not load instance "${instanceName}": ${err.message}`);
  }

  const host = userOptions.host || wynnInstance?.host || 'play.wynncraft.com';
  const port = userOptions.port || wynnInstance?.port || 25565;
  let version = userOptions.version || wynnInstance?.minecraftVersion || '1.21.11';

  // 2. Resolve Authentication
  const authMode = userOptions.auth || 'prism';
  let botUsername = userOptions.username || 'WynnBot';
  let authHandler = undefined;
  let activeAccount = null;

  if (authMode === 'prism') {
    activeAccount = prism.getActiveAccount();
    if (activeAccount && activeAccount.hasToken) {
      if (activeAccount.isTokenValid) {
        console.log(`\x1b[32m[Prism Link]\x1b[0m Using cached session for account: \x1b[1m${activeAccount.name}\x1b[0m (valid for ${Math.round(activeAccount.validSecondsRemaining / 60)} min)`);
        authHandler = prism.createPrismAuth(activeAccount);
        botUsername = activeAccount.name;
      } else {
        console.warn(`\x1b[33m[Prism Link]\x1b[0m Cached session for "${activeAccount.name}" has expired.`);
        console.log(`[Prism Link] Launch Prism Launcher once to refresh, or use --auth microsoft for standalone OAuth.`);
        if (userOptions.fallbackMicrosoft) {
          console.log(`[Prism Link] Falling back to Microsoft OAuth...`);
          authHandler = 'microsoft';
          botUsername = activeAccount.name;
        } else {
          throw new Error(`Prism session expired for ${activeAccount.name}. Please open Prism Launcher to renew session or pass --auth microsoft.`);
        }
      }
    } else {
      console.warn(`\x1b[33m[Prism Link]\x1b[0m No active Prism account found in accounts.json.`);
      authHandler = 'offline';
    }
  } else if (authMode === 'microsoft') {
    authHandler = 'microsoft';
    if (!userOptions.username) {
      activeAccount = prism.getActiveAccount();
      if (activeAccount) botUsername = activeAccount.name;
    }
  } else if (authMode === 'offline') {
    authHandler = 'offline';
    botUsername = userOptions.username || 'WynnBot';
  }

  // WynnProxy 2.2+ uses protocol 775, which matches '26.1' in modern minecraft-data
  // to avoid component 105 deserialization errors
  if (host.includes('wynncraft.com') && (version === '1.21.11' || !userOptions.version)) {
    version = '26.1';
  }

  const net = require('net');
  const profilesFolder = path.join(os.homedir(), '.local', 'share', 'mineflayer', 'auth-cache');

  // 3. Configure Mineflayer options
  const botOptions = {
    host,
    port,
    version,
    username: botUsername,
    auth: authHandler || 'offline',
    profilesFolder,
    disableChatSigning: true,
    hideErrors: false,
    connect: (client) => {
      client.setSocket(net.connect(port, host));
    }
  };

  console.log(`\x1b[36m[Mineflayer]\x1b[0m Connecting to \x1b[1m${host}:${port}\x1b[0m (Minecraft ${version})...`);
  const bot = mineflayer.createBot(botOptions);

  // 4. Load Pathfinder Plugin
  bot.loadPlugin(pathfinder);

  // 5. Load AutoEat Plugin
  if (autoEat.loader) {
    bot.loadPlugin(autoEat.loader);
  }

  // 6. Load Wynncraft Plugin
  wynncraftPlugin(bot, {
    characterSlot: userOptions.characterSlot ?? userOptions.character,
    autoLock: userOptions.autoLock ?? true,
    autoQuickConnect: userOptions.autoQuickConnect ?? true,
    autoDialogue: userOptions.autoDialogue ?? true,
    antiAfk: userOptions.antiAfk ?? false
  });

  // 7. Setup Pathfinder Movements on spawn
  bot.once('spawn', () => {
    try {
      const mcData = require('minecraft-data')(bot.version);
      if (mcData) {
        const defaultMove = new Movements(bot, mcData);
        bot.pathfinder.setMovements(defaultMove);
      }
    } catch (e) {
      // ignore
    }
  });

  // 8. Attach the Trade Market controller (bot.market)
  attachMarket(bot, {
    location: userOptions.marketLocation || 'detlas'
  });

  // 9. Attach 3D Viewer if requested
  if (userOptions.viewer) {
    bot.once('spawn', () => {
      const viewerPort = typeof userOptions.viewer === 'number' ? userOptions.viewer : 3000;
      attachViewer(bot, { port: viewerPort });
    });
  }

  // 10. Standard bot lifecycle events
  bot.on('login', () => {
    console.log(`\x1b[32m[Mineflayer]\x1b[0m Successfully logged in as \x1b[1m${bot.username}\x1b[0m`);
  });

  bot.on('kicked', (reason) => {
    console.warn(`\x1b[33m[Mineflayer]\x1b[0m Bot was kicked:`, reason);
  });

  bot.on('error', (err) => {
    console.error(`\x1b[31m[Mineflayer Error]\x1b[0m`, err.message);
  });

  bot.on('end', (reason) => {
    console.log(`\x1b[90m[Mineflayer]\x1b[0m Connection closed (${reason || 'disconnected'}).`);
  });

  return {
    bot,
    prismInstance: wynnInstance,
    account: activeAccount,
    options: botOptions
  };
}

module.exports = {
  createWynnBot
};
