/**
 * The roll model: reading a rolled item and scoring it.
 *
 * The claim this rests on is that Wynncraft's item database puts the
 * *better* roll in `max` and the worse one in `min`, in every sign
 * quadrant - so quality is `(rolled - min) / (max - min)` with no per-stat
 * direction table. A direction table is exactly the thing that rots when
 * new identifications appear, so the invariant is asserted here against
 * real database entries rather than trusted.
 *
 * tests/fixtures/item_db_sample.json holds 40 real items covering all four
 * quadrants. When the full database happens to be cached on this machine
 * the invariant is checked across all of it too; that check is a bonus,
 * never a requirement, because tests must not need the network.
 *
 * This file covers scripts/lib/item_db.js only. The roll model reaching an
 * actual trading decision (via the trade engine) and the synthetic listing
 * generator are covered once those modules exist, in a later phase of the
 * dashboard-to-Node port.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const itemDb = require('../scripts/lib/item_db');

const FIXTURE = path.join(__dirname, 'fixtures', 'item_db_sample.json');

console.log('Running roll model tests...');

let passed = 0;
let total = 0;
function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

function loadFixture() {
  const payload = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const byName = {};
  for (const item of payload.items) {
    byName[String(item.displayName).trim().toLowerCase()] = item;
  }
  return byName;
}

function mostRolledItem(byName) {
  return Object.values(byName).reduce((best, item) => (
    Object.keys(itemDb.rolledSpecs(item)).length > Object.keys(itemDb.rolledSpecs(best)).length
      ? item : best
  ));
}

function rolledAt(specs, fraction) {
  const out = {};
  for (const [name, spec] of Object.entries(specs)) {
    out[name] = spec.min + fraction * (spec.max - spec.min);
  }
  return out;
}

// --- RollArithmetic ---------------------------------------------------

test('The invariant the whole module rests on, over real entries', () => {
  const byName = loadFixture();
  const quadrants = new Set();
  let checked = 0;
  for (const item of Object.values(byName)) {
    for (const [name, spec] of Object.entries(itemDb.rolledSpecs(item))) {
      assert.strictEqual(itemDb.rollQuality(spec.min, spec), 0.0,
        `${item.displayName}.${name} min should score 0`);
      assert.strictEqual(itemDb.rollQuality(spec.max, spec), 1.0,
        `${item.displayName}.${name} max should score 1`);
      const raw = spec.raw || 0;
      quadrants.add(`${raw > 0 ? 'pos' : 'neg'}:${spec.min < spec.max ? 'lt' : 'gt'}`);
      checked++;
    }
  }
  assert.ok(checked > 100, 'the fixture should exercise a lot of specs');
  assert.strictEqual(quadrants.size, 4,
    `the fixture must cover all four sign quadrants, got ${[...quadrants].sort()}`);
});

test('A bonus pass over all ~6,700 items, when one is already on disk', () => {
  if (!fs.existsSync(itemDb.ITEM_DB_FILE)) {
    console.log('  (skipped: full item database not cached; fixture covers the invariant)');
    return;
  }
  const cached = JSON.parse(fs.readFileSync(itemDb.ITEM_DB_FILE, 'utf8'));
  const bad = [];
  for (const item of cached.items) {
    for (const [name, spec] of Object.entries(itemDb.rolledSpecs(item))) {
      if (itemDb.rollQuality(spec.min, spec) !== 0.0 || itemDb.rollQuality(spec.max, spec) !== 1.0) {
        bad.push(`${item.displayName}.${name}`);
      }
    }
  }
  assert.deepStrictEqual(bad.slice(0, 5), [], `${bad.length} specs broke the invariant`);
});

test('Quality is clamped and ordered', () => {
  const spec = { min: 10, raw: 20, max: 30 };
  assert.strictEqual(itemDb.rollQuality(10, spec), 0.0);
  assert.strictEqual(itemDb.rollQuality(30, spec), 1.0);
  assert.ok(Math.abs(itemDb.rollQuality(20, spec) - 0.5) < 1e-9);
  // Wynncraft rounds what it displays, so a real roll can land just outside
  // the published range; that is not a reason to return 1.4.
  assert.strictEqual(itemDb.rollQuality(999, spec), 1.0);
  assert.strictEqual(itemDb.rollQuality(-999, spec), 0.0);
  assert.strictEqual(itemDb.rollQuality(5, { min: 7, max: 7 }), null);
  assert.strictEqual(itemDb.rollQuality('nonsense', spec), null);
});

test('A plain integer is the same on every copy and says nothing', () => {
  const item = { identifications: { rawStrength: 10, walkSpeed: { min: 1, raw: 3, max: 4 } } };
  assert.deepStrictEqual(Object.keys(itemDb.rolledSpecs(item)), ['walkSpeed']);
});

test('Every identification lands in a group', () => {
  const byName = loadFixture();
  const names = new Set();
  for (const item of Object.values(byName)) {
    for (const name of Object.keys(item.identifications || {})) names.add(name);
  }
  assert.ok(names.size > 40);
  for (const name of names) {
    assert.ok(itemDb.GROUP_NAMES.includes(itemDb.attributeGroup(name)));
  }
  // Spell costs must not be swallowed by the raw-damage rule.
  assert.strictEqual(itemDb.attributeGroup('raw3rdSpellCost'), 'spell_cost');
  assert.strictEqual(itemDb.attributeGroup('rawFireDamage'), 'damage_raw');
  assert.strictEqual(itemDb.attributeGroup('fireDamage'), 'damage_pct');
  assert.strictEqual(itemDb.attributeGroup('rawDefence'), 'skill_points');
  assert.strictEqual(itemDb.attributeGroup('fireDefence'), 'defence');
  // Something Wynncraft adds later is weighted, not dropped.
  assert.strictEqual(itemDb.attributeGroup('someFutureStat'), 'utility');
});

// --- Percentile ---------------------------------------------------------

test('Single attribute percentile is exact', () => {
  assert.ok(Math.abs(itemDb.rollPercentile([0.85], [1.0]) - 0.85) < 1e-9);
  assert.ok(Math.abs(itemDb.rollPercentile([0.10], [2.0]) - 0.10) < 1e-9);
});

test('The reason a plain average of roll percentages misleads', () => {
  const ks = [1, 2, 3, 5, 8];
  const percentiles = ks.map((k) => itemDb.rollPercentile(
    new Array(k).fill(0.85), new Array(k).fill(1.0),
  ));
  assert.ok(Math.abs(percentiles[0] - 0.85) < 1e-9);
  for (let i = 0; i < percentiles.length - 1; i++) {
    assert.ok(percentiles[i + 1] > percentiles[i]);
  }
  assert.ok(percentiles[percentiles.length - 1] > 0.99);
});

test('A median roll is the median however many attributes', () => {
  for (const k of [1, 2, 4, 7]) {
    const p = itemDb.rollPercentile(new Array(k).fill(0.5), new Array(k).fill(1.0));
    assert.ok(Math.abs(p - 0.5) < 1e-6);
  }
});

test('A group weighted to zero must not drag the percentile toward 0.5', () => {
  const both = itemDb.rollPercentile([0.9, 0.1], [1.0, 1.0]);
  const onlyFirst = itemDb.rollPercentile([0.9, 0.1], [1.0, 0.0]);
  assert.ok(Math.abs(onlyFirst - 0.9) < 1e-9);
  assert.ok(both < onlyFirst);
});

test('No observations is not a bad roll', () => {
  assert.strictEqual(itemDb.rollPercentile([], []), 0.5);
});

// --- ScoreRoll ------------------------------------------------------------

test('A full roll scores end to end', () => {
  const byName = loadFixture();
  const item = mostRolledItem(byName);
  const specs = itemDb.rolledSpecs(item);
  const worst = itemDb.scoreRoll(item, rolledAt(specs, 0.0));
  const best = itemDb.scoreRoll(item, rolledAt(specs, 1.0));
  assert.ok(Math.abs(worst.quality_weighted - 0.0) < 1e-9);
  assert.ok(Math.abs(best.quality_weighted - 1.0) < 1e-9);
  assert.strictEqual(best.coverage, 1.0);
  assert.ok(best.percentile > worst.percentile);
});

test('A lore line the parser missed must not read as a terrible roll', () => {
  const byName = loadFixture();
  const item = mostRolledItem(byName);
  const specs = itemDb.rolledSpecs(item);
  const full = rolledAt(specs, 0.9);
  const partial = Object.fromEntries(Object.entries(full).slice(0, 2));
  const scoredFull = itemDb.scoreRoll(item, full);
  const scoredPartial = itemDb.scoreRoll(item, partial);
  assert.ok(Math.abs(scoredPartial.quality_weighted - 0.9) < 1e-6);
  assert.ok(scoredPartial.coverage < scoredFull.coverage);
  assert.strictEqual(scoredPartial.n_observed, 2);
  assert.strictEqual(scoredPartial.n_rolled, scoredFull.n_rolled);
});

test('Nothing readable scores nothing', () => {
  const byName = loadFixture();
  const item = mostRolledItem(byName);
  const scored = itemDb.scoreRoll(item, {});
  assert.strictEqual(scored.quality_weighted, null);
  assert.strictEqual(scored.percentile, null);
  assert.strictEqual(scored.coverage, 0.0);
});

test('Weights move the weighted quality', () => {
  const byName = loadFixture();
  const item = mostRolledItem(byName);
  const specs = itemDb.rolledSpecs(item);
  const groups = {};
  for (const name of Object.keys(specs)) {
    const group = itemDb.attributeGroup(name);
    (groups[group] = groups[group] || []).push(name);
  }
  // Give one group a good roll and everything else a bad one, then show
  // that weighting that group up raises the score.
  const favoured = Object.keys(groups).reduce((a, b) => (groups[b].length > groups[a].length ? b : a));
  const rolled = {};
  for (const [name, spec] of Object.entries(specs)) {
    const good = itemDb.attributeGroup(name) === favoured;
    rolled[name] = spec.min + (good ? 0.95 : 0.05) * (spec.max - spec.min);
  }
  const low = itemDb.scoreRoll(item, rolled, { ...itemDb.DEFAULT_GROUP_WEIGHTS, [favoured]: 0.1 });
  const high = itemDb.scoreRoll(item, rolled, { ...itemDb.DEFAULT_GROUP_WEIGHTS, [favoured]: 3.0 });
  assert.ok(high.quality_weighted > low.quality_weighted);
});

// --- LoreParsing ------------------------------------------------------------

test('Reads identifications and ignores the rest', () => {
  const lore = [
    '§7Legendary Item',
    '§a+55 Strength',
    '§c-12% Walk Speed',
    '§a+8 Mana Regen [73%]',
    '§aPrice: 2 le 30 eb',
    '§8Seller: Someone',
    '§7Combat Lv. Min: 103',
    'flavour text with no number',
  ];
  const found = itemDb.parseIdentificationLore(lore);
  assert.strictEqual(found.rawStrength, 55.0);
  assert.strictEqual(found.walkSpeed, -12.0);
  assert.strictEqual(found.manaRegen, 8.0);
  // Anything with a colon is a label, not a stat.
  assert.ok(!Object.keys(found).some((k) => k.toLowerCase() === 'price'));
  assert.strictEqual(Object.keys(found).length, 3);
});

test('Hostile lore does not throw or invent stats', () => {
  const cases = [
    [], null, [''], ['§§§'], ['+999999999 Nonsense'], ['x'.repeat(5000)],
    [null], [{ not: 'a string' }], ['+ Strength'], ['12'],
  ];
  for (const lore of cases) {
    const found = itemDb.parseIdentificationLore(lore);
    assert.strictEqual(typeof found, 'object');
    for (const value of Object.values(found)) {
      assert.strictEqual(typeof value, 'number');
      assert.ok(!Number.isNaN(value));
    }
  }
});

console.log(`\n\x1b[1mRoll model tests result: ${passed}/${total} passed\x1b[0m\n`);
if (passed !== total) process.exitCode = 1;
