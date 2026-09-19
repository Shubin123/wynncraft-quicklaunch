/**
 * Round-trip tests for the bridge.
 *
 * One cycle: read the in-game market, extract it across the boundary, decide,
 * send a command back in, and confirm the game changed the way the decision
 * expected. The pieces are tested individually elsewhere; this is the only
 * place they are driven as a loop, which is where ordering, retries and
 * reconciliation go wrong.
 *
 * The game side is a stand-in bot rather than Wynncraft: the write path spends
 * real emeralds and cannot be exercised against a live server. The stand-in
 * behaves like a container UI - clicks mutate a window, listings vanish when
 * bought, and a page can be turned underneath the caller.
 */

// Journals are written by the buy path; keep them out of the real data
// directory. Set before requiring anything that opens one.
process.env.WYNN_JOURNAL_FILE = require('path').join(
  require('os').tmpdir(), `wynn-journal-test-${process.pid}.jsonl`);

const assert = require('assert');
const EventEmitter = require('events');
const path = require('path');

// Game-side dependencies live in the bot package, not at the repo root.
const { Vec3 } = require(require.resolve('vec3', {
  paths: [path.resolve(__dirname, '../mineflayer-wynn')]
}));

const { attachMarket, formatEmeralds } = require('../mineflayer-wynn/src/market.js');

console.log('Running round-trip tests...');

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
 * A market whose state actually changes when clicked: buying removes the
 * listing and debits emeralds, so "did the world change as expected" is a
 * real question rather than an assumption.
 */
function gameWorld({ emeralds = 500000, latencyMs = 0 } = {}) {
  const state = {
    emeralds,
    sold: [],
    clicks: [],
    pages: [[]],
    page: 0,
    latencyMs
  };

  function windowFor() {
    const listings = state.pages[state.page];
    const slots = new Array(54).fill(null);
    listings.forEach((listing, index) => {
      if (listing) {
        slots[10 + index] = {
          name: listing.name || 'bow',
          customName: listing.item,
          customLore: [`${listing.tier || 'Legendary'} Item`, `Price: ${formatEmeralds(listing.price)}`,
            `Amount: ${listing.amount || 1}`],
          count: listing.amount || 1
        };
      }
    });
    return { id: 7, title: 'Trade Market', slots: slots.concat(new Array(36).fill(null)), inventoryStart: 54 };
  }

  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(500, 68, -1576) };
  bot.entities = {};
  bot.currentWindow = windowFor();
  bot.chat = () => {};
  bot.closeWindow = () => { bot.currentWindow = null; };
  bot.lookAt = async () => {};
  bot.activateEntity = () => {};
  bot.pathfinder = { goto: async () => {}, setGoal: () => {} };

  bot.clickWindow = async (slot) => {
    if (state.latencyMs) await new Promise(resolve => setTimeout(resolve, state.latencyMs));
    state.clicks.push({ slot, at: Date.now() });
    const index = slot - 10;
    const listings = state.pages[state.page];
    const listing = listings[index];
    if (!listing) return;
    if (state.emeralds < listing.price) throw new Error('not enough emeralds');
    state.emeralds -= listing.price;
    state.sold.push({ ...listing });
    listings[index] = null;            // the board changes, as it does in game
    bot.currentWindow = windowFor();
  };

  state.setListings = (listings, page = 0) => {
    state.pages[page] = listings.slice();
    state.page = page;
    bot.currentWindow = windowFor();
  };
  state.turnPage = (page) => {
    state.page = page;
    bot.currentWindow = windowFor();
  };

  return { bot, state };
}

/** The external side: price the board and decide what to buy. */
function decide(scan, { capital, fairValues, fee = 0.05 }) {
  return scan.listings
    .map(listing => {
      const fair = fairValues[listing.customName];
      if (!fair) return null;
      const delta = fair * (1 - fee) - listing.price;
      return { item: listing.customName, slot: listing.slot, ask: listing.price, delta,
        roi: delta / listing.price };
    })
    .filter(leg => leg && leg.roi > 0 && leg.ask <= capital)
    .sort((a, b) => b.roi - a.roi);
}

