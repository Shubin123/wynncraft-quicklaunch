/**
 * Tests the draggable panel layout: the grid maths, and the DOM behaviour
 * driven against a stub window.
 *
 * The property worth guarding hardest is that reordering never moves a panel
 * in the DOM - the 3D viewport is an iframe, and re-parenting an iframe
 * reloads it, which would drop its socket and every chunk it had meshed. The
 * order is expressed with CSS `order` instead, and a test here holds that.
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
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 });
  node.querySelector = (selector) => query(node, selector);
  node.querySelectorAll = (selector) => queryAll(node, selector);
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
  const document = {
    readyState: 'complete', head, body,
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

  return { sandbox, body, container, panels, storage, document };
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

test('Reordering never moves a panel in the DOM', () => {
  const { sandbox, container } = boot();
  const domBefore = container.children.map(c => c.id);

  const dragged = sandbox.document.getElementById('pw-diagnostics-card');
  const target = sandbox.document.getElementById('pw-telemetry');
  dragged.querySelector('.wynn-drag-handle').dispatch('dragstart', {
    dataTransfer: { setData() {}, setDragImage() {} }
  });
  target.dispatch('drop', { clientX: 5, dataTransfer: {} });

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
  const dragged = first.sandbox.document.getElementById('pw-nav');
  dragged.querySelector('.wynn-drag-handle').dispatch('dragstart', {
    dataTransfer: { setData() {}, setDragImage() {} }
  });
  first.sandbox.document.getElementById('pw-telemetry').dispatch('drop', { clientX: 5, dataTransfer: {} });
  const savedOrder = JSON.parse(JSON.stringify(first.sandbox.wynnLayout.state().order));
  assert.strictEqual(savedOrder[0], 'pw-nav');
  assert.ok(storage['wynn:layout:bot.html'], 'it is written under a per-page key');

  const second = boot({ storage });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(second.sandbox.wynnLayout.state().order)),
    savedOrder, 'and comes back on reload');
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
  const { sandbox, document } = boot({ storage });
  const dragged = document.getElementById('pw-nav');
  dragged.querySelector('.wynn-drag-handle').dispatch('dragstart', { dataTransfer: { setData() {}, setDragImage() {} } });
  document.getElementById('pw-telemetry').dispatch('drop', { clientX: 5, dataTransfer: {} });
  assert.strictEqual(sandbox.wynnLayout.state().order[0], 'pw-nav');

  document.getElementById('wynn-layout-reset').dispatch('click');
  assert.strictEqual(sandbox.wynnLayout.state().order[0], 'pw-telemetry');
  assert.ok(!storage['wynn:layout:bot.html'], 'the saved layout is cleared too');
});

test('A corrupt or unavailable store falls back to the default layout', () => {
  const { sandbox } = boot({ storage: { 'wynn:layout:bot.html': '{ not json' } });
  assert.strictEqual(sandbox.wynnLayout.state().order[0], 'pw-telemetry');
});

test('bot.html is wired to the layout module', () => {
  const html = fs.readFileSync(path.join(DASHBOARD, 'bot.html'), 'utf8');
  assert.ok(html.includes('<script src="wynn-layout.js"></script>'), 'the module is loaded');
  assert.ok(!html.includes('class="col-resizer"'), 'the old two-column resizers are gone');
  assert.strictEqual((html.match(/data-span=/g) || []).length, 7, 'every panel declares a default width');
  assert.ok(html.includes('window.resetPanelLayout'), 'the existing reset entry point still exists');
  assert.ok(html.includes('max-width: none'), 'the page no longer caps its width short of the screen');

  // The panels themselves must still be there.
  for (const id of ['pw-telemetry', 'pw-viewer', 'pw-chat', 'pw-ai', 'pw-container', 'pw-nav']) {
    assert.ok(html.includes(`id="${id}"`), `bot.html lost ${id}`);
  }
});

console.log(`\n\x1b[1;32mPanel layout tests: ${passed} passed.\x1b[0m`);
