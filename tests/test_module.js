/**
 * Module / Unit Tests for Wynncraft Mineflayer Setup
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Require mineflayer-wynn module
const candidateDirs = [
  path.resolve(__dirname, '../mineflayer-wynn'),
  path.resolve(__dirname, '../../mineflayer-wynn'),
  path.join(os.homedir(), 'mineflayer-wynn')
];
const resolvedDir = candidateDirs.find(d => fs.existsSync(d));
const mf = resolvedDir ? require(path.join(resolvedDir, 'src/index.js')) : require('mineflayer-wynn');
const {
  getPrismDir,
  getInstances,
  getWynnInstance,
  getPrismAccounts,
  getActiveAccount,
  getWynntilsData,
  stripFormatting,
  cleanWynncraftText
} = mf;
const { ChatInsightsEngine } = require('../scripts/chat_insights');

console.log('\x1b[1;34m=== [MODULE TESTS] Unit Testing Core Modules ===\x1b[0m\n');

let passed = 0;
let total = 0;

async function test(name, fn) {
  total++;
  try {
    await fn();
    console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}`);
    console.error(`  Error: ${err.message}\n`);
  }
}

async function runAll() {

  // 1. Prism Directory
  await test('Prism Launcher base directory is resolved correctly', () => {
    const dir = getPrismDir();
    assert.ok(dir, 'Directory must be defined');
    assert.ok(fs.existsSync(dir), `Directory must exist on disk: ${dir}`);
    assert.ok(dir.includes('PrismLauncher'), 'Path should include PrismLauncher');
  });

  // 2. Instances discovery
  await test('Discovers installed Prism instances including Wynncraft-1.21.11', () => {
    const instances = getInstances();
    assert.ok(Array.isArray(instances), 'Instances must be an array');
    assert.ok(instances.length >= 1, 'Should find at least 1 instance');
    const wynn = instances.find(i => i.name === 'Wynncraft-1.21.11');
    assert.ok(wynn, 'Should find Wynncraft-1.21.11 instance');
    assert.ok(wynn.hasConfig, 'Instance should have instance.cfg');
    assert.ok(wynn.hasPack, 'Instance should have mmc-pack.json');
  });

  // 3. Instance config parsing
  await test('Parses Wynncraft instance configuration and components', () => {
    const inst = getWynnInstance('Wynncraft-1.21.11');
    assert.strictEqual(inst.name, 'Wynncraft-1.21.11');
    assert.strictEqual(inst.host, 'play.wynncraft.com');
    assert.strictEqual(inst.port, 25565);
    assert.strictEqual(inst.minecraftVersion, '1.21.11');
    assert.strictEqual(inst.fabricVersion, '0.19.5');
    assert.strictEqual(inst.joinOnLaunch, true);
    assert.ok(fs.existsSync(inst.minecraftDir), 'Minecraft dir exists');
  });

  // 4. Accounts parsing
  await test('Parses Prism accounts and checks active token validity', () => {
    const accounts = getPrismAccounts();
    assert.ok(Array.isArray(accounts), 'Accounts must be an array');
    assert.ok(accounts.length >= 1, 'At least 1 account present');
    const active = getActiveAccount();
    assert.ok(active, 'Should find active account');
    assert.ok(typeof active.name === 'string' && active.name.length > 0);
    assert.strictEqual(active.type, 'MSA');
    assert.ok(typeof active.uuid === 'string' && active.uuid.length > 0);
    assert.ok(active.hasToken, 'Has Yggdrasil token');
    assert.strictEqual(active.isTokenValid, true, 'Active session token must be currently valid');
    assert.ok(active.validSecondsRemaining > 3600, 'Token should have substantial time remaining');
  });

  // 5. Wynntils data
  await test('Loads Wynntils player storage for active account', () => {
    const active = getActiveAccount();
    const storagePath = path.join(getPrismDir(), 'instances', 'Wynncraft-1.21.11',
      'minecraft', 'wynntils', 'storage', `${active.uuid}.data.json`);

    // Wynntils only writes this file after the account has played with the mod
    // installed, so on a fresh machine there is nothing to parse yet. Assert
    // the reader's contract in that case rather than failing on a missing file.
    if (!fs.existsSync(storagePath)) {
      assert.strictEqual(getWynntilsData(active.uuid, 'Wynncraft-1.21.11'), null,
        'Missing Wynntils storage must read as null, not throw');
      console.log(`  (no Wynntils storage at ${storagePath} yet; checked the null path instead)`);
      return;
    }

    const data = getWynntilsData(active.uuid, 'Wynncraft-1.21.11');
    assert.ok(data !== null, 'Wynntils data must be loaded');
    assert.ok(typeof data === 'object', 'Wynntils data must be an object');
    assert.ok(data['wynntils.upfixers'] !== undefined || data['service.update.lastShownChangelogVersion'] !== undefined, 'Contains standard Wynntils keys');
  });

  // 6. Formatting stripper
  await test('Strips Minecraft color formatting codes properly', () => {
    const raw = '§a[VIP] §6boredfrom0§r: §fHello Wynncraft! §k123§r §lBold§r';
    const clean = stripFormatting(raw);
    assert.strictEqual(clean, '[VIP] boredfrom0: Hello Wynncraft! 123 Bold');

    assert.strictEqual(stripFormatting(null), '');
    assert.strictEqual(stripFormatting('plain text'), 'plain text');
  });

  // 7. Emerald calculations
  await test('Calculates emerald conversions (LE, EB, E) accurately', () => {
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    bot.inventory = {
      items: () => [
        { name: 'emerald', count: 35 },
        { name: 'emerald_block', count: 5 },
        // A custom name is a plain string before 1.20.5 and a text component
        // after it, and a real bot on Wynncraft only ever sees the second.
        // Both shapes are held here because a test that knew only the first
        // is what let liquid emeralds go uncounted for a while - see
        // tests/test_protocol_harness.js, which found it against a real server.
        { name: 'emerald', customName: '§aLiquid Emerald', count: 2 },
        { name: 'emerald', count: 1,
          customName: { type: 'compound', value: { text: { type: 'string', value: '§aLiquid Emerald' } } } }
      ]
    };
    const { wynncraftPlugin } = mf;
    wynncraftPlugin(bot, {});
    const res = bot.wynn.countEmeralds();
    assert.strictEqual(res.total, 12643);
    assert.strictEqual(res.le, 3);
    assert.strictEqual(res.eb, 5);
    assert.strictEqual(res.e, 35);
    assert.strictEqual(res.formatted, '3 LE, 5 EB, 35 E');
  });

  // 8. Bot Server Waypoints
  await test('Waypoints contain valid coordinates and essential Wynncraft cities', () => {
    const serverPath = path.resolve(__dirname, '../scripts/wynn_bot_server.js');
    assert.ok(fs.existsSync(serverPath), 'wynn_bot_server.js must exist');
    const content = fs.readFileSync(serverPath, 'utf8');
    assert.ok(content.includes('Detlas'), 'Waypoints must include Detlas');
    assert.ok(content.includes('Ragni'), 'Waypoints must include Ragni');
    assert.ok(content.includes('Cinfras'), 'Waypoints must include Cinfras');
    assert.ok(content.includes('Lutho'), 'Waypoints must include Lutho');
  });

  // 9. Window and Glass Pane parsing in wynncraftPlugin
  await test('wynncraftPlugin identifies glass panes and formats container slots correctly', () => {
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    const { wynncraftPlugin } = mf;
    wynncraftPlugin(bot, { autoLock: true, characterTarget: 'first' });

    const mockSlots = new Array(54).fill(null);
    mockSlots[0] = { name: 'gray_stained_glass_pane', count: 1, customName: ' ' };
    mockSlots[9] = {
      name: 'bow',
      count: 1,
      customName: '§aArcher (Level 59)',
      customLore: ['§7Class: Archer', '§7Level: 59']
    };

    bot.currentWindow = {
      id: 1,
      type: 'minecraft:generic_9x6',
      title: '󏿕 Character Selection',
      slots: mockSlots
    };

    const win = bot.wynn.getOpenWindow();
    assert.strictEqual(win.open, true);
    assert.strictEqual(win.totalSlots, 54);
    assert.strictEqual(win.slots[0].isGlassPane, true);
    assert.strictEqual(win.slots[0].isCharacterSlot, false);
    assert.strictEqual(win.slots[9].isGlassPane, false);
    assert.strictEqual(win.slots[9].isCharacterSlot, true);
    assert.strictEqual(win.slots[9].customName, 'Archer (Level 59)');
  });

  // 10. Auto-Lock and Character Selection configuration
  await test('wynncraftPlugin initializes autoLock and target class correctly', () => {
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    const { wynncraftPlugin } = mf;
    wynncraftPlugin(bot, { autoLock: true, characterSlot: 'archer' });

    assert.strictEqual(bot.wynn.autoLock, true);
    assert.strictEqual(bot.wynn.characterTarget, 'archer');
    assert.strictEqual(bot.wynn.worldState, 'UNKNOWN');
  });

  // 11. Chat Component / Kick message parsing
  await test('parseChatComponent parses compound Mojang NBT / JSON kick messages into clean text', () => {
    const { parseChatComponent } = mf;
    assert.ok(typeof parseChatComponent === 'function', 'parseChatComponent must be exported');

    const mojangCompound = {
      type: 'compound',
      value: {
        extra: {
          type: 'list',
          value: [
            { color: { type: 'string', value: 'dark_red' }, text: { type: 'string', value: '⚠ ' } },
            { color: { type: 'string', value: 'red' }, text: { type: 'string', value: 'You are already logged on to Wynncraft.' } },
            { color: { type: 'string', value: 'gray' }, text: { type: 'string', value: '\nPlease try joining again' } }
          ]
        },
        text: { type: 'string', value: '' }
      }
    };

    const clean = parseChatComponent(mojangCompound);
    assert.ok(clean.includes('You are already logged on to Wynncraft.'));
    assert.ok(clean.includes('Please try joining again'));
    assert.ok(!clean.includes('compound'));
  });

  // 12. Manual Pane & Slot Override
  await test('wynn.selectCharacter supports manual pane & slot override (raw:1 and options.rawSlot)', async () => {
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    const { wynncraftPlugin } = mf;
    wynncraftPlugin(bot);

    const clicks = [];
    bot.clickWindow = async (slot, btn, mode) => {
      clicks.push({ slot, btn, mode });
    };

    const mockSlots = new Array(54).fill(null);
    mockSlots[1] = { name: 'gray_stained_glass_pane', count: 1 };
    mockSlots[9] = { name: 'bow', count: 1 };

    bot.currentWindow = {
      id: 1,
      slots: mockSlots,
      inventoryStart: 54,
      inventoryEnd: 90
    };

    // Test raw:1 (container slot 1, a glass pane)
    const ok1 = await bot.wynn.selectCharacter('raw:1');
    assert.strictEqual(ok1, true);
    assert.strictEqual(clicks.length, 1);
    assert.strictEqual(clicks[0].slot, 1);

    // Test options.rawSlot
    const ok2 = await bot.wynn.selectCharacter(2, { rawSlot: true });
    assert.strictEqual(ok2, true);
    assert.strictEqual(clicks.length, 2);
    assert.strictEqual(clicks[1].slot, 2);
  });

  // 13. extractCleanText & Compound Chat Parsing
  await test('extractCleanText extracts plain text from compound Mojang NBT preserving spacing', () => {
    const { extractCleanText } = mf;
    const compound = {
      type: 'compound',
      value: {
        text: { type: 'string', value: '' },
        extra: {
          type: 'list',
          value: {
            type: 'compound',
            value: [
              { text: { type: 'string', value: '§aNA | ' } },
              { text: { type: 'string', value: '§bWorld 1' } }
            ]
          }
        }
      }
    };
    const text = extractCleanText(compound);
    assert.strictEqual(text, 'NA | World 1');
  });

  // 14. Real World Gate & Character Card Discovery
  await test('wynncraftPlugin parses Character Cards AND Real World Gates (World 1, World 17)', async () => {
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    const { wynncraftPlugin } = mf;
    wynncraftPlugin(bot, { autoLock: false });

    const mockSlots = new Array(54).fill(null);
    // Border glass panes
    mockSlots[0] = { name: 'gray_stained_glass_pane', count: 1 };
    mockSlots[1] = { name: 'gray_stained_glass_pane', count: 1 };

    // Character cards (Slots 9, 10)
    mockSlots[9] = {
      name: 'potion',
      count: 1,
      customName: '§aMage',
      customLore: ['§7Class: Mage', '§7Combat Level: 105']
    };
    mockSlots[10] = {
      name: 'potion',
      count: 1,
      customName: '§6Warrior',
      customLore: ['§7Class: Warrior', '§7Combat Level: 85']
    };

    // Real World Gates (Slots 49, 50, 51, 52)
    mockSlots[49] = {
      name: 'lime_terracotta',
      count: 1,
      customName: '§aNA | World 17',
      customLore: ['§7Players: 42/60', '§eClick to join']
    };
    mockSlots[50] = {
      name: 'lime_terracotta',
      count: 1,
      customName: '§aNA | World 18',
      customLore: ['§7Players: 30/60', '§eClick to join']
    };
    mockSlots[51] = {
      name: 'lime_terracotta',
      count: 1,
      customName: '§aNA | World 1',
      customLore: ['§7Players: 55/60', '§eClick to join']
    };
    mockSlots[52] = {
      name: 'lime_terracotta',
      count: 1,
      customName: '§aNA | World 9',
      customLore: ['§7Players: 20/60', '§eClick to join']
    };

    const discoveredGates = [];
    bot.on('wynn:gate_found', (g) => discoveredGates.push(g));

    bot.currentWindow = {
      id: 1,
      title: 'Select a Character',
      slots: mockSlots,
      inventoryStart: 54,
      inventoryEnd: 90
    };

    bot.emit('windowOpen', bot.currentWindow);

    // Verify Characters
    assert.strictEqual(bot.wynn.availableCharacters.length, 2);
    assert.strictEqual(bot.wynn.availableCharacters[0].class, 'Mage');
    assert.strictEqual(bot.wynn.availableCharacters[0].level, 105);
    assert.strictEqual(bot.wynn.availableCharacters[1].class, 'Warrior');

    // Verify Real World Gates
    assert.strictEqual(bot.wynn.availableGates.length, 4);
    assert.strictEqual(discoveredGates.length, 4);

    const w1 = bot.wynn.availableGates.find(g => g.worldNumber === 1);
    assert.ok(w1, 'World 1 gate must be discovered');
    assert.strictEqual(w1.slot, 51);
    assert.strictEqual(w1.region, 'NA');
    assert.strictEqual(w1.onlinePlayers, '55/60');

    const w17 = bot.wynn.availableGates.find(g => g.worldNumber === 17);
    assert.ok(w17, 'World 17 gate must be discovered');
    assert.strictEqual(w17.slot, 49);

    // Verify getOpenWindow reports availableGates
    const winData = bot.wynn.getOpenWindow();
    assert.strictEqual(winData.availableGates.length, 4);
    assert.strictEqual(winData.slots[51].isWorldGate, true);
    assert.strictEqual(winData.slots[51].gateInfo.world, 1);
  });

  // 15. Gate Selection Method
  await test('wynn.findRealGate and wynn.selectGate click correct gate slot', async () => {
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    const { wynncraftPlugin } = mf;
    wynncraftPlugin(bot);

    bot.wynn.availableGates = [
      { slot: 49, name: 'NA | World 17', worldNumber: 17, region: 'NA' },
      { slot: 51, name: 'NA | World 1', worldNumber: 1, region: 'NA' }
    ];

    const clicks = [];
    bot.clickWindow = async (slot, btn, mode) => {
      clicks.push({ slot, btn, mode });
    };

    // Find gate by world number 1
    const gate1 = bot.wynn.findRealGate(1);
    assert.ok(gate1);
    assert.strictEqual(gate1.slot, 51);

    // Find gate by string 'WC17'
    const gate17 = bot.wynn.findRealGate('WC17');
    assert.ok(gate17);
    assert.strictEqual(gate17.slot, 49);

    // Select gate 1
    const res = await bot.wynn.selectGate(1);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(clicks.length, 1);
    assert.strictEqual(clicks[0].slot, 51);
  });

  // 16. Server Selector (90-slot) Container Gate Parsing
  await test('wynncraftPlugin parses Real World Gates from 90-slot "Wynncraft Servers" container', async () => {
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    const { wynncraftPlugin } = mf;
    wynncraftPlugin(bot, { autoQuickConnect: false });

    const mock90Slots = new Array(90).fill(null);
    for (let i = 0; i < 9; i++) mock90Slots[i] = { name: 'gray_stained_glass_pane', count: 1 };

    mock90Slots[12] = {
      name: 'diamond_block',
      count: 1,
      customName: 'NA | World 29 Recommended',
      customLore: ['Click to join', '✔ 32/40 Players Online', '0% Lag']
    };
    mock90Slots[33] = {
      name: 'lime_terracotta',
      count: 25,
      customName: 'NA | World 25',
      customLore: ['Click to join', '✔ 30/40 Players Online', '0% Lag']
    };
    mock90Slots[51] = {
      name: 'lime_terracotta',
      count: 1,
      customName: 'NA | World 1',
      customLore: ['Click to join', '✔ 33/40 Players Online', '0% Lag']
    };
    mock90Slots[44] = {
      name: 'arrow',
      count: 1,
      customName: 'Page 2 >>>>>'
    };

    const clicks = [];
    bot.clickWindow = async (slot, btn, mode) => {
      clicks.push({ slot, btn, mode });
    };

    bot.currentWindow = {
      id: 2,
      type: 'minecraft:generic_9x6',
      title: 'Wynncraft Servers',
      slots: mock90Slots,
      inventoryStart: 54,
      inventoryEnd: 90
    };

    bot.emit('windowOpen', bot.currentWindow);

    assert.strictEqual(bot.wynn.worldState, 'SERVER_SELECT');
    assert.strictEqual(bot.wynn.availableGates.length, 3);

    // Verify Recommended Gate
    const recGate = bot.wynn.findRealGate('recommended');
    assert.ok(recGate, 'Recommended gate should be resolved');
    assert.strictEqual(recGate.worldNumber, 29);
    assert.strictEqual(recGate.slot, 12);
    assert.strictEqual(recGate.recommended, true);
    assert.strictEqual(recGate.onlinePlayers, '32/40');
    assert.strictEqual(recGate.lag, '0%');

    // Verify World 25 Gate
    const w25 = bot.wynn.findRealGate(25);
    assert.ok(w25);
    assert.strictEqual(w25.slot, 33);
    assert.strictEqual(w25.onlinePlayers, '30/40');

    // Verify selecting recommended gate clicks slot 12
    const selRes = await bot.wynn.selectGate('recommended');
    assert.strictEqual(selRes.ok, true);
    assert.strictEqual(clicks.length, 1);
    assert.strictEqual(clicks[0].slot, 12);

    // Verify window data includes gateInfo for slot 33
    const winData = bot.wynn.getOpenWindow();
    assert.strictEqual(winData.slots[33].isWorldGate, true);
    assert.strictEqual(winData.slots[33].gateInfo.world, 25);
    assert.strictEqual(winData.slots[33].gateInfo.onlinePlayers, '30/40');
  });

  // 17. Wynncraft custom Unicode font & glyph cleaning
  await test('cleanWynncraftText strips formatting, Private Use Area glyphs, and control codes', () => {
    const raw = '§a[Guild] §r§fPlayer: §eHello §r§x§f§f§a§a§0§0World! \u0001\uE000\uE001';
    const cleaned = cleanWynncraftText(raw);
    assert.strictEqual(cleaned, '[Guild] Player: Hello World!');
  });

  // 18. Real-world Wynncraft Action Bar chat spam deduplication and cleaning
  await test('cleanWynncraftText cleans real-world Wynncraft action bar and lobby glyphs', () => {
    const rawSpam = 'v2.2.4_3\uE000\uE001NA11\uE000 Left-Click to play \uE001 Right-Click to switch\uE002\uE050boredfrom0\uE035\uE039\uE041\uE045\uE045\uE045\uE045\uE045\uE045\uE048';
    const cleaned = cleanWynncraftText(rawSpam);
    assert.strictEqual(cleaned, 'v2.2.4_3 NA11 Left-Click to play Right-Click to switch boredfrom0');

    const witchMsg = 'witch\uE002\uE050boredfrom0\uE035\uE039\uE041\uE045\uE045\uE045\uE045\uE045\uE045\uE048';
    assert.strictEqual(cleanWynncraftText(witchMsg), 'witch boredfrom0');
  });

  // 19. ChatInsightsEngine analyze()
  await test('ChatInsightsEngine analyzes chat logs, detects lobby state, and generates key insights', () => {
    const logs = [
      { id: 1, time: '3:48:00 p.m.', type: 'system', sender: 'System', text: 'Connecting to play.wynncraft.com' },
      { id: 2, time: '3:48:05 p.m.', type: 'dialogue', sender: 'Action Bar', text: 'v2.2.4_3 NA11 Left-Click to play Right-Click to switch boredfrom0' }
    ];
    const botStatus = { worldState: 'CHARACTER_SELECTION', username: 'boredfrom0', filteredSpamCount: 12 };
    const insights = ChatInsightsEngine.analyze(logs, botStatus);

    assert.ok(insights, 'Insights must be generated');
    assert.strictEqual(insights.currentState, 'Character Selection Lobby');
    assert.ok(insights.summary.includes('NA11'), 'Summary should mention NA11');
    assert.ok(insights.summary.includes('boredfrom0'), 'Summary should mention boredfrom0');
    assert.ok(Array.isArray(insights.actionRecommendations), 'Should provide action recommendations');
    assert.ok(insights.actionRecommendations.length >= 1, 'Should have at least 1 recommended action');
    assert.strictEqual(insights.stats.filteredSpam, 12);
  });

  // 20. ChatInsightsEngine reviewWithLLM()
  await test('ChatInsightsEngine.reviewWithLLM provides zero-overhead fallback structure', async () => {
    const logs = [
      { id: 1, time: '3:50:00 p.m.', type: 'dialogue', sender: 'Bob', text: 'Please bring me 10 wheat from Ragni farms.' }
    ];
    const botStatus = { worldState: 'WORLD', username: 'boredfrom0', server: 'WC1' };
    const review = await ChatInsightsEngine.reviewWithLLM(logs, botStatus);

    assert.ok(review, 'Review output must exist');
    assert.strictEqual(review.currentState, 'In Active World');
    assert.ok(review.summary.includes('Bob'), 'Should note NPC Bob');
    assert.ok(review.engine.includes('Heuristic NLP Engine'), 'Should default to zero-overhead local engine');
  });

  // 21. Wynncraft 2.2 Regional Real World Gates (NA11, EU2, AS5, etc.)
  await test('wynncraftPlugin discovers regional Real World Gates (NA11, EU2, AS5) and resolves them', async () => {
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    const { wynncraftPlugin } = mf;
    wynncraftPlugin(bot, { autoQuickConnect: false });

    const mockSlots = new Array(54).fill(null);
    mockSlots[49] = {
      name: 'light_blue_stained_glass_pane',
      count: 1,
      customName: 'NA11',
      customLore: ['Left-Click to play', '38/40 Players', '0% Lag']
    };
    mockSlots[50] = {
      name: 'lime_terracotta',
      count: 1,
      customName: 'EU2',
      customLore: ['Click to connect', '25/40 Players', '0% Lag']
    };
    mockSlots[51] = {
      name: 'orange_concrete',
      count: 1,
      customName: 'AS | 5',
      customLore: ['Join World', '18/40 Players']
    };

    const clicks = [];
    bot.clickWindow = async (slot, btn, mode) => {
      clicks.push({ slot, btn, mode });
    };

    bot.currentWindow = {
      id: 5,
      type: 'minecraft:generic_9x6',
      title: 'Wynncraft Servers',
      slots: mockSlots,
      inventoryStart: 54,
      inventoryEnd: 90
    };

    bot.emit('windowOpen', bot.currentWindow);

    assert.strictEqual(bot.wynn.availableGates.length, 3, 'Should discover all 3 regional gates');
    
    // Find NA11
    const na11 = bot.wynn.findRealGate('NA11');
    assert.ok(na11, 'NA11 gate must be found');
    assert.strictEqual(na11.region, 'NA');
    assert.strictEqual(na11.worldNumber, 11);
    assert.strictEqual(na11.slot, 49);

    // Find EU2
    const eu2 = bot.wynn.findRealGate('EU2');
    assert.ok(eu2, 'EU2 gate must be found');
    assert.strictEqual(eu2.region, 'EU');
    assert.strictEqual(eu2.worldNumber, 2);
    assert.strictEqual(eu2.slot, 50);

    // Find AS 5
    const as5 = bot.wynn.findRealGate('AS5');
    assert.ok(as5, 'AS5 gate must be found');
    assert.strictEqual(as5.region, 'AS');
    assert.strictEqual(as5.worldNumber, 5);

    // Select NA11
    const res = await bot.wynn.selectGate('NA11');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(clicks[clicks.length - 1].slot, 49);
  });

  // 22. Stained Glass Panes with Character Cards
  await test('wynncraftPlugin selects character cards styled as custom glass panes', async () => {
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    const { wynncraftPlugin } = mf;
    wynncraftPlugin(bot, { autoLock: false });

    const mockSlots = new Array(54).fill(null);
    // Border filler panes
    for (let i = 0; i < 9; i++) mockSlots[i] = { name: 'gray_stained_glass_pane', count: 1, customName: '', customLore: [] };

    // Slot 10: Character card on a cyan stained glass pane (Wynncraft 2.0+ custom model)
    mockSlots[10] = {
      name: 'cyan_stained_glass_pane',
      count: 1,
      customName: 'Mage',
      customLore: ['Class: Mage', 'Combat Level: 105', 'Left-Click to play']
    };

    const clicks = [];
    bot.clickWindow = async (slot, btn, mode) => {
      clicks.push({ slot, btn, mode });
    };

    bot.currentWindow = {
      id: 6,
      type: 'minecraft:generic_9x6',
      title: 'Select a Character',
      slots: mockSlots,
      inventoryStart: 54,
      inventoryEnd: 90
    };

    bot.emit('windowOpen', bot.currentWindow);

    assert.strictEqual(bot.wynn.availableCharacters.length, 1, 'Should find 1 character card on glass pane');
    assert.strictEqual(bot.wynn.availableCharacters[0].class, 'Mage');
    assert.strictEqual(bot.wynn.availableCharacters[0].level, 105);
    assert.strictEqual(bot.wynn.availableCharacters[0].slot, 10);

    // Select Mage character
    const selMage = await bot.wynn.selectCharacter('mage');
    assert.strictEqual(selMage, true);
    assert.strictEqual(clicks[0].slot, 10);

    // Auto-select 'first' character
    const selFirst = await bot.wynn.selectCharacter('first');
    assert.strictEqual(selFirst, true);
    assert.strictEqual(clicks[1].slot, 10);
  });

  // 23. Blank Filler Glass Panes filtering
  await test('wynncraftPlugin filters out blank border glass panes from character and gate lists', async () => {
    const { EventEmitter } = require('events');
    const bot = new EventEmitter();
    const { wynncraftPlugin } = mf;
    wynncraftPlugin(bot, { autoLock: false });

    const mockSlots = new Array(54).fill(null);
    for (let i = 0; i < 54; i++) {
      mockSlots[i] = { name: 'black_stained_glass_pane', count: 1, customName: ' ', customLore: [] };
    }

    bot.currentWindow = {
      id: 7,
      type: 'minecraft:generic_9x6',
      title: 'Container',
      slots: mockSlots,
      inventoryStart: 54,
      inventoryEnd: 90
    };

    const scan = bot.wynn.scanWindow(bot.currentWindow);
    assert.strictEqual(scan.characters.length, 0, 'No characters should be found from blank filler panes');
    assert.strictEqual(scan.gates.length, 0, 'No gates should be found from blank filler panes');
  });

  // 24. Wynncraft Texture Atlas UV and File Verification
  await test('Wynncraft Texture Atlas files exist and align with blocksStates UV definitions', () => {
    const candidatePv = [
      path.resolve(__dirname, '../mineflayer-wynn/node_modules/prismarine-viewer/public'),
      path.resolve(__dirname, '../../mineflayer-wynn/node_modules/prismarine-viewer/public'),
      path.join(os.homedir(), 'mineflayer-wynn/node_modules/prismarine-viewer/public'),
      path.join(os.homedir(), '.npm-global/lib/node_modules/prismarine-viewer/public')
    ];
    const pvPublic = candidatePv.find(d => fs.existsSync(d)) || candidatePv[0];

    // The viewer renders with the version blockstates.js resolves, not with the
    // bot's own protocol version ('26.1'), which prismarine-viewer cannot render.
    const { resolveRenderVersion } = require('../mineflayer-wynn/src/blockstates');
    const renderVersion = resolveRenderVersion('26.1');
    assert.ok(renderVersion, 'A renderable Minecraft version must resolve');

    const atlasPath = path.join(pvPublic, `textures/${renderVersion}.png`);
    const statesPath = path.join(pvPublic, `blocksStates/${renderVersion}.json`);
    assert.ok(fs.existsSync(atlasPath), `${renderVersion}.png atlas must exist`);
    assert.ok(fs.existsSync(statesPath), `${renderVersion}.json block states must exist`);

    const stat = fs.statSync(atlasPath);
    assert.ok(stat.size > 100000, `Atlas should be substantial image (>100KB), got ${stat.size} bytes`);

    // PNG IHDR: width is a big-endian uint32 at byte offset 16.
    const header = Buffer.alloc(24);
    const fd = fs.openSync(atlasPath, 'r');
    fs.readSync(fd, header, 0, 24, 0);
    fs.closeSync(fd);
    const atlasWidth = header.readUInt32BE(16);
    const tilesPerRow = atlasWidth / 16;
    assert.ok(Number.isInteger(tilesPerRow), `Atlas width ${atlasWidth} must be a whole number of 16px tiles`);

    const statesData = JSON.parse(fs.readFileSync(statesPath, 'utf8'));
    assert.ok(statesData.stone, 'Stone block state must exist');
    const stoneTex = statesData.stone.variants[''][0].model.textures.particle;
    assert.strictEqual(stoneTex.su, 1 / tilesPerRow, `Tile ratio must be 1/${tilesPerRow} for a ${atlasWidth}px atlas`);
    assert.strictEqual(stoneTex.sv, 1 / tilesPerRow, `Tile ratio must be 1/${tilesPerRow} for a ${atlasWidth}px atlas`);

    // apply_wynn_textures.py keeps a pristine copy; when it has run, the atlas must
    // carry the Wynncraft art and keep the vanilla geometry the UVs depend on.
    const vanillaPath = path.join(pvPublic, `textures/${renderVersion}.vanilla.png`);
    if (fs.existsSync(vanillaPath)) {
      const vanillaHeader = Buffer.alloc(24);
      const vfd = fs.openSync(vanillaPath, 'r');
      fs.readSync(vfd, vanillaHeader, 0, 24, 0);
      fs.closeSync(vfd);
      assert.strictEqual(vanillaHeader.readUInt32BE(16), atlasWidth, 'Patched atlas must keep the vanilla atlas width');
      assert.strictEqual(vanillaHeader.readUInt32BE(20), header.readUInt32BE(20), 'Patched atlas must keep the vanilla atlas height');
      assert.notStrictEqual(
        fs.readFileSync(atlasPath).toString('base64'),
        fs.readFileSync(vanillaPath).toString('base64'),
        'Atlas should differ from vanilla once the Wynncraft pack is applied'
      );
    }
  });

  // 25. macOS Portability: Prism Directory Resolution
  await test('Prism directory resolution handles macOS Darwin platform correctly', () => {
    const originalPlatform = process.platform;
    try {
      // Simulate macOS Darwin environment
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const prismDirDarwin = getPrismDir();
      assert.ok(typeof prismDirDarwin === 'string', 'Should return a valid path string');
      // When PRISM_DIR is not set, should resolve to either existing candidate or ~/Library/Application Support/PrismLauncher
      assert.ok(
        prismDirDarwin.includes('PrismLauncher'),
        `Should resolve to a PrismLauncher directory, got: ${prismDirDarwin}`
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  // 26. Codebase Portability: Zero hardcoded home paths in executable scripts and tests
  await test('Zero hardcoded user home paths (/home/...) in scripts, tests, and module source', () => {
    const checkDirs = [
      path.resolve(__dirname, '../scripts'),
      path.resolve(__dirname, '../tests'),
      path.resolve(__dirname, '../mineflayer-wynn/src')
    ];
    const forbidden = ['/', 'home', '/', 'shubcache'].join('');
    for (const dir of checkDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') || f.endsWith('.py') || f.endsWith('.sh'));
      for (const file of files) {
        if (file === 'test_module.js') continue; // Don't check self
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        assert.ok(
          !content.includes(forbidden),
          `File ${path.join(dir, file)} must not contain hardcoded user home path`
        );
      }
    }
  });

  console.log(`\n\x1b[1mModule Tests Result: ${passed}/${total} passed\x1b[0m\n`);
  if (passed !== total) process.exit(1);
}

runAll().catch(err => {
  console.error('Module test runner failed:', err);
  process.exit(1);
});
