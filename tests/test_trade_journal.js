/**
 * The trade journal: idempotency that survives a restart, and reconciliation
 * after a trade is interrupted.
 *
 * The gap this closes was named in docs/TESTING_STRATEGY.md: completed intents
 * used to live in memory, so a bot restart between an attempt and its retry
 * could buy the same thing twice.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const { Vec3 } = require(require.resolve('vec3', {
  paths: [path.resolve(__dirname, '../mineflayer-wynn')]
}));
const { createJournal, reconcileIntent } = require('../mineflayer-wynn/src/journal.js');
const { attachMarket, formatEmeralds } = require('../mineflayer-wynn/src/market.js');

console.log('Running trade journal tests...');

let passed = 0;
async function test(name, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-journal-')), 'journal.jsonl');
  try {
    await fn(file);
    console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

/** A market that debits emeralds, and can be made to fail mid-click. */
function gameWorld({ emeralds = 100000, listings = [], failClick = null } = {}) {
  const state = { emeralds, sold: [], listings: listings.slice(), failClick };

  function windowFor() {
    const slots = new Array(54).fill(null);
    state.listings.forEach((listing, index) => {
      if (!listing) return;
      slots[10 + index] = {
        name: 'bow',
        customName: listing.item,
        customLore: ['Legendary Item', `Price: ${formatEmeralds(listing.price)}`, 'Amount: 1'],
        count: 1
      };
    });
    return { id: 7, title: 'Trade Market', slots: slots.concat(new Array(36).fill(null)), inventoryStart: 54 };
  }

  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(500, 68, -1576) };
  bot.entities = {};
  bot.currentWindow = windowFor();
  bot.chat = () => {};
  bot.closeWindow = () => {};
  bot.lookAt = async () => {};
  bot.activateEntity = () => {};
  bot.pathfinder = { goto: async () => {}, setGoal: () => {} };
  bot.wynn = { countEmeralds: () => ({ total: state.emeralds }) };
  bot.clickWindow = async (slot) => {
    if (state.failClick) throw new Error(state.failClick);
    const listing = state.listings[slot - 10];
    if (!listing) return;
    state.emeralds -= listing.price;
    state.sold.push({ ...listing });
    state.listings[slot - 10] = null;
    bot.currentWindow = windowFor();
  };

  return { bot, state };
}

