/**
 * Renders the inventory pane against a hand-written DOM stub.
 *
 * The project has no browser or DOM library in its dependencies, and adding
 * one just for this would be a heavy price for a single component, so the test
 * implements the handful of DOM calls the pane actually makes and runs the
 * real file inside a VM context. That exercises the rendering, tooltip and
 * click paths, not only the pure helpers.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../dashboard/inventory-pane.js'), 'utf8');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.stack.split('\n').slice(0, 3).join('\n  ')}`);
    process.exitCode = 1;
  }
}

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    className: '',
    type: '',
    src: '',
    alt: '',
    events: {},
    _text: ''
  };
  node.classList = {
    add: (name) => { if (!node.className.split(' ').includes(name)) node.className = `${node.className} ${name}`.trim(); },
    remove: (name) => { node.className = node.className.split(' ').filter(c => c && c !== name).join(' '); },
    contains: (name) => node.className.split(' ').includes(name)
  };
  node.appendChild = (child) => { child.parentNode = node; node.children.push(child); return child; };
  node.remove = () => {
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(c => c !== node);
  };
  node.addEventListener = (type, handler) => { (node.events[type] = node.events[type] || []).push(handler); };
  node.dispatch = (type, event) => { (node.events[type] || []).forEach(handler => handler(event)); };
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 220, height: 140 });
  Object.defineProperty(node, 'textContent', {
    get: () => node._text || node.children.map(c => c.textContent).join(''),
    set: (value) => { node._text = String(value); node.children = []; }
  });
  Object.defineProperty(node, 'innerHTML', {
    get: () => '',
    set: () => { node.children = []; node._text = ''; }
  });
  return node;
}

function walk(node, out = []) {
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}

const byClass = (root, className) => walk(root).filter(n => n.classList.contains(className));

/**
 * Boots the pane in a VM context with a stub DOM and a stub bot server.
 */
