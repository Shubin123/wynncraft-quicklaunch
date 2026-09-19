/**
 * Draggable, persistent panel layout for the dashboard.
 *
 * The panels used to live in four fixed rows of two, so a wide monitor showed
 * the same two-across layout as a laptop and the order was whatever the HTML
 * said. This flattens them into one auto-fit grid: the browser fits as many
 * columns as the viewport allows - three, four, five on a wide screen - and
 * each panel can be dragged to a new position and made wider or narrower.
 *
 * The arrangement (order, per-panel width, column density) is remembered per
 * page in localStorage, and the default is exactly the order the HTML is
 * written in, so a fresh browser sees the layout the page was designed with.
 *
 * Node gets the pure layout maths for testing; a browser gets the whole thing.
 */
(function (global) {
  'use strict';

  const STORAGE_PREFIX = 'wynn:layout:';
  const MIN_PANEL_PX = 380;   // narrowest a panel may be before columns drop
  const MAX_SPAN = 4;

  /**
   * How many columns an auto-fit grid will actually produce.
   *
   * Mirrors what `repeat(auto-fit, minmax(min, 1fr))` does, so the code can
   * clamp panel spans to something that exists rather than guessing.
   */
  function columnCount(containerWidth, minPanelPx = MIN_PANEL_PX, gap = 16) {
    if (!containerWidth || containerWidth <= 0) return 1;
    const columns = Math.floor((containerWidth + gap) / (minPanelPx + gap));
    return Math.max(1, columns);
  }

  /**
   * A panel can never span more columns than exist, and never less than one.
   */
  function clampSpan(span, columns) {
    const wanted = Math.max(1, Math.min(MAX_SPAN, Math.round(Number(span) || 1)));
    return Math.max(1, Math.min(wanted, Math.max(1, columns)));
  }

  /**
   * Merges a saved arrangement over the page's own defaults.
   *
   * Panels the save does not mention keep their default position - so adding a
   * new panel to the page does not require anyone to reset their layout - and
   * ids that no longer exist are dropped.
   */
  function mergeOrder(defaultIds, savedIds) {
    const known = new Set(defaultIds);
    const ordered = (savedIds || []).filter(id => known.has(id));
    const placed = new Set(ordered);
    for (let index = 0; index < defaultIds.length; index++) {
      const id = defaultIds[index];
      if (placed.has(id)) continue;
      // Put an unseen panel back where the page wanted it.
      const insertAt = Math.min(index, ordered.length);
      ordered.splice(insertAt, 0, id);
      placed.add(id);
    }
    return ordered;
  }

  /**
   * The order after a drop: the dragged panel lands before the panel under the
   * cursor when the cursor is in its left half, after it otherwise.
   */
  function reorder(order, draggedId, targetId, before) {
    const without = order.filter(id => id !== draggedId);
    const targetAt = without.indexOf(targetId);
    if (targetAt === -1) return order.slice();
    const at = before ? targetAt : targetAt + 1;
    without.splice(at, 0, draggedId);
    return without;
  }

  const helpers = { columnCount, clampSpan, mergeOrder, reorder, MIN_PANEL_PX, MAX_SPAN, STORAGE_PREFIX };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
  }
  if (typeof document === 'undefined') return;

  const CSS = `
  .wynn-grid {
    display: grid;
    gap: 16px;
    align-items: start;
    grid-template-columns: repeat(auto-fit, minmax(var(--wynn-panel-min, ${MIN_PANEL_PX}px), 1fr));
    /* Dense: a narrow panel backfills the gap a wide one leaves, so a wide
       screen really does line up as many panels as it has room for. */
    grid-auto-flow: row dense;
  }
  .wynn-grid > .panel-wrap {
    min-width: 0;
    grid-column: span var(--wynn-span, 1);
  }
  .wynn-grid > .panel-wrap.wynn-dragging { opacity: 0.4; }
  .wynn-grid > .panel-wrap.wynn-drop-before { box-shadow: -4px 0 0 0 var(--accent, #22c55e); }
  .wynn-grid > .panel-wrap.wynn-drop-after { box-shadow: 4px 0 0 0 var(--accent, #22c55e); }
  .wynn-drag-handle {
    cursor: grab; user-select: none; color: var(--muted, #94a3b8);
    font-size: 0.95rem; padding: 0 8px 0 2px; line-height: 1;
    touch-action: none; /* the handle owns the gesture, so touch can drag too */
  }
  .wynn-drag-handle:active { cursor: grabbing; }
  .wynn-panel-tools {
    display: inline-flex; gap: 2px; align-items: center; margin-left: 6px;
  }
  .wynn-panel-tools button {
    background: transparent; border: 1px solid var(--border, rgba(255,255,255,0.09));
    color: var(--muted, #94a3b8); border-radius: 4px; cursor: pointer;
    font-size: 0.7rem; line-height: 1; padding: 2px 5px; margin: 0;
  }
  .wynn-panel-tools button:hover:not(:disabled) { color: var(--text, #f1f5f9); border-color: var(--accent, #22c55e); }
  .wynn-panel-tools button:disabled { opacity: 0.3; cursor: default; }
  /* While a panel is moving, nothing else should be selecting text. */
  body.wynn-dragging-active { user-select: none; }
  .wynn-layout-bar {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    font-size: 0.78rem; color: var(--muted, #94a3b8); margin-bottom: 12px;
  }
  .wynn-layout-bar button, .wynn-layout-bar input[type="range"] { margin: 0; }
  .wynn-layout-bar button {
    background: transparent; border: 1px solid var(--border, rgba(255,255,255,0.09));
    color: var(--muted, #94a3b8); border-radius: 6px; padding: 3px 10px;
    font-size: 0.75rem; cursor: pointer;
  }
  .wynn-layout-bar button:hover { color: var(--text, #f1f5f9); border-color: var(--accent, #22c55e); }
  `;

  function install(options = {}) {
    const container = document.querySelector(options.container || '.node-grid');
    if (!container || container.dataset.wynnLayout === 'on') return null;

    const pageKey = STORAGE_PREFIX + (options.key || location.pathname.split('/').pop() || 'page');
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Flatten whatever row structure the page used into one grid, keeping the
    // panels in the order the HTML wrote them: that is the default layout.
    const panels = Array.from(container.querySelectorAll('.panel-wrap'));
    for (const row of Array.from(container.querySelectorAll('.grid-row'))) row.remove();
    for (const resizer of Array.from(container.querySelectorAll('.col-resizer'))) resizer.remove();
    container.classList.add('wynn-grid');
    container.dataset.wynnLayout = 'on';

    let index = 0;
    for (const panel of panels) {
      if (!panel.id) {
        const card = panel.querySelector('.node-card');
        panel.id = card && card.id ? `pw-${card.id}` : `pw-panel-${index}`;
      }
      index++;
      container.appendChild(panel);
    }

    const defaultIds = panels.map(panel => panel.id);
    const defaultSpans = {};
    for (const panel of panels) {
      defaultSpans[panel.id] = Number(panel.dataset.span) || 1;
    }

    const state = {
      order: defaultIds.slice(),
      spans: { ...defaultSpans },
      minPanel: MIN_PANEL_PX
    };

    function load() {
      try {
        const saved = JSON.parse(localStorage.getItem(pageKey));
        if (!saved) return;
        state.order = mergeOrder(defaultIds, saved.order);
        state.spans = { ...defaultSpans, ...(saved.spans || {}) };
        state.minPanel = Number(saved.minPanel) || MIN_PANEL_PX;
      } catch (err) {
        // A corrupt or unavailable store just means the default layout.
      }
    }

    function save() {
      try {
        localStorage.setItem(pageKey, JSON.stringify({
          order: state.order, spans: state.spans, minPanel: state.minPanel
        }));
      } catch (err) {
        // Layout is a convenience; losing it must never break the page.
      }
    }

    function apply() {
      container.style.setProperty('--wynn-panel-min', `${state.minPanel}px`);
      const columns = columnCount(container.clientWidth, state.minPanel);
      state.order.forEach((id, position) => {
        const panel = document.getElementById(id);
        if (!panel) return;
        // CSS order, not appendChild: moving the node would re-parent the
        // viewer's iframe, which reloads it and loses its chunks.
        panel.style.order = String(position);
        const span = clampSpan(state.spans[id] || 1, columns);
        panel.style.setProperty('--wynn-span', String(span));
        const tools = panel.querySelector('.wynn-panel-tools');
        if (tools) {
          tools.querySelector('[data-act="narrow"]').disabled = span <= 1;
          tools.querySelector('[data-act="wide"]').disabled = span >= Math.min(MAX_SPAN, columns);
        }
      });
      if (columnsLabel) columnsLabel.textContent = `${columns} column${columns === 1 ? '' : 's'}`;
    }

    function setSpan(id, delta) {
      const columns = columnCount(container.clientWidth, state.minPanel);
      state.spans[id] = clampSpan((state.spans[id] || 1) + delta, columns);
      apply();
      save();
    }

    let dragged = null;
    // Set by whichever panel is currently being dragged.
    let abortDrag = null;

    function clearDropMarks() {
      for (const panel of container.querySelectorAll('.panel-wrap')) {
        panel.classList.remove('wynn-drop-before', 'wynn-drop-after');
      }
    }

    /**
     * The panel under the pointer, and which side of it we are on.
     *
     * elementFromPoint is a plain hit test, so it works over the 3D viewport's
     * iframe too - it returns the iframe, whose closest panel is the one we
     * want. Native HTML5 drag events would have gone into the iframe's own
     * document instead and never reached us.
     */
    function panelUnder(x, y) {
      const element = document.elementFromPoint(x, y);
      const panel = element && element.closest ? element.closest('.panel-wrap') : null;
      if (!panel || panel === dragged || !container.contains(panel)) return null;
      const rect = panel.getBoundingClientRect();
      return { panel, before: x < rect.left + rect.width / 2 };
    }

    function wirePanel(panel) {
      const header = panel.querySelector('.node-header') || panel.querySelector('h2') || panel.firstElementChild;
      if (!header) return;

      const handle = document.createElement('span');
      handle.className = 'wynn-drag-handle';
      handle.textContent = '⠿';
      handle.title = 'Drag to move this panel';
      const title = header.querySelector('.node-title') || header.firstElementChild || header;
      title.insertBefore(handle, title.firstChild);

      const tools = document.createElement('span');
      tools.className = 'wynn-panel-tools';
      tools.innerHTML =
        '<button type="button" data-act="narrow" title="Narrower">&minus;</button>' +
        '<button type="button" data-act="wide" title="Wider">&plus;</button>';
      tools.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        setSpan(panel.id, button.dataset.act === 'wide' ? 1 : -1);
      });
      header.appendChild(tools);

      // Pointer events rather than HTML5 drag-and-drop: they work the same way
      // for mouse, pen and touch, they survive the pointer crossing an iframe,
      // and nothing depends on dataTransfer or a browser's drag heuristics.
      let start = null;
      let target = null;

      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        start = { x: event.clientX, y: event.clientY, id: event.pointerId };
        event.preventDefault();
        try { handle.setPointerCapture(event.pointerId); } catch (err) { /* older browsers */ }
      });

      handle.addEventListener('pointermove', (event) => {
        if (!start) return;
        if (!dragged) {
          // A few pixels of movement before this becomes a drag, so a stray
          // click on the handle does not rearrange the page.
          if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) < 4) return;
          dragged = panel;
          panel.classList.add('wynn-dragging');
          document.body.classList.add('wynn-dragging-active');
        }
        const over = panelUnder(event.clientX, event.clientY);
        clearDropMarks();
        target = over;
        if (over) over.panel.classList.add(over.before ? 'wynn-drop-before' : 'wynn-drop-after');
      });

      function finish(commit) {
        if (start) {
          try { handle.releasePointerCapture(start.id); } catch (err) { /* already released */ }
        }
        if (dragged && commit && target) {
          state.order = reorder(state.order, dragged.id, target.panel.id, target.before);
          apply();
          save();
        }
        if (dragged) {
          dragged.classList.remove('wynn-dragging');
          document.body.classList.remove('wynn-dragging-active');
        }
        clearDropMarks();
        dragged = null;
        target = null;
        start = null;
      }

      handle.addEventListener('pointerup', () => finish(true));
      handle.addEventListener('pointercancel', () => finish(false));
      handle.addEventListener('lostpointercapture', () => { if (dragged) finish(true); });
      // Escape is handled once for the page, below, rather than per panel.
      abortDrag = () => finish(false);
    }

    // Controls: how dense the columns are, and a way back to the default.
    const bar = document.createElement('div');
    bar.className = 'wynn-layout-bar';
    bar.innerHTML =
      '<span>Layout</span>' +
      '<input type="range" id="wynn-density" min="300" max="700" step="20" title="Panel width before a column is dropped" />' +
      '<span id="wynn-columns"></span>' +
      '<button type="button" id="wynn-layout-reset">Reset layout</button>' +
      '<span style="opacity:0.7">drag ⠿ to rearrange</span>';
    container.parentNode.insertBefore(bar, container);
    const columnsLabel = bar.querySelector('#wynn-columns');
    const density = bar.querySelector('#wynn-density');

    for (const panel of panels) wirePanel(panel);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && dragged && abortDrag) abortDrag();
    });

    load();
    density.value = String(state.minPanel);
    density.addEventListener('input', () => {
      state.minPanel = Number(density.value);
      apply();
    });
    density.addEventListener('change', save);

    bar.querySelector('#wynn-layout-reset').addEventListener('click', () => {
      state.order = defaultIds.slice();
      state.spans = { ...defaultSpans };
      state.minPanel = MIN_PANEL_PX;
      density.value = String(state.minPanel);
      try { localStorage.removeItem(pageKey); } catch (err) { /* nothing to clear */ }
      apply();
    });

    global.addEventListener('resize', apply);
    apply();

    return {
      apply,
      reset: () => bar.querySelector('#wynn-layout-reset').click(),
      state: () => JSON.parse(JSON.stringify(state))
    };
  }

  global.WynnLayout = Object.assign({}, helpers, { install });

  function autoInstall() {
    global.wynnLayout = install();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInstall);
  } else {
    autoInstall();
  }
})(typeof window !== 'undefined' ? window : globalThis);
