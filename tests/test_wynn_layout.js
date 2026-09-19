/**
 * Tests the draggable panel layout: the grid maths, and the DOM behaviour
 * driven against a stub window.
 *
 * Two properties are worth guarding hardest:
 *
 *  - Reordering never moves a panel in the DOM. The 3D viewport is an iframe,
 *    and re-parenting an iframe reloads it, dropping its socket and every
 *    chunk it had meshed. The order is expressed with CSS `order` instead.
 *  - Dragging runs on pointer events, not HTML5 drag-and-drop. The first
 *    implementation used the latter and did not work in a real browser, and
 *    the test that "verified" it dispatched DragEvents straight at elements,
 *    which skips the hit-testing that was actually broken. These tests drive
 *    the same sequence a pointer does, through elementFromPoint.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const layout = require('../dashboard/wynn-layout.js');
const DASHBOARD = path.resolve(__dirname, '../dashboard');

console.log('Running panel layout tests...');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

test('Dragging an edge snaps the width to whole columns', () => {
  // A 1920 container in 4 columns: each column is 484px including the gap.
  // Each column is (1920 + 16) / 4 = 484 wide, so the snap to two columns
  // happens as the pointer crosses 710 - half a column past the first.
  assert.strictEqual(layout.spanFromPointer(400, 0, 1920, 4), 1, 'inside the first column');
  assert.strictEqual(layout.spanFromPointer(700, 0, 1920, 4), 1, 'just short of the midpoint');
  assert.strictEqual(layout.spanFromPointer(760, 0, 1920, 4), 2, 'just past it');
  assert.strictEqual(layout.spanFromPointer(1450, 0, 1920, 4), 3);
  assert.strictEqual(layout.spanFromPointer(1900, 0, 1920, 4), 4);
  assert.strictEqual(layout.spanFromPointer(5000, 0, 1920, 4), 4, 'never wider than the grid');
  assert.strictEqual(layout.spanFromPointer(-200, 0, 1920, 4), 1, 'nor narrower than one column');

  // A panel that does not start at the left edge measures from its own left.
  assert.strictEqual(layout.spanFromPointer(1400, 968, 1920, 4), 1);
});

test('Dragging the bottom edge sets a height, with a floor', () => {
  assert.strictEqual(layout.heightFromPointer(600, 100), 500);
  assert.strictEqual(layout.heightFromPointer(150, 100), layout.MIN_PANEL_HEIGHT,
    'a panel cannot be dragged away to nothing');
  assert.strictEqual(layout.heightFromPointer(0, 100), layout.MIN_PANEL_HEIGHT);
});

test('The column count follows the viewport, well past two', () => {
  assert.strictEqual(layout.columnCount(700), 1, 'a narrow window is one column');
  assert.strictEqual(layout.columnCount(1280), 3);
  assert.strictEqual(layout.columnCount(1920), 4);
  assert.strictEqual(layout.columnCount(2560), 6, 'an ultrawide screen fills with panels');
  assert.strictEqual(layout.columnCount(3840), 9);
  assert.strictEqual(layout.columnCount(0), 1, 'a container with no width still has one column');

  // Denser panels mean more of them side by side.
  assert.ok(layout.columnCount(1920, 300) > layout.columnCount(1920, 500));
  assert.strictEqual(layout.columnCount(1920, 300), 6);
});

test('Spans are clamped to columns that actually exist', () => {
  assert.strictEqual(layout.clampSpan(3, 4), 3);
  assert.strictEqual(layout.clampSpan(3, 2), 2, 'a 3-wide panel on a 2-column screen is 2 wide');
  assert.strictEqual(layout.clampSpan(9, 8), layout.MAX_SPAN, 'and never wider than the cap');
  assert.strictEqual(layout.clampSpan(0, 4), 1);
  assert.strictEqual(layout.clampSpan(undefined, 4), 1);
  assert.strictEqual(layout.clampSpan(2, 0), 1);
});

test('A saved arrangement survives panels being added or removed', () => {
  const defaults = ['a', 'b', 'c'];
  assert.deepStrictEqual(layout.mergeOrder(defaults, ['c', 'b', 'a']), ['c', 'b', 'a']);
  assert.deepStrictEqual(layout.mergeOrder(defaults, ['c', 'a', 'gone']), ['c', 'b', 'a'],
    'an id that no longer exists is dropped, and the unseen panel returns near its default place');
  assert.deepStrictEqual(layout.mergeOrder(defaults, []), defaults, 'no save means the default order');
  assert.deepStrictEqual(layout.mergeOrder(defaults, null), defaults);

  // A panel added to the page later must appear without anyone resetting.
  const withNew = ['a', 'b', 'c', 'd'];
  const merged = layout.mergeOrder(withNew, ['c', 'a', 'b']);
  assert.strictEqual(merged.length, 4);
  assert.ok(merged.includes('d'), 'a new panel is not lost');
});

test('Dropping puts the panel on the side of the target you aimed at', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepStrictEqual(layout.reorder(order, 'd', 'b', true), ['a', 'd', 'b', 'c']);
  assert.deepStrictEqual(layout.reorder(order, 'd', 'b', false), ['a', 'b', 'd', 'c']);
  assert.deepStrictEqual(layout.reorder(order, 'a', 'd', false), ['b', 'c', 'd', 'a'], 'moving to the end');
  assert.deepStrictEqual(layout.reorder(order, 'c', 'a', true), ['c', 'a', 'b', 'd'], 'moving to the front');
  assert.deepStrictEqual(layout.reorder(order, 'a', 'zzz', true), order, 'an unknown target changes nothing');
});

/* ------------------------------------------------------------------ *
 * DOM behaviour, against a stub window
 * ------------------------------------------------------------------ */

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], parentNode: null,
    style: {}, dataset: {}, className: '', id: '', textContent: '', disabled: false,
    draggable: false, title: '', type: '', events: {}, clientWidth: 1920
  };
  node.style.setProperty = (name, value) => { node.style[name] = value; };
  node.style.getPropertyValue = (name) => node.style[name] || '';
  node.classList = {
    add: (...names) => { for (const n of names) if (!node.className.split(' ').includes(n)) node.className = `${node.className} ${n}`.trim(); },
    remove: (...names) => { node.className = node.className.split(' ').filter(c => c && !names.includes(c)).join(' '); },
    contains: (name) => node.className.split(' ').includes(name)
  };
  node.appendChild = (child) => { child.parentNode = node; node.children.push(child); return child; };
  node.insertBefore = (child, ref) => {
    child.parentNode = node;
    const at = ref ? node.children.indexOf(ref) : -1;
    if (at === -1) node.children.push(child); else node.children.splice(at, 0, child);
    return child;
  };
  node.remove = () => {
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(c => c !== node);
    node.parentNode = null;
  };
  node.addEventListener = (type, handler) => { (node.events[type] = node.events[type] || []).push(handler); };
  node.dispatch = (type, event = {}) => (node.events[type] || []).forEach(h => h({ preventDefault() {}, ...event }));
  node.rect = { left: 0, top: 0, width: 400, height: 200 };
  node.getBoundingClientRect = () => ({ ...node.rect, right: node.rect.left + node.rect.width,
    bottom: node.rect.top + node.rect.height });
  node.querySelector = (selector) => query(node, selector);
  node.querySelectorAll = (selector) => queryAll(node, selector);
  node.closest = (selector) => {
    let current = node;
    while (current) {
      if (matches(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  };
  node.contains = (other) => walk(node).includes(other);
  node.setPointerCapture = () => {};
  node.releasePointerCapture = () => {};
  Object.defineProperty(node, 'innerHTML', {
    get: () => '',
    set: (html) => {
      // Only the layout bar and the width buttons use innerHTML; parse just enough.
      node.children = [];
      for (const match of String(html).matchAll(/<(button|span|input)[^>]*>/g)) {
        const child = makeNode(match[1]);
        const id = /id="([^"]+)"/.exec(match[0]);
        const act = /data-act="([^"]+)"/.exec(match[0]);
        if (id) child.id = id[1];
        if (act) child.dataset.act = act[1];
        node.appendChild(child);
      }
    }
  });
  return node;
}

