/**
 * Tests the optional account lock.
 *
 * The point of the lock is that Prism's own notion of an "active account" can
 * change - you switch to a second account to watch the bot from inside the
 * game - without the bot following along. So these tests drive a fake Prism
 * directory, flip which account is active there, and check the bot's choice
 * does not move.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('Running account lock tests...');

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

const ALICE = '8aee6d8bf7e344b0a8b033ca18aed57b';
const BOB = 'c59fc2e439cc4a03b7eb6fd6aa728d8a';

function account(name, uuid, active, { expired = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    type: 'MSA',
    active,
    profile: { id: uuid, name },
    ygg: { token: `token-${name}`, exp: expired ? now - 600 : now + 86400 }
  };
}

/**
 * A throwaway Prism directory plus a throwaway lock file, so nothing here
 * touches the real launcher or the user's config.
 */
function sandbox(accounts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-accounts-'));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts }));
  process.env.PRISM_DIR = dir;
  process.env.WYNN_BOT_ACCOUNT_FILE = path.join(dir, 'bot-account.json');
  delete process.env.WYNN_BOT_ACCOUNT;

  // prism.js reads the environment on every call, but the module cache would
  // otherwise carry state between cases.
  delete require.cache[require.resolve('../src/prism')];
  const prism = require('../src/prism');
  return {
    prism,
    dir,
    /** Flips which account Prism considers active, as switching in Prism does. */
    setActive(uuid) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
      for (const entry of data.accounts) entry.active = entry.profile.id === uuid;
      fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(data));
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.PRISM_DIR;
      delete process.env.WYNN_BOT_ACCOUNT_FILE;
      delete process.env.WYNN_BOT_ACCOUNT;
    }
  };
}

function withSandbox(accounts, fn) {
  const box = sandbox(accounts);
  try {
    fn(box);
  } finally {
    box.cleanup();
  }
}

test('Without a lock the bot follows whichever account Prism has active', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ prism, setActive }) => {
    let selection = prism.getAccountSelection();
    assert.strictEqual(selection.account.name, 'Alice');
    assert.strictEqual(selection.source, 'prism-active');
    assert.ok(selection.warnings.some(w => /switching accounts in Prism will switch the bot/i.test(w)),
      `expected a warning about following Prism, got ${JSON.stringify(selection.warnings)}`);

    setActive(BOB);
    selection = prism.getAccountSelection();
    assert.strictEqual(selection.account.name, 'Bob', 'this is the behaviour the lock exists to prevent');
  });
});

test('A lock keeps the bot on its account when Prism switches', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ prism, setActive }) => {
    const locked = prism.setAccountLock('Alice');
    assert.ok(locked.ok, locked.error);

    // Switch Prism to the other account, exactly as you would to play manually.
    setActive(BOB);

    const selection = prism.getAccountSelection();
    assert.strictEqual(selection.account.name, 'Alice', 'the bot must stay on the locked account');
    assert.strictEqual(selection.source, 'lock');
    assert.strictEqual(selection.prismActive.name, 'Bob', 'and must still report what Prism is on');
    assert.strictEqual(prism.getActiveAccount().name, 'Alice', 'the legacy accessor honours the lock too');
    assert.deepStrictEqual(selection.warnings, [], 'locked onto a different account is the quiet, intended case');
  });
});

test('The lock survives a fresh read of the module', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ prism, dir }) => {
    prism.setAccountLock(BOB);
    delete require.cache[require.resolve('../src/prism')];
    const reloaded = require('../src/prism');
    assert.strictEqual(reloaded.getActiveAccount().name, 'Bob', 'a restart must not lose the lock');
    assert.ok(fs.existsSync(path.join(dir, 'bot-account.json')), 'the lock is persisted, not in memory');
  });
});

test('Locking by UUID works, in either spelling', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ prism }) => {
    const dashed = BOB.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const result = prism.setAccountLock(dashed);
    assert.ok(result.ok, result.error);
    assert.strictEqual(prism.getActiveAccount().name, 'Bob');
    assert.strictEqual(prism.readAccountLock().uuid, BOB, 'the lock stores the canonical uuid');
  });
});

test('Names match case-insensitively, and unknown names are refused', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ prism }) => {
    assert.ok(prism.setAccountLock('bob').ok, 'names should not be case-sensitive');
    assert.strictEqual(prism.getActiveAccount().name, 'Bob');

    const bad = prism.setAccountLock('Carol');
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /No Prism account matches/);
    assert.deepStrictEqual(bad.available.map(a => a.name), ['Alice', 'Bob'], 'and should say what is available');
    assert.strictEqual(prism.getActiveAccount().name, 'Bob', 'a failed lock must not clear the good one');
  });
});

test('Unlocking hands the bot back to Prism', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ prism, setActive }) => {
    prism.setAccountLock('Alice');
    setActive(BOB);
    assert.strictEqual(prism.getActiveAccount().name, 'Alice');

    prism.clearAccountLock();
    assert.strictEqual(prism.readAccountLock(), null);
    assert.strictEqual(prism.getActiveAccount().name, 'Bob', 'unlocked, it follows Prism again');
    assert.strictEqual(prism.clearAccountLock().ok, true, 'unlocking twice is not an error');
  });
});

