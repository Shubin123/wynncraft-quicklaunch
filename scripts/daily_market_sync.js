#!/usr/bin/env node
'use strict';

/**
 * Daily collector for liquid market candidates.
 *
 * This is intentionally a candidate list, not a claim that today's volume is
 * known in advance. Each successful live quote becomes a price_point; the
 * accumulated observations provide the evidence for future ranking.
 */
const cache = require('./lib/price_cache');
const mysqlStore = require('./lib/mysql_store');

const DEFAULT_LIQUID_ITEMS = [
  'Absolution', 'Alkatraz', 'Apocalypse', 'Az', 'Cancer', 'Capricorn', 'Cataclysm', 'Collapse',
  'Conduit of Spirit', 'Dark Shroud', 'Dawnbreak', 'Diamond Hydro Necklace', 'Discoverer', 'Divzer',
  'Fatal', 'Freedom', 'Gaia', 'Grandmother', 'Guardian', 'Harwrol', 'Hero', 'Idol', 'Ignis', 'Inferno',
  'Lament', 'Libra', 'Monster', 'Moon Pool Circlet', 'Nirvana', 'Nullification', 'Ornate Shadow Garb',
  'Photon', 'Pisces', 'Prism', 'Soulflare', 'Spectre', 'Spring', 'Stardew', 'Steamjet Walkers',
  'Stratiformis', 'The Nothing', 'Third Eye', 'Thrundacrack', 'Toxoplasmosis', 'Vaward', 'Ventus Tail',
  'Virgo', 'Warp', 'Warchief', 'Weathered'
];

function mergedWatchlist(existing = []) {
  return [...new Map([...DEFAULT_LIQUID_ITEMS, ...existing]
    .map((item) => [String(item).trim().toLowerCase(), String(item).trim()])).values()];
}

async function sync() {
  const items = mergedWatchlist(cache.loadWatchlist());
  cache.saveWatchlist(items);
  if (!cache.loadApiKey()) {
    await mysqlStore.flush();
    await mysqlStore.close();
    return { items: items.length, recorded: 0, failed: 0,
      warning: `No Wynnventory API key: set WYNNVENTORY_API_KEY or create ${cache.KEY_FILE}` };
  }
  let recorded = 0;
  const failed = [];
  for (const item of items) {
    const [status, body] = await cache.getCachedPrice(item);
    if (status === 200) recorded++;
    else failed.push({ item, status, error: body?.error || 'unknown error' });
  }
  await mysqlStore.flush();
  await mysqlStore.close();
  return { items: items.length, recorded, failed: failed.length, failures: failed };
}

if (require.main === module) {
  sync().then((result) => {
    console.log(`Daily market sync: tracked=${result.items}, recorded=${result.recorded}, failed=${result.failed}.`);
    if (result.warning) console.warn(result.warning);
    if (result.failures?.length) console.warn(`Failed items: ${result.failures.map((f) => f.item).join(', ')}`);
  }).catch(async (err) => { await mysqlStore.close(); console.error(`Daily market sync failed: ${err.message}`); process.exitCode = 1; });
}

module.exports = { DEFAULT_LIQUID_ITEMS, mergedWatchlist, sync };