function walk(node, out = []) {
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}

/** A tiny selector matcher: tag, .class, #id and [data-x="y"]. */
function matches(node, selector) {
  return selector.split(',').map(s => s.trim()).some(part => {
    if (part.startsWith('.')) return node.classList.contains(part.slice(1));
    if (part.startsWith('#')) return node.id === part.slice(1);
    const attr = /^\[data-([a-z]+)="([^"]+)"\]$/.exec(part);
    if (attr) return node.dataset[attr[1]] === attr[2];
    return node.tagName === part.toUpperCase();
  });
}

function query(root, selector) {
  return walk(root).slice(1).find(n => matches(n, selector)) || null;
}
function queryAll(root, selector) {
  return walk(root).slice(1).filter(n => matches(n, selector));
}

/**
 * Builds a page shaped like bot.html: rows of panels, each with a header.
 */
function boot({ storage = {}, containerWidth = 1920 } = {}) {
  const body = makeNode('body');
  const head = makeNode('head');
  const container = makeNode('div');
  container.className = 'node-grid';
  container.clientWidth = containerWidth;

  const panels = [];
  const spec = [
    ['pw-telemetry', 1], ['pw-viewer', 2], ['pw-chat', 2],
    ['pw-ai', 1], ['pw-container', 2], ['pw-nav', 1], [null, 3]
  ];
  let row = null;
  spec.forEach(([id, span], index) => {
    if (index % 2 === 0) {
      row = makeNode('div');
      row.className = 'grid-row';
      container.appendChild(row);
    }
    const panel = makeNode('div');
    panel.className = 'panel-wrap';
    if (id) panel.id = id;
    panel.dataset.span = String(span);
    const card = makeNode('div');
    card.className = 'node-card';
    if (!id) card.id = 'diagnostics-card';
    const header = makeNode('div');
    header.className = 'node-header';
    const title = makeNode('div');
    title.className = 'node-title';
    header.appendChild(title);
    card.appendChild(header);
    panel.appendChild(card);
    row.appendChild(panel);
    panels.push(panel);
  });
  body.appendChild(container);

  const elements = () => walk(body);
  // The module hit-tests with elementFromPoint; the test says what is there.
  let pointerTarget = null;
  const document = {
    readyState: 'complete', head, body,
    elementFromPoint: () => pointerTarget,
    createElement: makeNode,
    querySelector: (sel) => (matches(container, sel) ? container : query(body, sel)),
    querySelectorAll: (sel) => queryAll(body, sel),
    getElementById: (id) => elements().find(n => n.id === id) || null,
    addEventListener() {}
  };

  const sandbox = {
    document, console,
    location: { pathname: '/bot.html' },
    localStorage: {
      getItem: (key) => (key in storage ? storage[key] : null),
      setItem: (key, value) => { storage[key] = String(value); },
      removeItem: (key) => { delete storage[key]; }
    },
    addEventListener() {},
    setTimeout: (fn) => { fn(); return 1; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(DASHBOARD, 'wynn-layout.js'), 'utf8'), sandbox,
    { filename: 'wynn-layout.js' });

  /** Drags one panel's handle onto another, the way a pointer does. */
  function drag(fromId, toId, { before = true, commit = true } = {}) {
    const from = document.getElementById(fromId);
    const to = document.getElementById(toId);
    const handle = from.querySelector('.wynn-drag-handle');
    pointerTarget = to.querySelector('.node-header') || to;
    handle.dispatch('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse', pointerId: 1 });
    // The first move is below the threshold: a click must not rearrange.
    handle.dispatch('pointermove', { clientX: 101, clientY: 100, pointerId: 1 });
    handle.dispatch('pointermove', { clientX: before ? 150 : 350, clientY: 140, pointerId: 1 });
    if (commit) handle.dispatch('pointerup', { pointerId: 1 });
    else handle.dispatch('pointercancel', { pointerId: 1 });
    return handle;
  }

  return { sandbox, body, container, panels, storage, document, drag, setPointerTarget: (n) => { pointerTarget = n; } };
}

