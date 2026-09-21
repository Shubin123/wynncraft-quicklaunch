'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'wynn-dashboard');
const KEY_FILE = path.join(os.homedir(), '.config', 'wynn-dashboard', 'wynnventory.key');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const BANDIT_STATE_FILE = path.join(DATA_DIR, 'bandit_state.json');
const WATCHLIST_FILE = path.join(os.homedir(), '.config', 'wynn-dashboard', 'watchlist.json');
const API_BASE = 'https://www.wynnventory.com/api';
const MARKET_FEE = 0.05;
const CONFIDENCE_REFERENCE_COUNT = 20;
const CACHE_TTL_SECONDS = 300;
const MIN_UPSTREAM_INTERVAL_SECONDS = 1.5;

const cache = new Map();
let lastUpstreamCall = 0;

function loadApiKey() {
  if (process.env.WYNNVENTORY_API_KEY) return process.env.WYNNVENTORY_API_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim() || null; } catch { return null; }
}

async function throttle() {
  const wait = lastUpstreamCall + MIN_UPSTREAM_INTERVAL_SECONDS * 1000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastUpstreamCall = Date.now();
}

async function fetchWynnventory(endpoint, key) {
  await throttle();
  try {
    const response = await fetch(`${API_BASE}/${endpoint}`, {
      headers: { Accept: 'application/json', Authorization: `Api-Key ${key}`, 'User-Agent': 'wynncraft-quicklaunch-dashboard/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 404) return [404, { error: 'not found' }];
    if (!response.ok) return [response.status, { error: `upstream error (${response.status})` }];
    return [response.status, await response.json()];
  } catch (err) { return [502, { error: `request to Wynnventory failed: ${err.message}` }]; }
}

function recordSnapshot(item, body) {
  if (!body || body.lowest_price === undefined) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(HISTORY_FILE, `${JSON.stringify({ ts: Date.now() / 1000, item: item.toLowerCase(),
    lowest_price: body.lowest_price, highest_price: body.highest_price, average_price: body.average_price,
    p50_price: body.p50_price })}\n`);
}

function readHistoryRows() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return fs.readFileSync(HISTORY_FILE, 'utf8').split(/\r?\n/).flatMap((line) => {
    if (!line) return [];
    try { const row = JSON.parse(line); return row.item ? [row] : []; } catch { return []; }
  });
}
function readHistory(item, days = 30) {
  const cutoff = Date.now() / 1000 - days * 86400;
  return readHistoryRows().filter((r) => r.item === item.toLowerCase() && r.ts >= cutoff).sort((a, b) => a.ts - b.ts);
}

function linearRegression(points, metric = 'lowest_price') {
  const values = points.filter((p) => p[metric] != null).map((p) => [p.ts, Number(p[metric])]);
  if (values.length < 2) return null;
  const t0 = values[0][0]; const xs = values.map(([x]) => (x - t0) / 86400); const ys = values.map(([, y]) => y);
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length; const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const xx = xs.reduce((s, x) => s + (x - meanX) ** 2, 0); if (xx === 0) return null;
  const slope = xs.reduce((s, x, i) => s + (x - meanX) * (ys[i] - meanY), 0) / xx;
  const intercept = meanY - slope * meanX;
  const total = ys.reduce((s, y) => s + (y - meanY) ** 2, 0);
  const residual = ys.reduce((s, y, i) => s + (y - (slope * xs[i] + intercept)) ** 2, 0);
  const last = xs[xs.length - 1]; const span = last - xs[0];
  const confidence = xs.length < 5 || span < 1 ? 'low' : (xs.length < 15 || span < 3 ? 'medium' : 'high');
  const round = (v, n) => Number(v.toFixed(n));
  return { metric, n: xs.length, span_days: round(span, 2), slope_per_day: round(slope, 4),
    r_squared: round(total === 0 ? 1 : Math.max(0, 1 - residual / total), 4), confidence,
    current_estimate: round(slope * last + intercept, 2), projected_1d: round(slope * (last + 1) + intercept, 2),
    projected_7d: round(slope * (last + 7) + intercept, 2) };
}

function loadBanditState() { try { return JSON.parse(fs.readFileSync(BANDIT_STATE_FILE, 'utf8')); } catch { return {}; } }
function saveBanditState(state) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BANDIT_STATE_FILE, JSON.stringify(state, null, 2)); }
function recordOutcome(item, sold, realizedMargin = null) {
  const state = loadBanditState(); const key = item.toLowerCase();
  const entry = state[key] || { n_outcomes: 0, n_sold: 0, margin_sum: 0, margin_sumsq: 0 };
  entry.n_outcomes++; if (sold) entry.n_sold++; if (realizedMargin != null) { entry.margin_sum += realizedMargin; entry.margin_sumsq += realizedMargin ** 2; }
  state[key] = entry; saveBanditState(state); return entry;
}

async function getCachedPrice(item, tier = '', shiny = '') {
  const key = loadApiKey(); if (!key) return [503, { error: 'no API key configured', hint: `set WYNNVENTORY_API_KEY or create ${KEY_FILE}` }, false];
  const cacheKey = `${item.toLowerCase()}|${tier}|${shiny}`; const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_SECONDS * 1000) return [cached.status, cached.body, true];
  const query = new URLSearchParams(); if (tier) query.set('tier', tier); if (shiny) query.set('shiny', shiny);
  const endpoint = `trademarket/item/${encodeURIComponent(item)}/price${query.toString() ? `?${query}` : ''}`;
  const [status, body] = await fetchWynnventory(endpoint, key);
  if (status === 200) { cache.set(cacheKey, { ts: Date.now(), status, body }); recordSnapshot(item, body); }
  return [status, body, false];
}
async function getCachedHistoryAggregate(item) {
  const key = loadApiKey(); if (!key) return [503, { error: 'no API key configured' }];
  const cacheKey = `hist:${item.toLowerCase()}`; const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_SECONDS * 1000) return [cached.status, cached.body];
  const [status, body] = await fetchWynnventory(`trademarket/history/${encodeURIComponent(item)}/price`, key);
  if (status === 200) cache.set(cacheKey, { ts: Date.now(), status, body }); return [status, body];
}
function loadWatchlist() { try { const x = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')); return Array.isArray(x) ? x : []; } catch { return []; } }
function saveWatchlist(items) { fs.mkdirSync(path.dirname(WATCHLIST_FILE), { recursive: true }); fs.writeFileSync(WATCHLIST_FILE, JSON.stringify([...new Set(items)].sort())); }

module.exports = { DATA_DIR, KEY_FILE, HISTORY_FILE, BANDIT_STATE_FILE, WATCHLIST_FILE, MARKET_FEE,
  CONFIDENCE_REFERENCE_COUNT, CACHE_TTL_SECONDS, loadApiKey, getCachedPrice, getCachedHistoryAggregate,
  recordSnapshot, readHistoryRows, readHistory, linearRegression, loadBanditState, saveBanditState,
  recordOutcome, loadWatchlist, saveWatchlist };
