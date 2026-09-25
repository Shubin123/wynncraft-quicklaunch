#!/usr/bin/env node
'use strict';

/** Import the local append-only records into the single wynn_events table. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./lib/mysql_store');

const dataDir = path.join(os.homedir(), '.local', 'share', 'wynn-dashboard');
function jsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
}
async function main() {
  if (!store.status().configured) throw new Error('MySQL is not configured; run npm run db:init first');
  const batches = [
    ['price', jsonl(path.join(dataDir, 'history.jsonl')).map((row) => ({ type: 'price_point', ...row }))],
    ['market', jsonl(path.join(dataDir, 'market_scans.jsonl'))],
    ['trade', jsonl(path.join(dataDir, 'journal.jsonl'))]
  ];
  const imported = {};
  for (const [stream, rows] of batches) {
    imported[stream] = rows.length;
    store.recordEvents(stream, rows);
  }
  // A fixed id makes this an upsert and gives a new installation one useful,
  // non-sensitive row even before the first market observation is recorded.
  store.recordEvent('system', {
    type: 'storage_initialized', intent_id: 'wynn-mysql-initialization', ts: Date.now() / 1000,
    application: 'wynncraft-quicklaunch', database: 'wynn_dashboard', imported
  });
  await store.flush();
  await store.close();
  console.log(`Backfill complete: price=${imported.price}, market=${imported.market}, trade=${imported.trade}.`);
}
main().catch(async (err) => { await store.close(); console.error(`MySQL backfill failed: ${err.message}`); process.exitCode = 1; });