test('Installing flattens the rows into one grid and names every panel', () => {
  const { container, sandbox } = boot();
  assert.ok(container.classList.contains('wynn-grid'));
  assert.strictEqual(container.querySelectorAll('.grid-row').length, 0, 'the fixed rows are gone');
  const panels = container.children.filter(c => c.classList.contains('panel-wrap'));
  assert.strictEqual(panels.length, 7, 'every panel is a direct child of the grid');
  assert.strictEqual(panels[6].id, 'pw-diagnostics-card', 'a panel with no id gets one from its card');
  assert.ok(sandbox.wynnLayout, 'the handle is published for the page to drive');
});

test('The default order is the order the page was written in', () => {
  const { sandbox } = boot();
  // Values cross a VM realm boundary, so compare contents, not prototypes.
  const order = (handle) => JSON.parse(JSON.stringify(handle.state().order));
  assert.deepStrictEqual(order(sandbox.wynnLayout).slice(0, 3),
    ['pw-telemetry', 'pw-viewer', 'pw-chat']);
  assert.strictEqual(sandbox.wynnLayout.state().spans['pw-viewer'], 2, 'default spans come from the markup');
});

test('A pointer drag rearranges the panels', () => {
  const { sandbox, drag } = boot();
  drag('pw-diagnostics-card', 'pw-telemetry', { before: true });
  const order = JSON.parse(JSON.stringify(sandbox.wynnLayout.state().order));
  assert.strictEqual(order[0], 'pw-diagnostics-card', 'it lands before the panel it was dropped on');
  assert.strictEqual(order[1], 'pw-telemetry');
});

