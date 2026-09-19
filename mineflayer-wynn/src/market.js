const { goals } = require('mineflayer-pathfinder');
const { extractCleanText } = require('./wynncraft');
const { createJournal } = require('./journal');

/**
 * Trade Market (auction house) automation for Wynncraft.
 *
 * The bot walks to a market location, opens the Trade Market GUI and reads or
 * clicks its panes. Wynncraft renders the market as a normal container of
 * custom-named items and glass panes, so everything here works off item names
 * and lore text rather than fixed slot numbers: Wynncraft moves the controls
 * around between updates, and slot hints would silently click the wrong thing.
 */

// Emerald denominations, in plain emeralds.
const EMERALD_UNITS = {
  stx: 262144, // stack of liquid emeralds (64 le)
  le: 4096, //   liquid emerald (64 eb)
  eb: 64, //     emerald block (64 e)
  e: 1
};

// Known Trade Market NPC locations. y is the standing height near the NPC.
const MARKET_LOCATIONS = {
  detlas: { name: 'Detlas', x: 500, y: 68, z: -1578 },
  llevigar: { name: 'Llevigar', x: -200, y: 40, z: -4400 },
  cinfras: { name: 'Cinfras', x: -450, y: 45, z: -4900 }
};

// Pane roles recognised by custom name, most specific first.
const PANE_ROLES = [
  { role: 'next_page', match: /next\s*page|▶|→/i },
  { role: 'prev_page', match: /(previous|prev|back)\s*page|◀|←/i },
  { role: 'search', match: /search|find\s*item|look\s*up/i },
  { role: 'sell', match: /sell\s*(item|offer)?|create\s*sell/i },
  { role: 'buy_order', match: /buy\s*order|create\s*buy/i },
  { role: 'my_listings', match: /your\s*(listings|orders|offers)|manage\s*(listings|orders)/i },
  { role: 'claim', match: /claim|collect|expired/i },
  { role: 'filter', match: /filter|sort|category/i },
  { role: 'close', match: /close|exit|go\s*back/i },
  { role: 'confirm', match: /confirm|accept|purchase|buy\s*it/i },
  { role: 'cancel', match: /cancel|decline/i }
];

const MARKET_TITLE = /trade\s*market|market|auction/i;

/**
 * Parses a Wynncraft emerald amount ("1 stx 32 le 16 eb 8 e") into emeralds.
 * Returns null when the text carries no amount.
 */
function parseEmeralds(text) {
  if (!text) return null;
  const clean = String(text).replace(/,/g, '');
  const matches = clean.matchAll(/(\d+(?:\.\d+)?)\s*(stx|le|eb|e)\b/gi);
  let total = 0;
  let found = false;
  for (const match of matches) {
    const unit = EMERALD_UNITS[match[2].toLowerCase()];
    if (unit === undefined) continue;
    total += parseFloat(match[1]) * unit;
    found = true;
  }
  if (found) return Math.round(total);

  // Bare numbers are emeralds, but only when the line is actually about price.
  const bare = clean.match(/(?:price|cost|each|total|for)\D{0,4}(\d+(?:\.\d+)?)/i);
  if (bare) return Math.round(parseFloat(bare[1]));
  return null;
}

/**
 * Renders an emerald amount back into Wynncraft's stx/le/eb/e notation.
 */
function formatEmeralds(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return '';
  let left = Math.max(0, Math.round(amount));
  const parts = [];
  for (const [unit, value] of Object.entries(EMERALD_UNITS)) {
    const count = Math.floor(left / value);
    if (count > 0) {
      parts.push(`${count}${unit}`);
      left -= count * value;
    }
  }
  return parts.length ? parts.join(' ') : '0e';
}

/**
 * Classifies one container slot as a market control, a listing, or filler.
 */
