/**
 * Shared data layer for the Wynncraft dashboard.
 *
 * Every page used to fetch its own slice of the system and re-implement the
 * same formatting, so the same item meant something slightly different
 * depending on which tab you were looking at. This gives all of them one
 * snapshot of the world (GET /api/state), one set of formatters, and one
 * notion of "the item I am currently looking at" that travels between pages.
 *
 * The selection is the cross-page handle: it lives in the URL (so links and
 * bookmarks carry it) and in localStorage (so plain navigation keeps it).
 *
 * Node gets the pure helpers for testing; a browser gets the whole client.
 */
(function (global) {
  'use strict';

  const SELECTION_KEY = 'wynn:selection';
  const DEFAULT_POLL_MS = 5000;

  /** Every page, by role, so links are never hand-written twice. */
  const PAGES = {
    price: 'index.html',
    trend: 'predict.html',
    optimize: 'optimize.html',
    liquidity: 'liquidity.html',
    market: 'market.html',
    bot: 'bot.html'
  };

  const EMERALD_UNITS = [['stx', 262144], ['le', 4096], ['eb', 64], ['e', 1]];

  /** Wynncraft's stx/le/eb/e notation, from a plain emerald count. */
  function formatEmeralds(amount) {
    if (amount === null || amount === undefined || isNaN(amount)) return '';
    const sign = amount < 0 ? '-' : '';
    let left = Math.abs(Math.round(amount));
    const parts = [];
    for (const [unit, value] of EMERALD_UNITS) {
      const count = Math.floor(left / value);
      if (count > 0) { parts.push(`${count}${unit}`); left -= count * value; }
    }
    return sign + (parts.length ? parts.join(' ') : '0e');
  }

  /** The inverse: "1stx 2le" and "1 stx 2 le" both parse. */
  function parseEmeralds(text) {
    if (text === null || text === undefined) return null;
    const matches = String(text).replace(/,/g, '').matchAll(/(\d+(?:\.\d+)?)\s*(stx|le|eb|e)\b/gi);
    let total = 0;
    let found = false;
    for (const match of matches) {
      const unit = EMERALD_UNITS.find(([name]) => name === match[2].toLowerCase());
      if (!unit) continue;
      total += parseFloat(match[1]) * unit[1];
      found = true;
    }
    return found ? Math.round(total) : null;
  }

  function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function percent(value, digits = 1) {
    if (value === null || value === undefined || isNaN(value)) return '';
    return `${(value * 100).toFixed(digits)}%`;
  }

  /**
   * Reads a selection out of a query string.
   *
   * `item` is the one thing in focus, `items` the working set. Pages that deal
   * in one item (price, trend) use the first; pages that deal in baskets
   * (optimizer, liquidity) use the list. `search` is market.html's way of
   * saying "and go look this up in game".
   */
  function readSelection(search) {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const list = (params.get('items') || '')
      .split(',').map(entry => entry.trim()).filter(Boolean);
    const single = (params.get('item') || '').trim();
    const query = (params.get('search') || '').trim();

    const items = list.length ? list : (single ? [single] : []);
    if (!items.length && !query) return null;
    return {
      item: single || query || items[0] || null,
      items: items.length ? items : (query ? [query] : []),
      search: query || null
    };
  }

  /** Normalises anything selection-shaped into the canonical form. */
  function toSelection(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      const item = value.trim();
      return item ? { item, items: [item], search: null } : null;
    }
    const items = (value.items || []).map(entry => String(entry).trim()).filter(Boolean);
    const item = (value.item || items[0] || '').trim();
    if (!item && !items.length) return null;
    return {
      item: item || items[0],
      items: items.length ? items : [item],
      search: value.search ? String(value.search).trim() : null
    };
  }

  /**
   * A link to another page carrying the selection.
   *
   * The market page is given `search` (it runs the search in game), basket
   * pages are given `items`, single-item pages `item` - so each page receives
   * the selection in the form it actually acts on.
   */
  function linkTo(page, value) {
    const target = PAGES[page] || page;
    const selection = toSelection(value);
    if (!selection) return target;

    const params = new URLSearchParams();
    if (page === 'market') {
      params.set('search', selection.item);
    } else if (page === 'optimize' || page === 'liquidity') {
      params.set('items', selection.items.join(','));
      if (selection.item) params.set('item', selection.item);
    } else {
      params.set('item', selection.item);
    }
    return `${target}?${params.toString()}`;
  }

  /**
   * Renders the "open this item elsewhere" links every page shows next to an
   * item, skipping whichever page is being viewed.
   */
  function crossLinks(item, { exclude = [], labels = {} } = {}) {
    const selection = toSelection(item);
    if (!selection) return '';
    const defaults = { price: 'price', trend: 'trend', liquidity: 'delta', market: 'in game' };
    return Object.keys(defaults)
      .filter(page => !exclude.includes(page))
      .map(page => `<a class="wynn-xlink" href="${linkTo(page, selection)}" ` +
        `title="Open ${escapeHtml(selection.item)} in ${PAGES[page]}">${labels[page] || defaults[page]}</a>`)
      .join(' ');
  }

  const helpers = {
    PAGES,
    crossLinks,
    formatEmeralds,
    parseEmeralds,
    escapeHtml,
    percent,
    readSelection,
    toSelection,
    linkTo,
    SELECTION_KEY,
    DEFAULT_POLL_MS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
  }
  if (typeof document === 'undefined') return;

  const subscribers = new Set();
  let lastState = null;
  let pollTimer = null;
  let events = null;
  let selectionListeners = [];

  function storedSelection() {
    try {
      return toSelection(JSON.parse(global.localStorage.getItem(SELECTION_KEY)));
    } catch (err) {
      return null; // private window, cleared storage, or junk
    }
  }

  /** URL first - an explicit link always beats what the last page remembered. */
  function getSelection() {
    return readSelection(global.location.search) || storedSelection();
  }

  /**
   * Records the selection so other pages pick it up, and reflects it in the
   * address bar without adding history entries.
   */
  function setSelection(value, { updateUrl = true } = {}) {
    const selection = toSelection(value);
    try {
      if (selection) global.localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
      else global.localStorage.removeItem(SELECTION_KEY);
    } catch (err) {
      // Storage is a convenience here; the URL still carries the selection.
    }
    if (updateUrl && selection && global.history && global.history.replaceState) {
      const page = Object.keys(PAGES).find(key => global.location.pathname.endsWith(PAGES[key]));
      const href = linkTo(page || global.location.pathname.split('/').pop(), selection);
      global.history.replaceState(null, '', href);
    }
    for (const listener of selectionListeners) listener(selection);
    return selection;
  }

  function onSelection(listener) {
    selectionListeners.push(listener);
    return () => { selectionListeners = selectionListeners.filter(entry => entry !== listener); };
  }

  function gotoPage(page, value) {
    const selection = toSelection(value) || getSelection();
    if (selection) setSelection(selection, { updateUrl: false });
    global.location.href = linkTo(page, selection);
  }

  async function get(path) {
    const response = await fetch(path);
    const body = await response.json();
    return { status: response.status, body };
  }

  async function post(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    return { status: response.status, body: await response.json() };
  }

  /** One snapshot of everything cheap: bot, account, market, engine, prices. */
  async function state() {
    try {
      const { body } = await get('/api/state');
      lastState = body;
    } catch (err) {
      lastState = { ok: false, error: 'dashboard server unreachable' };
    }
    for (const subscriber of subscribers) {
      try { subscriber(lastState); } catch (err) { /* one bad render must not stop the rest */ }
    }
    return lastState;
  }

  /**
   * Keeps a page in step with the system: a slow poll, plus an immediate
   * refresh whenever the bot server says something changed.
   */
  function subscribe(listener, { intervalMs = DEFAULT_POLL_MS } = {}) {
    subscribers.add(listener);
    if (lastState) listener(lastState);

    if (!pollTimer) {
      pollTimer = setInterval(state, intervalMs);
      try {
        events = new EventSource('/api/bot/events');
        for (const name of ['status', 'market', 'window', 'window_close']) {
          events.addEventListener(name, () => state());
        }
      } catch (err) {
        events = null; // polling alone still works
      }
      state();
    }

    return () => {
      subscribers.delete(listener);
      if (subscribers.size === 0) {
        clearInterval(pollTimer);
        pollTimer = null;
        if (events) { events.close(); events = null; }
      }
    };
  }

  global.WynnClient = Object.assign({}, helpers, {
    get,
    post,
    state,
    subscribe,
    getSelection,
    setSelection,
    onSelection,
    gotoPage,
    lastState: () => lastState
  });
})(typeof window !== 'undefined' ? window : globalThis);