(async () => {
  await test('One full cycle: read, decide, buy, confirm the world changed', async () => {
    const { bot, state } = gameWorld({ emeralds: 100000 });
    const market = attachMarket(bot);
    state.setListings([
      { item: 'Spring', price: 9000 },
      { item: 'Comet', price: 30000 },
      { item: 'Wybel Paw', price: 800 }
    ]);

    // 1. read in-game state, 2. extract it across the boundary
    const scan = market.scan();
    assert.strictEqual(scan.listings.length, 3, 'extraction lost listings');

    // 3. decide, outside the game
    const plan = decide(scan, { capital: 100000, fairValues: { Spring: 20000, Comet: 20000 } });
    assert.strictEqual(plan[0].item, 'Spring', 'the best edge should lead');
    assert.ok(!plan.some(leg => leg.item === 'Comet'), 'a negative edge must not be planned');

    // 4. send the command back into the game
    const emeraldsBefore = state.emeralds;
    const result = await market.buy({ slot: plan[0].slot }, {
      confirm: true, expectItem: plan[0].item, maxPrice: plan[0].ask, settleMs: 0,
      intentId: 'intent-1'
    });
    assert.ok(result.ok, `the buy failed: ${result.error}`);

    // 5. confirm the world changed the way the decision expected
    assert.deepStrictEqual(state.sold.map(s => s.item), ['Spring'], 'the wrong thing was bought');
    assert.strictEqual(state.emeralds, emeraldsBefore - 9000, 'the balance does not reconcile');
    const after = market.scan();
    assert.ok(!after.listings.some(l => l.customName === 'Spring'),
      'the bought listing is still on the board');
  });

  await test('A retried buy does not buy twice', async () => {
    const { bot, state } = gameWorld({ emeralds: 100000 });
    const market = attachMarket(bot);
    state.setListings([{ item: 'Spring', price: 9000 }, { item: 'Spring', price: 9000 }]);

    const first = await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', intentId: 'intent-retry', settleMs: 0
    });
    assert.ok(first.ok && !first.duplicate);

    // The caller never saw the response and sends it again.
    const retry = await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', intentId: 'intent-retry', settleMs: 0
    });
    assert.ok(retry.ok, 'a retry should report success, not an error');
    assert.strictEqual(retry.duplicate, true, 'the retry must be recognised as one');
    assert.strictEqual(state.sold.length, 1, 'the retry bought a second copy');
    assert.strictEqual(state.emeralds, 100000 - 9000, 'the retry spent twice');

    // A different intent is a different trade, even for the same item.
    const second = await market.buy({ slot: 11 }, {
      confirm: true, expectItem: 'Spring', intentId: 'intent-other', settleMs: 0
    });
    assert.ok(second.ok && !second.duplicate);
    assert.strictEqual(state.sold.length, 2);
  });

  await test('A decision acted on too late buys nothing rather than the wrong thing', async () => {
    const { bot, state } = gameWorld({ emeralds: 100000 });
    const market = attachMarket(bot);
    state.setListings([{ item: 'Spring', price: 9000 }, { item: 'Comet', price: 30000 }]);

    const scan = market.scan();
    const plan = decide(scan, { capital: 100000, fairValues: { Spring: 20000 } });
    const leg = plan[0];

    // Between deciding and acting, the board moves: someone buys Spring and
    // the slot it occupied now holds something else entirely.
    state.setListings([{ item: 'Diamond Boots', price: 500 }, { item: 'Comet', price: 30000 }]);

    const result = await market.buy({ slot: leg.slot }, {
      confirm: true, expectItem: leg.item, maxPrice: leg.ask, settleMs: 0, intentId: 'intent-stale'
    });
    assert.strictEqual(result.ok, false, 'a stale plan must not execute');
    assert.match(result.error, /now holds "Diamond Boots"/);
    assert.strictEqual(state.sold.length, 0, 'nothing should have been bought');
    assert.strictEqual(state.clicks.length, 0, 'and nothing should have been clicked');
  });

  await test('A page turned under the caller does not misdirect the buy', async () => {
    const { bot, state } = gameWorld({ emeralds: 100000 });
    const market = attachMarket(bot);
    state.pages[1] = [{ item: 'Cheap Junk', price: 100 }];
    state.setListings([{ item: 'Spring', price: 9000 }], 0);

    const leg = decide(market.scan(), { capital: 100000, fairValues: { Spring: 20000 } })[0];
    state.turnPage(1); // the same slot index, an entirely different page

    const result = await market.buy({ slot: leg.slot }, {
      confirm: true, expectItem: leg.item, maxPrice: leg.ask, settleMs: 0
    });
    assert.strictEqual(result.ok, false, 'slot 10 on page 2 is not the item that was planned');
    assert.strictEqual(state.sold.length, 0);
  });

  await test('Legs execute in the order the plan ranked them', async () => {
    const { bot, state } = gameWorld({ emeralds: 100000 });
    const market = attachMarket(bot);
    state.setListings([
      { item: 'Small Edge', price: 10000 },
      { item: 'Big Edge', price: 10000 },
      { item: 'Middle Edge', price: 10000 }
    ]);

    const plan = decide(market.scan(), {
      capital: 100000,
      fairValues: { 'Small Edge': 11000, 'Big Edge': 40000, 'Middle Edge': 20000 }
    });
    assert.deepStrictEqual(plan.map(l => l.item), ['Big Edge', 'Middle Edge', 'Small Edge']);

    for (const [index, leg] of plan.entries()) {
      // Re-read before each leg: earlier buys have changed the board.
      const current = market.scan().listings.find(l => l.customName === leg.item);
      assert.ok(current, `${leg.item} vanished before its turn`);
      const result = await market.buy({ slot: current.slot }, {
        confirm: true, expectItem: leg.item, maxPrice: leg.ask, settleMs: 0,
        intentId: `ordered-${index}`
      });
      assert.ok(result.ok, `${leg.item} failed: ${result.error}`);
    }

    assert.deepStrictEqual(state.sold.map(s => s.item), ['Big Edge', 'Middle Edge', 'Small Edge'],
      'the game saw the legs in a different order than the plan ranked them');
    assert.strictEqual(state.emeralds, 100000 - 30000);
  });

  await test('Reconciliation catches a buy that cost more than planned', async () => {
    const { bot, state } = gameWorld({ emeralds: 100000 });
    const market = attachMarket(bot);
    state.setListings([{ item: 'Spring', price: 9000 }]);
    const leg = decide(market.scan(), { capital: 100000, fairValues: { Spring: 20000 } })[0];

    // The listing is repriced upward before the click lands.
    state.setListings([{ item: 'Spring', price: 15000 }]);

    const result = await market.buy({ slot: leg.slot }, {
      confirm: true, expectItem: leg.item, maxPrice: leg.ask, settleMs: 0
    });
    assert.strictEqual(result.ok, false, 'the ceiling should have stopped this');
    assert.match(result.error, /ceiling/);
    assert.strictEqual(state.emeralds, 100000, 'nothing should have been spent');

    // With the ceiling raised to the new price it goes through, and the
    // balance still reconciles against what was actually paid.
    const retried = await market.buy({ slot: leg.slot }, {
      confirm: true, expectItem: leg.item, maxPrice: 15000, settleMs: 0
    });
    assert.ok(retried.ok, retried.error);
    assert.strictEqual(state.emeralds, 100000 - 15000);
    assert.strictEqual(retried.bought.price, 15000, 'the result must report what was really paid');
  });

  await test('A slow game does not lose the cycle', async () => {
    const { bot, state } = gameWorld({ emeralds: 100000, latencyMs: 120 });
    const market = attachMarket(bot);
    state.setListings([{ item: 'Spring', price: 9000 }]);

    const started = Date.now();
    const result = await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', settleMs: 0, intentId: 'slow-1'
    });
    const elapsed = Date.now() - started;

    assert.ok(result.ok, result.error);
    assert.ok(elapsed >= 100, `the click should have waited for the game: ${elapsed}ms`);
    assert.strictEqual(state.sold.length, 1);
  });

  await test('An unconfirmed or unpriced decision never reaches the game', async () => {
    const { bot, state } = gameWorld({ emeralds: 100000 });
    const market = attachMarket(bot);
    state.setListings([{ item: 'Spring', price: 9000 }]);

    const unconfirmed = await market.buy({ slot: 10 }, { expectItem: 'Spring', settleMs: 0 });
    assert.strictEqual(unconfirmed.ok, false);
    assert.ok(unconfirmed.needsConfirm);

    const overCeiling = await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', maxPrice: 100, settleMs: 0
    });
    assert.strictEqual(overCeiling.ok, false);

    assert.strictEqual(state.clicks.length, 0, 'a refused decision still touched the game');
    assert.strictEqual(state.emeralds, 100000);
  });

  console.log(`\n\x1b[1;32mRound-trip tests: ${passed} passed.\x1b[0m`);
})();