function boot(windowPayload, statusPayload = { viewerUrl: 'http://localhost:3000' }) {
  const body = makeNode('body');
  const head = makeNode('head');
  const requests = [];

  const document = {
    readyState: 'complete',
    head,
    body,
    createElement: makeNode,
    createTextNode: (text) => {
      const node = makeNode('#text');
      node.textContent = text;
      return node;
    },
    events: {},
    addEventListener: (type, handler) => {
      (document.events[type] = document.events[type] || []).push(handler);
    },
    dispatch: (type, event) => (document.events[type] || []).forEach(handler => handler(event))
  };

  const sandbox = {
    document,
    location: { protocol: 'http:', hostname: 'localhost' },
    innerWidth: 1280,
    innerHeight: 800,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 1; },
    console,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        json: async () => (String(url).includes('/api/bot/status') ? statusPayload : windowPayload)
      };
    },
    EventSource: function EventSource() {
      this.addEventListener = () => {};
      this.close = () => {};
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(SOURCE, sandbox, { filename: 'inventory-pane.js' });
  return { sandbox, document, body, head, requests, pane: sandbox.WynnInventoryPane };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function chestPayload() {
  const items = {
    10: { name: 'bow', customName: 'Spring', count: 1, lore: ['Legendary Item', 'Water Damage: 60-90'] },
    11: { name: 'diamond_chestplate', customName: 'Boreal-Patterned Aegis', count: 1, lore: ['Mythic Item', 'Health: +3000'] },
    12: { name: 'emerald', customName: 'Emerald', count: 64, lore: ['Currency'] }
  };
  return {
    open: true,
    id: 3,
    title: 'Chest',
    totalSlots: 63,
    slots: Array.from({ length: 63 }, (_, slot) => (
      items[slot]
        ? { slot, empty: false, ...items[slot] }
        : { slot, empty: true, name: 'empty', count: 0, lore: [] }
    ))
  };
}

(async () => {
  console.log('Running inventory pane render tests...');

  await test('Installing the pane adds its own DOM and leaves the page alone', () => {
    const { body, head, pane } = boot(chestPayload());
    assert.ok(pane, 'the pane must publish its API on window');
    assert.strictEqual(head.children.length, 1, 'exactly one style element');
    const roots = byClass(body, 'wynn-inv-root');
    assert.strictEqual(roots.length, 1, 'one overlay root');
    assert.ok(!roots[0].classList.contains('open'), 'the pane starts closed');
    assert.strictEqual(byClass(body, 'wynn-inv-toggle').length, 1, 'one toggle button');
    assert.strictEqual(byClass(body, 'wynn-inv-slot').length, 0, 'nothing is rendered until it opens');
  });

  await test('Opening renders every chest slot plus the player inventory', async () => {
    const { body, pane } = boot(chestPayload());
    pane.open();
    await flush();
    await flush();

    assert.ok(byClass(body, 'wynn-inv-root')[0].classList.contains('open'));
    const slots = byClass(body, 'wynn-inv-slot');
    assert.strictEqual(slots.length, 63, `expected 27 chest + 36 player slots, got ${slots.length}`);
    assert.deepStrictEqual(slots.map(s => s.dataset.slot).slice(0, 3), ['0', '1', '2']);
    assert.strictEqual(slots[62].dataset.slot, '62');

    const rows = byClass(body, 'wynn-inv-row');
    assert.strictEqual(rows.length, 3 + 3 + 1, 'chest rows + inventory rows + hotbar');
  });

  await test('Filled slots show their texture and stack size', async () => {
    const { body, pane } = boot(chestPayload());
    pane.open();
    await flush();
    await flush();

    const slots = byClass(body, 'wynn-inv-slot');
    const spring = slots[10];
    const images = walk(spring).filter(n => n.tagName === 'IMG');
    assert.strictEqual(images.length, 1, 'an item slot renders its texture');
    assert.strictEqual(images[0].src, 'http://localhost:3000/textures/1.21.4/items/bow.png');

    const emerald = slots[12];
    const counts = byClass(emerald, 'wynn-inv-count');
    assert.strictEqual(counts.length, 1);
    assert.strictEqual(counts[0].textContent, '64');

    assert.strictEqual(byClass(slots[0], 'wynn-inv-count').length, 0, 'empty slots show no count');
    assert.strictEqual(walk(slots[0]).filter(n => n.tagName === 'IMG').length, 0);
  });

  await test('A missing texture falls back to the item name', async () => {
    const { body, pane } = boot(chestPayload());
    pane.open();
    await flush();
    await flush();

    const spring = byClass(body, 'wynn-inv-slot')[10];
    const image = walk(spring).find(n => n.tagName === 'IMG');
    image.dispatch('error', {});
    assert.strictEqual(walk(spring).filter(n => n.tagName === 'IMG').length, 0, 'the broken image is removed');
    const fallback = byClass(spring, 'wynn-inv-fallback');
    assert.strictEqual(fallback.length, 1);
    assert.ok(fallback[0].textContent.startsWith('Spring'));
  });

  await test('Hovering shows the in-game tooltip, coloured by tier', async () => {
    const { body, pane, sandbox } = boot(chestPayload());
    pane.open();
    await flush();
    await flush();

    const tooltip = walk(sandbox.document.body).find(n => n.classList.contains('wynn-inv-tooltip'));
    assert.ok(tooltip, 'the tooltip lives outside the overlay so it can overlap it');

    const aegis = byClass(body, 'wynn-inv-slot')[11];
    aegis.dispatch('mousemove', { clientX: 200, clientY: 200 });
    assert.strictEqual(tooltip.style.display, 'block');

    const name = byClass(tooltip, 'wynn-inv-tip-name')[0];
    assert.strictEqual(name.textContent, 'Boreal-Patterned Aegis');
    assert.strictEqual(name.style.color, pane.TIER_COLORS.mythic, 'a mythic name is mythic-coloured');

    const lore = byClass(tooltip, 'wynn-inv-tip-lore').map(n => n.textContent);
    assert.deepStrictEqual(lore, ['Mythic Item', 'Health: +3000']);
    const meta = byClass(tooltip, 'wynn-inv-tip-meta')[0];
    assert.ok(meta.textContent.includes('slot 11'), meta.textContent);
    assert.strictEqual(tooltip.style.left, '212px', 'the tooltip sits below-right of the cursor');

    aegis.dispatch('mouseleave', {});
    assert.strictEqual(tooltip.style.display, 'none');

    // Empty slots have nothing to describe.
    byClass(body, 'wynn-inv-slot')[0].dispatch('mousemove', { clientX: 10, clientY: 10 });
    assert.strictEqual(tooltip.style.display, 'none');
  });

  await test('Clicking a slot posts the matching click to the bot server', async () => {
    const { body, pane, requests } = boot(chestPayload());
    pane.open();
    await flush();
    await flush();
    requests.length = 0;

    byClass(body, 'wynn-inv-slot')[10].dispatch('click', { button: 0, shiftKey: false });
    await flush();
    const left = requests.find(r => r.url === '/api/bot/click');
    assert.ok(left, 'a click must reach /api/bot/click');
    assert.deepStrictEqual(JSON.parse(left.options.body), { slot: 10, button: 0, mode: 0 });

    requests.length = 0;
    let prevented = false;
    byClass(body, 'wynn-inv-slot')[11].dispatch('contextmenu', {
      button: 2, shiftKey: true, preventDefault: () => { prevented = true; }
    });
    await flush();
    assert.ok(prevented, 'the browser context menu must be suppressed');
    const right = requests.find(r => r.url === '/api/bot/click');
    assert.deepStrictEqual(JSON.parse(right.options.body), { slot: 11, button: 1, mode: 1 });
  });

  await test('The E key toggles the pane but never while typing', async () => {
    const { body, document, pane } = boot(chestPayload());
    const root = byClass(body, 'wynn-inv-root')[0];

    document.dispatch('keydown', { key: 'e', target: { tagName: 'INPUT' }, preventDefault() {} });
    assert.ok(!root.classList.contains('open'), 'typing "e" in a text field must not open the pane');

    document.dispatch('keydown', { key: 'e', target: { tagName: 'BODY' }, preventDefault() {} });
    await flush();
    assert.ok(root.classList.contains('open'), 'E opens the pane');
    assert.strictEqual(pane.isOpen(), true);

    document.dispatch('keydown', { key: 'Escape', target: { tagName: 'BODY' }, preventDefault() {} });
    assert.ok(!root.classList.contains('open'), 'Escape closes it');

    document.dispatch('keydown', { key: 'e', target: { tagName: 'BODY' }, ctrlKey: true, preventDefault() {} });
    assert.ok(!root.classList.contains('open'), 'Ctrl+E is a browser shortcut, not ours');
  });

  await test('With no container open the pane shows the player inventory', async () => {
    const payload = {
      open: false,
      id: 0,
      title: 'Player Inventory (E)',
      totalSlots: 46,
      slots: Array.from({ length: 46 }, (_, slot) => ({ slot, empty: true, name: 'empty', count: 0, lore: [] }))
    };
    const { body, pane } = boot(payload);
    pane.open();
    await flush();
    await flush();

    const slots = byClass(body, 'wynn-inv-slot');
    // 5 equipment + 5 crafting + 27 main + 9 hotbar
    assert.strictEqual(slots.length, 46, `expected the full E layout, got ${slots.length}`);
    const labels = byClass(body, 'wynn-inv-label').map(n => n.textContent);
    assert.deepStrictEqual(labels, ['Equipment', 'Crafting', 'Inventory']);
  });

  await test('An offline bot renders an explanation instead of an empty grid', async () => {
    const { body, pane } = boot({ open: false, id: 0, title: 'Bot Offline', totalSlots: 0, slots: [] });
    pane.open();
    await flush();
    await flush();

    assert.strictEqual(byClass(body, 'wynn-inv-slot').length, 0);
    const empty = byClass(body, 'wynn-inv-empty');
    assert.strictEqual(empty.length, 1);
    assert.ok(/not connected/.test(empty[0].textContent), empty[0].textContent);
  });

  await test('Closing stops the pane watching the bot server', async () => {
    const { pane, requests } = boot(chestPayload());
    pane.open();
    await flush();
    await flush();
    assert.ok(requests.some(r => r.url === '/api/bot/window'));

    pane.close();
    requests.length = 0;
    await flush();
    assert.strictEqual(requests.length, 0, 'a closed pane must not keep polling');
    assert.strictEqual(pane.isOpen(), false);
  });

  console.log(`\n\x1b[1;32mInventory pane render tests: ${passed} passed.\x1b[0m`);
})();