test('A lock pointing at a removed account falls back and says so', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ prism, dir }) => {
    prism.setAccountLock('Bob');
    // Bob is removed from Prism while the lock still names him.
    fs.writeFileSync(path.join(dir, 'accounts.json'),
      JSON.stringify({ accounts: [account('Alice', ALICE, true)] }));

    const selection = prism.getAccountSelection();
    assert.strictEqual(selection.account.name, 'Alice', 'the bot must still be able to connect');
    assert.strictEqual(selection.source, 'prism-active', 'and fall back to whatever Prism has active');
    assert.ok(selection.warnings.some(w => /no longer in Prism/i.test(w)), selection.warnings);
  });
});

test('A corrupt lock file is ignored rather than fatal', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ prism, dir }) => {
    fs.writeFileSync(path.join(dir, 'bot-account.json'), '{ not json');
    assert.strictEqual(prism.readAccountLock(), null);
    assert.strictEqual(prism.getActiveAccount().name, 'Alice', 'the bot still connects');

    fs.writeFileSync(path.join(dir, 'bot-account.json'), '{}');
    assert.strictEqual(prism.readAccountLock(), null, 'an empty lock is no lock');
  });
});

test('An unwritable lock location is reported, not thrown', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ prism, dir }) => {
    // A path whose parent is a file cannot be created: stands in for a
    // read-only or otherwise unwritable config directory.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    process.env.WYNN_BOT_ACCOUNT_FILE = path.join(blocker, 'bot-account.json');

    let result;
    assert.doesNotThrow(() => { result = prism.setAccountLock('Alice'); },
      'a filesystem error must not escape into the caller');
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /Could not write the account lock/);

    assert.doesNotThrow(() => prism.clearAccountLock(), 'nor when clearing it');
  });
});

test('WYNN_BOT_ACCOUNT overrides the saved lock for one run', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ prism }) => {
    prism.setAccountLock('Alice');
    process.env.WYNN_BOT_ACCOUNT = 'Bob';
    try {
      const selection = prism.getAccountSelection();
      assert.strictEqual(selection.account.name, 'Bob');
      assert.strictEqual(selection.source, 'env');
      assert.strictEqual(prism.readAccountLock().name, 'Alice', 'the saved lock is left intact');

      process.env.WYNN_BOT_ACCOUNT = 'Nobody';
      const fallback = prism.getAccountSelection();
      assert.strictEqual(fallback.account.name, 'Alice', 'an unknown override falls back to the lock');
      assert.ok(fallback.warnings.some(w => /WYNN_BOT_ACCOUNT/.test(w)), fallback.warnings);
    } finally {
      delete process.env.WYNN_BOT_ACCOUNT;
    }
  });
});

test('Locking onto the account Prism is using warns about the clash', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ prism }) => {
    prism.setAccountLock('Alice'); // the same account Prism has active
    const selection = prism.getAccountSelection();
    assert.strictEqual(selection.source, 'lock');
    assert.ok(selection.warnings.some(w => /will kick the bot/i.test(w)),
      `expected a clash warning, got ${JSON.stringify(selection.warnings)}`);
  });
});

test('An expired session on the locked account is flagged, not hidden', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false, { expired: true })], ({ prism }) => {
    prism.setAccountLock('Bob');
    const selection = prism.getAccountSelection();
    assert.strictEqual(selection.account.name, 'Bob', 'still the chosen account');
    assert.strictEqual(selection.account.isTokenValid, false);
    assert.ok(selection.warnings.some(w => /expired session/i.test(w)), selection.warnings);
  });
});

test('A --account that matches nothing stops instead of connecting offline', () => {
  withSandbox([account('Alice', ALICE, true), account('Bob', BOB, false)], ({ dir }) => {
    delete require.cache[require.resolve('../src/bot')];
    const { createWynnBot } = require('../src/bot');
    assert.throws(
      () => createWynnBot({ account: 'Carol', auth: 'prism' }),
      /No Prism account matches "Carol"\. Available: Alice, Bob/,
      'a typo must fail loudly, not log in offline as the default username'
    );
  });
});

test('No accounts at all is reported, not crashed on', () => {
  withSandbox([], ({ prism }) => {
    const selection = prism.getAccountSelection();
    assert.strictEqual(selection.account, null);
    assert.strictEqual(selection.source, 'none');
    assert.strictEqual(prism.getActiveAccount(), null);
    assert.strictEqual(prism.setAccountLock('Alice').ok, false);
  });
});

test('One account needs no warning about switching', () => {
  withSandbox([account('Alice', ALICE, true)], ({ prism }) => {
    const selection = prism.getAccountSelection();
    assert.strictEqual(selection.account.name, 'Alice');
    assert.deepStrictEqual(selection.warnings, [], 'nothing to switch between, nothing to warn about');
  });
});

console.log(`\n\x1b[1;32mAccount lock tests: ${passed} passed.\x1b[0m`);
