'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WYNN_WAYPOINT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-waypoints-')), 'places.json');
const store = require('../scripts/lib/waypoints');

console.log('Running saved waypoint tests...');
let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`); passed++; }
  catch (err) { console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.message}`); process.exitCode = 1; }
}

test('built-in places remain available', () => {
  const detlas = store.listWaypoints().find((place) => place.name === 'Detlas');
  assert.ok(detlas && detlas.builtin);
  assert.strictEqual(store.validWaypoint(detlas), true);
});
test('named coordinates persist and replace case-insensitively', () => {
  assert.strictEqual(store.saveWaypoint({ name: ' Mine Base ', x: 1, y: 2, z: 3 }).ok, true);
  store.saveWaypoint({ name: 'mine base', x: 4, y: 5, z: 6, desc: 'updated' });
  const saved = store.listWaypoints().filter((place) => !place.builtin);
  assert.strictEqual(saved.length, 1);
  assert.deepStrictEqual([saved[0].x, saved[0].y, saved[0].z], [4, 5, 6]);
  assert.strictEqual(store.deleteWaypoint('MINE BASE').ok, true);
  assert.strictEqual(store.listWaypoints().filter((place) => !place.builtin).length, 0);
});
test('invalid coordinates are rejected', () => {
  assert.strictEqual(store.saveWaypoint({ name: 'bad', x: 'no', y: 2, z: 3 }).ok, false);
});

console.log(`\n\x1b[1mSaved waypoint tests result: ${passed}/3 passed\x1b[0m`);
if (passed !== 3) process.exitCode = 1;
