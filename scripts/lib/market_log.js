'use strict';

/** JSONL market recorder and derived liquidity measurements. */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseIdentificationLore, scoreRoll } = require('./item_db');

const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'wynn-dashboard');
const SCAN_FILE = path.join(DATA_DIR, 'market_scans.jsonl');
const MIN_SCAN_INTERVAL_SECONDS = Number(process.env.WYNN_SCAN_INTERVAL || 60);
const SCAN_RETENTION_DAYS = Number(process.env.WYNN_SCAN_RETENTION_DAYS || 90);
let lastScan = { signature: null, ts: 0 };

function scanFile() {
  return process.env.WYNN_SCAN_FILE || SCAN_FILE;
}

function normaliseItemKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function itemVariant(name, tier = null, shiny = false) {
  return [normaliseItemKey(name), tier ? normaliseItemKey(tier) : '', shiny ? 'shiny' : ''].join('|');
}

function listingFingerprint(variant, price, amount) {
  return crypto.createHash('sha1')
    .update(`${variant}|${Math.trunc(Number(price))}|${Math.trunc(Number(amount || 1))}`)
    .digest('hex').slice(0, 16);
}

function scanSignature(listings) {
  const parts = listings
    .filter((l) => (l.customName || l.name) && l.price)
    .map((l) => `${normaliseItemKey(l.customName || l.name)}:${l.price}:${l.amount}`)
    .sort();
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function shouldRecord(signature, now, last = lastScan, minInterval = MIN_SCAN_INTERVAL_SECONDS) {
  if (last.signature !== signature) return true;
  return now - Number(last.ts || 0) >= minInterval;
}

function safeAppendRows(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, fs.statSync(file).size - 1);
    fs.closeSync(fd);
    if (buf[0] !== 10) fs.appendFileSync(file, '\n');
  }
  fs.appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}

function recordScan(market, { sessionId = null, world = null, now = Date.now() / 1000,
  minInterval = MIN_SCAN_INTERVAL_SECONDS } = {}) {
  if (!market || !market.open || !market.isMarket) return null;
  const listings = (market.listings || []).filter((l) => l.price && normaliseItemKey(l.customName || l.name));
  if (!listings.length) return null;
  const signature = scanSignature(listings);
  if (!shouldRecord(signature, now, lastScan, minInterval)) return null;

  const sellers = new Set(listings.filter((l) => l.seller && String(l.seller).trim())
    .map((l) => String(l.seller).trim().toLowerCase()));
  const scanId = crypto.createHash('sha1').update(`${now}|${signature}`).digest('hex').slice(0, 16);
  const scan = {
    type: 'market_scan', scan_id: scanId, ts: now, session_id: sessionId, world,
    query: market.query ?? null, page: market.page ?? null, listing_count: listings.length,
    distinct_sellers: sellers.size,
    container_slots: market.containerSlots || market.totalSlots || null,
  };
  const rows = [scan];
  for (const listing of listings) {
    const name = listing.customName || listing.name;
    const variant = itemVariant(name, listing.tier, Boolean(listing.shiny));
    const observation = {
      type: 'listing_observation', scan_id: scanId, ts: now, item_key: normaliseItemKey(name),
      item_variant: variant, price: Math.trunc(Number(listing.price)),
      amount: Math.trunc(Number(listing.amount || 1)), tier: listing.tier ?? null,
      shiny: Boolean(listing.shiny),
      listing_fingerprint: listingFingerprint(variant, listing.price, listing.amount),
    };
    const identifications = parseIdentificationLore(listing.lore);
    if (Object.keys(identifications).length) observation.identifications = identifications;
    rows.push(observation);
  }
  safeAppendRows(scanFile(), rows);
  lastScan = { signature, ts: now };
  return scan;
}

function readRows(days = null) {
  const file = scanFile();
  if (!fs.existsSync(file)) return [];
  const cutoff = days == null ? 0 : Date.now() / 1000 - Number(days) * 86400;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.ts >= cutoff && row.type) rows.push(row);
    } catch { /* ignore torn or malformed lines */ }
  }
  return rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

function splitRows(rows) {
  return [rows.filter((r) => r.type === 'market_scan'), rows.filter((r) => r.type === 'listing_observation')];
}

function deriveLifecycles(rows) {
  const [scans, observations] = splitRows(rows);
  if (!scans.length) return [];
  const scanTs = new Map(scans.map((s) => [s.scan_id, s.ts]));
  const ordered = [...scans].sort((a, b) => a.ts - b.ts);
  const itemsPerScan = new Map(scans.map((s) => [s.scan_id, new Set()]));
  const byFingerprint = new Map();
  for (const o of observations) {
    if (!scanTs.has(o.scan_id)) continue;
    itemsPerScan.get(o.scan_id).add(o.item_key);
    const key = `${o.item_key}\u0000${o.listing_fingerprint}`;
    let e = byFingerprint.get(key);
    if (!e) {
      e = { item_key: o.item_key, listing_fingerprint: o.listing_fingerprint,
        price: o.price, first_seen_ts: o.ts, last_seen_ts: o.ts, seen_scans: new Set() };
      byFingerprint.set(key, e);
    }
    e.first_seen_ts = Math.min(e.first_seen_ts, o.ts);
    e.last_seen_ts = Math.max(e.last_seen_ts, o.ts);
    e.seen_scans.add(o.scan_id);
  }
  const floor = new Map();
  for (const o of observations) {
    const key = `${o.scan_id}\u0000${o.item_key}`;
    if (!floor.has(key) || o.price < floor.get(key)) floor.set(key, o.price);
  }
  const result = [];
  for (const e of byFingerprint.values()) {
    const later = ordered.find((s) => s.ts > e.last_seen_ts && itemsPerScan.get(s.scan_id).has(e.item_key));
    const disappeared = later ? later.ts : null;
    let wasCheapest = false;
    for (const scanId of e.seen_scans) if (floor.get(`${scanId}\u0000${e.item_key}`) === e.price) wasCheapest = true;
    result.push({ item_key: e.item_key, listing_fingerprint: e.listing_fingerprint,
      first_seen_ts: e.first_seen_ts, last_seen_ts: e.last_seen_ts, disappeared_ts: disappeared,
      lifetime_seconds: disappeared == null ? null : disappeared - e.first_seen_ts,
      was_cheapest: wasCheapest, resolution: disappeared == null ? 'still_listed' : 'sold_or_pulled' });
  }
  return result.sort((a, b) => a.item_key.localeCompare(b.item_key) || a.first_seen_ts - b.first_seen_ts);
}

