'use strict';

// Starts a fresh HTTP server and exercises the public retrieval surface against
// the configured RDS mirror. It intentionally makes no bot connection.
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const store = require('../scripts/lib/mysql_store');

const REPO = path.resolve(__dirname, '..');
const PORT = Number(process.env.WYNN_TEST_MYSQL_E2E_PORT || 8797);
const base = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${pathname}`, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { reject(new Error(`non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function main() {
  if (!store.status().configured) {
    console.log('MySQL E2E test skipped (no local MySQL configuration).');
    return;
  }
  const server = spawn('node', [path.join(REPO, 'scripts', 'wynn_bot_server.js')], {
    env: { ...process.env, WYNN_BOT_PORT: String(PORT), WYNN_BOT_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await get('/api/bot/status'); ready = true; break; } catch { await wait(125); }
    }
    if (!ready && /node version[\s\S]*>=\s*22/i.test(serverOutput)) {
      console.log('MySQL E2E test skipped (the bot dependency requires Node.js 22+).');
      return;
    }
    assert.ok(ready, `fresh bot server did not start: ${serverOutput.slice(-500)}`);
    const status = await get('/api/storage/status');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.configured, true);
    const events = await get('/api/storage/events?limit=1');
    assert.strictEqual(events.status, 200, JSON.stringify(events.body));
    assert.ok(Array.isArray(events.body.events));
    const missingKind = await get('/api/storage/state');
    assert.strictEqual(missingKind.status, 400);
    const emptyState = await get('/api/storage/state?kind=e2e_probe&key=absent');
    assert.strictEqual(emptyState.status, 200, JSON.stringify(emptyState.body));
    assert.deepStrictEqual(emptyState.body.state, []);
    console.log('MySQL E2E retrieval test passed.');
  } finally {
    server.kill('SIGTERM');
    await wait(50);
  }
}
main().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
