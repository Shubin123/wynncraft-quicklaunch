/**
 * In-game inventory / container pane for the Wynncraft dashboard.
 *
 * Brings up the bot's inventory the way Minecraft does when you press E, and
 * the same pane doubles as the chest view whenever the bot has a container
 * open - chests, the Trade Market, the character menu - because that is what
 * the bot spends most of its time looking at.
 *
 * It is deliberately self-contained: one script tag, its own styles, its own
 * DOM under a single root element, and no assumptions about the page that
 * hosts it. Dropping it into a page must not disturb anything already there.
 *
 * Contents update on demand rather than continuously: once when opened, on the
 * bot server's window events (so opening a chest in-game is reflected), and on
 * a slow poll while the pane is visible.
 */
(function (global) {
  'use strict';

  const SLOT_PX = 34;
  const POLL_INTERVAL_MS = 4000;

  // Minecraft's rarity colours, used the way the in-game tooltip does: the
  // item name takes the colour of its tier.
  const TIER_COLORS = {
    mythic: '#AA00AA',
    fabled: '#FF5555',
    legendary: '#55FFFF',
    rare: '#FF55FF',
    set: '#55FF55',
    unique: '#FFFF55',
    normal: '#FFFFFF'
  };

  const LORE_COLOR = '#AAAAAA';

  /**
   * Player inventory slot map for window 0, as the Minecraft protocol lays it
   * out: 0 crafting output, 1-4 crafting grid, 5-8 armour, 9-35 main,
   * 36-44 hotbar, 45 offhand.
   */
  const PLAYER_LAYOUT = {
    craftingOutput: [0],
    crafting: [1, 2, 3, 4],
    armor: [5, 6, 7, 8],
    main: range(9, 36),
    hotbar: range(36, 45),
    offhand: [45]
  };

  function range(start, end) {
    const out = [];
    for (let i = start; i < end; i++) out.push(i);
    return out;
  }

  function chunk(items, size) {
    const rows = [];
    for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
    return rows;
  }

  /**
   * Splits a window payload into the sections the pane renders.
   *
   * With a container open, the protocol appends the player's 27 main slots and
   * 9 hotbar slots after the container's own, which is how the container size
   * is recovered. With no container open the payload is the player inventory
   * itself, so the vanilla E layout applies.
   */
  function layoutFor(windowData) {
    const slots = (windowData && windowData.slots) || [];
    const total = (windowData && windowData.totalSlots) || slots.length;

    if (windowData && windowData.open && total > 36) {
      const containerSize = total - 36;
      return {
        kind: 'container',
        title: windowData.title || 'Container',
        sections: [
          { key: 'container', label: windowData.title || 'Container', rows: chunk(range(0, containerSize), 9) },
          { key: 'main', label: 'Inventory', rows: chunk(range(containerSize, containerSize + 27), 9) },
          { key: 'hotbar', label: '', rows: [range(containerSize + 27, containerSize + 36)] }
        ]
      };
    }

    return {
      kind: 'player',
      title: (windowData && windowData.title) || 'Inventory',
      sections: [
        { key: 'equipment', label: 'Equipment', rows: [PLAYER_LAYOUT.armor.concat(PLAYER_LAYOUT.offhand)] },
        { key: 'crafting', label: 'Crafting', rows: [PLAYER_LAYOUT.crafting.concat(PLAYER_LAYOUT.craftingOutput)] },
        { key: 'main', label: 'Inventory', rows: chunk(PLAYER_LAYOUT.main, 9) },
        { key: 'hotbar', label: '', rows: [PLAYER_LAYOUT.hotbar] }
      ]
    };
  }

  /**
   * The tier colour for an item, read from its name and lore the way the
   * in-game tooltip reads it.
   */
  function rarityColor(slot) {
    if (!slot || slot.empty) return TIER_COLORS.normal;
    const haystack = [slot.customName || '', (slot.lore || []).join(' ')].join(' ').toLowerCase();
    for (const tier of ['mythic', 'fabled', 'legendary', 'rare', 'set', 'unique']) {
      if (new RegExp(`\\b${tier}\\b`).test(haystack)) return TIER_COLORS[tier];
    }
    return TIER_COLORS.normal;
  }

  /**
   * Texture URL for an item, served by prismarine-viewer (which
   * apply_wynn_textures.py has already patched with the Wynncraft art).
   */
  function textureUrl(viewerBase, version, itemName) {
    if (!viewerBase || !itemName) return null;
    const clean = String(itemName).replace(/^minecraft:/, '').replace(/[^a-z0-9_]/gi, '');
    if (!clean || clean === 'empty') return null;
    return `${viewerBase.replace(/\/$/, '')}/textures/${version}/items/${clean}.png`;
  }

  /**
   * Keeps the tooltip on screen, preferring below-right of the cursor exactly
   * like the in-game one, and flipping when it would overflow.
   */
  function tooltipPosition(mouseX, mouseY, tipWidth, tipHeight, viewportWidth, viewportHeight, offset) {
    const gap = offset === undefined ? 12 : offset;
    let x = mouseX + gap;
    let y = mouseY + gap;
    if (x + tipWidth > viewportWidth) x = Math.max(0, mouseX - gap - tipWidth);
    if (y + tipHeight > viewportHeight) y = Math.max(0, viewportHeight - tipHeight - 4);
    return { x, y };
  }

  /**
   * Maps a mouse event onto the click the bot server expects:
   * left/right button, and shift for a quick-move.
   */
  function clickArgsFor(event) {
    return {
      button: event && event.button === 2 ? 1 : 0,
      mode: event && event.shiftKey ? 1 : 0
    };
  }

  /**
   * A keystroke only opens the pane when the user is not typing into the page
   * - the bot controller has a chat box, and stealing its "e" would be rude.
   */
  function isTypingTarget(element) {
    if (!element) return false;
    const tag = (element.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
  }

  const helpers = {
    layoutFor,
    rarityColor,
    textureUrl,
    tooltipPosition,
    clickArgsFor,
    isTypingTarget,
    chunk,
    range,
    TIER_COLORS,
    PLAYER_LAYOUT,
    SLOT_PX
  };

  // Node (tests) gets the pure helpers; a browser gets the whole pane.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
  }
  if (typeof document === 'undefined') return;

  const CSS = `
  .wynn-inv-root { position: fixed; inset: 0; z-index: 9000; display: none; }
  .wynn-inv-root.open { display: block; }
  .wynn-inv-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.55); }
  .wynn-inv-panel {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    background: #c6c6c6; border: 4px solid; border-color: #ffffff #555555 #555555 #ffffff;
    padding: 10px 12px 14px 12px; max-height: 90vh; overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: #3f3f3f; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  }
  .wynn-inv-title { font-size: 0.85rem; font-weight: 700; margin-bottom: 8px; display: flex; gap: 10px; align-items: center; }
  .wynn-inv-title .wynn-inv-meta { font-weight: 400; color: #5a5a5a; font-size: 0.75rem; }
  .wynn-inv-title button {
    margin-left: auto; background: #8b8b8b; border: 2px solid; border-color: #ffffff #555 #555 #ffffff;
    color: #1c1c1c; font: inherit; font-size: 0.72rem; padding: 2px 8px; cursor: pointer;
  }
  .wynn-inv-section { margin-bottom: 10px; }
  .wynn-inv-label { font-size: 0.7rem; color: #4a4a4a; margin-bottom: 4px; }
  .wynn-inv-row { display: flex; gap: 2px; margin-bottom: 2px; }
  .wynn-inv-slot {
    width: ${SLOT_PX}px; height: ${SLOT_PX}px; background: #8b8b8b;
    border: 2px solid; border-color: #373737 #ffffff #ffffff #373737;
    position: relative; padding: 0; cursor: pointer; image-rendering: pixelated;
  }
  .wynn-inv-slot:hover::after {
    content: ''; position: absolute; inset: 0; background: rgba(255,255,255,0.45);
  }
  .wynn-inv-slot img { width: 100%; height: 100%; image-rendering: pixelated; display: block; }
  .wynn-inv-slot .wynn-inv-fallback {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 0.62rem; color: #2b2b2b; text-align: center; line-height: 1.05; padding: 1px; overflow: hidden;
  }
  .wynn-inv-slot .wynn-inv-count {
    position: absolute; right: 1px; bottom: 0; font-size: 0.72rem; color: #fff;
    text-shadow: 1px 1px 0 #3f3f3f; pointer-events: none;
  }
  .wynn-inv-tooltip {
    position: fixed; z-index: 9100; pointer-events: none; display: none;
    background: rgba(16, 0, 16, 0.94); border: 2px solid #28007f;
    outline: 1px solid #5000ff; padding: 6px 8px; max-width: 320px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.76rem; line-height: 1.35; text-shadow: 1px 1px 0 #1c1c1c;
  }
  .wynn-inv-tooltip .wynn-inv-tip-name { font-weight: 700; }
  .wynn-inv-tooltip .wynn-inv-tip-lore { color: ${LORE_COLOR}; }
  .wynn-inv-tooltip .wynn-inv-tip-meta { color: #7a7a7a; margin-top: 4px; font-size: 0.7rem; }
  .wynn-inv-toggle {
    position: fixed; right: 16px; bottom: 16px; z-index: 8900;
    background: #2e6b3e; color: #fff; border: none; border-radius: 8px;
    padding: 8px 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  }
  .wynn-inv-empty { font-size: 0.8rem; color: #4a4a4a; }
  `;

  const state = {
    root: null,
    panel: null,
    tooltip: null,
    toggleButton: null,
    windowData: null,
    viewerBase: null,
    version: global.WYNN_TEXTURE_VERSION || '1.21.4',
    pollTimer: null,
    events: null,
    open: false,
    hoverSlot: null
  };

  function element(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function slotAt(index) {
    const slots = (state.windowData && state.windowData.slots) || [];
    return slots[index] || { slot: index, empty: true, name: 'empty', count: 0, lore: [] };
  }

  function renderTooltip(slot, event) {
    if (!slot || slot.empty) {
      state.tooltip.style.display = 'none';
      return;
    }
    const name = slot.customName || slot.name.replace(/_/g, ' ');
    const lore = slot.lore || [];
    state.tooltip.innerHTML = '';
    const nameNode = element('div', 'wynn-inv-tip-name', state.tooltip);
    nameNode.textContent = name;
    nameNode.style.color = rarityColor(slot);
    for (const line of lore) {
      const loreNode = element('div', 'wynn-inv-tip-lore', state.tooltip);
      loreNode.textContent = line;
    }
    const meta = element('div', 'wynn-inv-tip-meta', state.tooltip);
    const tags = (slot.typeTags || []).join(', ');
    meta.textContent = [slot.itemType || 'item', tags, slot.tier, slot.name, `slot ${slot.slot}`, slot.count > 1 ? `x${slot.count}` : '']
      .filter(Boolean).join(' · ');

    state.tooltip.style.display = 'block';
    const rect = state.tooltip.getBoundingClientRect();
    const position = tooltipPosition(event.clientX, event.clientY, rect.width, rect.height,
      window.innerWidth, window.innerHeight);
    state.tooltip.style.left = `${position.x}px`;
    state.tooltip.style.top = `${position.y}px`;
  }

  function renderSlot(index, parent) {
    const slot = slotAt(index);
    const button = element('button', 'wynn-inv-slot', parent);
    button.type = 'button';
    button.dataset.slot = String(index);

    if (!slot.empty) {
      const url = textureUrl(state.viewerBase, state.version, slot.name);
      if (url) {
        const image = element('img', null, button);
        image.src = url;
        image.alt = slot.name;
        image.addEventListener('error', () => {
          image.remove();
          const fallback = element('div', 'wynn-inv-fallback', button);
          fallback.textContent = (slot.customName || slot.name).slice(0, 10);
        });
      } else {
        const fallback = element('div', 'wynn-inv-fallback', button);
        fallback.textContent = (slot.customName || slot.name).slice(0, 10);
      }
      if (slot.count > 1) {
        const count = element('span', 'wynn-inv-count', button);
        count.textContent = String(slot.count);
      }
    }

    button.addEventListener('mousemove', (event) => renderTooltip(slot, event));
    button.addEventListener('mouseleave', () => { state.tooltip.style.display = 'none'; });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      clickSlot(index, event);
    });
    button.addEventListener('click', (event) => clickSlot(index, event));
    return button;
  }

  function render() {
    const layout = layoutFor(state.windowData);
    state.panel.innerHTML = '';

    const header = element('div', 'wynn-inv-title', state.panel);
    header.appendChild(document.createTextNode(layout.title));
    const meta = element('span', 'wynn-inv-meta', header);
    const slots = (state.windowData && state.windowData.slots) || [];
    meta.textContent = state.windowData && state.windowData.open
      ? `container #${state.windowData.id} · ${slots.length} slots`
      : 'press E or Esc to close';
    const refresh = element('button', null, header);
    refresh.type = 'button';
    refresh.textContent = 'Refresh';
    refresh.addEventListener('click', load);

    if (!slots.length) {
      const empty = element('div', 'wynn-inv-empty', state.panel);
      empty.textContent = 'The bot is not connected, so it has no inventory to show.';
      return;
    }

    for (const section of layout.sections) {
      const sectionNode = element('div', 'wynn-inv-section', state.panel);
      if (section.label) {
        const label = element('div', 'wynn-inv-label', sectionNode);
        label.textContent = section.label;
      }
      for (const row of section.rows) {
        const rowNode = element('div', 'wynn-inv-row', sectionNode);
        for (const index of row) renderSlot(index, rowNode);
      }
    }
  }

  async function clickSlot(index, event) {
    const args = clickArgsFor(event);
    try {
      await fetch('/api/bot/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot: index, button: args.button, mode: args.mode })
      });
    } catch (error) {
      // The bot server may be down; the next refresh will show the truth.
    }
    // Wynncraft menus repaint a moment after a click lands.
    setTimeout(load, 350);
  }

  async function load() {
    try {
      const response = await fetch('/api/bot/window');
      state.windowData = await response.json();
    } catch (error) {
      state.windowData = null;
    }
    if (state.open) render();
  }

  async function resolveViewerBase() {
    if (state.viewerBase !== null) return;
    try {
      const response = await fetch('/api/bot/status');
      const status = await response.json();
      state.viewerBase = status.viewerUrl || `${location.protocol}//${location.hostname}:3000`;
    } catch (error) {
      state.viewerBase = `${location.protocol}//${location.hostname}:3000`;
    }
  }

  function startWatching() {
    stopWatching();
    state.pollTimer = setInterval(load, POLL_INTERVAL_MS);
    try {
      state.events = new EventSource('/api/bot/events');
      // Chests and menus open and close constantly while the bot plays, so
      // react to those events rather than polling fast.
      state.events.addEventListener('window', load);
      state.events.addEventListener('window_close', load);
    } catch (error) {
      state.events = null;
    }
  }

  function stopWatching() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (state.events) {
      state.events.close();
      state.events = null;
    }
  }

  function open() {
    if (state.open) return;
    state.open = true;
    state.root.classList.add('open');
    resolveViewerBase().then(load);
    startWatching();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    state.root.classList.remove('open');
    state.tooltip.style.display = 'none';
    stopWatching();
  }

  function toggle() {
    if (state.open) close(); else open();
  }

  function install(options) {
    if (state.root) return global.WynnInventoryPane;
    const settings = options || {};
    if (settings.version) state.version = settings.version;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    state.root = element('div', 'wynn-inv-root');
    document.body.appendChild(state.root);
    const backdrop = element('div', 'wynn-inv-backdrop', state.root);
    backdrop.addEventListener('click', close);
    state.panel = element('div', 'wynn-inv-panel', state.root);
    state.tooltip = element('div', 'wynn-inv-tooltip');
    document.body.appendChild(state.tooltip);

    if (settings.button !== false) {
      state.toggleButton = element('button', 'wynn-inv-toggle');
      state.toggleButton.type = 'button';
      state.toggleButton.textContent = 'Inventory (E)';
      state.toggleButton.addEventListener('click', toggle);
      document.body.appendChild(state.toggleButton);
    }

    document.addEventListener('keydown', (event) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === 'Escape' && state.open) {
        close();
      } else if ((event.key === 'e' || event.key === 'E') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        toggle();
      }
    });

    return global.WynnInventoryPane;
  }

  global.WynnInventoryPane = Object.assign({}, helpers, {
    install, open, close, toggle, refresh: load,
    isOpen: () => state.open
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => install());
  } else {
    install();
  }
})(typeof window !== 'undefined' ? window : globalThis);
