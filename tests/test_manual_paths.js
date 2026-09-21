'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WYNN_MANUAL_PATH_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-manual-paths-')), 'paths.json');
const paths = require('../scripts/lib/manual_paths');

console.log('Running manual path tests...');
let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`); passed++; }
  catch (err) { console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.message}`); process.exitCode = 1; }
}

test('rejects empty or malformed recordings', () => {
  assert.strictEqual(paths.savePath('', [{ x: 0, y: 1, z: 2 }]).ok, false);
  assert.strictEqual(paths.savePath('short', [{ x: 0, y: 1, z: 2 }]).ok, false);
  assert.strictEqual(paths.savePath('bad', [{ x: 0, y: 1, z: 2 }, { x: 'x', y: 1, z: 2 }]).ok, false);
});
test('saves, replaces, lists, and deletes a recorded path', () => {
  const points = [{ x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }, { x: 5, y: 64, z: 5 }];
  assert.strictEqual(paths.savePath('Detlas loop', points, 'test route').ok, true);
  assert.strictEqual(paths.listPaths()[0].points.length, 3);
  paths.savePath('detlas LOOP', points.slice(0, 2));
  assert.strictEqual(paths.listPaths().length, 1);
  assert.strictEqual(paths.listPaths()[0].points.length, 2);
  assert.strictEqual(paths.deletePath('DETLAS LOOP').ok, true);
  assert.strictEqual(paths.listPaths().length, 0);
});

console.log(`\n\x1b[1mManual path tests result: ${passed}/2 passed\x1b[0m`);
if (passed !== 2) process.exitCode = 1;
