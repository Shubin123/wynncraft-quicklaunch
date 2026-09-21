#!/usr/bin/env node
/**
 * Wynncraft Mineflayer Bot Web Server & API
 *
 * Provides REST & SSE APIs to control the Mineflayer bot, inspect status,
 * send in-game chat, pathfind, and stream live events to the dashboard web app.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

// Add module lookup paths dynamically (portable across macOS, Linux, and custom setups)
const candidateMfDirs = [
  path.resolve(__dirname, '../mineflayer-wynn'),
  path.resolve(__dirname, '../../mineflayer-wynn'),
  path.join(os.homedir(), 'mineflayer-wynn')
];

let resolvedMfDir = candidateMfDirs.find(d => fs.existsSync(d)) || null;

if (resolvedMfDir) {
  const mfNodeModules = path.join(resolvedMfDir, 'node_modules');
  if (fs.existsSync(mfNodeModules)) {
    module.paths.push(mfNodeModules);
  }
  const mfSrc = path.join(resolvedMfDir, 'src');
  if (fs.existsSync(mfSrc)) {
    module.paths.push(mfSrc);
  }
}

// Global npm module paths (Linux + macOS Homebrew / custom prefix)
const candidateGlobalDirs = [
  path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
  '/opt/homebrew/lib/node_modules',
  '/usr/local/lib/node_modules'
];
for (const g of candidateGlobalDirs) {
  if (fs.existsSync(g)) {
    module.paths.push(g);
  }
}

// Require mineflayer-wynn components
let prism, createWynnBot, stripFormatting, attachViewer, parseChatComponent, extractCleanText, cleanWynncraftText;
let parseMarketWindow, formatEmeralds, MARKET_LOCATIONS;
try {
  let mf = null;
  if (resolvedMfDir && fs.existsSync(path.join(resolvedMfDir, 'src', 'index.js'))) {
    mf = require(path.join(resolvedMfDir, 'src', 'index.js'));
  } else if (resolvedMfDir && fs.existsSync(path.join(resolvedMfDir, 'package.json'))) {
    mf = require(resolvedMfDir);
  } else {
    mf = require('mineflayer-wynn');
  }
  prism = mf;
  createWynnBot = mf.createWynnBot;
  stripFormatting = mf.stripFormatting;
  attachViewer = mf.attachViewer;
  parseChatComponent = mf.parseChatComponent;
  extractCleanText = mf.extractCleanText;
  cleanWynncraftText = mf.cleanWynncraftText;
  parseMarketWindow = mf.parseMarketWindow;
  formatEmeralds = mf.formatEmeralds;
  MARKET_LOCATIONS = mf.MARKET_LOCATIONS;
} catch (e) {
  console.error('Failed to load mineflayer-wynn:', e);
}

const { ChatInsightsEngine } = require('./chat_insights');
const { goals } = require('mineflayer-pathfinder');
const { handlePriceRoute } = require('./routes/price_routes');
const { serveStatic } = require('./routes/static_routes');
const waypointStore = require('./lib/waypoints');

// The bot and dashboard now share this process. Keep WYNN_BOT_PORT as a
// compatibility override, but make the unified service's documented port
// the default.
const PORT = parseInt(process.env.WYNN_PORT || process.env.WYNN_BOT_PORT || process.env.WYNN_DASHBOARD_PORT || '8123', 10);
// Loopback by default: this API has no authentication and can move the bot,
// spend emeralds and change which account it logs in as. The dashboard it
// serves is localhost-only too. Set WYNN_BOT_HOST to expose it deliberately.
const HOST = process.env.WYNN_BOT_HOST || '127.0.0.1';
const VIEWER_PORT = parseInt(process.env.WYNN_VIEWER_PORT || '3000', 10);

// Presets for Wynncraft Cities / POIs
const WAYPOINTS = [
  { name: 'Ragni', x: -890, y: 67, z: -1565, desc: 'Starting City (Level 1+)' },
  { name: 'Detlas', x: 470, y: 67, z: -1575, desc: 'Main Trading Hub' },
  { name: 'Trade Market (Detlas)', x: 500, y: 68, z: -1578, desc: 'Trade Market location in Detlas' },
  { name: 'Almuj', x: 950, y: 80, z: -1950, desc: 'Desert City (Level 50+)' },
  { name: 'Nesaak', x: 120, y: 70, z: -800, desc: 'Snow City (Level 40+)' },
  { name: 'Llevigar', x: -200, y: 40, z: -4400, desc: 'Gavel Portal City (Level 40+)' },
  { name: 'Olux', x: -1680, y: 55, z: -5500, desc: 'Swamp City (Level 55+)' },
  { name: 'Cinfras', x: -450, y: 45, z: -4900, desc: 'Gavel Capital (Level 70+)' },
  { name: 'Thanos', x: 400, y: 80, z: -5200, desc: 'Canyon Fortress (Level 80+)' },
  { name: 'Rodoroc', x: 1100, y: 20, z: -5100, desc: 'Dwarven Capital (Level 90+)' },
  { name: 'Lutho', x: 800, y: 110, z: -850, desc: 'Silent Expanse Entry (Level 100+)' }
];

// Bot State Manager
class BotManager extends EventEmitter {
  constructor() {
    super();
    this.botContext = null;
    this.bot = null;
    this.status = 'disconnected'; // disconnected, connecting, connected, error
    this.statusMessage = 'Bot is idle';
    this.chatLog = [];
    this.nextChatId = 1;
    this.systemLogs = [];
    this.nextLogId = 1;
    this.sseClients = new Set();
    this.antiAfkEnabled = false;
    this.viewerActive = false;
    this.autoLockEnabled = true;
    this.characterTarget = 'first';
    this.manualOverride = false;
    this.currentActionBar = '';
    this.lastActionBar = '';
    this.lastActionBarTime = 0;
    this.filteredSpamCount = 0;
    this.lastLogKey = '';
    this.lastLogTime = 0;
    this.antiAfkInterval = null;      // handle for anti-AFK loop
    this.idleWindowInterval = null;   // handle for idle window/pane checker
  }

  getBot() {
    return this.bot;
  }

  /**
   * Anti-AFK: Randomly look around + sneak briefly every 30-60 seconds.
   * Only fires when the bot is in WORLD state (in-game, not lobby/selection).
   */
  startAntiAfk() {
    this.stopAntiAfk();
    const tick = () => {
      if (!this.bot || this.bot.wynn?.worldState !== 'WORLD') return;
      try {
        // Random yaw offset ±30 degrees, keep current pitch
        const yawDelta = (Math.random() - 0.5) * (Math.PI / 3);
        const newYaw = (this.bot.entity?.yaw || 0) + yawDelta;
        const pitch = this.bot.entity?.pitch || 0;
        this.bot.look(newYaw, pitch, false);
        // Brief sneak to reset idle timer on Wynncraft's side
        setTimeout(() => {
          if (!this.bot) return;
          this.bot.setControlState('sneak', true);
          setTimeout(() => { if (this.bot) this.bot.setControlState('sneak', false); }, 300);
        }, 600);
        this.addLog('UI', '[Anti-AFK] Micro-movement: look + sneak tick');
      } catch (e) {
        this.addLog('ERROR', `Anti-AFK tick error: ${e.message}`);
      }
    };
    // Fire on a random interval between 30s and 55s
    const scheduleNext = () => {
      const delay = 30000 + Math.random() * 25000; // 30–55s
      this.antiAfkInterval = setTimeout(() => {
        tick();
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    this.addLog('STATE', '[Anti-AFK] Anti-AFK loop started (30–55s random interval).');
  }

  stopAntiAfk() {
    if (this.antiAfkInterval) {
      clearTimeout(this.antiAfkInterval);
      this.antiAfkInterval = null;
    }
  }

  /**
   * Idle Window / Pane Checker: Every 10s, if the bot is in WORLD state and
   * has an unexpected inventory/container open (i.e. a pane screen appeared
   * while the bot is stationary and not in character selection), close it with ESC.
   */
  startIdleWindowChecker() {
    this.stopIdleWindowChecker();
    this.idleWindowInterval = setInterval(() => {
      if (!this.bot) return;
      const state = this.bot.wynn?.worldState;
      // Only close stray windows in WORLD state — not during lobby/selection
      if (state !== 'WORLD') return;
      const win = this.bot.currentWindow;
      if (win && win.id !== 0) {
        // There's an open container while we're in-world and idle — close it
        try {
          this.bot.closeWindow(win);
          this.addLog('UI', `[Idle Checker] Closed stray open window: "${win.title || 'unknown'}" (id ${win.id})`);
          this.broadcastSSE('log', { category: 'UI', message: `[Idle Checker] Closed stray pane: "${win.title || 'unknown'}"` });
        } catch (e) {
          this.addLog('ERROR', `[Idle Checker] Failed to close window: ${e.message}`);
        }
      }
    }, 10000);
    this.addLog('STATE', '[Idle Checker] Idle window/pane checker started (10s interval).');
  }

  stopIdleWindowChecker() {
    if (this.idleWindowInterval) {
      clearInterval(this.idleWindowInterval);
      this.idleWindowInterval = null;
    }
  }

  addLog(category, message, details = null) {
    const cleanMsg = cleanWynncraftText ? cleanWynncraftText(message) : String(message || '').trim();
    if (!cleanMsg) return null;

    const key = `${category}:${cleanMsg}`;
    const now = Date.now();
    const isDuplicate = key === this.lastLogKey && (now - this.lastLogTime < 10000);

    const entry = {
      id: this.nextLogId++,
      time: new Date().toLocaleTimeString(),
      timestamp: now,
      category: (category || 'SYSTEM').toUpperCase(),
      message: cleanMsg,
      details
    };

    if (!isDuplicate) {
      this.lastLogKey = key;
      this.lastLogTime = now;
      this.systemLogs.push(entry);
      if (this.systemLogs.length > 500) this.systemLogs.shift();
      console.log(`[${entry.time}] [${entry.category}] ${entry.message}`);
      this.broadcastSSE('log', entry);
    } else {
      this.filteredSpamCount++;
    }
    return entry;
  }

  getStatus() {
    const accountSelection = prism?.getAccountSelection
      ? (tryGet(() => prism.getAccountSelection()) || null)
      : null;
    const activeAccount = accountSelection ? accountSelection.account : prism?.getActiveAccount();
    const wynnInstance = prism ? (tryGet(() => prism.getWynnInstance()) || null) : null;
    const availableGates = this.getGates();
    const availableCharacters = this.bot?.wynn?.availableCharacters || [];

    let botState = {
      connected: this.status === 'connected',
      status: this.status,
      statusMessage: this.statusMessage,
      username: this.bot?.username || activeAccount?.name || 'WynnBot',
      health: this.bot ? Math.round(this.bot.health || 0) : 0,
      maxHealth: 20,
      food: this.bot ? Math.round(this.bot.food || 0) : 0,
      position: null,
      server: this.bot?.wynn?.currentServer || 'Unknown',
      worldState: this.bot?.wynn?.worldState || 'UNKNOWN',
      autoLock: this.bot?.wynn?.autoLock !== undefined ? this.bot.wynn.autoLock : this.autoLockEnabled,
      characterTarget: this.bot?.wynn?.characterTarget || this.characterTarget,
      manualOverride: this.manualOverride,
      hasOpenWindow: !!this.bot?.currentWindow,
      currentWindowTitle: this.bot?.currentWindow ? (extractCleanText ? extractCleanText(this.bot.currentWindow.title) : (typeof this.bot.currentWindow.title === 'string' ? stripFormatting(this.bot.currentWindow.title) : 'Window')) : null,
      currentWindowId: this.bot?.currentWindow?.id ?? null,
      availableCharacters,
      availableGates,
      realGateFound: availableGates.length > 0,
      antiAfk: this.antiAfkEnabled,
      viewerActive: this.viewerActive,
      viewerUrl: this.viewerActive ? `http://${getHostname()}:${VIEWER_PORT}` : null,
      viewerRenderVersion: this.bot?.viewerInfo?.renderVersion || null,
      viewerBotVersion: this.bot?.viewerInfo?.botVersion || null,
      viewerTracking: this.bot?.viewerInfo?.trackingOverlay ?? null,
      emeralds: { total: 0, le: 0, eb: 0, e: 0, formatted: '0 E' },
      currentActionBar: this.currentActionBar || this.bot?.wynn?.currentActionBar || '',
      filteredSpamCount: this.filteredSpamCount,
      recentLogs: this.systemLogs.slice(-25),
      account: accountSelection ? {
        // Which account the bot will use, and why - so the dashboard can say
        // whether switching accounts in Prism would drag the bot along.
        using: accountSelection.account ? {
          name: accountSelection.account.name,
          uuid: accountSelection.account.uuid,
          isTokenValid: accountSelection.account.isTokenValid,
          validMinutesRemaining: Math.round(accountSelection.account.validSecondsRemaining / 60)
        } : null,
        source: accountSelection.source,
        locked: accountSelection.source === 'lock' || accountSelection.source === 'env',
        lock: accountSelection.lock || null,
        prismActive: accountSelection.prismActive ? {
          name: accountSelection.prismActive.name,
          uuid: accountSelection.prismActive.uuid
        } : null,
        followsPrism: accountSelection.source === 'prism-active' || accountSelection.source === 'prism-first',
        sameAsPrismActive: !!(accountSelection.account && accountSelection.prismActive &&
          accountSelection.account.uuid === accountSelection.prismActive.uuid),
        warnings: accountSelection.warnings
      } : null,
      prism: {
        instance: wynnInstance?.name || 'Wynncraft-1.21.11',
        minecraftVersion: wynnInstance?.minecraftVersion || '1.21.11',
        host: wynnInstance?.host || 'play.wynncraft.com',
        port: wynnInstance?.port || 25565,
        account: activeAccount ? {
          name: activeAccount.name,
          uuid: activeAccount.uuid,
          type: activeAccount.type,
          isTokenValid: activeAccount.isTokenValid,
          validMinutesRemaining: Math.round(activeAccount.validSecondsRemaining / 60)
        } : null
      }
    };

    if (this.bot && this.status === 'connected') {
      const pos = this.bot.entity?.position;
      if (pos) {
        botState.position = {
          x: Math.round(pos.x * 10) / 10,
          y: Math.round(pos.y * 10) / 10,
          z: Math.round(pos.z * 10) / 10,
          yaw: Math.round(this.bot.entity.yaw * 100) / 100,
          pitch: Math.round(this.bot.entity.pitch * 100) / 100
        };
      }
      if (this.bot.wynn?.countEmeralds) {
        botState.emeralds = this.bot.wynn.countEmeralds();
      }
    }

    return botState;
  }

  getInventory() {
    if (!this.bot || this.status !== 'connected') return [];
    const items = this.bot.inventory?.items() || [];
    return items.map(item => ({
      slot: item.slot,
      name: item.name,
      customName: item.customName ? (extractCleanText ? extractCleanText(item.customName) : stripFormatting(item.customName)) : item.name,
      count: item.count
    }));
  }

  addChatMessage(type, sender, text, raw) {
    const clean = cleanWynncraftText ? cleanWynncraftText(text) : String(text || '').trim();
    if (!clean && !sender) return null;

    // Direct any action bar string to updateActionBar
    if (clean.startsWith('[Action Bar]') || sender === 'Action Bar') {
      const barText = clean.replace(/^\[Action Bar\]\s*/, '');
      return this.updateActionBar(barText);
    }

    // Auto-categorize if type is generic 'chat'
    let category = type || 'chat';
    if (!type || type === 'chat') {
      const lower = clean.toLowerCase();
      if (clean.startsWith('[Quest Updated:') || clean.startsWith('[New Quest:') || lower.includes('quest')) {
        category = 'quest';
      } else if (clean.includes('[Trade Market]') || lower.includes('bought') || lower.includes('sold') || lower.includes('emeralds')) {
        category = 'market';
      } else if (/^(?:\[\d+\/\d+\]\s*)?([A-Za-z0-9 _'-]+):\s*(.+)$/.test(clean) || clean.includes('[Press SHIFT to continue]')) {
        category = 'dialogue';
      } else if (lower.includes('world') || lower.includes('server') || lower.includes('lobby') || lower.includes('logged') || lower.includes('kicked')) {
        category = 'system';
      } else if (sender && sender !== 'System' && sender !== 'UI' && sender !== 'Gate') {
        category = 'player';
      }
    }

    const entry = {
      id: this.nextChatId++,
      time: new Date().toLocaleTimeString(),
      timestamp: Date.now(),
      type: category, // 'chat', 'dialogue', 'quest', 'market', 'system', 'player', 'actionbar'
      sender: sender || '',
      text: clean,
      raw: raw || text
    };
    this.chatLog.push(entry);
    if (this.chatLog.length > 500) this.chatLog.shift();
    this.broadcastSSE('chat', entry);
    return entry;
  }

  updateActionBar(text) {
    const clean = cleanWynncraftText ? cleanWynncraftText(text) : String(text || '').trim();
    if (!clean) return null;

    this.currentActionBar = clean;
    const now = Date.now();
    const isDuplicate = clean === this.lastActionBar && (now - this.lastActionBarTime < 15000);

    if (isDuplicate) {
      this.filteredSpamCount++;
      return null;
    }

    this.lastActionBar = clean;
    this.lastActionBarTime = now;

    const entry = {
      id: this.nextChatId++,
      time: new Date().toLocaleTimeString(),
      timestamp: now,
      type: 'actionbar',
      sender: 'Action Bar',
      text: clean,
      raw: text
    };
    this.chatLog.push(entry);
    if (this.chatLog.length > 500) this.chatLog.shift();
    this.broadcastSSE('actionbar', { text: clean });
    this.broadcastSSE('chat', entry);
    return entry;
  }

  broadcastSSE(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch (e) {
        this.sseClients.delete(client);
      }
    }
  }

  connect(options = {}) {
    if (this.bot && this.status === 'connected') {
      return { ok: false, error: 'Bot is already connected' };
    }

    this.status = 'connecting';
    this.statusMessage = 'Connecting to Wynncraft...';
    this.antiAfkEnabled = options.antiAfk ?? false;
    if (options.autoLock !== undefined) this.autoLockEnabled = !!options.autoLock;
    if (options.manualOverride !== undefined) this.manualOverride = !!options.manualOverride;
    if (options.characterTarget) this.characterTarget = options.characterTarget;
    else if (options.characterSlot) this.characterTarget = options.characterSlot;
    this.broadcastSSE('status', this.getStatus());

    try {
      this.botContext = createWynnBot({
        instance: options.instance || 'Wynncraft-1.21.11',
        auth: options.auth || 'prism',
        character: this.characterTarget,
        autoLock: this.autoLockEnabled && !this.manualOverride,
        antiAfk: this.antiAfkEnabled,
        viewer: options.viewer ? VIEWER_PORT : false,
        fallbackMicrosoft: true
      });

      this.bot = this.botContext.bot;

      this.addLog('SYSTEM', `Initiating connection to Wynncraft (${options.instance || 'Wynncraft-1.21.11'}, target: ${this.characterTarget})...`);

      this.bot.on('login', () => {
        this.status = 'connected';
        this.statusMessage = `Logged in as ${this.bot.username}`;
        this.addChatMessage('system', 'System', `Logged into Wynncraft as ${this.bot.username}`);
        this.addLog('SYSTEM', `Successfully logged into Wynncraft as ${this.bot.username}`);
        this.broadcastSSE('status', this.getStatus());
      });

      this.bot.on('spawn', () => {
        this.status = 'connected';
        this.statusMessage = 'Spawned in Wynncraft';
        if (options.viewer) {
          this.viewerActive = true;
        }
        this.addLog('STATE', `Spawned in Wynncraft. World State: ${this.bot.wynn?.worldState || 'UNKNOWN'}`);
        this.broadcastSSE('status', this.getStatus());

        // Start anti-AFK and idle window checker on every spawn
        this.startAntiAfk();
        this.startIdleWindowChecker();
      });

      this.bot.on('market:open', () => {
        this.broadcastSSE('market', this.getMarket());
      });

      this.bot.on('market:buy', ({ pane }) => {
        const price = formatEmeralds ? formatEmeralds(pane?.price) : pane?.price;
        this.addChatMessage('system', 'Market', `Bought "${pane?.customName}" for ${price}`);
        this.addLog('MARKET', `Bought "${pane?.customName}" for ${price} from slot ${pane?.slot}`);
        this.broadcastSSE('market', this.getMarket());
      });

      this.bot.on('windowOpen', (win) => {
        const winData = this.getWindow();
        const winId = win?.id ?? '?';
        const gateCount = winData.availableGates?.length || 0;
        const charCount = winData.availableCharacters?.length || 0;
        this.addChatMessage('system', 'UI', `Container window opened: ${winData.title} (#${winId}, ${winData.totalSlots} slots, ${charCount} chars, ${gateCount} gates)`);
        this.addLog('UI', `Container opened: "${winData.title}" (#${winId}, ${winData.totalSlots} slots) - Characters: ${charCount}, Real Gates: ${gateCount}`);
        this.broadcastSSE('window', winData);
        this.broadcastSSE('status', this.getStatus());
      });

      this.bot.on('windowClose', (win) => {
        const winId = win?.id ?? '0';
        this.addChatMessage('system', 'UI', `Container window closed (#${winId})`);
        this.addLog('UI', `Container window closed (#${winId})`);
        this.broadcastSSE('window_close', { id: winId });
        this.broadcastSSE('status', this.getStatus());
      });

      this.bot.on('wynn:gate_found', (gate) => {
        this.addLog('GATE', `Real World Gate found: ${gate.name} (World ${gate.worldNumber}, Region: ${gate.region}) at slot ${gate.slot}`, gate);
        this.addChatMessage('system', 'Gate', `Real World Gate identified: ${gate.name} (World ${gate.worldNumber}) at slot ${gate.slot}`);
        this.broadcastSSE('gate', gate);
      });

      this.bot.on('wynn:gates', (gates) => {
        this.addLog('GATE', `Discovered ${gates.length} Real World Gate(s): ${gates.map(g => `${g.name} [Slot ${g.slot}]`).join(', ')}`);
        this.broadcastSSE('gates', gates);
        this.broadcastSSE('status', this.getStatus());
      });

      this.bot.on('wynn:chat', (cleanText, rawText) => {
        if (cleanText) {
          if (cleanText.startsWith('[Action Bar]')) {
            this.updateActionBar(cleanText.replace(/^\[Action Bar\]\s*/, ''));
          } else {
            this.addChatMessage('chat', '', cleanText, rawText);
            this.addLog('CHAT', cleanText);
          }
        }
      });

      this.bot.on('wynn:dialogue', (d) => {
        this.addChatMessage('dialogue', d.npc, d.speech, d.raw);
        this.addLog('DIALOGUE', `[${d.npc}] ${d.speech}`);
      });

      this.bot.on('wynn:quest', (q) => {
        this.addChatMessage('quest', 'Quest', q);
        this.addLog('QUEST', q);
      });

      this.bot.on('wynn:market', (m) => {
        this.addChatMessage('market', 'Market', m);
        this.addLog('MARKET', m);
      });

      this.bot.on('wynn:characters', (chars) => {
        this.addChatMessage('system', 'System', `Detected ${chars.length} characters in character selection.`);
        this.addLog('CHAR', `Character selection cards detected: ${chars.map(c => `${c.class} (Slot ${c.slot}, Lvl ${c.level})`).join(', ')}`);
        this.broadcastSSE('window', this.getWindow());
        this.broadcastSSE('status', this.getStatus());
      });

      this.bot.on('wynn:state', (newState, oldState) => {
        this.addChatMessage('system', 'State', `Wynncraft world state: ${oldState} -> ${newState}`);
        this.addLog('STATE', `Wynncraft world state: ${oldState} -> ${newState}`);
        this.broadcastSSE('status', this.getStatus());
      });

      this.bot.on('health', () => {
        this.broadcastSSE('health', {
          health: Math.round(this.bot.health || 0),
          food: Math.round(this.bot.food || 0)
        });
      });

      this.bot.on('wynn:actionbar', (text) => {
        if (text) {
          this.updateActionBar(text);
        }
      });

      this.bot.on('wynn:title', (text) => {
        // text may be a raw chat component object or already a string
        let titleStr = '';
        if (typeof text === 'string') {
          titleStr = cleanWynncraftText ? cleanWynncraftText(text) : text;
        } else if (text && typeof text === 'object') {
          titleStr = extractCleanText ? extractCleanText(text) : (cleanWynncraftText ? cleanWynncraftText(JSON.stringify(text)) : '');
        }
        if (titleStr && titleStr !== '[object Object]') {
          this.addChatMessage('dialogue', 'Screen Title', titleStr);
          this.addLog('TITLE', titleStr);
        }
      });

      this.bot.on('kicked', (reason) => {
        this.status = 'disconnected';
        let cleanReason = '';
        try {
          cleanReason = extractCleanText ? extractCleanText(reason) : (parseChatComponent ? parseChatComponent(reason) : '');
        } catch (e) {}
        if (!cleanReason) {
          cleanReason = stripFormatting(typeof reason === 'string' ? reason : JSON.stringify(reason));
        }
        cleanReason = cleanReason.replace(/\n+/g, ' ').trim();
        this.lastKickReason = cleanReason;
        this.lastKickTime = Date.now();

        this.statusMessage = `Kicked: ${cleanReason}`;
        this.addChatMessage('system', 'Kicked', cleanReason);
        this.addLog('ERROR', `Kicked from server: ${cleanReason}`);

        // Informed decision / advice for session conflict:
        if (cleanReason.toLowerCase().includes('already logged on')) {
          const advice = "Another game instance (e.g. Prism Launcher) is already logged in with account 'boredfrom0', or the Wynncraft proxy session is still clearing. Please wait ~5-10s before retrying.";
          this.addChatMessage('system', 'Session Guard', advice);
          this.statusMessage = `Kicked: Already logged on. Close other game instances or wait ~10s before retrying.`;
          this.addLog('SYSTEM', advice);
        }

        this.broadcastSSE('status', this.getStatus());
      });

      this.bot.on('error', (err) => {
        this.status = 'error';
        this.statusMessage = `Error: ${err.message}`;
        this.addChatMessage('system', 'Error', err.message);
        this.addLog('ERROR', `Bot error: ${err.message}`);
        this.broadcastSSE('status', this.getStatus());
      });

      this.bot.on('end', (reason) => {
        this.status = 'disconnected';
        if (this.lastKickReason && (Date.now() - (this.lastKickTime || 0)) < 15000) {
          const isSessionConflict = this.lastKickReason.toLowerCase().includes('already logged on');
          if (isSessionConflict) {
            this.statusMessage = `Disconnected: Already logged on to Wynncraft. Prism launcher or other client is running.`;
          } else {
            this.statusMessage = `Disconnected (${reason || 'socketClosed'}): ${this.lastKickReason}`;
          }
        } else {
          this.statusMessage = `Disconnected (${reason || 'ended'})`;
        }
        this.viewerActive = false;
        this.stopAntiAfk();
        this.stopIdleWindowChecker();
        this.addChatMessage('system', 'System', this.statusMessage);
        this.addLog('SYSTEM', `Bot disconnected (${reason || 'ended'})`);
        this.broadcastSSE('status', this.getStatus());
        this.bot = null;
      });

      return { ok: true, status: 'connecting' };
    } catch (err) {
      this.status = 'error';
      this.statusMessage = err.message;
      this.broadcastSSE('status', this.getStatus());
      return { ok: false, error: err.message };
    }
  }

  getWindow() {
    if (!this.bot) {
      return {
        open: false,
        id: 0,
        type: 'inventory',
        title: 'Bot Offline',
        totalSlots: 0,
        availableCharacters: [],
        availableGates: [],
        slots: []
      };
    }
    if (this.bot.wynn?.getOpenWindow) {
      return this.bot.wynn.getOpenWindow();
    }
    const win = this.bot.currentWindow;
    if (!win) {
      const invSlots = this.bot.inventory?.slots || [];
      return {
        open: false,
        id: 0,
        type: 'inventory',
        title: 'Player Inventory (E)',
        totalSlots: invSlots.length,
        availableCharacters: this.bot.wynn?.availableCharacters || [],
        availableGates: this.bot.wynn?.availableGates || [],
        slots: invSlots.map((item, idx) => ({
          slot: idx,
          empty: !item,
          name: item?.name || 'empty',
          count: item?.count || 0,
          customName: item?.customName ? (extractCleanText ? extractCleanText(item.customName) : stripFormatting(item.customName)) : '',
          isGlassPane: item?.name?.includes('glass_pane') || false,
          isCharacterSlot: false,
          isWorldGate: false
        }))
      };
    }
    const cleanTitle = extractCleanText ? extractCleanText(win.title) : (typeof win.title === 'string' ? stripFormatting(win.title) : 'Window');
    const availableGates = this.bot.wynn?.availableGates || [];
    const availableCharacters = this.bot.wynn?.availableCharacters || [];
    return {
      open: true,
      id: win.id,
      type: win.type || 'container',
      title: cleanTitle || 'Window',
      totalSlots: win.slots.length,
      availableCharacters,
      availableGates,
      slots: win.slots.map((item, idx) => {
        const customName = item?.customName ? (extractCleanText ? extractCleanText(item.customName) : stripFormatting(item.customName)) : '';
        const isPane = item?.name?.includes('glass_pane') || false;
        const gateMatch = customName.match(/^(?:([A-Z]{2,3})\s*\|\s*)?(?:World|WC)\s*(\d+)/i);
        const isGate = !isPane && (!!gateMatch || ([48, 49, 50, 51, 52].includes(idx) && customName.toLowerCase().includes('world')));
        return {
          slot: idx,
          empty: !item,
          name: item?.name || 'empty',
          count: item?.count || 0,
          customName,
          isGlassPane: isPane,
          isCharacterSlot: [9, 10, 11, 18, 19, 20, 27, 28, 29, 36, 37, 38, 45, 46, 47].includes(idx),
          isWorldGate: isGate,
          gateInfo: gateMatch ? { world: parseInt(gateMatch[2], 10), region: gateMatch[1] || 'DEFAULT' } : null
        };
      })
    };
  }

  async clickSlot(slot, button = 0, mode = 0, windowId = null) {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, error: 'Bot is not connected' };
    }
    const s = parseInt(slot, 10);
    const b = parseInt(button || 0, 10);
    const m = parseInt(mode || 0, 10);
    if (isNaN(s)) {
      return { ok: false, error: 'Invalid slot index' };
    }

    // If no container window is open, and user targets slot 0-53 (container slots),
    // summon the class window first!
    if (!this.bot.currentWindow && (windowId === null || windowId === 0 || !windowId) && s >= 0 && s <= 53) {
      this.addChatMessage('system', 'UI', `No container window open: summoning class menu via interaction to reach slot ${s}...`);
      if (this.bot.wynn?.triggerLobbyRightClick) {
        this.bot.wynn.triggerLobbyRightClick();
      } else {
        const interact = this.findNearestInteraction();
        if (interact && typeof this.bot.useOn === 'function') {
          try { this.bot.useOn(interact); } catch (e) {}
        }
        try { this.bot.activateItem(); } catch (e) {}
      }
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 1000);
        this.bot.once('windowOpen', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    try {
      if (this.bot.wynn?.clickWindowSlot) {
        const res = await this.bot.wynn.clickWindowSlot(s, b, m, windowId);
        this.addChatMessage('system', 'UI', `Clicked slot ${s} (btn=${b}, mode=${m})`);
        this.broadcastSSE('window', this.getWindow());
        return { ok: true, slot: s, button: b, mode: m, result: res };
      }
      await this.bot.clickWindow(s, b, m);
      this.addChatMessage('system', 'UI', `Clicked slot ${s} (btn=${b}, mode=${m})`);
      this.broadcastSSE('window', this.getWindow());
      return { ok: true, slot: s, button: b, mode: m };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  setAutoLock(enabled, characterTarget = null, options = {}) {
    this.autoLockEnabled = !!enabled;
    if (characterTarget !== null && characterTarget !== undefined) {
      this.characterTarget = characterTarget;
    }
    this.manualOverride = options.manualOverride ?? false;
    if (this.bot && this.bot.wynn) {
      this.bot.wynn.autoLock = this.autoLockEnabled && !this.manualOverride;
      if (this.characterTarget) {
        this.bot.wynn.characterTarget = this.characterTarget;
      }
    }
    const modeDesc = this.manualOverride ? 'MANUAL OVERRIDE ACTIVE (Auto-Lock Paused)' : (this.autoLockEnabled ? `ENABLED (${this.characterTarget})` : 'DISABLED');
    this.addChatMessage('system', 'Config', `Auto-Lock: ${modeDesc}`);
    this.broadcastSSE('status', this.getStatus());
    return { ok: true, autoLock: this.autoLockEnabled, characterTarget: this.characterTarget, manualOverride: this.manualOverride };
  }

  openInventory() {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, error: 'Bot is not running' };
    }
    const invSlots = this.bot.inventory?.slots || [];
    return {
      ok: true,
      window: {
        open: true,
        id: 0,
        type: 'inventory',
        title: 'Player Inventory (E)',
        totalSlots: invSlots.length,
        slots: invSlots.map((item, idx) => ({
          slot: idx,
          empty: !item,
          name: item?.name || 'empty',
          count: item?.count || 0,
          customName: item?.customName ? (extractCleanText ? extractCleanText(item.customName) : stripFormatting(item.customName)) : '',
          isGlassPane: false,
          isCharacterSlot: false
        }))
      }
    };
  }

  closeWindow() {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, error: 'Bot is not running' };
    }
    if (this.bot.currentWindow) {
      try {
        const id = this.bot.currentWindow.id;
        this.bot.closeWindow(this.bot.currentWindow);
        this.broadcastSSE('window_close', { id });
        return { ok: true, message: `Closed window #${id}` };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    return { ok: true, message: 'No container window open' };
  }

  /**
   * All Prism accounts, with which one the bot uses and which one Prism has
   * active - the two are independent once a lock is set.
   */
  getAccounts() {
    if (!prism?.getAccountSelection) {
      return { ok: false, error: 'Prism integration is unavailable', accounts: [] };
    }
    const selection = prism.getAccountSelection();
    return {
      ok: true,
      source: selection.source,
      locked: selection.source === 'lock' || selection.source === 'env',
      lock: selection.lock || null,
      lockFile: prism.getAccountLockFile(),
      warnings: selection.warnings,
      accounts: selection.accounts.map(account => ({
        name: account.name,
        uuid: account.uuid,
        type: account.type,
        prismActive: account.active,
        usedByBot: !!(selection.account && selection.account.uuid === account.uuid),
        isTokenValid: account.isTokenValid,
        validMinutesRemaining: Math.round(account.validSecondsRemaining / 60),
        hasToken: account.hasToken
      }))
    };
  }

  /**
   * Pins the bot to one account, or releases it.
   *
   * A running bot keeps the session it connected with; the lock decides what
   * the next connect uses, so this never yanks a live bot off its account.
   */
  setAccountLock(identifier) {
    if (!prism?.setAccountLock) {
      return { ok: false, error: 'Prism integration is unavailable' };
    }
    const result = identifier ? prism.setAccountLock(identifier) : prism.clearAccountLock();
    if (!result.ok) return result;

    if (identifier) {
      this.addLog('ACCOUNT', `Bot locked to Prism account "${result.account.name}" - switching accounts in Prism no longer moves the bot`);
    } else {
      this.addLog('ACCOUNT', 'Account lock released; the bot follows Prism\'s active account again');
    }

    const state = this.getAccounts();
    if (this.status === 'connected' && identifier && this.bot?.username &&
        result.account.name !== this.bot.username) {
      state.note = `The bot stays connected as "${this.bot.username}" until you reconnect it`;
    }
    this.broadcastSSE('status', this.getStatus());
    return { ...result, ...state };
  }

  /**
   * Trades whose result is unknown: an intent was written, the answer never
   * arrived. Usually a connection dropped mid-purchase. Surfaced so someone
   * can check the game and resolve it, rather than the bot guessing.
   */
  getPendingTrades() {
    const journal = this.bot?.market?.journal;
    if (!journal) {
      return { ok: false, error: 'Bot is not connected', pending: [] };
    }
    const pending = journal.pending();
    return {
      ok: true,
      journalFile: journal.file,
      pending: pending.map(intent => ({
        intentId: intent.intent_id,
        ts: intent.ts,
        side: intent.side,
        item: intent.item,
        units: intent.units,
        limitPrice: intent.limit_price,
        emeraldsBefore: intent.emeralds_before
      })),
      note: pending.length
        ? 'These were started and never answered. Check the game before retrying: the trade may or may not have happened.'
        : null
    };
  }

  /**
   * Settles what it can of the pending trades from the bot's own balance,
   * instead of asking someone to go and look in the game.
   *
   * Whatever the evidence cannot argue stays pending and is returned as such,
   * with the reason it could not be settled.
   */
  reconcileTrades(options = {}) {
    if (!this.bot || !this.bot.market) {
      return { ok: false, error: 'Bot is not connected', settled: [], stillPending: [] };
    }
    const result = this.bot.market.reconcilePending(options);
    for (const resolution of result.settled || []) {
      this.addLog('MARKET', `Reconciled ${resolution.intent_id}: ${resolution.status} - ${resolution.reason}`);
    }
    return result;
  }

  /**
   * Just the bot's position, for pollers like the viewer's tracking camera
   * that would otherwise pull the whole status payload several times a second.
   */
  getPosition() {
    const pos = this.bot?.entity?.position;
    if (!this.bot || this.status !== 'connected' || !pos) {
      return { ok: false, error: 'Bot is not connected', position: null };
    }
    return {
      ok: true,
      position: {
        x: Math.round(pos.x * 100) / 100,
        y: Math.round(pos.y * 100) / 100,
        z: Math.round(pos.z * 100) / 100,
        yaw: Math.round((this.bot.entity.yaw || 0) * 1000) / 1000,
        pitch: Math.round((this.bot.entity.pitch || 0) * 1000) / 1000
      },
      username: this.bot.username || null
    };
  }

  /**
   * Reads the Trade Market window the bot currently has open.
   */
  getMarket() {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, open: false, error: 'Bot is not connected', locations: MARKET_LOCATIONS || {} };
    }
    const scan = this.bot.market
      ? this.bot.market.scan()
      : (parseMarketWindow ? parseMarketWindow(this.bot.currentWindow) : { open: false });
    return {
      ok: true,
      locations: MARKET_LOCATIONS || {},
      distance: this.bot.market ? this.bot.market.distanceTo() : null,
      walking: this.bot.market ? this.bot.market.walking : false,
      ...scan
    };
  }

  /**
   * Runs one Trade Market action, keeping the dashboard and logs in sync.
   */
  async marketAction(action, body = {}) {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, error: 'Bot is not connected' };
    }
    if (!this.bot.market) {
      return { ok: false, error: 'Market controller is not attached to this bot' };
    }

    const market = this.bot.market;
    let result;
    try {
      switch (action) {
        case 'walk':
          this.addLog('MARKET', `Walking to the ${body.location || market.defaultLocation} Trade Market...`);
          result = await market.walkTo(body.location, body);
          break;
        case 'open':
          this.addLog('MARKET', `Opening the Trade Market (${body.location || market.defaultLocation})...`);
          result = await market.open(body);
          break;
        case 'close':
          result = market.close();
          break;
        case 'search':
          this.addLog('MARKET', `Searching the Trade Market for "${body.query}"...`);
          result = await market.search(body.query, body);
          break;
        case 'next_page':
          result = await market.nextPage(body);
          break;
        case 'prev_page':
          result = await market.prevPage(body);
          break;
        case 'click':
          result = await market.click(body.selector ?? body, body);
          break;
        case 'buy':
          // body carries confirm, maxPrice, expectItem and intentId; the
          // executor decides what to honour.
          result = await market.buy(body.selector ?? body, body);
          break;
        default:
          return { ok: false, error: `Unknown market action: ${action}` };
      }
    } catch (err) {
      this.addLog('MARKET', `Market action "${action}" failed: ${err.message}`);
      return { ok: false, error: err.message };
    }

    if (result && result.ok === false && result.error) {
      this.addLog('MARKET', `Market action "${action}" rejected: ${result.error}`);
    }
    const snapshot = this.getMarket();
    this.broadcastSSE('market', snapshot);
    return { ...result, market: snapshot };
  }

  disconnect() {
    this.stopAntiAfk();
    this.stopIdleWindowChecker();
    if (this.bot) {
      try {
        this.bot.quit();
      } catch (e) {}
    }
    this.bot = null;
    this.status = 'disconnected';
    this.statusMessage = 'Disconnected by user';
    this.viewerActive = false;
    this.broadcastSSE('status', this.getStatus());
    return { ok: true };
  }

  sendChat(message) {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, error: 'Bot is not connected' };
    }
    this.bot.chat(message);
    this.addChatMessage('chat', this.bot.username, message);
    return { ok: true };
  }

  async selectCharacter(slotOrClass, options = {}) {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, error: 'Bot is not connected' };
    }
    try {
      const ok = await this.bot.wynn.selectCharacter(slotOrClass, options);
      if (ok) {
        this.addLog('CHAR', `Targeted character/slot: ${slotOrClass}`);
      }
      return { ok };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  getGates() {
    if (!this.bot) return [];
    if ((!this.bot.wynn?.availableGates || this.bot.wynn.availableGates.length === 0) && this.bot.currentWindow && this.bot.wynn?.scanWindow) {
      this.bot.wynn.scanWindow(this.bot.currentWindow, false);
    }
    return this.bot.wynn?.availableGates || [];
  }

  async selectGate(targetWorld = null) {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, error: 'Bot is not connected' };
    }
    if (this.bot.wynn?.selectGate) {
      const res = await this.bot.wynn.selectGate(targetWorld);
      if (res.ok && res.gate) {
        this.addLog('GATE', `Selected Real World Gate: ${res.gate.name} (World ${res.gate.worldNumber}) at slot ${res.gate.slot}`);
        this.addChatMessage('system', 'Gate', `Entering Real World Gate: ${res.gate.name} (World ${res.gate.worldNumber})`);
      }
      return res;
    }
    return { ok: false, error: 'selectGate is not supported' };
  }

  goto(x, y, z) {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, error: 'Bot is not connected' };
    }
    if (isNaN(x) || isNaN(y) || isNaN(z)) {
      return { ok: false, error: 'Invalid coordinates' };
    }
    this.bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z));
    this.addChatMessage('system', 'Navigation', `Pathfinding towards (${x}, ${y}, ${z})...`);
    return { ok: true };
  }

  currentPosition() {
    const position = this.bot?.entity?.position;
    if (!position) return null;
    return { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
  }

  saveCurrentWaypoint(name, desc = '') {
    const position = this.currentPosition();
    if (!position) return { ok: false, error: 'Bot position is unavailable; connect and load into a world first' };
    return waypointStore.saveWaypoint({ name, desc, ...position });
  }

  stop() {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, error: 'Bot is not connected' };
    }
    this.bot.pathfinder.stop();
    this.addChatMessage('system', 'Navigation', 'Pathfinding stopped.');
    return { ok: true };
  }

  setAntiAfk(enable) {
    this.antiAfkEnabled = !!enable;
    if (this.bot && this.bot.wynn) {
      if (this.antiAfkEnabled) {
        this.bot.wynn.startAntiAfk();
      } else {
        this.bot.wynn.stopAntiAfk();
      }
    }
    this.broadcastSSE('status', this.getStatus());
    return { ok: true, antiAfk: this.antiAfkEnabled };
  }

  switchServer(serverName) {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, error: 'Bot is not connected' };
    }
    if (serverName.toLowerCase() === 'hub') {
      this.bot.wynn.goToHub();
    } else {
      this.bot.wynn.switchServer(serverName);
    }
    return { ok: true };
  }

  findNearestInteraction() {
    if (!this.bot || !this.bot.entities) return null;
    const botPos = this.bot.entity?.position;
    if (!botPos) return null;
    let nearest = null;
    let minDist = 6;
    for (const e of Object.values(this.bot.entities)) {
      if (!e || e === this.bot.entity || !e.position) continue;
      const n = (e.name || '').toLowerCase();
      if (n === 'interaction' || n === 'item_display' || n === 'armor_stand') {
        const d = botPos.distanceTo(e.position);
        if (d < minDist) {
          minDist = d;
          nearest = e;
        }
      }
    }
    return nearest;
  }

  performAction(action, options = {}) {
    if (!this.bot || this.status !== 'connected') {
      return { ok: false, error: 'Bot is not connected' };
    }
    const act = (action || '').toLowerCase().trim();
    try {
      if (act === 'left_click' || act === 'swing' || act === 'play' || act === 'attack') {
        if (this.bot.wynn?.triggerLobbyLeftClick) {
          this.bot.wynn.triggerLobbyLeftClick();
        } else {
          const interactEntity = this.findNearestInteraction();
          if (interactEntity && typeof this.bot.attack === 'function') {
            try { this.bot.attack(interactEntity, true); } catch (e) {}
          }
          try { this.bot.swingArm('right'); } catch (e) {}
        }
        this.addChatMessage('system', 'Action', 'Performed Left-Click (Targeted interaction entity / Swing arm to Connect & Play)');
        return { ok: true, action: 'left_click' };
      }
      if (act === 'right_click' || act === 'use' || act === 'switch' || act === 'activate' || act === 'open_class' || act === 'class') {
        if (this.bot.wynn?.triggerLobbyRightClick) {
          this.bot.wynn.triggerLobbyRightClick();
        } else {
          const interactEntity = this.findNearestInteraction();
          if (interactEntity && typeof this.bot.useOn === 'function') {
            try { this.bot.useOn(interactEntity); } catch (e) {}
          }
          try { this.bot.activateItem(); } catch (e) {}
        }
        this.addChatMessage('system', 'Action', 'Performed Right-Click (Targeted interaction entity / Activate item to open Window Panes)');
        return { ok: true, action: 'right_click' };
      }
      if (act === 'sneak') {
        this.bot.setControlState('sneak', true);
        setTimeout(() => this.bot.setControlState('sneak', false), 350);
        this.addChatMessage('system', 'Action', 'Sneaked (Shift)');
        return { ok: true, action: 'sneak' };
      }
      if (act === 'jump') {
        this.bot.setControlState('jump', true);
        setTimeout(() => this.bot.setControlState('jump', false), 350);
        this.addChatMessage('system', 'Action', 'Jumped');
        return { ok: true, action: 'jump' };
      }
      return { ok: false, error: `Unknown action: ${action}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  getEntities() {
    if (!this.bot || this.status !== 'connected') return [];
    const botPos = this.bot.entity?.position;
    if (!botPos) return [];
    return Object.values(this.bot.entities || {})
      .filter(e => e && e !== this.bot.entity && e.position)
      .map(e => ({
        id: e.id,
        name: e.name || e.displayName || e.username || 'unknown',
        type: e.type,
        distance: Math.round(botPos.distanceTo(e.position) * 10) / 10,
        position: { x: Math.round(e.position.x * 10) / 10, y: Math.round(e.position.y * 10) / 10, z: Math.round(e.position.z * 10) / 10 }
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 30);
  }
}

function tryGet(fn) {
  try { return fn(); } catch (e) { return null; }
}

function getHostname() {
  return 'localhost';
}

const manager = new BotManager();

// Setup HTTP API
const server = http.createServer(async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // JSON helper
  function json(statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  // Parse body helper
  function readBody() {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          resolve({});
        }
      });
    });
  }

  // Routes
  if (req.method === 'GET') {
    if (await handlePriceRoute(req, res, parsedUrl)) return;

    if (pathname === '/api/bot/status') {
      return json(200, manager.getStatus());
    }

    if (pathname === '/api/bot/window') {
      return json(200, manager.getWindow());
    }

    if (pathname === '/api/bot/inventory') {
      return json(200, { items: manager.getInventory() });
    }

    if (pathname === '/api/bot/entities') {
      return json(200, { entities: manager.getEntities() });
    }

    if (pathname === '/api/bot/trades/pending') {
      return json(200, manager.getPendingTrades());
    }

    if (pathname === '/api/bot/accounts') {
      return json(200, manager.getAccounts());
    }

    if (pathname === '/api/bot/position') {
      return json(200, manager.getPosition());
    }

    if (pathname === '/api/bot/market') {
      return json(200, manager.getMarket());
    }

    if (pathname === '/api/bot/waypoints') {
      return json(200, { waypoints: waypointStore.listWaypoints() });
    }

    if (pathname === '/api/bot/waypoints/current') {
      const position = manager.currentPosition();
      return json(200, { ok: !!position, position, synced: !!position });
    }

    if (pathname === '/api/bot/chat/history') {
      return json(200, { messages: manager.chatLog });
    }

    if (pathname === '/api/bot/chat/insights') {
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '60', 10);
      const insights = ChatInsightsEngine.analyze(manager.chatLog, manager.getStatus(), { limit });
      return json(200, { ok: true, insights });
    }

    if (pathname === '/api/bot/actionbar') {
      return json(200, {
        ok: true,
        actionbar: manager.currentActionBar || manager.bot?.wynn?.currentActionBar || '',
        filteredSpamCount: manager.filteredSpamCount
      });
    }

    if (pathname === '/api/bot/poll') {
      const since = parseInt(parsedUrl.searchParams.get('since') || '0', 10);
      const newMessages = manager.chatLog.filter(m => m.id > since);
      return json(200, {
        status: manager.getStatus(),
        messages: newMessages,
        actionbar: manager.currentActionBar || '',
        filteredSpamCount: manager.filteredSpamCount
      });
    }

    if (pathname === '/api/bot/gates') {
      const gates = manager.getGates();
      return json(200, {
        ok: true,
        gates,
        realGateFound: gates.length > 0,
        count: gates.length
      });
    }

    if (pathname === '/api/bot/logs') {
      const cat = parsedUrl.searchParams.get('category');
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '100', 10);
      let logs = manager.systemLogs;
      if (cat) {
        logs = logs.filter(l => l.category.toLowerCase() === cat.toLowerCase());
      }
      return json(200, {
        ok: true,
        total: logs.length,
        logs: logs.slice(-limit)
      });
    }

    if (pathname === '/api/bot/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(`data: ${JSON.stringify(manager.getStatus())}\n\n`);
      manager.sseClients.add(res);
      req.on('close', () => {
        manager.sseClients.delete(res);
      });
      return;
    }
  }

  if (req.method === 'HEAD') {
    return serveStatic(req, res, pathname);
  }

  if (req.method === 'POST') {
    const body = await readBody();

    if (pathname === '/api/bot/connect') {
      const result = manager.connect(body);
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/disconnect') {
      const result = manager.disconnect();
      return json(200, result);
    }

    if (pathname === '/api/bot/chat') {
      if (!body.message) return json(400, { ok: false, error: 'Missing message' });
      const result = manager.sendChat(body.message);
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/chat/insights' || pathname === '/api/bot/chat/review') {
      const insights = await ChatInsightsEngine.reviewWithLLM(
        manager.chatLog,
        manager.getStatus(),
        body
      );
      return json(200, { ok: true, insights });
    }

    if (pathname === '/api/bot/class') {
      const result = await manager.selectCharacter(body.slotOrClass, {
        rawSlot: body.rawSlot ?? body.raw,
        manualSlot: body.manualSlot ?? body.slot
      });
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/gate') {
      const target = body.world !== undefined ? body.world : (body.slot !== undefined ? body.slot : (body.gate ?? 'first'));
      const result = await manager.selectGate(target);
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/goto') {
      const result = manager.goto(parseFloat(body.x), parseFloat(body.y), parseFloat(body.z));
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/waypoints') {
      const result = waypointStore.saveWaypoint(body);
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/waypoints/finalize') {
      const result = manager.saveCurrentWaypoint(body.name, body.desc);
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/waypoints/delete') {
      const result = waypointStore.deleteWaypoint(body.name);
      return json(result.ok ? 200 : 404, result);
    }

    if (pathname === '/api/bot/stop') {
      const result = manager.stop();
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/antiafk') {
      const result = manager.setAntiAfk(body.enabled);
      return json(200, result);
    }

    if (pathname === '/api/bot/server') {
      const result = manager.switchServer(body.server || 'hub');
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/account/lock') {
      const identifier = body.account || body.uuid || body.name;
      if (!identifier) return json(400, { ok: false, error: 'Missing account (name or uuid)' });
      const result = manager.setAccountLock(identifier);
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/account/unlock') {
      const result = manager.setAccountLock(null);
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/trades/reconcile') {
      const result = manager.reconcileTrades(body || {});
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname.startsWith('/api/bot/market/')) {
      const action = pathname.slice('/api/bot/market/'.length);
      const result = await manager.marketAction(action, body);
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/click') {
      const result = await manager.clickSlot(body.slot, body.button, body.mode, body.windowId);
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/autolock') {
      const result = manager.setAutoLock(body.enabled, body.characterTarget, {
        manualOverride: body.manualOverride ?? body.manual
      });
      return json(200, result);
    }

    if (pathname === '/api/bot/open_inventory') {
      const result = manager.openInventory();
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/close_window') {
      const result = manager.closeWindow();
      return json(result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/bot/action') {
      const result = manager.performAction(body.action, body);
      return json(result.ok ? 200 : 400, result);
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  json(404, { error: 'Not found' });
});

process.on('uncaughtException', (err) => {
  console.error('[WynnBot Server] Uncaught exception:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error('[WynnBot Server] Port is already in use; exiting so the foreground shell reports failure.');
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[WynnBot Server] Unhandled rejection:', reason?.message || reason);
});

server.listen(PORT, HOST, () => {
  console.log(`\x1b[36m[WynnBot Server]\x1b[0m API running on http://localhost:${PORT}`);
});

module.exports = {
  server,
  manager
};
