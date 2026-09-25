#!/usr/bin/env node
'use strict';

// Deliberate baseline values, not live market quotes. Replace them with real
// snapshots as the dashboard records prices, or supply ITEM=PRICE arguments.
const store = require('./lib/mysql_store');
const defaults = [['Spring', 9000], ['Comet', 21000], ['Idol', 10000]];

function itemsFromArgs() {
  if (!process.argv.slice(2).length) return defaults;
  return process.argv.slice(2).map((arg) => {
    const at = arg.lastIndexOf('=');
    const name = at < 1 ? '' : arg.slice(0, at).trim();
    const price = Number(at < 0 ? NaN : arg.slice(at + 1));
    if (!name || !Number.isFinite(price) || price < 0) throw new Error(`invalid item=price: ${arg}`);
    return [name, price];
  });
}
async function main() {
  const now = Date.now() / 1000;
  const rows = itemsFromArgs().map(([item, price]) => ({
    type: 'price_point', ts: now, item: item.toLowerCase(), lowest_price: price,
    average_price: price, p50_price: price, source: 'seeded_baseline', display_name: item
  }));
  store.recordEvents('price', rows);
  await store.flush();
  await store.close();
  console.log(`Tracked ${rows.length} seeded price point${rows.length === 1 ? '' : 's'} in wynn_events.`);
}
main().catch(async (err) => { await store.close(); console.error(`Price seed failed: ${err.message}`); process.exitCode = 1; });
