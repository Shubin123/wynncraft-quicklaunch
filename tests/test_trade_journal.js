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
const { createJournal } = require('../mineflayer-wynn/src/journal.js');
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

  console.log(`\n\x1b[1;32mTrade journal tests: ${passed} passed.\x1b[0m`);
})();
