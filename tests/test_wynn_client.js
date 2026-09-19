/**
 * Tests the shared dashboard data layer: the selection that travels between
 * pages, the links that carry it, and the formatters every page now shares.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const client = require('../dashboard/wynn-client.js');
const DASHBOARD = path.resolve(__dirname, '../dashboard');

console.log('Running shared dashboard client tests...');

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

test('Emerald formatting round-trips and matches the bot module', () => {
  const amount = 262144 + 32 * 4096 + 16 * 64 + 8;
  assert.strictEqual(client.formatEmeralds(amount), '1stx 32le 16eb 8e');
  assert.strictEqual(client.parseEmeralds(client.formatEmeralds(987654)), 987654);
  assert.strictEqual(client.formatEmeralds(0), '0e');
  assert.strictEqual(client.formatEmeralds(-4096), '-1le', 'a negative delta still reads correctly');
  assert.strictEqual(client.parseEmeralds('nothing here'), null);

  // The dashboard and the bot must agree on what a price means.
  const market = require('../mineflayer-wynn/src/market.js');
  for (const value of [0, 1, 63, 64, 4095, 4096, 987654, 262144 * 3 + 5]) {
    assert.strictEqual(client.formatEmeralds(value), market.formatEmeralds(value),
      `dashboard and bot disagree on ${value}`);
  }
});

test('A selection is read from the query string in each page\'s dialect', () => {
  assert.deepStrictEqual(client.readSelection('?item=Spring'),
    { item: 'Spring', items: ['Spring'], search: null });
  assert.deepStrictEqual(client.readSelection('?items=Spring,Wybel%20Paw'),
    { item: 'Spring', items: ['Spring', 'Wybel Paw'], search: null });
  assert.deepStrictEqual(client.readSelection('?search=Spring'),
    { item: 'Spring', items: ['Spring'], search: 'Spring' });
  assert.deepStrictEqual(client.readSelection('?items=a,b&item=b'),
    { item: 'b', items: ['a', 'b'], search: null }, 'an explicit focus wins inside a basket');
  assert.strictEqual(client.readSelection(''), null);
  assert.strictEqual(client.readSelection('?capital=1000'), null, 'unrelated params are not a selection');
  assert.strictEqual(client.readSelection('?items=%20,%20'), null, 'a list of blanks is no selection');
});

test('Links hand each page the form of the selection it acts on', () => {
  const basket = { item: 'Spring', items: ['Spring', 'Wybel Paw'] };
  assert.strictEqual(client.linkTo('price', 'Spring'), 'index.html?item=Spring');
  assert.strictEqual(client.linkTo('trend', 'Spring'), 'predict.html?item=Spring');
  assert.strictEqual(client.linkTo('market', basket), 'market.html?search=Spring',
    'the market page searches for the focused item, not the basket');
  assert.ok(client.linkTo('liquidity', basket).startsWith('liquidity.html?items='),
    'basket pages get the whole list');
  assert.ok(client.linkTo('optimize', basket).includes('Wybel'));
  assert.strictEqual(client.linkTo('price', null), 'index.html', 'no selection, no query string');

  // Round-trip: every link a page emits must be readable by the page it targets.
  for (const page of ['price', 'trend', 'market', 'liquidity', 'optimize']) {
    const href = client.linkTo(page, basket);
    const parsed = client.readSelection(href.slice(href.indexOf('?')));
    assert.strictEqual(parsed.item, 'Spring', `${page} link lost the focused item`);
  }
});

test('Selections are normalised from whatever a page hands over', () => {
  assert.deepStrictEqual(client.toSelection('  Spring  '),
    { item: 'Spring', items: ['Spring'], search: null });
  assert.deepStrictEqual(client.toSelection({ items: ['a', ' ', 'b'] }),
    { item: 'a', items: ['a', 'b'], search: null }, 'blank entries are dropped');
  assert.strictEqual(client.toSelection(''), null);
  assert.strictEqual(client.toSelection({ items: [] }), null);
  assert.strictEqual(client.toSelection(null), null);
});

test('Cross-links skip the current page and escape the item name', () => {
  const links = client.crossLinks('Spring', { exclude: ['price'] });
  assert.ok(!links.includes('index.html'), 'the page you are on should not link to itself');
  assert.ok(links.includes('predict.html?item=Spring'));
  assert.ok(links.includes('market.html?search=Spring'));
  assert.ok(links.includes('liquidity.html?items=Spring'));

  const nasty = client.crossLinks('<img src=x onerror=alert(1)>', {});
  assert.ok(!nasty.includes('<img'), 'item names must be escaped into the title attribute');
  assert.strictEqual(client.crossLinks('', {}), '');
});

test('Percentages render consistently', () => {
  assert.strictEqual(client.percent(0.1234), '12.3%');
  assert.strictEqual(client.percent(-0.05, 0), '-5%');
  assert.strictEqual(client.percent(null), '');
});

test('Every dashboard page loads the shared client', () => {
  for (const page of ['index.html', 'predict.html', 'optimize.html', 'liquidity.html', 'market.html']) {
    const html = fs.readFileSync(path.join(DASHBOARD, page), 'utf8');
    assert.ok(html.includes('<script src="wynn-client.js"></script>'), `${page} does not load the client`);
    assert.ok(html.indexOf('wynn-client.js') < html.lastIndexOf('<script>'),
      `${page} must load the client before its own script`);
  }
});

test('Pages accept an incoming selection and pass one on', () => {
  const expectations = {
    'index.html': ['WynnClient.getSelection()', 'WynnClient.setSelection'],
    'predict.html': ['WynnClient.getSelection()', 'WynnClient.setSelection'],
    'optimize.html': ['WynnClient.getSelection()', 'WynnClient.setSelection'],
    'liquidity.html': ['WynnClient.getSelection()', 'WynnClient.setSelection'],
    'market.html': ['WynnClient.getSelection()', 'WynnClient.setSelection']
  };
  for (const [page, markers] of Object.entries(expectations)) {
    const html = fs.readFileSync(path.join(DASHBOARD, page), 'utf8');
    for (const marker of markers) {
      assert.ok(html.includes(marker), `${page} is missing ${marker}`);
    }
  }
});

test('The duplicated formatters are gone from the pages', () => {
  for (const page of ['market.html', 'liquidity.html']) {
    const html = fs.readFileSync(path.join(DASHBOARD, page), 'utf8');
    assert.ok(!/function formatEmeralds\s*\(/.test(html),
      `${page} still defines its own formatEmeralds instead of using the shared one`);
    assert.ok(!/function escapeHtml\s*\(/.test(html),
      `${page} still defines its own escapeHtml`);
    assert.ok(html.includes('WynnClient'), `${page} should take them from the client`);
  }
});

test('The browser half of the client runs and keeps the selection', () => {
  // A minimal window: enough for the client to read a URL, remember a
  // selection, and hand it to a listener.
  const store = {};
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    document: { readyState: 'complete', addEventListener() {} },
    location: { search: '?item=Spring', pathname: '/index.html' },
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; }
    },
    history: { replaceState(state, title, href) { sandbox.location.href = href; } },
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async () => ({ json: async () => ({ ok: true }) }),
    EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(DASHBOARD, 'wynn-client.js'), 'utf8'), sandbox,
    { filename: 'wynn-client.js' });

  const api = sandbox.WynnClient;
  assert.strictEqual(api.getSelection().item, 'Spring', 'the URL selection is picked up');

  let notified = null;
  api.onSelection((selection) => { notified = selection; });
  api.setSelection('Wybel Paw');
  assert.strictEqual(notified.item, 'Wybel Paw', 'listeners are told when it changes');
  assert.strictEqual(sandbox.location.href, 'index.html?item=Wybel+Paw', 'the address bar follows');
  assert.ok(store['wynn:selection'].includes('Wybel Paw'), 'and it is remembered for the next page');

  // With no URL selection, the remembered one is used.
  sandbox.location.search = '';
  assert.strictEqual(api.getSelection().item, 'Wybel Paw');
});

test('Storage being unavailable does not break the client', () => {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    document: { readyState: 'complete', addEventListener() {} },
    location: { search: '', pathname: '/market.html' },
    localStorage: {
      getItem() { throw new Error('storage disabled'); },
      setItem() { throw new Error('storage disabled'); },
      removeItem() { throw new Error('storage disabled'); }
    },
    history: { replaceState() {} },
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async () => ({ json: async () => ({}) }),
    EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(DASHBOARD, 'wynn-client.js'), 'utf8'), sandbox,
    { filename: 'wynn-client.js' });

  assert.strictEqual(sandbox.WynnClient.getSelection(), null, 'a private window just has no selection');
  assert.doesNotThrow(() => sandbox.WynnClient.setSelection('Spring'));
});

console.log(`\n\x1b[1;32mShared dashboard client tests: ${passed} passed.\x1b[0m`);
