'use strict';

const assert = require('assert');
const store = require('../scripts/lib/mysql_store');

async function main() {
  assert.strictEqual(typeof store.readEvents, 'function');
  assert.strictEqual(typeof store.readState, 'function');
  const status = store.status();
  assert.strictEqual(typeof status.configured, 'boolean');
  if (!status.configured) {
    console.log('MySQL integration test skipped (no local MySQL configuration).');
    return;
  }

  const intentId = `mysql-integration-${process.pid}-${Date.now()}`;
  const row = { type: 'integration_probe', intent_id: intentId, item: 'integration probe', ts: Date.now() / 1000 };
  store.recordEvent('test', row);
  await store.flush();
  const events = await store.readEvents({ stream: 'test', type: 'integration_probe', item: 'integration probe', limit: 20 });
  assert.ok(events.some((event) => event.intent_id === intentId), 'written event must be retrievable from MySQL');
  store.saveState('test', intentId, { ok: true });
  await store.flush();
  const state = await store.readState('test', intentId);
  assert.deepStrictEqual(state[0]?.value, { ok: true }, 'written state must be retrievable from MySQL');
  console.log('MySQL integration test passed.');
}
main().then(() => store.close()).catch(async (err) => { await store.close(); throw err; });