test('Dropping on the right half lands after the target', () => {
  const { sandbox, drag } = boot();
  drag('pw-telemetry', 'pw-viewer', { before: false });
  const order = JSON.parse(JSON.stringify(sandbox.wynnLayout.state().order));
  assert.deepStrictEqual(order.slice(0, 2), ['pw-viewer', 'pw-telemetry']);
});

test('A cancelled drag changes nothing', () => {
  const { sandbox, drag } = boot();
  const before = JSON.parse(JSON.stringify(sandbox.wynnLayout.state().order));
  drag('pw-nav', 'pw-telemetry', { commit: false });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.wynnLayout.state().order)), before);
});

test('A click on the handle without movement is not a drag', () => {
  const { sandbox, document } = boot();
  const before = JSON.parse(JSON.stringify(sandbox.wynnLayout.state().order));
  const handle = document.getElementById('pw-nav').querySelector('.wynn-drag-handle');
  handle.dispatch('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse', pointerId: 1 });
  handle.dispatch('pointermove', { clientX: 101, clientY: 101, pointerId: 1 });
  handle.dispatch('pointerup', { pointerId: 1 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.wynnLayout.state().order)), before);
});

test('Reordering never moves a panel in the DOM', () => {
  const { sandbox, container, drag } = boot();
  const domBefore = container.children.map(c => c.id);

  drag('pw-diagnostics-card', 'pw-telemetry', { before: true });

  assert.strictEqual(sandbox.wynnLayout.state().order[0], 'pw-diagnostics-card', 'the order changed');
  assert.deepStrictEqual(container.children.map(c => c.id), domBefore,
    're-parenting would reload the viewport iframe, so the DOM must not change');
  assert.strictEqual(sandbox.document.getElementById('pw-diagnostics-card').style.order, '0',
    'position is expressed with CSS order instead');
  assert.strictEqual(sandbox.document.getElementById('pw-telemetry').style.order, '1');
});

test('The arrangement is saved and restored', () => {
  const storage = {};
  const first = boot({ storage });
  first.drag('pw-nav', 'pw-telemetry', { before: true });
  const savedOrder = JSON.parse(JSON.stringify(first.sandbox.wynnLayout.state().order));
  assert.strictEqual(savedOrder[0], 'pw-nav');
  assert.ok(storage['wynn:layout:bot.html'], 'it is written under a per-page key');

  const second = boot({ storage });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(second.sandbox.wynnLayout.state().order)),
    savedOrder, 'and comes back on reload');
});

test('Every panel has grabbable edges', () => {
  const { document } = boot();
  const panel = document.getElementById('pw-ai');
  for (const axis of ['x', 'y', 'xy']) {
    assert.ok(panel.querySelector(`.wynn-resize-${axis}`), `the ${axis} edge is missing`);
  }
});

