/**
 * The market against a real server, over the real protocol.
 *
 * Gap 1 from docs/TESTING_STRATEGY.md. Every other test replaces the game with
 * a stand-in object, which covers the logic and nothing else: the stand-in is
 * written by the same hand as the parser, so the two agree by construction. A
 * protocol change - or an assumption about what the wire carries that was only
 * ever true of the stand-in - passes straight through.
 *
 * Here a real mineflayer bot joins a real Minecraft server at the version the
 * bot negotiates with Wynncraft, reads a Trade Market built from real packets,
 * and buys from it. The purchase leaves as a `window_click` on the wire and it
 * is the server, not the test, that removes the listing and debits the purse.
 *
 * This is still not Wynncraft: the harness serves what the market code reads,
 * and the live server is never written to. What it adds over the stand-in is
 * that everything between `parseMarketWindow` and the socket is real.
 */

// The buy path writes a journal; keep it out of the real data directory.
// Set before requiring anything that opens one.
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.WYNN_JOURNAL_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-harness-')), 'journal.jsonl');

const assert = require('assert');
const { startWynnServer, connectBot, priceText } = require('./harness/wynn_server.js');
const { parseMarketWindow, parseEmeralds } = require('../mineflayer-wynn/src/market.js');
const { createJournal } = require('../mineflayer-wynn/src/journal.js');

console.log('Running protocol harness tests...');

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
 * Starts a server, joins a bot, runs the body, and shuts both down whatever
 * happens - a leaked bot keeps the process alive and the suite hangs.
 */
async function withGame(options, body) {
  const harness = await startWynnServer(options);
  const joined = [];

  const join = async (botOptions = {}) => {
    const bot = await connectBot(harness, botOptions);
    joined.push(bot);
    return bot;
  };

  /** Takes a session away the way a crash does, and waits for the game to notice. */
  const leave = (bot) => new Promise((resolve) => {
    const index = joined.indexOf(bot);
    if (index >= 0) joined.splice(index, 1);
    bot.removeAllListeners('error');
    bot.on('error', () => {});
    bot.once('end', () => setTimeout(resolve, 50));
    try {
      bot.quit();
    } catch (err) {
      resolve();
    }
  });

  try {
    const bot = await join(options.bot || {});
    await body({ harness, bot, state: harness.state, join, leave });
  } finally {
    for (const bot of joined) {
      bot.removeAllListeners('error');
      bot.on('error', () => {});
      try { bot.quit(); } catch (err) { /* already gone */ }
    }
    await harness.close();
  }
}

/** A journal of its own, so one test's trades are not another's. */
function scratchJournal() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-reconcile-')), 'journal.jsonl');
}

