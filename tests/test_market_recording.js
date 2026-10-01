/**
 * The bot server records every Trade Market board it reads.
 *
 * The Python price server used to call record_scan on each read; when the
 * Node server replaced it the call was lost, and every board the bot looked
 * at was thrown away. This pins the wiring in BotManager.getMarket rather
 * than the recorder alone, which test_market_log.js already covers.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-market-rec-'));
process.env.WYNN_SCAN_FILE = path.join(dir, 'market_scans.jsonl');
process.env.WYNN_JOURNAL_FILE = path.join(dir, 'journal.jsonl');
process.env.WYNN_MYSQL_DISABLED = '1';
process.env.WYNN_PORT = process.env.WYNN_TEST_MARKET_REC_PORT || '8797';

const { server, manager } = require('../scripts/wynn_bot_server');
const { attachMarket } = require('../mineflayer-wynn/src/market');
const marketLog = require('../scripts/lib/market_log');

console.log('Running market recording tests...');
let passed = 0;
// Dedupe state carries across tests on purpose: test 2 relies on test 1's read.
marketLog.resetDedupeState();
function test(name, fn) {
  try { fn(); console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`); passed++; }
  catch (err) { console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.message}`); process.exitCode = 1; }
}

function boardWindow(title, listings) {
  const slots = new Array(90).fill(null);
  listings.forEach(([name, price], i) => {
    slots[10 + i] = { name: 'bow', customName: name, customLore: ['Legendary Item', `Price: ${price}`, 'Amount: 1'], count: 1 };
  });
  return { id: 4, title, slots, inventoryStart: 54 };
}

function attachFakeBot(window) {
  const bot = { currentWindow: window, wynn: { currentServer: 'EU2' }, entity: null, entities: {} };
  attachMarket(bot);
  manager.bot = bot;
  manager.status = 'connected';
  return bot;
}

test('Reading an open Trade Market board records it', () => {
  attachFakeBot(boardWindow('Trade Market', [['Spring', '2 le'], ['Idol', '3 le 8 eb']]));
  const snapshot = manager.getMarket();
  assert.ok(snapshot.ok && snapshot.isMarket);
  const [scans, observations] = marketLog.splitRows(marketLog.readRows());
  assert.strictEqual(scans.length, 1, 'one board read should be one scan');
  assert.strictEqual(scans[0].world, 'EU2');
  assert.deepStrictEqual(observations.map((o) => o.item_key).sort(), ['idol', 'spring']);
});

test('Polling the same board does not duplicate the scan', () => {
  manager.getMarket();
  manager.getMarket();
  assert.strictEqual(marketLog.splitRows(marketLog.readRows())[0].length, 1);
});

test('Containers that are not the market are not recorded', () => {
  attachFakeBot(boardWindow('Bank', [['Spring', '1 le']]));
  manager.getMarket();
  assert.strictEqual(marketLog.splitRows(marketLog.readRows())[0].length, 1);
});

manager.bot = null;
manager.status = 'disconnected';
server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n\x1b[1;32mMarket recording tests: ${passed} passed.\x1b[0m`);
if (passed !== 3) process.exitCode = 1;
