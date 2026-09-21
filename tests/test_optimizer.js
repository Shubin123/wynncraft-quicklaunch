'use strict';

const assert = require('assert');
const { estimateItem, optimizeSlots } = require('../scripts/lib/optimizer');

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
  passed++;
}

console.log('Running Node optimizer tests...');

test('estimates net margin and flags thin roll-driven spreads', () => {
  const estimate = estimateItem('Pure', {
    lowest_price: 100,
    p50_price: 500,
    total_count: 4
  }, 1000);
  assert.strictEqual(estimate.buy_cost, 100);
  assert.strictEqual(estimate.sell_estimate, 500);
  assert.strictEqual(estimate.roll_variance_warning, true);
  assert.ok(estimate.net_margin > 0);
});

test('fills distinct slots without exceeding capital', () => {
  const result = optimizeSlots([
    { item: 'A', buy_cost: 60, net_margin: 30, sell_probability: 1, affordable: true, roll_variance_warning: false },
    { item: 'B', buy_cost: 50, net_margin: 20, sell_probability: 1, affordable: true, roll_variance_warning: false },
    { item: 'C', buy_cost: 90, net_margin: 90, sell_probability: 1, affordable: true, roll_variance_warning: false }
  ], 150, 2);
  assert.strictEqual(result.slots_filled, 2);
  assert.strictEqual(result.capital_spent, 150);
  assert.deepStrictEqual(result.picks.map((pick) => pick.item), ['C', 'A']);
});

console.log(`\n\x1b[1;32mNode optimizer tests: ${passed}/2 passed.\x1b[0m`);