(async () => {
  await test('An intent is written before the click and an outcome after', async (file) => {
    const { bot, state } = gameWorld({ listings: [{ item: 'Spring', price: 9000 }] });
    const market = attachMarket(bot, { journal: createJournal({ path: file }) });

    const result = await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', intentId: 'i-1', settleMs: 0
    });
    assert.ok(result.ok, result.error);

    const rows = createJournal({ path: file }).rows();
    assert.deepStrictEqual(rows.map(r => r.type), ['trade_intent', 'trade_outcome'],
      'the intent must be on disk before the outcome, not written as one entry afterwards');

    const [intent, outcome] = rows;
    assert.strictEqual(intent.intent_id, 'i-1');
    assert.strictEqual(intent.item, 'Spring');
    assert.strictEqual(intent.side, 'buy');
    assert.strictEqual(intent.confirmed_by, 'human');
    assert.strictEqual(intent.emeralds_before, 100000);

    assert.strictEqual(outcome.status, 'executed');
    assert.strictEqual(outcome.actual_price, 9000);
    assert.strictEqual(outcome.emeralds_after, 91000);
    assert.strictEqual(outcome.reconciled, true, 'the balance moved by exactly the price');
    assert.strictEqual(state.sold.length, 1);
  });

  await test('Idempotency survives a restart', async (file) => {
    const first = gameWorld({ listings: [{ item: 'Spring', price: 9000 }] });
    const firstMarket = attachMarket(first.bot, { journal: createJournal({ path: file }) });
    await firstMarket.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', intentId: 'i-restart', settleMs: 0
    });
    assert.strictEqual(first.state.sold.length, 1);

    // The bot restarts: a brand new process, a brand new market, the same
    // journal on disk - and the caller retries an intent it never saw answered.
    const second = gameWorld({ listings: [{ item: 'Spring', price: 9000 }] });
    const secondMarket = attachMarket(second.bot, { journal: createJournal({ path: file }) });

    const retry = await secondMarket.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', intentId: 'i-restart', settleMs: 0
    });
    assert.strictEqual(retry.duplicate, true, 'the restart forgot the completed intent');
    assert.ok(retry.ok);
    assert.strictEqual(second.state.sold.length, 0, 'the retry bought it a second time');
    assert.strictEqual(second.state.emeralds, 100000, 'and spent a second time');
  });

  await test('A disconnect mid-purchase leaves an unresolved intent, not a guess', async (file) => {
    const { bot, state } = gameWorld({
      listings: [{ item: 'Spring', price: 9000 }],
      failClick: 'Connection reset by peer'
    });
    const market = attachMarket(bot, { journal: createJournal({ path: file }) });

    const result = await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', intentId: 'i-dropped', settleMs: 0
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /Connection reset/);
    assert.strictEqual(state.sold.length, 0);

    const journal = createJournal({ path: file });
    const outcome = journal.outcomeFor('i-dropped');
    assert.ok(outcome, 'a failed click must still be recorded');
    assert.strictEqual(outcome.status, 'failed');
    assert.strictEqual(outcome.reconciled, null, 'nothing is claimed about a trade that threw');

    // A failure is not a completed trade, so a deliberate retry is allowed.
    assert.strictEqual(journal.isCompleted('i-dropped'), false);
  });

  await test('An intent with no outcome at all stays visible for reconciliation', async (file) => {
    // The process died between the click and the answer: the intent is on
    // disk, the outcome never was. Whether the trade happened is unknown.
    const journal = createJournal({ path: file });
    journal.recordIntent({ intent_id: 'i-halfway', side: 'buy', item: 'Spring', units: 1 });

    const reopened = createJournal({ path: file });
    const pending = reopened.pending();
    assert.strictEqual(pending.length, 1, 'an unanswered intent must not disappear');
    assert.strictEqual(pending[0].intent_id, 'i-halfway');
    assert.strictEqual(reopened.isCompleted('i-halfway'), false,
      'unknown is not the same as done');

    // Once resolved it leaves the pending list.
    reopened.recordOutcome({ intent_id: 'i-halfway', status: 'executed', actual_price: 9000 });
    assert.deepStrictEqual(createJournal({ path: file }).pending(), []);
  });

  await test('Reconciliation notices when the balance does not match the price', async (file) => {
    const { bot, state } = gameWorld({ listings: [{ item: 'Spring', price: 9000 }] });
    // A fee, a tax, a second charge: the balance moves by more than the ask.
    const original = bot.clickWindow;
    bot.clickWindow = async (slot) => {
      await original(slot);
      state.emeralds -= 500;
    };
    const market = attachMarket(bot, { journal: createJournal({ path: file }) });

    await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', intentId: 'i-mismatch', settleMs: 0
    });

    const outcome = createJournal({ path: file }).outcomeFor('i-mismatch');
    assert.strictEqual(outcome.status, 'executed');
    assert.strictEqual(outcome.reconciled, false,
      'spending 9500 on a 9000 listing must not be reported as reconciled');
    assert.strictEqual(outcome.emeralds_before - outcome.emeralds_after, 9500);
  });

  await test('A bot that cannot count emeralds records unknown, not zero', async (file) => {
    const { bot } = gameWorld({ listings: [{ item: 'Spring', price: 9000 }] });
    delete bot.wynn;
    const market = attachMarket(bot, { journal: createJournal({ path: file }) });

    await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', intentId: 'i-blind', settleMs: 0
    });

    const outcome = createJournal({ path: file }).outcomeFor('i-blind');
    assert.strictEqual(outcome.status, 'executed');
    assert.strictEqual(outcome.emeralds_before, null);
    assert.strictEqual(outcome.reconciled, null,
      'with no balance to compare, reconciliation is unknown rather than false');
  });

  await test('A refused buy writes nothing to the journal', async (file) => {
    const { bot, state } = gameWorld({ listings: [{ item: 'Spring', price: 9000 }] });
    const market = attachMarket(bot, { journal: createJournal({ path: file }) });

    await market.buy({ slot: 10 }, { expectItem: 'Spring', intentId: 'i-unconfirmed', settleMs: 0 });
    await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Something Else', intentId: 'i-wrong-item', settleMs: 0
    });
    await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', maxPrice: 10, intentId: 'i-too-dear', settleMs: 0
    });

    assert.strictEqual(state.sold.length, 0);
    assert.deepStrictEqual(createJournal({ path: file }).rows(), [],
      'a decision that never reached the game is not a trade');
  });

  await test('A line torn by a crash costs only itself', async (file) => {
    const journal = createJournal({ path: file });
    journal.recordIntent({ intent_id: 'i-good', side: 'buy', item: 'Spring', units: 1 });
    fs.appendFileSync(file, '{"type": "trade_outcome", "intent_id": "i-tor');  // killed mid-write

    const reopened = createJournal({ path: file });
    assert.strictEqual(reopened.rows().length, 1, 'the good row survives');
    assert.strictEqual(reopened.pending().length, 1);

    reopened.recordOutcome({ intent_id: 'i-good', status: 'executed', actual_price: 1 });
    const final = createJournal({ path: file });
    assert.strictEqual(final.isCompleted('i-good'), true,
      'the torn line must not swallow the row appended after it');
  });

  await test('An unwritable journal does not block a trade the user asked for', async () => {
    const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-ro-')), 'file', 'journal.jsonl');
    fs.writeFileSync(path.dirname(blocked), 'not a directory');

    const { bot, state } = gameWorld({ listings: [{ item: 'Spring', price: 9000 }] });
    const market = attachMarket(bot, { journal: createJournal({ path: blocked }) });

    const result = await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', intentId: 'i-nowrite', settleMs: 0
    });
    assert.ok(result.ok, `the purchase should still go through: ${result.error}`);
    assert.strictEqual(state.sold.length, 1);
    assert.ok(market.journal.lastError, 'but the journal failure must be visible');
  });

  // ---------------------------------------------------------------
  // Reconciliation: settling an intent nobody watched finish.
  // ---------------------------------------------------------------

  /** An intent as the buy path writes one, a minute ago. */
  const orphan = (over = {}) => ({
    intent_id: 'i-orphan', ts: 1000, side: 'buy', item: 'Spring', item_key: 'spring',
    units: 1, limit_price: 12000, observed_price: 9000, emeralds_before: 100000, ...over
  });
  const AT = { now: 1060 };

  await test('A balance that fell by the asking price settles the intent', async () => {
    const result = reconcileIntent(orphan(), { emeralds_now: 91000, ...AT });
    assert.strictEqual(result.status, 'executed');
    assert.strictEqual(result.expected_price, 9000);
    assert.strictEqual(result.age_seconds, 60);
  });

  await test('A balance that never moved settles it the other way', async () => {
    const result = reconcileIntent(orphan(), { emeralds_now: 100000, ...AT });
    assert.strictEqual(result.status, 'not_executed');
  });

  await test('A balance that moved by something else settles nothing', async () => {
    const result = reconcileIntent(orphan(), { emeralds_now: 95000, ...AT });
    assert.strictEqual(result.status, 'unknown');
    assert.ok(/5000/.test(result.reason), result.reason);
  });

  await test('Multi-unit intents are priced the same way the buy path prices them', async () => {
    const stack = orphan({ units: 4, observed_price: 500 });
    assert.strictEqual(reconcileIntent(stack, { emeralds_now: 98000, ...AT }).status, 'executed');
    assert.strictEqual(reconcileIntent(stack, { emeralds_now: 99500, ...AT }).status, 'unknown',
      'one unit of a four-unit intent is not that intent');
  });

  await test('Nothing to compare against leaves the intent pending', async () => {
    assert.strictEqual(
      reconcileIntent(orphan({ emeralds_before: null }), { emeralds_now: 91000, ...AT }).status, 'unknown');
    assert.strictEqual(
      reconcileIntent(orphan(), { emeralds_now: null, ...AT }).status, 'unknown');
    assert.strictEqual(
      reconcileIntent(orphan({ observed_price: null }), { emeralds_now: 91000, ...AT }).status, 'unknown',
      'without the asking price there is no sum to check');
  });

  await test('A balance stops being a witness once the intent is old', async () => {
    const old = reconcileIntent(orphan(), { emeralds_now: 91000, now: 1000 + (4 * 3600) });
    assert.strictEqual(old.status, 'unknown');
    assert.ok(/old/.test(old.reason), old.reason);

    // Including the balance that did not move: over four hours "unchanged" is
    // not "untouched", because a purchase and a sale cancel out. The age gate
    // comes before every conclusion, not just the confident one.
    const untouched = reconcileIntent(orphan(), { emeralds_now: 100000, now: 1000 + (4 * 3600) });
    assert.strictEqual(untouched.status, 'unknown');

    // Within the window it is decisive again.
    assert.strictEqual(reconcileIntent(orphan(), { emeralds_now: 100000, ...AT }).status, 'not_executed');
  });

  await test('One balance cannot attribute a spend among several open intents', async () => {
    const shared = { emeralds_now: 91000, pending_count: 2, ...AT };
    assert.strictEqual(reconcileIntent(orphan(), shared).status, 'unknown');

    // Zero movement is still unambiguous, however many are outstanding.
    const nothingSpent = reconcileIntent(orphan(), { emeralds_now: 100000, pending_count: 3, ...AT });
    assert.strictEqual(nothingSpent.status, 'not_executed');
  });

  await test('Holding the item can veto a conclusion but never reach one', async () => {
    const held = reconcileIntent(orphan(), { emeralds_now: 100000, item_in_inventory: true, ...AT });
    assert.strictEqual(held.status, 'unknown',
      'the item is there but nothing was paid; that needs a human');

    const alsoHeld = reconcileIntent(orphan(), { emeralds_now: 95000, item_in_inventory: true, ...AT });
    assert.strictEqual(alsoHeld.status, 'unknown', 'holding it does not make a wrong sum right');
  });

  await test('Reconciling writes an outcome, and an unknown writes nothing', async (file) => {
    const { bot } = gameWorld({ emeralds: 91000, listings: [] });
    const market = attachMarket(bot, { journal: createJournal({ path: file }) });
    market.journal.recordIntent(orphan({ ts: Date.now() / 1000 }));
    assert.strictEqual(market.journal.pending().length, 1);

    const settled = market.reconcilePending();
    assert.strictEqual(settled.checked, 1);
    assert.strictEqual(settled.settled.length, 1);
    assert.strictEqual(settled.settled[0].status, 'executed');
    assert.strictEqual(market.journal.pending().length, 0, 'the intent should be closed now');

    const outcome = market.journal.outcomeFor('i-orphan');
    assert.strictEqual(outcome.status, 'executed');
    assert.strictEqual(outcome.actual_price, 9000);
    assert.strictEqual(outcome.resolution, 'reconciled',
      'an inferred outcome must not look like one the buy path watched');
    assert.strictEqual(outcome.reconciled, true);

    // And it survives the restart that made it necessary.
    assert.ok(createJournal({ path: file }).isCompleted('i-orphan'));
  });

  await test('An intent reconciliation cannot settle stays pending on disk', async (file) => {
    const { bot } = gameWorld({ emeralds: 95000, listings: [] });
    const market = attachMarket(bot, { journal: createJournal({ path: file }) });
    market.journal.recordIntent(orphan({ ts: Date.now() / 1000 }));

    const result = market.reconcilePending();
    assert.strictEqual(result.settled.length, 0);
    assert.strictEqual(result.stillPending.length, 1);
    assert.ok(result.stillPending[0].reason);
    assert.strictEqual(createJournal({ path: file }).pending().length, 1,
      'an unsettled intent must still be pending after a restart');
  });

  await test('A trade reconciliation called executed is not bought again', async (file) => {
    const { bot, state } = gameWorld({ emeralds: 91000, listings: [{ item: 'Spring', price: 9000 }] });
    const market = attachMarket(bot, { journal: createJournal({ path: file }) });
    market.journal.recordIntent(orphan({ ts: Date.now() / 1000 }));
    market.reconcilePending();

    const retry = await market.buy({ slot: 10 }, {
      confirm: true, expectItem: 'Spring', intentId: 'i-orphan', settleMs: 0
    });
    assert.ok(retry.duplicate, 'the settled intent should refuse a second execution');
    assert.strictEqual(state.sold.length, 0, 'it bought the thing a second time');
  });

  console.log(`\n\x1b[1;32mTrade journal tests: ${passed} passed.\x1b[0m`);
})();
