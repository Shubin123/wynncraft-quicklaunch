const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pane = require('../dashboard/inventory-pane.js');

console.log('Running inventory pane tests...');

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

/**
 * Builds a /api/bot/window payload of the shape the bot server returns.
 */
function windowPayload(open, totalSlots, title) {
  return {
    open,
    id: open ? 3 : 0,
    title,
    totalSlots,
    slots: Array.from({ length: totalSlots }, (_, slot) => ({
      slot, empty: true, name: 'empty', count: 0, customName: '', lore: []
    }))
  };
}

test('A closed window renders the vanilla E layout', () => {
  const layout = pane.layoutFor(windowPayload(false, 46, 'Player Inventory (E)'));
  assert.strictEqual(layout.kind, 'player');
  const keys = layout.sections.map(s => s.key);
  assert.deepStrictEqual(keys, ['equipment', 'crafting', 'main', 'hotbar']);

  const main = layout.sections.find(s => s.key === 'main');
  assert.strictEqual(main.rows.length, 3, 'the main inventory is three rows of nine');
  assert.deepStrictEqual(main.rows[0], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepStrictEqual(main.rows[2][8], 35);

  const hotbar = layout.sections.find(s => s.key === 'hotbar');
  assert.deepStrictEqual(hotbar.rows[0], [36, 37, 38, 39, 40, 41, 42, 43, 44]);

  const equipment = layout.sections.find(s => s.key === 'equipment');
  assert.deepStrictEqual(equipment.rows[0], [5, 6, 7, 8, 45], 'armour then offhand');
});

test('A single chest splits into 27 container slots plus the player inventory', () => {
  // A 27-slot chest sends 27 + 27 main + 9 hotbar = 63 slots.
  const layout = pane.layoutFor(windowPayload(true, 63, 'Chest'));
  assert.strictEqual(layout.kind, 'container');
  assert.strictEqual(layout.title, 'Chest');

  const container = layout.sections.find(s => s.key === 'container');
  assert.strictEqual(container.rows.length, 3, 'a single chest is three rows');
  assert.deepStrictEqual(container.rows[0], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.strictEqual(container.rows[2][8], 26);

  const main = layout.sections.find(s => s.key === 'main');
  assert.strictEqual(main.rows[0][0], 27, 'the player inventory starts after the container');
  const hotbar = layout.sections.find(s => s.key === 'hotbar');
  assert.deepStrictEqual(hotbar.rows[0], [54, 55, 56, 57, 58, 59, 60, 61, 62]);
});

test('A double chest and a 54-slot Wynncraft menu both lay out fully', () => {
  const double = pane.layoutFor(windowPayload(true, 54 + 36, 'Large Chest'));
  const container = double.sections.find(s => s.key === 'container');
  assert.strictEqual(container.rows.length, 6, 'a double chest is six rows');
  assert.strictEqual(container.rows[5][8], 53);

  // The Trade Market and character menus are 54-slot containers too.
  const market = pane.layoutFor(windowPayload(true, 90, 'Trade Market'));
  assert.strictEqual(market.title, 'Trade Market');
  assert.strictEqual(market.sections.find(s => s.key === 'container').rows.length, 6);
});

test('Every container slot is rendered exactly once', () => {
  for (const containerSize of [9, 27, 45, 54]) {
    const layout = pane.layoutFor(windowPayload(true, containerSize + 36, 'Chest'));
    const rendered = layout.sections.flatMap(s => s.rows.flat());
    assert.strictEqual(new Set(rendered).size, rendered.length, `duplicate slot at size ${containerSize}`);
    assert.strictEqual(rendered.length, containerSize + 36, `missing slots at size ${containerSize}`);
    assert.strictEqual(Math.max(...rendered), containerSize + 35);
  }
});

test('An offline bot yields a layout instead of throwing', () => {
  const layout = pane.layoutFor(null);
  assert.strictEqual(layout.kind, 'player');
  assert.ok(layout.sections.length > 0);
  assert.strictEqual(pane.layoutFor({ open: false, slots: [] }).kind, 'player');
});

test('Item names take their tier colour, as in game', () => {
  assert.strictEqual(pane.rarityColor({ customName: 'Boreal-Patterned Aegis', lore: ['Mythic Item'] }),
    pane.TIER_COLORS.mythic);
  assert.strictEqual(pane.rarityColor({ customName: 'Spring', lore: ['Legendary Item'] }),
    pane.TIER_COLORS.legendary);
  assert.strictEqual(pane.rarityColor({ customName: 'Wybel Paw', lore: ['Unique Item'] }),
    pane.TIER_COLORS.unique);
  assert.strictEqual(pane.rarityColor({ customName: 'Bread', lore: [] }), pane.TIER_COLORS.normal);
  assert.strictEqual(pane.rarityColor({ empty: true }), pane.TIER_COLORS.normal);
  // "rarely" must not read as the Rare tier.
  assert.strictEqual(pane.rarityColor({ customName: 'Rarely Used Key', lore: [] }), pane.TIER_COLORS.normal);
});

test('Item textures resolve to the patched prismarine-viewer assets', () => {
  assert.strictEqual(
    pane.textureUrl('http://localhost:3000', '1.21.4', 'diamond_chestplate'),
    'http://localhost:3000/textures/1.21.4/items/diamond_chestplate.png'
  );
  assert.strictEqual(
    pane.textureUrl('http://localhost:3000/', '1.21.4', 'minecraft:bow'),
    'http://localhost:3000/textures/1.21.4/items/bow.png'
  );
  assert.strictEqual(pane.textureUrl('http://localhost:3000', '1.21.4', 'empty'), null);
  assert.strictEqual(pane.textureUrl(null, '1.21.4', 'bow'), null);
  assert.strictEqual(pane.textureUrl('http://localhost:3000', '1.21.4', '../../etc/passwd'),
    'http://localhost:3000/textures/1.21.4/items/etcpasswd.png', 'path separators must not survive');
});

test('The textures the pane asks for actually exist in the viewer assets', () => {
  const itemsDir = path.resolve(__dirname,
    '../mineflayer-wynn/node_modules/prismarine-viewer/public/textures/1.21.4/items');
  if (!fs.existsSync(itemsDir)) {
    console.log('  (skipped: prismarine-viewer assets are not installed)');
    return;
  }
  for (const item of ['bow', 'diamond_chestplate', 'emerald', 'bread']) {
    const url = pane.textureUrl('http://localhost:3000', '1.21.4', item);
    const file = path.join(itemsDir, url.split('/').pop());
    assert.ok(fs.existsSync(file), `${item} texture missing at ${file}`);
  }
});

test('Tooltips follow the cursor and flip at the screen edges', () => {
  const middle = pane.tooltipPosition(100, 100, 200, 120, 1200, 800);
  assert.deepStrictEqual(middle, { x: 112, y: 112 }, 'default is below-right of the cursor');

  const nearRight = pane.tooltipPosition(1150, 100, 200, 120, 1200, 800);
  assert.ok(nearRight.x + 200 <= 1200, `tooltip overflowed the right edge: ${nearRight.x}`);

  const nearBottom = pane.tooltipPosition(100, 780, 200, 120, 1200, 800);
  assert.ok(nearBottom.y + 120 <= 800, `tooltip overflowed the bottom edge: ${nearBottom.y}`);

  const corner = pane.tooltipPosition(1190, 795, 300, 200, 1200, 800);
  assert.ok(corner.x >= 0 && corner.y >= 0, 'the tooltip must stay on screen in the corner');
  assert.ok(corner.x + 300 <= 1200 && corner.y + 200 <= 800, corner);
});

test('Mouse buttons map to the click the bot server expects', () => {
  assert.deepStrictEqual(pane.clickArgsFor({ button: 0, shiftKey: false }), { button: 0, mode: 0 });
  assert.deepStrictEqual(pane.clickArgsFor({ button: 2, shiftKey: false }), { button: 1, mode: 0 },
    'right click is button 1');
  assert.deepStrictEqual(pane.clickArgsFor({ button: 0, shiftKey: true }), { button: 0, mode: 1 },
    'shift click is a quick move');
  assert.deepStrictEqual(pane.clickArgsFor({ button: 2, shiftKey: true }), { button: 1, mode: 1 });
});

test('The E shortcut never steals keystrokes from the page', () => {
  assert.strictEqual(pane.isTypingTarget({ tagName: 'INPUT' }), true);
  assert.strictEqual(pane.isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.strictEqual(pane.isTypingTarget({ tagName: 'SELECT' }), true);
  assert.strictEqual(pane.isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.strictEqual(pane.isTypingTarget({ tagName: 'DIV' }), false);
  assert.strictEqual(pane.isTypingTarget(null), false);
});

test('The pane is wired into the dashboard pages without replacing anything', () => {
  const dashboard = path.resolve(__dirname, '../dashboard');
  for (const page of ['bot.html', 'market.html']) {
    const html = fs.readFileSync(path.join(dashboard, page), 'utf8');
    assert.ok(html.includes('inventory-pane.js'), `${page} does not load the inventory pane`);
    assert.ok(html.includes('</body>'), `${page} lost its body tag`);
  }

  // The existing bot controller markup must still be intact.
  const bot = fs.readFileSync(path.join(dashboard, 'bot.html'), 'utf8');
  for (const marker of ['/api/bot/status', '/api/bot/events', '/api/bot/connect']) {
    assert.ok(bot.includes(marker), `bot.html lost ${marker}`);
  }
});

test('The component is loadable in Node without a DOM', () => {
  // Requiring the file must not touch document/window; if it did, the require
  // at the top of this file would already have thrown.
  assert.strictEqual(typeof pane.layoutFor, 'function');
  assert.strictEqual(typeof pane.install, 'undefined', 'browser-only API must not leak into Node');
});

console.log(`\n\x1b[1;32mInventory pane tests: ${passed} passed.\x1b[0m`);
