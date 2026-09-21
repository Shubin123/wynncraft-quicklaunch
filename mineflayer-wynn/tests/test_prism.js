const assert = require('assert');
const prism = require('../src/prism');
const { stripFormatting } = require('../src/wynncraft');

console.log('Running test suite for mineflayer-wynn...');

// Test 1: Prism directory detection
const prismDir = prism.getPrismDir();
assert.ok(prismDir, 'Prism directory should be detected');
console.log('✔ Test 1 passed: Prism directory detected:', prismDir);

// Test 2: Instances detection
const instances = prism.getInstances();
assert.ok(Array.isArray(instances), 'Instances should be an array');
assert.ok(instances.length > 0, 'Should find at least one instance');
console.log(`✔ Test 2 passed: Found ${instances.length} Prism instances`);

// Test 3: Wynncraft instance configuration
const wynn = prism.getWynnInstance('Wynncraft-1.21.11');
assert.strictEqual(wynn.name, 'Wynncraft-1.21.11', 'Instance name matches');
assert.strictEqual(wynn.host, 'play.wynncraft.com', 'Host is play.wynncraft.com');
assert.strictEqual(wynn.port, 25565, 'Port is 25565');
assert.strictEqual(wynn.minecraftVersion, '1.21.11', 'Version is 1.21.11');
console.log('✔ Test 3 passed: Wynncraft instance configuration parsed correctly');

// Test 4: Prism accounts detection
const accounts = prism.getPrismAccounts();
assert.ok(Array.isArray(accounts), 'Accounts should be an array');
assert.ok(accounts.length > 0, 'Should find at least one account');
const active = prism.getActiveAccount();
assert.ok(active, 'Active account should be found');
assert.ok(typeof active.name === 'string' && active.name.length > 0, 'Active account has a name');
assert.ok(active.hasToken, 'Account should have token');
console.log(`✔ Test 4 passed: Active account "${active.name}" found with valid session`);

// Test 5: Formatting stripper
const formatted = '§6[Gold] §aHello §cWorld!§r';
const stripped = stripFormatting(formatted);
assert.strictEqual(stripped, '[Gold] Hello World!', 'Minecraft formatting stripped');
console.log('✔ Test 5 passed: Formatting stripper works');

// Test 6: Emerald calculation logic
const { EventEmitter } = require('events');
const dummyBot = new EventEmitter();
dummyBot.inventory = {
  items: () => [
    { name: 'emerald', count: 10 },
    { name: 'emerald_block', count: 2 },
    { name: 'emerald', customName: '§aLiquid Emerald', count: 1 }
  ]
};
// 10 + 2*64 (128) + 1*4096 = 4234
// LE: 1, EB: 2, E: 10
const { wynncraftPlugin } = require('../src/wynncraft');
wynncraftPlugin(dummyBot, {});
const counts = dummyBot.wynn.countEmeralds();
assert.strictEqual(counts.total, 4234, 'Emerald total matches');
assert.strictEqual(counts.le, 1, 'LE count matches');
assert.strictEqual(counts.eb, 2, 'EB count matches');
assert.strictEqual(counts.e, 10, 'E count matches');
console.log('✔ Test 6 passed: Emerald calculation logic accurate');

console.log('\nAll tests passed successfully! 🎉');