test('Dragging the right edge resizes the panel and remembers it', () => {
  const storage = {};
  const { sandbox, document, container } = boot({ storage, containerWidth: 1920 });
  const panel = document.getElementById('pw-telemetry');
  panel.rect = { left: 0, top: 0, width: 452, height: 400 };
  const handle = panel.querySelector('.wynn-resize-x');

  assert.strictEqual(panel.style['--wynn-span'], '1');
  handle.dispatch('pointerdown', { clientX: 452, clientY: 200, button: 0, pointerType: 'mouse', pointerId: 2,
    stopPropagation() {} });
  handle.dispatch('pointermove', { clientX: 1450, clientY: 200, pointerId: 2 });
  assert.strictEqual(panel.style['--wynn-span'], '3', 'the width follows the pointer as it drags');
  handle.dispatch('pointerup', { pointerId: 2 });

  assert.strictEqual(sandbox.wynnLayout.state().spans['pw-telemetry'], 3);
  assert.ok(JSON.parse(storage['wynn:layout:bot.html']).spans['pw-telemetry'] === 3,
    'and is written down on release');
});

test('Dragging the bottom edge resizes the height and remembers it', () => {
  const storage = {};
  const { sandbox, document } = boot({ storage });
  const panel = document.getElementById('pw-ai');
  panel.rect = { left: 0, top: 100, width: 452, height: 300 };
  const handle = panel.querySelector('.wynn-resize-y');

  handle.dispatch('pointerdown', { clientX: 200, clientY: 400, button: 0, pointerType: 'mouse', pointerId: 3,
    stopPropagation() {} });
  handle.dispatch('pointermove', { clientX: 200, clientY: 700, pointerId: 3 });
  assert.strictEqual(panel.style.height, '600px', 'the height tracks the pointer');
  assert.strictEqual(panel.dataset.sized, '1', 'and the card is told to fill it');
  handle.dispatch('pointerup', { pointerId: 3 });

  assert.strictEqual(sandbox.wynnLayout.state().heights['pw-ai'], 600);
  assert.strictEqual(JSON.parse(storage['wynn:layout:bot.html']).heights['pw-ai'], 600);
});

test('A height can be given back to the content, and reset clears it', () => {
  const { sandbox, document } = boot();
  const panel = document.getElementById('pw-ai');
  panel.rect = { left: 0, top: 100, width: 452, height: 300 };
  const handle = panel.querySelector('.wynn-resize-y');
  handle.dispatch('pointerdown', { clientX: 200, clientY: 400, button: 0, pointerType: 'mouse', pointerId: 4,
    stopPropagation() {} });
  handle.dispatch('pointermove', { clientX: 200, clientY: 800, pointerId: 4 });
  handle.dispatch('pointerup', { pointerId: 4 });
  assert.ok(sandbox.wynnLayout.state().heights['pw-ai']);

  handle.dispatch('dblclick', {});
  assert.strictEqual(sandbox.wynnLayout.state().heights['pw-ai'], undefined, 'double click frees the height');
  assert.strictEqual(panel.style.height, '');
  assert.strictEqual(panel.dataset.sized, undefined);
});

test('Resizing an edge does not also drag the panel away', () => {
  const { sandbox, document } = boot();
  const before = JSON.parse(JSON.stringify(sandbox.wynnLayout.state().order));
  const panel = document.getElementById('pw-ai');
  const handle = panel.querySelector('.wynn-resize-x');
  let stopped = false;
  handle.dispatch('pointerdown', { clientX: 400, clientY: 200, button: 0, pointerType: 'mouse', pointerId: 5,
    stopPropagation() { stopped = true; } });
  handle.dispatch('pointermove', { clientX: 900, clientY: 260, pointerId: 5 });
  handle.dispatch('pointerup', { pointerId: 5 });

  assert.ok(stopped, 'the resize must not bubble up as the start of a move');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.wynnLayout.state().order)), before);
});