/** Waits for the bot's window to satisfy a predicate, or gives up. */
function until(predicate, timeoutMs = 5000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        return reject(err);
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out waiting for ${label}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

const IDOL = { item: 'Idol', price: 10112, amount: 1, tier: 'Legendary', name: 'bow', seller: 'Someone' };

(async () => {
  await test('A real bot joins, at the version the bot speaks to Wynncraft', async () => {
    await withGame({ listings: [IDOL] }, async ({ bot, harness }) => {
      assert.strictEqual(bot.version, harness.version);
      assert.strictEqual(harness.version, '26.1', 'the harness must track bot.js');
      assert.ok(bot.entity, 'the bot spawned without an entity');
    });
  });

  await test('The Trade Market arrives as a real container the parser can read', async () => {
    await withGame({ listings: [IDOL] }, async ({ bot, harness }) => {
      harness.openMarket();
      const window = await until(() => bot.currentWindow, 5000, 'the market window');

      const scan = parseMarketWindow(window);
      assert.ok(scan.open);
      assert.strictEqual(scan.title, 'Trade Market');
      assert.ok(scan.isMarket);
      assert.strictEqual(scan.containerSlots, 54, 'a six-row container should parse as 54 slots');

      assert.strictEqual(scan.listings.length, 1);
      const [listing] = scan.listings;
      assert.strictEqual(listing.customName, 'Idol');
      assert.strictEqual(listing.price, IDOL.price);
      assert.strictEqual(listing.tier, 'Legendary');
      assert.strictEqual(listing.seller, 'Someone');

      const roles = scan.controls.map(control => control.role).sort();
      assert.deepStrictEqual(roles, ['next_page', 'prev_page', 'search']);
      assert.ok(scan.slots.some(slot => slot.kind === 'filler'),
        'an unnamed glass pane should classify as filler, not as an item');
    });
  });

  await test('Names and lore cross the wire as components, not strings', async () => {
    await withGame({ listings: [IDOL] }, async ({ bot, harness }) => {
      harness.openMarket();
      const window = await until(() => bot.currentWindow, 5000, 'the market window');
      const item = window.slots[10];

      // This is the assumption the stand-in cannot test. Since 1.20.5 a name
      // and its lore are data components carrying NBT text components, so
      // anything that treats them as strings sees nothing at all. If a future
      // version puts plain strings back on the wire, this fails loudly rather
      // than letting the string-handling code look correct by accident.
      assert.strictEqual(typeof item.customName, 'object',
        'customName should be a component; the stand-in hands over a string');
      assert.strictEqual(item.customName.type, 'compound');
      assert.ok(Array.isArray(item.customLore));
      assert.strictEqual(typeof item.customLore[0], 'object');

      // And the market code reads through it regardless.
      assert.strictEqual(parseMarketWindow(window).listings[0].customName, 'Idol');
    });
  });

  await test('Emeralds are counted off a real inventory, liquid emeralds included', async () => {
    // 2 le + 3 eb, held as the items Wynncraft holds them as: emerald blocks
    // are named by their item id, but a liquid emerald is an ordinary item
    // wearing a custom name - which is the case that disappears when a
    // component is read as a string.
    const total = (2 * 4096) + (3 * 64);
    await withGame({ emeralds: total, listings: [IDOL] }, async ({ bot, harness }) => {
      await until(() => bot.inventory.items().length >= 2, 5000, 'the purse to arrive');
      const counted = bot.wynn.countEmeralds();
      assert.strictEqual(counted.total, total,
        `counted ${counted.total} of ${total}; liquid emeralds are being dropped`);
      assert.strictEqual(counted.le, 2);
      assert.strictEqual(counted.eb, 3);

      // A real purse spans slots: nothing stacks past 64, so the count is a
      // sum over several stacks rather than one number read off one slot.
      const big = (200 * 4096) + (40 * 64) + 63;
      harness.setEmeralds(big);
      await until(() => bot.wynn.countEmeralds().total === big, 3000, 'the larger purse');
      assert.ok(bot.inventory.items().length >= 6,
        'a 200 le purse should occupy several stacks');
    });
  });

  await test('A buy leaves the process as a window_click packet', async () => {
    await withGame({ emeralds: 3 * 4096, listings: [IDOL] }, async ({ bot, harness, state }) => {
      const windowId = harness.openMarket();
      await until(() => bot.currentWindow, 5000, 'the market window');

      const result = await bot.market.buy({ slot: 10 }, {
        confirm: true, intentId: 'wire-1', expectItem: 'Idol', maxPrice: 12000
      });
      assert.ok(result.ok, result.error);

      assert.strictEqual(state.clicks.length, 1, 'the game saw no click');
      const [click] = state.clicks;
      assert.strictEqual(click.windowId, windowId);
      assert.strictEqual(click.slot, 10);
      assert.strictEqual(click.mouseButton, 0);
      assert.strictEqual(click.mode, 0);
    });
  });

  await test('The board and the purse actually move, and the bot sees it', async () => {
    const start = 3 * 4096;
    await withGame({ emeralds: start, listings: [IDOL] }, async ({ bot, harness, state }) => {
      harness.openMarket();
      await until(() => bot.currentWindow, 5000, 'the market window');
      assert.strictEqual(bot.wynn.countEmeralds().total, start);

      const result = await bot.market.buy({ slot: 10 }, {
        confirm: true, intentId: 'wire-2', expectItem: 'Idol', maxPrice: 12000
      });
      assert.ok(result.ok, result.error);

      // The server decided all of this, not the test.
      assert.strictEqual(state.sold.length, 1);
      assert.strictEqual(state.emeralds, start - IDOL.price);

      await until(() => bot.wynn.countEmeralds().total === start - IDOL.price, 3000,
        'the purse to be debited on the client');
      await until(() => parseMarketWindow(bot.currentWindow).listings.length === 0, 3000,
        'the listing to leave the board');
    });
  });

  await test('The journal reconciles against the balance the game reported', async () => {
    const start = 3 * 4096;
    await withGame({ emeralds: start, listings: [IDOL] }, async ({ bot, harness }) => {
      harness.openMarket();
      await until(() => bot.currentWindow, 5000, 'the market window');

      await bot.market.buy({ slot: 10 }, {
        confirm: true, intentId: 'wire-3', expectItem: 'Idol', maxPrice: 12000
      });

      const outcome = bot.market.journal.outcomeFor('wire-3');
      assert.ok(outcome, 'no outcome was written');
      assert.strictEqual(outcome.status, 'executed');
      assert.strictEqual(outcome.emeralds_before, start);
      assert.strictEqual(outcome.emeralds_after, start - IDOL.price);
      assert.strictEqual(outcome.actual_price, IDOL.price);
      assert.strictEqual(outcome.reconciled, true,
        'the balance moved by the price, so reconciliation should agree');
    });
  });

  await test('A retry over the wire buys nothing a second time', async () => {
    const start = 3 * 4096;
    await withGame({ emeralds: start, listings: [IDOL] }, async ({ bot, harness, state }) => {
      harness.openMarket();
      await until(() => bot.currentWindow, 5000, 'the market window');

      const first = await bot.market.buy({ slot: 10 }, {
        confirm: true, intentId: 'wire-4', expectItem: 'Idol', maxPrice: 12000
      });
      assert.ok(first.ok, first.error);

      const retry = await bot.market.buy({ slot: 10 }, {
        confirm: true, intentId: 'wire-4', expectItem: 'Idol', maxPrice: 12000
      });
      assert.ok(retry.ok);
      assert.ok(retry.duplicate, 'the retry was not recognised as a repeat');
      assert.strictEqual(state.clicks.length, 1, 'the retry reached the game');
      assert.strictEqual(state.emeralds, start - IDOL.price, 'the retry spent emeralds');
    });
  });

  await test('A refused buy sends nothing at all', async () => {
    await withGame({ emeralds: 3 * 4096, listings: [IDOL] }, async ({ bot, harness, state }) => {
      harness.openMarket();
      await until(() => bot.currentWindow, 5000, 'the market window');

      const unconfirmed = await bot.market.buy({ slot: 10 }, { expectItem: 'Idol' });
      assert.strictEqual(unconfirmed.ok, false);
      assert.ok(unconfirmed.needsConfirm);

      const overCeiling = await bot.market.buy({ slot: 10 }, {
        confirm: true, expectItem: 'Idol', maxPrice: 100
      });
      assert.strictEqual(overCeiling.ok, false);

      const wrongItem = await bot.market.buy({ slot: 10 }, {
        confirm: true, expectItem: 'Spring', maxPrice: 12000
      });
      assert.strictEqual(wrongItem.ok, false);

      assert.strictEqual(state.clicks.length, 0, 'a refused buy still reached the game');
      assert.strictEqual(state.emeralds, 3 * 4096);
    });
  });

  await test('A listing repriced under the bot is caught by the ceiling', async () => {
    await withGame({ emeralds: 10 * 4096, listings: [IDOL] }, async ({ bot, harness, state }) => {
      harness.openMarket();
      await until(() => bot.currentWindow, 5000, 'the market window');

      // The board moves between the decision and the click, as it does when
      // someone else buys and the seller relists higher.
      harness.setListing(0, { ...IDOL, price: 30000 });
      await until(() => parseMarketWindow(bot.currentWindow).listings[0].price === 30000, 3000,
        'the reprice to reach the bot');

      const result = await bot.market.buy({ slot: 10 }, {
        confirm: true, intentId: 'wire-5', expectItem: 'Idol', maxPrice: 12000
      });
      assert.strictEqual(result.ok, false);
      assert.ok(/ceiling/i.test(result.error), result.error);
      assert.strictEqual(state.clicks.length, 0);
    });
  });

  await test('A page turn is a real click, and the next page is a real window', async () => {
    const second = { item: 'Spring', price: 4096, amount: 1, tier: 'Mythic', name: 'stick' };
    await withGame({ emeralds: 4096, pages: [[IDOL], [second]] }, async ({ bot, harness, state }) => {
      harness.openMarket();
      await until(() => bot.currentWindow, 5000, 'the market window');
      assert.strictEqual(parseMarketWindow(bot.currentWindow).listings[0].customName, 'Idol');

      const turned = await bot.market.nextPage();
      assert.ok(turned.ok, turned.error);
      assert.strictEqual(state.clicks.length, 1);
      assert.strictEqual(state.clicks[0].slot, 53);

      await until(() => {
        const listings = parseMarketWindow(bot.currentWindow).listings;
        return listings.length === 1 && listings[0].customName === 'Spring';
      }, 3000, 'the second page');
    });
  });

  await test('A window that is not the market is not treated as one', async () => {
    await withGame({ listings: [IDOL] }, async ({ bot, harness }) => {
      harness.openWindow('Character Selection');
      const window = await until(() => bot.currentWindow, 5000, 'the window');

      const scan = parseMarketWindow(window);
      assert.strictEqual(scan.title, 'Character Selection');
      assert.strictEqual(scan.isMarket, false);
      assert.strictEqual(scan.listings.length, 0);

      const opened = await bot.market.open({ walk: false, timeout: 500 });
      assert.strictEqual(opened.ok, false, 'a non-market window was accepted as the market');
    });
  });

  await test('The prices the harness writes are the prices the parser reads', async () => {
    // The lore is rendered by the harness independently of formatEmeralds, so
    // this compares two implementations rather than one against itself.
    for (const amount of [1, 63, 64, 4095, 4096, 10112, 262144, 300000]) {
      assert.strictEqual(parseEmeralds(`Price: ${priceText(amount)}`), amount,
        `round trip failed for ${amount}: "${priceText(amount)}"`);
    }
  });

  await test('A trade orphaned by a crash is settled against the balance the server reports', async () => {
    const file = scratchJournal();
    const start = 3 * 4096;
    await withGame({
      emeralds: start, listings: [IDOL], bot: { market: { journal: createJournal({ path: file }) } }
    }, async ({ harness, bot, state, join, leave }) => {
      harness.openMarket();
      await until(() => bot.currentWindow, 5000, 'the market window');

      // Exactly what buy() does, in the order it does it: the intent reaches
      // disk, then the click goes out. Dying between the two is the one case
      // buy() cannot stage from the inside, because it always writes an
      // outcome on the way out - only losing the process skips that.
      const before = bot.wynn.countEmeralds().total;
      bot.market.journal.recordIntent({
        intent_id: 'crash-1', side: 'buy', item: 'Idol', item_key: 'idol', units: 1,
        limit_price: 12000, observed_price: IDOL.price, emeralds_before: before,
        slot: 10, confirmed_by: 'human'
      });
      const clicked = await bot.market.click({ slot: 10 }, { confirm: true });
      assert.ok(clicked.ok, clicked.error);
      assert.strictEqual(state.sold.length, 1, 'the server should have sold it');

      await leave(bot); // the crash. No outcome was ever written.

      const revived = await join({ market: { journal: createJournal({ path: file }) } });
      assert.strictEqual(revived.market.journal.pending().length, 1,
        'the new session should find the unanswered intent on disk');
      await until(() => revived.wynn.countEmeralds().total === start - IDOL.price, 5000,
        'the debited purse to reach the new session');

      const result = revived.market.reconcilePending();
      assert.strictEqual(result.settled.length, 1);
      assert.strictEqual(result.settled[0].status, 'executed',
        `reconciliation could not settle it: ${result.stillPending[0] && result.stillPending[0].reason}`);
      assert.strictEqual(revived.market.journal.pending().length, 0);

      // The listing is gone from the board, so a retry that looked at the
      // board first would fail with "that slot is empty" and learn nothing.
      // The settled intent answers before anything looks.
      const retry = await revived.market.buy({ slot: 10 }, {
        confirm: true, intentId: 'crash-1', maxPrice: 12000
      });
      assert.ok(retry.duplicate, 'a settled trade was offered for execution again');
      assert.strictEqual(state.sold.length, 1, 'it bought the same thing twice');
      assert.strictEqual(state.emeralds, start - IDOL.price);
    });
  });

  await test('A crash before the click leaves the balance untouched, and that settles it too', async () => {
    const file = scratchJournal();
    const start = 3 * 4096;
    await withGame({
      emeralds: start, listings: [IDOL], bot: { market: { journal: createJournal({ path: file }) } }
    }, async ({ harness, bot, state, join, leave }) => {
      harness.openMarket();
      await until(() => bot.currentWindow, 5000, 'the market window');

      bot.market.journal.recordIntent({
        intent_id: 'crash-2', side: 'buy', item: 'Idol', item_key: 'idol', units: 1,
        limit_price: 12000, observed_price: IDOL.price,
        emeralds_before: bot.wynn.countEmeralds().total, slot: 10, confirmed_by: 'human'
      });
      await leave(bot); // died before the click this time

      const revived = await join({ market: { journal: createJournal({ path: file }) } });
      harness.openMarket();
      await until(() => revived.currentWindow, 5000, 'the market window');

      const result = revived.market.reconcilePending();
      assert.strictEqual(result.settled.length, 1);
      assert.strictEqual(result.settled[0].status, 'not_executed');
      assert.strictEqual(state.sold.length, 0);

      // And "it never happened" must not stand in the way of doing it. Only a
      // completed trade refuses a retry.
      const retry = await revived.market.buy({ slot: 10 }, {
        confirm: true, intentId: 'crash-2', expectItem: 'Idol', maxPrice: 12000
      });
      assert.ok(retry.ok, retry.error);
      assert.ok(!retry.duplicate, 'a trade that never happened was refused as a repeat');
      assert.strictEqual(state.sold.length, 1);
    });
  });

  console.log(`\n\x1b[1;32mProtocol harness tests: ${passed} passed.\x1b[0m`);
})();
