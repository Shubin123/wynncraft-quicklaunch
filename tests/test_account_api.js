/**
 * HTTP tests for the account lock endpoints.
 *
 * Boots a throwaway bot server with PRISM_DIR and WYNN_BOT_ACCOUNT_FILE
 * pointed at temporary files, so the real launcher config and the real lock
 * are never read or written.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.WYNN_TEST_BOT_PORT || '8795', 10);
const BASE = `http://localhost:${PORT}`;

const ALICE = '8aee6d8bf7e344b0a8b033ca18aed57b';
const BOB = 'c59fc2e439cc4a03b7eb6fd6aa728d8a';

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
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function account(name, uuid, active) {
  const now = Math.floor(Date.now() / 1000);
  return { type: 'MSA', active, profile: { id: uuid, name }, ygg: { token: `token-${name}`, exp: now + 86400 } };
}

(async () => {
  console.log('Running account lock API tests...');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-account-api-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const lockFile = path.join(dir, 'bot-account.json');
  fs.writeFileSync(accountsFile, JSON.stringify({
    accounts: [account('Alice', ALICE, true), account('Bob', BOB, false)]
  }));

  const server = spawn('node', [path.join(REPO, 'scripts', 'wynn_bot_server.js')], {
    env: {
      ...process.env,
      WYNN_BOT_PORT: String(PORT),
      PRISM_DIR: dir,
      WYNN_BOT_ACCOUNT_FILE: lockFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  /** Flips Prism's active account, as switching in the launcher does. */
  function setPrismActive(uuid) {
    const data = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    for (const entry of data.accounts) entry.active = entry.profile.id === uuid;
    fs.writeFileSync(accountsFile, JSON.stringify(data));
  }

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

    await test('GET /api/bot/accounts lists both accounts and who uses what', async () => {
      const { status, body } = await request('/api/bot/accounts');
      assert.strictEqual(status, 200, JSON.stringify(body));
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.locked, false);
      assert.strictEqual(body.lockFile, lockFile, 'the temp lock file must be the one in play');
      assert.deepStrictEqual(body.accounts.map(a => a.name).sort(), ['Alice', 'Bob']);

      const alice = body.accounts.find(a => a.name === 'Alice');
      assert.strictEqual(alice.prismActive, true);
      assert.strictEqual(alice.usedByBot, true, 'unlocked, the bot follows Prism');
      assert.ok(body.warnings.some(w => /switching accounts in Prism/i.test(w)));
    });

    await test('Locking pins the bot, and status reports both accounts', async () => {
      const locked = await request('/api/bot/account/lock', { method: 'POST', body: { account: 'Alice' } });
      assert.strictEqual(locked.status, 200, JSON.stringify(locked.body));
      assert.strictEqual(locked.body.locked, true);
      assert.ok(fs.existsSync(lockFile), 'the lock must be persisted');

      // Switch Prism to the other account, as you would to play alongside it.
      setPrismActive(BOB);

      const { body } = await request('/api/bot/status');
      assert.strictEqual(body.account.using.name, 'Alice', 'the bot must not follow Prism');
      assert.strictEqual(body.account.prismActive.name, 'Bob');
      assert.strictEqual(body.account.locked, true);
      assert.strictEqual(body.account.followsPrism, false);
      assert.strictEqual(body.account.sameAsPrismActive, false);
    });

    await test('The accounts list reflects the split too', async () => {
      const { body } = await request('/api/bot/accounts');
      const alice = body.accounts.find(a => a.name === 'Alice');
      const bob = body.accounts.find(a => a.name === 'Bob');
      assert.strictEqual(alice.usedByBot, true);
      assert.strictEqual(alice.prismActive, false);
      assert.strictEqual(bob.usedByBot, false);
      assert.strictEqual(bob.prismActive, true);
      assert.strictEqual(body.source, 'lock');
    });

    await test('Locking an unknown account is refused and changes nothing', async () => {
      const { status, body } = await request('/api/bot/account/lock', { method: 'POST', body: { account: 'Carol' } });
      assert.strictEqual(status, 400, JSON.stringify(body));
      assert.match(body.error, /No Prism account matches/);

      const after = await request('/api/bot/status');
      assert.strictEqual(after.body.account.using.name, 'Alice', 'the existing lock must survive');
    });

    await test('A lock request without an account is rejected', async () => {
      const { status, body } = await request('/api/bot/account/lock', { method: 'POST', body: {} });
      assert.strictEqual(status, 400);
      assert.match(body.error, /Missing account/);
    });

    await test('Unlocking hands the bot back to Prism', async () => {
      const { status, body } = await request('/api/bot/account/unlock', { method: 'POST' });
      assert.strictEqual(status, 200, JSON.stringify(body));
      assert.strictEqual(body.locked, false);
      assert.ok(!fs.existsSync(lockFile), 'the lock file must be gone');

      const after = await request('/api/bot/status');
      assert.strictEqual(after.body.account.using.name, 'Bob', 'Prism is on Bob, so the bot is too');
      assert.strictEqual(after.body.account.followsPrism, true);
    });

    await test('Locking by UUID works over HTTP as well', async () => {
      const { body } = await request('/api/bot/account/lock', { method: 'POST', body: { uuid: ALICE } });
      assert.strictEqual(body.locked, true);
      assert.strictEqual(body.lock.name, 'Alice');

      const status = await request('/api/bot/status');
      assert.strictEqual(status.body.account.using.uuid, ALICE);
      await request('/api/bot/account/unlock', { method: 'POST' });
    });

    await test('Locking onto the account Prism is using is allowed but flagged', async () => {
      setPrismActive(ALICE);
      await request('/api/bot/account/lock', { method: 'POST', body: { account: 'Alice' } });

      const { body } = await request('/api/bot/status');
      assert.strictEqual(body.account.sameAsPrismActive, true);
      assert.ok(body.account.warnings.some(w => /kick the bot/i.test(w)),
        `expected a clash warning, got ${JSON.stringify(body.account.warnings)}`);
      await request('/api/bot/account/unlock', { method: 'POST' });
    });
    await test('The dashboard exposes the lock and does not lose its own controls', async () => {
      const html = fs.readFileSync(path.join(REPO, 'dashboard', 'bot.html'), 'utf8');
      for (const marker of ['account-lock-select', 'account-lock-btn', 'toggleAccountLock',
        'loadAccountChoices', '/api/bot/account/lock', '/api/bot/account/unlock', '/api/bot/accounts',
        'prism-active-name']) {
        assert.ok(html.includes(marker), `bot.html is missing ${marker}`);
      }
      // The pre-existing controls must still be there.
      for (const marker of ['/api/bot/connect', '/api/bot/events', 'account-name', 'inventory-pane.js']) {
        assert.ok(html.includes(marker), `bot.html lost ${marker}`);
      }
    });

  } finally {
    server.kill('SIGTERM');
    try { server.unref(); } catch (err) { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n\x1b[1;32mAccount lock API tests: ${passed} passed.\x1b[0m`);
  setTimeout(() => process.exit(process.exitCode || 0), 200);
})();
