'use strict';

const assert = require('assert');
const store = require('../scripts/lib/mysql_store');

async function main() {
  if (!store.status().configured) {
    console.log('MySQL smoke test skipped (no local MySQL configuration).');
    return;
  }
  // A zero-row state lookup still opens a pool and executes a parameterized
  // SELECT, making this a low-impact connectivity, TLS, auth, and schema check.
  const rows = await store.readState('smoke_probe', '__absent__');
  assert.deepStrictEqual(rows, []);
  console.log('MySQL smoke test passed.');
}
main().then(() => store.close()).catch(async (err) => { await store.close(); throw err; });
