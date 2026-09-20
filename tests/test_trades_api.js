/**
 * HTTP surface for the trade record: what is unresolved, and settling it.
 *
 * Boots a throwaway bot server rather than talking to whatever is running on
 * the usual port. That matters more than convenience here: a long-lived server
 * from an earlier checkout answers a new route with 404, so a test pointed at
 * it would report a missing endpoint that is actually present, or pass on an
 * old one that is not.
 *
 * With no bot attached these endpoints can only decline, and that is most of
 * what is worth pinning: reconciliation writes to the trade record, so it must
 * refuse rather than invent an answer when it has nothing to read. The
 * behaviour with a bot is covered where the evidence is real -
 * test_trade_journal.js for the rules, test_protocol_harness.js against a
 * server that actually reports a balance.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.WYNN_TEST_TRADES_PORT || '8796', 10);
const BASE = `http://localhost:${PORT}`;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : null;
    const req = http.request(`${BASE}${pathname}`, {
      method: options.method || 'GET',
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {}
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (err) { /* reported as null */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  console.log('Running trade record API tests...');

  // Temporary everything: this server must not read the real launcher config,
  // touch the real account lock, or write to the real trade journal.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-trades-api-'));
  const server = spawn('node', [path.join(REPO, 'scripts', 'wynn_bot_server.js')], {
    env: {
      ...process.env,
      WYNN_BOT_PORT: String(PORT),
      PRISM_DIR: dir,
      WYNN_BOT_ACCOUNT_FILE: path.join(dir, 'bot-account.json'),
      WYNN_JOURNAL_FILE: path.join(dir, 'journal.jsonl')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    let up = false;
    for (let attempt = 0; attempt < 60 && !up; attempt++) {
      try {
        await request('/api/bot/status');
        up = true;
      } catch (err) {
        await wait(250);
      }
    }
    assert.ok(up, 'bot server did not start');

    await test('GET /api/bot/trades/pending always answers with a list', async () => {
      const { status, body } = await request('/api/bot/trades/pending');
      assert.strictEqual(status, 200, JSON.stringify(body));
      assert.strictEqual(typeof body.ok, 'boolean');
      assert.ok(Array.isArray(body.pending),
        'pending must be a list even with no bot, so no caller has to guard it');
      assert.strictEqual(body.pending.length, 0);
    });

    await test('POST /api/bot/trades/reconcile is routed, and declines with no bot', async () => {
      const { status, body, raw } = await request('/api/bot/trades/reconcile', {
        method: 'POST', body: {}
      });
      assert.notStrictEqual(status, 404,
        `the route is missing: ${raw}. A server started before this endpoint existed answers 404.`);
      assert.strictEqual(status, 400, JSON.stringify(body));
      assert.strictEqual(body.ok, false);
      assert.ok(body.error, 'a refusal must say why');
      assert.deepStrictEqual(body.settled, [],
        'nothing may be reported settled when nothing could be read');
      assert.deepStrictEqual(body.stillPending, []);
    });

    await test('Reconciliation never reports a settlement it did not make', async () => {
      // Twice, because an endpoint that accumulated state would show it here.
      const first = await request('/api/bot/trades/reconcile', { method: 'POST', body: {} });
      const second = await request('/api/bot/trades/reconcile', { method: 'POST', body: {} });
      assert.deepStrictEqual(first.body, second.body);

      const { body } = await request('/api/bot/trades/pending');
      assert.strictEqual(body.pending.length, 0,
        'a declined reconciliation must not have written anything');
    });


  } finally {
    server.kill('SIGTERM');
    try { server.unref(); } catch (err) { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n\x1b[1;32mTrade record API tests: ${passed} passed.\x1b[0m`);
  setTimeout(() => process.exit(process.exitCode || 0), 200);
})();
