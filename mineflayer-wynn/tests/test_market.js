const assert = require('assert');
const EventEmitter = require('events');
const { Vec3 } = require('vec3');

const {
  attachMarket,
  parseMarketWindow,
  classifySlot,
  parseEmeralds,
  formatEmeralds,
  resolveLocation,
  MARKET_LOCATIONS
} = require('../src/market');

console.log('Running Trade Market tests...');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * Builds a container slot the way Wynncraft sends Trade Market panes.
 */
function pane(name, customName, lore = [], count = 1) {
  return { name, customName, customLore: lore, count };
}

function marketWindow(slots, title = 'Trade Market') {
  const full = new Array(54).fill(null);
  for (const [slot, item] of Object.entries(slots)) full[slot] = item;
  return { id: 7, title, slots: full.concat(new Array(36).fill(null)), inventoryStart: 54 };
}

/**
 * Minimal bot stand-in: enough surface for the market controller.
 */
function fakeBot(window) {
  const bot = new EventEmitter();
  bot.currentWindow = window;
  bot.clicks = [];
  bot.chats = [];
  bot.entity = { position: new Vec3(500, 68, -1576) };
  bot.entities = {};
  bot.clickWindow = async (slot, button, mode) => { bot.clicks.push({ slot, button, mode }); };
  bot.chat = (msg) => { bot.chats.push(msg); };
  bot.closeWindow = () => { bot.currentWindow = null; };
  bot.lookAt = async () => {};
  bot.activateEntity = () => {};
  bot.pathfinder = { goto: async () => {}, setGoal: () => {} };
  return bot;
}