test('Panels can be widened and narrowed, within the columns available', () => {
  const { sandbox } = boot({ containerWidth: 1920 }); // 4 columns
  const panel = sandbox.document.getElementById('pw-ai');
  const tools = panel.querySelector('.wynn-panel-tools');

  assert.strictEqual(panel.style['--wynn-span'], '1');
  tools.dispatch('click', { target: { closest: () => tools.children.find(c => c.dataset.act === 'wide') } });
  assert.strictEqual(panel.style['--wynn-span'], '2');
  assert.strictEqual(sandbox.wynnLayout.state().spans['pw-ai'], 2);

  const narrow = tools.children.find(c => c.dataset.act === 'narrow');
  tools.dispatch('click', { target: { closest: () => narrow } });
  assert.strictEqual(panel.style['--wynn-span'], '1');
  tools.dispatch('click', { target: { closest: () => narrow } });
  assert.strictEqual(panel.style['--wynn-span'], '1', 'a panel never narrows below one column');
});

test('On a narrow screen a wide panel is clamped to what fits', () => {
  const { sandbox } = boot({ containerWidth: 700 }); // one column
  assert.strictEqual(sandbox.document.getElementById('pw-viewer').style['--wynn-span'], '1',
    'a 2-wide panel cannot span 2 of 1 column');
  assert.strictEqual(sandbox.wynnLayout.state().spans['pw-viewer'], 2,
    'but its preference is remembered for when there is room again');
});

test('Reset returns the page to its designed layout', () => {
  const storage = {};
  const { sandbox, document, drag } = boot({ storage });
  drag('pw-nav', 'pw-telemetry', { before: true });
  assert.strictEqual(sandbox.wynnLayout.state().order[0], 'pw-nav');

  document.getElementById('wynn-layout-reset').dispatch('click');
  assert.strictEqual(sandbox.wynnLayout.state().order[0], 'pw-telemetry');
  assert.ok(!storage['wynn:layout:bot.html'], 'the saved layout is cleared too');
});

test('A corrupt or unavailable store falls back to the default layout', () => {
  const { sandbox } = boot({ storage: { 'wynn:layout:bot.html': '{ not json' } });
  assert.strictEqual(sandbox.wynnLayout.state().order[0], 'pw-telemetry');
});

test('Escape is handled once for the page, not once per panel', () => {
  const module = fs.readFileSync(path.join(DASHBOARD, 'wynn-layout.js'), 'utf8');
  const listeners = (module.match(/document\.addEventListener\('keydown'/g) || []).length;
  assert.strictEqual(listeners, 1,
    'a per-panel keydown listener runs N times for every keystroke on the page');
  const wireBody = module.slice(module.indexOf('function wirePanel'), module.indexOf('// Controls: how dense'));
  assert.ok(!wireBody.includes("document.addEventListener('keydown'"),
    'the page-level handler must live outside wirePanel');
});

test('bot.html is wired to the layout module', () => {
  const html = fs.readFileSync(path.join(DASHBOARD, 'bot.html'), 'utf8');
  assert.ok(html.includes('<script src="wynn-layout.js"></script>'), 'the module is loaded');
  assert.ok(!html.includes('class="col-resizer"'), 'the old two-column resizers are gone');
  assert.strictEqual((html.match(/data-span=/g) || []).length, 7, 'every panel declares a default width');
  assert.ok(html.includes('window.resetPanelLayout'), 'the existing reset entry point still exists');
  assert.ok(html.includes('max-width: none'), 'the page no longer caps its width short of the screen');

  // Native drag-and-drop did not work in a real browser; pointer events do.
  const module = fs.readFileSync(path.join(DASHBOARD, 'wynn-layout.js'), 'utf8');
  assert.ok(module.includes('pointerdown') && module.includes('setPointerCapture'),
    'dragging must run on pointer events');
  assert.ok(!/\bdraggable\s*=/.test(module) && !module.includes('dataTransfer.setData'),
    'no HTML5 drag-and-drop should remain');

  // The panels themselves must still be there.
  for (const id of ['pw-telemetry', 'pw-viewer', 'pw-chat', 'pw-ai', 'pw-container', 'pw-nav']) {
    assert.ok(html.includes(`id="${id}"`), `bot.html lost ${id}`);
  }
});

console.log(`\n\x1b[1;32mPanel layout tests: ${passed} passed.\x1b[0m`);