function classifySlot(item, slot) {
  if (!item) {
    return { slot, empty: true, kind: 'empty' };
  }

  const name = item.name || '';
  const customName = extractCleanText(item.customName);
  const rawLore = item.customLore || [];
  const lore = Array.isArray(rawLore) ? rawLore.map(line => extractCleanText(line)).filter(Boolean) : [];
  const isGlassPane = name.includes('glass_pane');
  const loreText = lore.join(' ');

  const base = {
    slot,
    empty: false,
    name,
    customName,
    lore,
    count: item.count || 1,
    isGlassPane
  };

  if (isGlassPane && !customName && lore.length === 0) {
    return { ...base, kind: 'filler' };
  }

  for (const { role, match } of PANE_ROLES) {
    if (match.test(customName)) {
      return { ...base, kind: 'control', role };
    }
  }

  // A listing is a real item whose lore quotes a price.
  const priceLine = lore.find(line => /price|cost|each|total/i.test(line) && parseEmeralds(line) !== null);
  const price = priceLine ? parseEmeralds(priceLine) : null;
  if (price !== null) {
    const amountLine = lore.find(line => /amount|quantity|stock|x\s*\d+/i.test(line));
    const amountMatch = amountLine ? amountLine.match(/(\d+)/) : null;
    const sellerLine = lore.find(line => /seller|listed by|owner/i.test(line));
    const sellerMatch = sellerLine ? sellerLine.match(/(?:seller|listed by|owner)\s*[:\-]?\s*(\S+)/i) : null;
    const unitPrice = lore.find(line => /each|per\s*unit/i.test(line));

    return {
      ...base,
      kind: 'listing',
      price,
      priceText: formatEmeralds(price),
      unitPrice: unitPrice ? parseEmeralds(unitPrice) : null,
      amount: amountMatch ? parseInt(amountMatch[1], 10) : (item.count || 1),
      seller: sellerMatch ? sellerMatch[1] : null,
      tier: (loreText.match(/\b(mythic|fabled|legendary|rare|unique|set|normal)\b/i) || [])[1] || null,
      shiny: /shiny/i.test(customName) || /shiny/i.test(loreText)
    };
  }

  if (isGlassPane) {
    return { ...base, kind: 'filler' };
  }
  return { ...base, kind: 'item' };
}

/**
 * Reads a container window into market panes without touching the bot.
 */
function parseMarketWindow(window) {
  if (!window || !window.slots) {
    return { open: false, title: '', isMarket: false, listings: [], controls: [], slots: [] };
  }

  const title = extractCleanText(window.title) ||
    (typeof window.title === 'string' ? window.title : '');
  const containerEnd = window.inventoryStart || window.slots.length;

  const slots = [];
  for (let slot = 0; slot < containerEnd; slot++) {
    slots.push(classifySlot(window.slots[slot], slot));
  }

  const listings = slots.filter(s => s.kind === 'listing');
  const controls = slots.filter(s => s.kind === 'control');
  const pageLabel = slots.find(s => s.kind !== 'empty' && /page\s*\d+/i.test(s.customName || ''));
  const pageMatch = pageLabel ? (pageLabel.customName.match(/page\s*(\d+)/i)) : null;

  return {
    open: true,
    id: window.id,
    title,
    isMarket: MARKET_TITLE.test(title),
    page: pageMatch ? parseInt(pageMatch[1], 10) : null,
    totalSlots: window.slots.length,
    containerSlots: containerEnd,
    listings,
    controls,
    slots
  };
}

/**
 * Resolves the "walk here" goal for a market location name or coordinate.
 */