function deriveDepth(rows) {
  const [scans, observations] = splitRows(rows);
  const scanTs = new Map(scans.map((s) => [s.scan_id, s.ts]));
  const grouped = new Map();
  for (const o of observations) {
    if (!scanTs.has(o.scan_id)) continue;
    const key = `${o.scan_id}\u0000${o.item_key}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(o);
  }
  const depth = [];
  for (const [key, group] of grouped) {
    const [scanId, itemKey] = key.split('\u0000');
    const prices = group.map((o) => o.price).sort((a, b) => a - b);
    const ts = scanTs.get(scanId);
    depth.push({ ts, item_key: itemKey, ask_min: prices[0], ask_p50: prices[Math.floor(prices.length / 2)],
      ask_max: prices[prices.length - 1], listing_count: prices.length,
      distinct_sellers: scans.find((s) => s.scan_id === scanId)?.distinct_sellers || 0,
      undercut_delta: null, hour_of_day_utc: new Date(ts * 1000).getUTCHours() });
  }
  depth.sort((a, b) => a.item_key.localeCompare(b.item_key) || a.ts - b.ts);
  const previous = new Map();
  for (const row of depth) {
    if (previous.has(row.item_key)) row.undercut_delta = row.ask_min - previous.get(row.item_key);
    previous.set(row.item_key, row.ask_min);
  }
  return depth;
}

function deriveRollQuality(rows, byName, weights = undefined) {
  const [, observations] = splitRows(rows);
  const result = [];
  for (const o of observations) {
    if (!o.identifications) continue;
    const item = byName[o.item_key];
    if (!item) continue;
    const roll = scoreRoll(item, o.identifications, weights);
    if (roll.quality_weighted == null) continue;
    result.push({ ts: o.ts, scan_id: o.scan_id, item_key: o.item_key,
      listing_fingerprint: o.listing_fingerprint, price: o.price,
      quality_weighted: Number(roll.quality_weighted.toFixed(5)), quality_mean: Number(roll.quality_mean.toFixed(5)),
      quality_max: Number(roll.quality_max.toFixed(5)), percentile: Number(roll.percentile.toFixed(5)),
      n_observed: roll.n_observed, n_rolled: roll.n_rolled, coverage: Number(roll.coverage.toFixed(4)) });
  }
  return result;
}

function trainingRows(rows, byName) {
  const [, observations] = splitRows(rows);
  const byItem = {};
  for (const o of observations) if (o.identifications && byName[o.item_key]) (byItem[o.item_key] ||= []).push(o);
  const dataset = [];
  for (const [itemKey, group] of Object.entries(byItem)) {
    if (group.length < 2) continue;
    const prices = group.map((o) => o.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    if (median <= 0) continue;
    const item = byName[itemKey];
    for (const o of group) if (o.price > 0) dataset.push({
      item: item.displayName || itemKey, tier: item.tier || o.tier,
      level: (item.requirements || {}).level || 1, rolled: o.identifications,
      n_rolled_true: null, true_percentile: null, log_price_ratio: Math.log(o.price / median),
      observations_for_item: group.length,
    });
  }
  return dataset;
}

function holdStatisticsByItem(rows) {
  const lifetimes = {};
  for (const l of deriveLifecycles(rows)) if (l.lifetime_seconds) (lifetimes[l.item_key] ||= []).push(l.lifetime_seconds);
  const result = {};
  for (const [item, seconds] of Object.entries(lifetimes)) {
    seconds.sort((a, b) => a - b);
    result[item] = { days: Number((seconds[Math.floor(seconds.length / 2)] / 86400).toFixed(4)),
      samples: seconds.length, fastest_days: Number((seconds[0] / 86400).toFixed(4)),
      slowest_days: Number((seconds[seconds.length - 1] / 86400).toFixed(4)) };
  }
  return result;
}

function holdStatistics(rows, itemKey) { return holdStatisticsByItem(rows)[normaliseItemKey(itemKey)] || null; }
function observedHoldDays(rows, itemKey) { return holdStatistics(rows, itemKey)?.days ?? null; }

function prune(days = SCAN_RETENTION_DAYS) {
  const file = scanFile();
  if (!fs.existsSync(file)) return 0;
  const before = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length;
  const kept = readRows(days);
  fs.writeFileSync(file, kept.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return Math.max(0, before - kept.length);
}

function resetDedupeState() { lastScan = { signature: null, ts: 0 }; }

module.exports = { DATA_DIR, SCAN_FILE, MIN_SCAN_INTERVAL_SECONDS, SCAN_RETENTION_DAYS,
  scanFile, normaliseItemKey, itemVariant, listingFingerprint, scanSignature, shouldRecord,
  recordScan, readRows, splitRows, deriveLifecycles, deriveDepth, deriveRollQuality, trainingRows,
  holdStatisticsByItem, holdStatistics, observedHoldDays, prune, resetDedupeState };
