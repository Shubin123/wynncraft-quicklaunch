'use strict';

const assert = require('assert');
const cache = require('../scripts/lib/price_cache');

console.log('Running price-cache tests...');
let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`); passed++; }
  catch (err) { console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.message}`); process.exitCode = 1; }
}

test('linear regression reports slope and confidence', () => {
  const points = [0, 1, 2, 3, 4].map((day) => ({ ts: day * 86400, lowest_price: 100 + day * 10 }));
  const result = cache.linearRegression(points);
  assert.strictEqual(result.n, 5);
  assert.strictEqual(result.slope_per_day, 10);
  assert.strictEqual(result.projected_1d, 150);
  assert.strictEqual(result.confidence, 'medium');
});

test('regression rejects insufficient or same-time samples', () => {
  assert.strictEqual(cache.linearRegression([{ ts: 1, lowest_price: 2 }]), null);
  assert.strictEqual(cache.linearRegression([{ ts: 1, lowest_price: 2 }, { ts: 1, lowest_price: 3 }]), null);
});

console.log(`\n\x1b[1mPrice-cache tests result: ${passed}/2 passed\x1b[0m`);
if (passed !== 2) process.exitCode = 1;
