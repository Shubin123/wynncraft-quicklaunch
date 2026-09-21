'use strict';

const cache = require('../lib/price_cache');

function json(res, status, body, cacheHit = false) {
  const output = cacheHit && body && typeof body === 'object' ? { ...body, _cached: true } : body;
  const payload = Buffer.from(JSON.stringify(output));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
  res.end(payload);
  return true;
}

function param(url, key, fallback = '') { return url.searchParams.get(key) ?? fallback; }
function candidates(url) { return (param(url, 'items') || '').split(',').map((x) => x.trim()).filter(Boolean); }

async function handlePriceRoute(req, res, url) {
  const { pathname } = url;
  if (pathname === '/api/price') {
    const item = param(url, 'item').trim(); if (!item) return json(res, 400, { error: "missing 'item' query param" });
    const [status, body, hit] = await cache.getCachedPrice(item, param(url, 'tier'), param(url, 'shiny'));
    return json(res, status, body, hit);
  }
  if (pathname === '/api/history_local') {
    const item = param(url, 'item').trim(); if (!item) return json(res, 400, { error: "missing 'item' query param" });
    const days = Number(param(url, 'days', '30')); return json(res, 200, { item, points: cache.readHistory(item, Number.isFinite(days) ? days : 30) });
  }
  if (pathname === '/api/trend') {
    const item = param(url, 'item').trim(); if (!item) return json(res, 400, { error: "missing 'item' query param" });
    const days = Number(param(url, 'days', '30')); const metric = param(url, 'metric', 'lowest_price');
    const regression = cache.linearRegression(cache.readHistory(item, Number.isFinite(days) ? days : 30), metric);
    const result = { item, regression };
    const [liveStatus, liveBody] = await cache.getCachedPrice(item);
    const [historyStatus, historyBody] = await cache.getCachedHistoryAggregate(item);
    if (liveStatus === 200 && historyStatus === 200) result.wynnventory_comparison = {
      today_avg: liveBody.average_price, recent_history_avg: historyBody.average_price,
      recent_history_documents: historyBody.document_count,
    };
    if (!regression && !result.wynnventory_comparison) return json(res, 404, { error: `no data available for '${item}' yet` });
    return json(res, 200, result);
  }
  if (pathname === '/api/watchlist') return json(res, 200, { watchlist: cache.loadWatchlist() });
  if (pathname === '/api/watch/add' || pathname === '/api/watch/remove') {
    const item = param(url, 'item').trim(); if (!item) return json(res, 400, { error: "missing 'item' query param" });
    let items = cache.loadWatchlist();
    if (pathname.endsWith('/add')) items.push(item); else items = items.filter((x) => x.toLowerCase() !== item.toLowerCase());
    cache.saveWatchlist(items); return json(res, 200, { watchlist: cache.loadWatchlist() });
  }
  if (pathname === '/api/record_outcome') {
    const item = param(url, 'item').trim(); if (!item) return json(res, 400, { error: "missing 'item' query param" });
    const marginRaw = url.searchParams.get('margin'); const margin = marginRaw == null || marginRaw === '' ? null : Number(marginRaw);
    return json(res, 200, { item, state: cache.recordOutcome(item, param(url, 'sold', 'false').toLowerCase() === 'true', margin) });
  }
  if (pathname === '/api/optimize') return json(res, 501, { error: 'optimize endpoint is pending the Node trade-engine port' });
  return false;
}

module.exports = { handlePriceRoute, json, candidates };
