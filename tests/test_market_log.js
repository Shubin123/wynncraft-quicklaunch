'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../scripts/lib/market_log');

console.log('Running market recorder tests...');
let passed = 0;
function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-scan-'));
  process.env.WYNN_SCAN_FILE = path.join(dir, 'market_scans.jsonl');
  log.resetDedupeState();
  try { fn(); console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`); passed++; }
  catch (err) { console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.message}`); process.exitCode = 1; }
  finally { delete process.env.WYNN_SCAN_FILE; }
}
function listing(customName, price, amount = 1, seller = null, extra = {}) {
  return { customName, price, amount, seller, ...extra };
}
function market(listings, extra = {}) {
  return { open: true, isMarket: true, title: 'Trade Market', containerSlots: 54, listings, ...extra };
}
function rows() { return log.readRows(); }
function observation() { return rows().find((r) => r.type === 'listing_observation'); }

test('records a scan and observations without seller names', () => {
  const scan = log.recordScan(market([listing('Spring', 12000, 1, 'Alice'), listing('Spring', 9000, 1, 'Bob')]),
    { sessionId: 's1', world: 'NA3', now: 1000 });
  assert.ok(scan); assert.strictEqual(scan.listing_count, 2); assert.strictEqual(scan.distinct_sellers, 2);
  assert.strictEqual(log.splitRows(rows())[1].length, 2);
  const raw = fs.readFileSync(process.env.WYNN_SCAN_FILE, 'utf8');
  assert.ok(!raw.includes('Alice') && !raw.includes('Bob'));
});

test('normalises keys, variants, and fingerprints', () => {
  assert.strictEqual(log.normaliseItemKey('  Boreal-Patterned   Aegis '), 'boreal-patterned aegis');
  assert.strictEqual(log.itemVariant('Spring', 'Legendary', true), 'spring|legendary|shiny');
  assert.notStrictEqual(log.listingFingerprint('spring||', 9, 1), log.listingFingerprint('spring||', 10, 1));
});

test('dedupes unchanged windows but records changed windows', () => {
  const m = market([listing('Spring', 9000)]);
  assert.ok(log.recordScan(m, { now: 1000, minInterval: 60 }));
  assert.strictEqual(log.recordScan(m, { now: 1005, minInterval: 60 }), null);
  assert.ok(log.recordScan(m, { now: 1100, minInterval: 60 }));
  assert.ok(log.recordScan(market([listing('Spring', 8500)]), { now: 1101, minInterval: 60 }));
});

test('ignores non-market and empty windows', () => {
  assert.strictEqual(log.recordScan(null, { now: 1 }), null);
  assert.strictEqual(log.recordScan({ open: false }, { now: 1 }), null);
  assert.strictEqual(log.recordScan(market([]), { now: 1 }), null);
  assert.deepStrictEqual(rows(), []);
});

test('derives listing lifetimes only from covering scans', () => {
  const day = 86400;
  const spring = listing('Spring', 9000);
  log.recordScan(market([spring, listing('Spring', 12000)]), { now: day });
  log.recordScan(market([spring, listing('Spring', 12000), listing('Spring', 13000)]), { now: day * 2 });
  log.recordScan(market([listing('Spring', 12000)]), { now: day * 3 });
  const fp = log.listingFingerprint(log.itemVariant('Spring'), 9000, 1);
  const lifecycle = log.deriveLifecycles(rows()).find((l) => l.listing_fingerprint === fp);
  assert.strictEqual(lifecycle.disappeared_ts, day * 3);
  assert.strictEqual(lifecycle.lifetime_seconds, day * 2);
  assert.strictEqual(lifecycle.resolution, 'sold_or_pulled');
  log.resetDedupeState();
  log.recordScan(market([listing('Comet', 21000)]), { now: day * 4 });
  const springStill = log.deriveLifecycles(rows()).find((l) => l.listing_fingerprint === log.listingFingerprint(log.itemVariant('Spring'), 12000, 1));
  assert.strictEqual(springStill.disappeared_ts, null);
});

test('derives depth and undercut movement', () => {
  log.recordScan(market([listing('Spring', 9000, 1, 'a'), listing('Spring', 12000, 1, 'b'), listing('Spring', 15000, 1, 'c')]), { now: 3600 });
  log.recordScan(market([listing('Spring', 8000, 1, 'd'), listing('Spring', 12000, 1, 'b')]), { now: 7200 });
  const depth = log.deriveDepth(rows());
  assert.deepStrictEqual([depth[0].ask_min, depth[0].ask_p50, depth[0].ask_max], [9000, 12000, 15000]);
  assert.strictEqual(depth[1].undercut_delta, -1000);
  assert.strictEqual(depth[0].hour_of_day_utc, 1);
});

test('records raw lore rolls and keeps derived quality separate', () => {
  log.recordScan(market([listing('Idol', 10000, 1, null, { lore: ['§a+55 Strength', '§c-12% Walk Speed', '§aPrice: 1 le'] })]), { now: 1000, minInterval: 0 });
  const o = observation();
  assert.deepStrictEqual(o.identifications, { rawStrength: 55, walkSpeed: -12 });
  assert.ok(!('percentile' in o));
});

test('survives torn lines and prunes old rows', () => {
  const current = Date.now() / 1000;
  log.recordScan(market([listing('Spring', 9000)]), { now: current });
  fs.appendFileSync(process.env.WYNN_SCAN_FILE, '{"type":"broken"');
  log.resetDedupeState(); log.recordScan(market([listing('Comet', 21000)]), { now: current + 1 });
  assert.strictEqual(log.splitRows(rows())[0].length, 2);
  log.resetDedupeState(); log.recordScan(market([listing('Old', 100)]), { now: current - 120 * 86400 });
  log.resetDedupeState(); log.recordScan(market([listing('Fresh', 200)]), { now: current - 86400 });
  // The malformed torn line is also discarded by the rewrite, in addition
  // to the old scan and its observation.
  assert.strictEqual(log.prune(90), 3);
  assert.deepStrictEqual(log.splitRows(rows())[1].map((r) => r.item_key), ['fresh', 'spring', 'comet']);
});

console.log(`\n\x1b[1mMarket recorder tests result: ${passed}/8 passed\x1b[0m`);
if (passed !== 8) process.exitCode = 1;