function resolveLocation(location) {
  if (!location) return MARKET_LOCATIONS.detlas;
  if (typeof location === 'string') {
    const key = location.toLowerCase().replace(/[^a-z]/g, '');
    return MARKET_LOCATIONS[key] || null;
  }
  const { x, y, z } = location;
  if ([x, y, z].every(v => typeof v === 'number' && !isNaN(v))) {
    return { name: location.name || 'custom', x, y, z };
  }
  return null;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Waits for the next window that satisfies a predicate.
 */
function waitForWindow(bot, predicate, timeoutMs) {
  return new Promise((resolve) => {
    if (bot.currentWindow && predicate(bot.currentWindow)) {
      resolve(bot.currentWindow);
      return;
    }
    const onOpen = (window) => {
      if (!predicate(window)) return;
      cleanup();
      resolve(window);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      bot.removeListener('windowOpen', onOpen);
    }
    bot.on('windowOpen', onOpen);
  });
}

/**
 * Attaches the Trade Market controller as bot.market.
 */
function attachMarket(bot, options = {}) {
  /** Current emerald total, or null when the bot cannot say. */
  function countEmeralds() {
    try {
      const counted = bot.wynn && bot.wynn.countEmeralds ? bot.wynn.countEmeralds() : null;
      return counted && typeof counted.total === 'number' ? counted.total : null;
    } catch (err) {
      return null;
    }
  }

  const market = {
    locations: MARKET_LOCATIONS,
    lastScan: null,
    lastError: null,
    defaultLocation: options.location || 'detlas',
    npcSearchRadius: options.npcSearchRadius || 6,
    walking: false,
    // Purchases are written down before and after the click, so a retry is
    // recognised as a repeat even across a restart, and a trade interrupted
    // mid-flight stays visible as unresolved rather than being assumed either
    // way.
    journal: options.journal || createJournal()
  };

  /**
   * Distance from the bot to a location, or null when the bot has no position.
   */
  market.distanceTo = function (location = market.defaultLocation) {
    const target = resolveLocation(location);
    if (!target || !bot.entity || !bot.entity.position) return null;
    const dx = bot.entity.position.x - target.x;
    const dy = bot.entity.position.y - target.y;
    const dz = bot.entity.position.z - target.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  /**
   * Walks the bot to a market location and resolves once it is within range.
   */
  market.walkTo = async function (location = market.defaultLocation, opts = {}) {
    const target = resolveLocation(location);
    if (!target) {
      return { ok: false, error: `Unknown market location: ${location}` };
    }
    if (!bot.pathfinder) {
      return { ok: false, error: 'Pathfinder plugin is not loaded' };
    }

    const range = opts.range ?? 3;
    const timeoutMs = opts.timeout ?? 120000;
    const startDistance = market.distanceTo(target);
    if (startDistance !== null && startDistance <= range) {
      return { ok: true, alreadyThere: true, location: target, distance: startDistance };
    }

    market.walking = true;
    try {
      const goal = new goals.GoalNear(target.x, target.y, target.z, range);
      await Promise.race([
        bot.pathfinder.goto(goal),
        wait(timeoutMs).then(() => {
          throw new Error(`Timed out walking to ${target.name} after ${Math.round(timeoutMs / 1000)}s`);
        })
      ]);
      return { ok: true, location: target, distance: market.distanceTo(target) };
    } catch (err) {
      market.lastError = err.message;
      return { ok: false, error: err.message, location: target, distance: market.distanceTo(target) };
    } finally {
      market.walking = false;
      try {
        bot.pathfinder.setGoal(null);
      } catch (e) {
        // pathfinder already idle
      }
    }
  };

  /**
   * Finds the nearest Trade Market NPC entity around the bot.
   */
  market.findNpc = function (radius = market.npcSearchRadius) {
    if (!bot.entities || !bot.entity) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity === bot.entity || !entity.position) continue;
      const label = extractCleanText(entity.displayName || entity.customName || entity.username || entity.name || '');
      const isMarketNpc = MARKET_TITLE.test(label) || /trade|market|merchant/i.test(label);
      if (!isMarketNpc) continue;
      const distance = entity.position.distanceTo(bot.entity.position);
      if (distance <= radius && distance < bestDistance) {
        best = entity;
        bestDistance = distance;
      }
    }
    return best ? { entity: best, distance: bestDistance, label: extractCleanText(best.displayName || best.name || '') } : null;
  };

  /**
   * Walks to the market (optional) and opens the Trade Market GUI.
   */
  market.open = async function (opts = {}) {
    const timeoutMs = opts.timeout ?? 8000;

    if (bot.currentWindow) {
      const current = parseMarketWindow(bot.currentWindow);
      if (current.isMarket) {
        market.lastScan = current;
        return { ok: true, alreadyOpen: true, market: current };
      }
    }

    if (opts.walk !== false) {
      const walked = await market.walkTo(opts.location || market.defaultLocation, opts);
      if (!walked.ok) return walked;
    }

    const npc = market.findNpc(opts.npcSearchRadius);
    if (!npc) {
      return { ok: false, error: 'No Trade Market NPC found within range; move closer or pass explicit coordinates' };
    }

    try {
      await bot.lookAt(npc.entity.position.offset(0, 1, 0), true);
      bot.activateEntity(npc.entity);
    } catch (err) {
      return { ok: false, error: `Failed to interact with ${npc.label || 'market NPC'}: ${err.message}` };
    }

    const window = await waitForWindow(bot, w => MARKET_TITLE.test(extractCleanText(w.title) || ''), timeoutMs);
    if (!window) {
      return { ok: false, error: `Trade Market did not open within ${Math.round(timeoutMs / 1000)}s` };
    }

    const scan = parseMarketWindow(window);
    market.lastScan = scan;
    bot.emit('market:open', scan);
    return { ok: true, market: scan };
  };

  /**
   * Reads the currently open market window.
   */
  market.scan = function () {
    const scan = parseMarketWindow(bot.currentWindow);
    market.lastScan = scan;
    return scan;
  };

  /**
   * Resolves a pane selector (slot number, { role }, { name }) to a parsed pane.
   */
  market.findPane = function (selector) {
    const scan = market.scan();
    if (!scan.open) return null;
    if (typeof selector === 'number') {
      return scan.slots[selector] || null;
    }
    if (typeof selector === 'string') {
      return scan.slots.find(s => s.role === selector) ||
        scan.slots.find(s => s.customName && s.customName.toLowerCase().includes(selector.toLowerCase())) || null;
    }
    if (selector && typeof selector === 'object') {
      if (typeof selector.slot === 'number') return scan.slots[selector.slot] || null;
      if (selector.role) return scan.slots.find(s => s.role === selector.role) || null;
      if (selector.name) {
        const needle = selector.name.toLowerCase();
        return scan.slots.find(s => s.customName && s.customName.toLowerCase().includes(needle)) || null;
      }
    }
    return null;
  };

  /**
   * Clicks a market pane. Purchases need an explicit confirm because they spend
   * real in-game emeralds and cannot be undone.
   */
  market.click = async function (selector, opts = {}) {
    const pane = market.findPane(selector);
    if (!pane) {
      return { ok: false, error: `No market pane matched ${JSON.stringify(selector)}` };
    }
    if (pane.kind === 'listing' && !opts.confirm) {
      return {
        ok: false,
        needsConfirm: true,
        pane,
        error: `Clicking listing "${pane.customName}" (${pane.priceText}) buys it; pass confirm to proceed`
      };
    }

    try {
      await bot.clickWindow(pane.slot, opts.button ?? 0, opts.mode ?? 0);
    } catch (err) {
      return { ok: false, error: `Click on slot ${pane.slot} failed: ${err.message}`, pane };
    }

    await wait(opts.settleMs ?? 400);
    const scan = market.scan();
    bot.emit('market:click', { pane, scan });
    return { ok: true, pane, market: scan };
  };

  /**
   * Runs a market search: clicks the search pane, then answers the chat prompt.
   */
  market.search = async function (query, opts = {}) {
    if (!query || !String(query).trim()) {
      return { ok: false, error: 'Search query is empty' };
    }
    const clicked = await market.click({ role: 'search' }, opts);
    if (!clicked.ok) return clicked;

    // Wynncraft asks for the item name in chat once the search pane is clicked.
    await wait(opts.promptMs ?? 600);
    bot.chat(String(query).trim());
    await wait(opts.settleMs ?? 1200);

    const scan = market.scan();
    bot.emit('market:search', { query, scan });
    return { ok: true, query, market: scan };
  };

  market.nextPage = (opts = {}) => market.click({ role: 'next_page' }, opts);
  market.prevPage = (opts = {}) => market.click({ role: 'prev_page' }, opts);

  /**
   * Buys one listing. Requires confirm: true, and optionally a price ceiling.
   */
  market.buy = async function (selector, opts = {}) {
    // Before anything looks at the board. A retry arrives *after* the first
    // purchase removed the listing, so a pane lookup would fail on "that slot
    // is empty" and hide the fact that the trade already happened.
    if (opts.intentId && market.journal.isCompleted(opts.intentId)) {
      const previous = market.journal.outcomeFor(opts.intentId);
      return {
        ok: true,
        duplicate: true,
        intentId: opts.intentId,
        bought: previous.item ? { customName: previous.item, price: previous.actual_price } : null,
        boughtAt: previous.ts,
        error: null
      };
    }

    const pane = market.findPane(selector);
    if (!pane) return { ok: false, error: `No market pane matched ${JSON.stringify(selector)}` };
    if (pane.kind !== 'listing') {
      return { ok: false, error: `Slot ${pane.slot} is a ${pane.kind}, not a listing` };
    }
    if (!opts.confirm) {
      return { ok: false, needsConfirm: true, pane, error: 'Buying requires confirm: true' };
    }
    // A slot index is not an identity. Listings move as pages turn, other
    // players buy, and searches rerun, so a caller that knows what it meant to
    // buy says so and the purchase is refused if the slot now holds something
    // else - a price ceiling alone cannot tell a cheap right item from a cheap
    // wrong one.
    if (opts.expectItem) {
      const wanted = String(opts.expectItem).trim().toLowerCase();
      const actual = String(pane.customName || pane.name || '').trim().toLowerCase();
      if (wanted !== actual) {
        return {
          ok: false,
          pane,
          error: `Slot ${pane.slot} now holds "${pane.customName || pane.name}", not "${opts.expectItem}"; ` +
            'the market moved since this was planned'
        };
      }
    }
    if (typeof opts.maxPrice === 'number' && pane.price !== null && pane.price > opts.maxPrice) {
      return {
        ok: false,
        pane,
        error: `Listing costs ${formatEmeralds(pane.price)}, above the ${formatEmeralds(opts.maxPrice)} ceiling`
      };
    }

    const emeraldsBefore = countEmeralds();
    if (opts.intentId) {
      // On disk before the click: if the connection drops here, the journal
      // shows an intent with no outcome, which is the truthful state.
      market.journal.recordIntent({
        intent_id: opts.intentId,
        side: 'buy',
        item_key: String(pane.customName || pane.name || '').toLowerCase(),
        item: pane.customName || pane.name,
        units: pane.amount || 1,
        limit_price: opts.maxPrice ?? null,
        expected_fair_value: opts.expectedFairValue ?? null,
        slot: pane.slot,
        confirmed_by: opts.confirmedBy || 'human',
        emeralds_before: emeraldsBefore
      });
    }

    let clicked;
    try {
      clicked = await market.click({ slot: pane.slot }, { ...opts, confirm: true });
    } catch (err) {
      // A click that threw - a disconnect mid-purchase, most likely - is
      // recorded as failed rather than left as an unanswered intent.
      if (opts.intentId) {
        market.journal.recordOutcome({
          intent_id: opts.intentId, status: 'failed', error: err.message,
          actual_price: null, emeralds_before: emeraldsBefore, emeralds_after: countEmeralds(),
          reconciled: null
        });
      }
      return { ok: false, error: `Buy failed: ${err.message}`, pane, intentId: opts.intentId || null };
    }

    if (!clicked.ok) {
      if (opts.intentId) {
        market.journal.recordOutcome({
          intent_id: opts.intentId, status: 'failed', error: clicked.error,
          actual_price: null, emeralds_before: emeraldsBefore, emeralds_after: countEmeralds(),
          reconciled: null
        });
      }
      return clicked;
    }

    // Wynncraft shows a confirmation screen for purchases.
    const confirmPane = market.findPane({ role: 'confirm' });
    if (confirmPane) {
      await market.click({ slot: confirmPane.slot }, { ...opts, confirm: true });
    }

    if (opts.intentId) {
      const emeraldsAfter = countEmeralds();
      const spent = (emeraldsBefore !== null && emeraldsAfter !== null)
        ? emeraldsBefore - emeraldsAfter
        : null;
      market.journal.recordOutcome({
        intent_id: opts.intentId,
        status: 'executed',
        item: pane.customName || pane.name,
        actual_price: pane.price,
        units: pane.amount || 1,
        emeralds_before: emeraldsBefore,
        emeralds_after: emeraldsAfter,
        // Did the game agree with what we thought we did?
        reconciled: spent === null ? null : spent === pane.price * (pane.amount || 1),
        error: null
      });
    }

    const scan = market.scan();
    bot.emit('market:buy', { pane, scan, intentId: opts.intentId || null });
    return {
      ok: true,
      bought: pane,
      confirmed: !!confirmPane,
      intentId: opts.intentId || null,
      duplicate: false,
      market: scan
    };
  };

  /**
   * Closes the market window.
   */
  market.close = function () {
    if (!bot.currentWindow) return { ok: true, alreadyClosed: true };
    bot.closeWindow(bot.currentWindow);
    market.lastScan = null;
    return { ok: true };
  };

  bot.market = market;
  return market;
}

module.exports = {
  attachMarket,
  parseMarketWindow,
  classifySlot,
  parseEmeralds,
  formatEmeralds,
  resolveLocation,
  MARKET_LOCATIONS,
  EMERALD_UNITS,
  PANE_ROLES
};
