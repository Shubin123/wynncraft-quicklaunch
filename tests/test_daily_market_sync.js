'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_LIQUID_ITEMS, mergedWatchlist } = require('../scripts/daily_market_sync');

assert.ok(DEFAULT_LIQUID_ITEMS.length >= 50, 'the default liquid watchlist must contain at least 50 items');
assert.strictEqual(new Set(DEFAULT_LIQUID_ITEMS.map((item) => item.toLowerCase())).size, DEFAULT_LIQUID_ITEMS.length,
  'default tracked items must be unique');
assert.ok(mergedWatchlist(['Spring', 'Custom Item']).some((item) => item === 'Custom Item'),
  'an existing custom watch item must be preserved');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-market-sync-'));
try {
  const watchlist = path.join(dir, 'watchlist.json');
  const result = childProcess.spawnSync('node', [path.join(__dirname, '..', 'scripts', 'daily_market_sync.js')], {
    env: { ...process.env, HOME: dir, WYNN_WATCHLIST_FILE: watchlist, WYNN_MYSQL_DISABLED: '1' }, encoding: 'utf8'
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /tracked=50, recorded=0/);
  assert.strictEqual(JSON.parse(fs.readFileSync(watchlist, 'utf8')).length, 50);
  console.log('Daily market sync watchlist test passed.');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