(async () => {
  await test('Emerald amounts parse from Wynncraft stx/le/eb/e notation', () => {
    assert.strictEqual(parseEmeralds('Price: 1 stx 32 le 16 eb 8 e'), 262144 + 32 * 4096 + 16 * 64 + 8);
    assert.strictEqual(parseEmeralds('Price: 24 le'), 24 * 4096);
    assert.strictEqual(parseEmeralds('Cost: 1,024 eb'), 1024 * 64);
    assert.strictEqual(parseEmeralds('Price: 1200'), 1200);
    assert.strictEqual(parseEmeralds('Seller: Notch'), null);
    assert.strictEqual(parseEmeralds(''), null);
  });

  await test('Emerald amounts format back into stx/le/eb/e', () => {
    const amount = 262144 + 32 * 4096 + 16 * 64 + 8;
    assert.strictEqual(formatEmeralds(amount), '1stx 32le 16eb 8e');
    assert.strictEqual(formatEmeralds(0), '0e');
    assert.strictEqual(parseEmeralds(formatEmeralds(987654)), 987654, 'format/parse must round-trip');
  });

  await test('Filler panes, controls, and listings are told apart', () => {
    assert.strictEqual(classifySlot(null, 0).kind, 'empty');
    assert.strictEqual(classifySlot(pane('gray_stained_glass_pane', ''), 1).kind, 'filler');

    const next = classifySlot(pane('arrow', 'Next Page', ['Go to page 2']), 53);
    assert.strictEqual(next.kind, 'control');
    assert.strictEqual(next.role, 'next_page');

    const search = classifySlot(pane('compass', 'Search Items', ['Click to search']), 47);
    assert.strictEqual(search.role, 'search');

    const listing = classifySlot(pane('diamond_chestplate', 'Boreal-Patterned Aegis', [
      'Mythic Item',
      'Price: 12 le 32 eb',
      'Amount: 1',
      'Seller: SomePlayer'
    ]), 10);
    assert.strictEqual(listing.kind, 'listing');
    assert.strictEqual(listing.price, 12 * 4096 + 32 * 64);
    assert.strictEqual(listing.amount, 1);
    assert.strictEqual(listing.seller, 'SomePlayer');
    assert.strictEqual(listing.tier.toLowerCase(), 'mythic');
  });

  await test('Market windows expose listings, controls, and page number', () => {
    const window = marketWindow({
      0: pane('gray_stained_glass_pane', ''),
      10: pane('diamond_chestplate', 'Boreal-Patterned Aegis', ['Mythic Item', 'Price: 12 le', 'Amount: 1']),
      11: pane('bow', 'Spring', ['Legendary Item', 'Price: 3 le 20 eb', 'Amount: 2']),
      45: pane('paper', 'Page 3', ['Showing results 21-30']),
      47: pane('compass', 'Search Items', []),
      53: pane('arrow', 'Next Page', [])
    });

    const scan = parseMarketWindow(window);
    assert.ok(scan.isMarket, 'Trade Market title should be recognised');
    assert.strictEqual(scan.listings.length, 2);
    assert.strictEqual(scan.page, 3);
    assert.strictEqual(scan.containerSlots, 54, 'Player inventory slots must not be scanned');
    assert.ok(scan.controls.some(c => c.role === 'search'));
    assert.ok(scan.controls.some(c => c.role === 'next_page'));
  });

  await test('Non-market containers are not treated as the market', () => {
    const scan = parseMarketWindow(marketWindow({ 0: pane('chest', 'Item') }, 'Bank'));
    assert.strictEqual(scan.isMarket, false);
  });

  await test('Control panes click, listings refuse to click unconfirmed', async () => {
    const window = marketWindow({
      10: pane('bow', 'Spring', ['Legendary Item', 'Price: 3 le', 'Amount: 1']),
      53: pane('arrow', 'Next Page', [])
    });
    const bot = fakeBot(window);
    const market = attachMarket(bot);

    const nextPage = await market.nextPage();
    assert.ok(nextPage.ok, `Next page click should succeed: ${nextPage.error}`);
    assert.strictEqual(bot.clicks[0].slot, 53);

    const blocked = await market.click({ slot: 10 });
    assert.strictEqual(blocked.ok, false);
    assert.ok(blocked.needsConfirm, 'Clicking a listing must ask for confirmation');
    assert.strictEqual(bot.clicks.length, 1, 'Unconfirmed listing click must not reach the server');
  });

  await test('Buying enforces confirmation and a price ceiling', async () => {
    const window = marketWindow({
      10: pane('bow', 'Spring', ['Legendary Item', 'Price: 3 le', 'Amount: 1'])
    });
    const bot = fakeBot(window);
    const market = attachMarket(bot);

    const unconfirmed = await market.buy({ slot: 10 });
    assert.strictEqual(unconfirmed.ok, false);
    assert.ok(unconfirmed.needsConfirm);

    const tooExpensive = await market.buy({ slot: 10 }, { confirm: true, maxPrice: 2 * 4096 });
    assert.strictEqual(tooExpensive.ok, false);
    assert.ok(/ceiling/.test(tooExpensive.error));
    assert.strictEqual(bot.clicks.length, 0, 'A rejected buy must not click anything');

    const bought = await market.buy({ slot: 10 }, { confirm: true, maxPrice: 4 * 4096, settleMs: 0 });
    assert.ok(bought.ok, `Buy should succeed: ${bought.error}`);
    assert.strictEqual(bot.clicks[0].slot, 10);
  });

  await test('Search clicks the search pane and answers the chat prompt', async () => {
    const window = marketWindow({ 47: pane('compass', 'Search Items', []) });
    const bot = fakeBot(window);
    const market = attachMarket(bot);

    const result = await market.search('Spring', { settleMs: 0, promptMs: 0 });
    assert.ok(result.ok, `Search should succeed: ${result.error}`);
    assert.strictEqual(bot.clicks[0].slot, 47);
    assert.deepStrictEqual(bot.chats, ['Spring']);
  });

  await test('Market locations resolve by name and by coordinates', () => {
    assert.strictEqual(resolveLocation('Detlas').x, MARKET_LOCATIONS.detlas.x);
    assert.strictEqual(resolveLocation('detlas').z, MARKET_LOCATIONS.detlas.z);
    assert.strictEqual(resolveLocation('atlantis'), null);
    const custom = resolveLocation({ x: 1, y: 2, z: 3 });
    assert.deepStrictEqual([custom.x, custom.y, custom.z], [1, 2, 3]);
  });

  await test('Walking reports distance and rejects unknown locations', async () => {
    const bot = fakeBot(null);
    const market = attachMarket(bot);

    const distance = market.distanceTo('detlas');
    assert.ok(distance !== null && distance < 3, `Bot should start near Detlas market, got ${distance}`);

    const near = await market.walkTo('detlas');
    assert.ok(near.ok && near.alreadyThere, 'Already-in-range walk should short-circuit');

    const unknown = await market.walkTo('atlantis');
    assert.strictEqual(unknown.ok, false);
    assert.ok(/Unknown market location/.test(unknown.error));
  });

  await test('Opening without a nearby NPC reports why', async () => {
    const bot = fakeBot(null);
    const market = attachMarket(bot);
    const result = await market.open({ walk: false });
    assert.strictEqual(result.ok, false);
    assert.ok(/No Trade Market NPC/.test(result.error));
  });

  await test('Opening finds the market NPC and reads the window it opens', async () => {
    const window = marketWindow({
      10: pane('bow', 'Spring', ['Legendary Item', 'Price: 3 le', 'Amount: 1']),
      53: pane('arrow', 'Next Page', [])
    });
    const bot = fakeBot(null);
    bot.entities = {
      1: { id: 1, name: 'villager', displayName: 'Trade Market', position: new Vec3(500, 68, -1578) },
      2: { id: 2, name: 'zombie', displayName: 'Zombie', position: new Vec3(502, 68, -1578) }
    };
    bot.activateEntity = () => {
      bot.currentWindow = window;
      setImmediate(() => bot.emit('windowOpen', window));
    };
    const market = attachMarket(bot);

    const opened = await market.open({ walk: false });
    assert.ok(opened.ok, `Market should open: ${opened.error}`);
    assert.strictEqual(opened.market.listings.length, 1);
    assert.strictEqual(opened.market.listings[0].customName, 'Spring');
  });

  console.log(`\n\x1b[1;32mTrade Market tests: ${passed} passed.\x1b[0m`);
})();
