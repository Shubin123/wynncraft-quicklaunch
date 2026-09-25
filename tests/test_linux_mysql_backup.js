'use strict';

// Exercises the exact Linux backup entrypoint with a short-lived password file
// rather than using macOS Keychain access inside the backup process.
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../scripts/lib/mysql_store');

async function main() {
  if (!store.status().configured) {
    console.log('Linux MySQL backup integration test skipped (no local MySQL configuration).');
    return;
  }
  const config = store.readConfig();
  let password;
  try {
    password = childProcess.execFileSync('security', ['find-generic-password', '-s', store.KEYCHAIN_SERVICE, '-a', config.user, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    console.log('Linux MySQL backup integration test skipped (no Keychain test credential).');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wynn-linux-backup-'));
  const keyFile = path.join(directory, 'key.text');
  const standaloneScript = path.join(directory, 'wynner.sh');
  fs.writeFileSync(keyFile, `${password}\n`, { mode: 0o600 });
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'linux_mysql_backup.sh'), standaloneScript);
  try {
    const result = childProcess.spawnSync('bash', [standaloneScript], {
      cwd: directory, env: { ...process.env, WYNN_REPO_DIR: path.join(__dirname, '..'), WYNN_MYSQL_PASSWORD_FILE: keyFile }, encoding: 'utf8'
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Backfill complete/);
    const wrapper = childProcess.spawnSync('bash', [path.join(__dirname, '..', 'scripts', 'wynner.sh')], {
      cwd: directory, env: { ...process.env, WYNN_REPO_DIR: path.join(__dirname, '..'), WYNN_MYSQL_PASSWORD_FILE: keyFile }, encoding: 'utf8'
    });
    assert.strictEqual(wrapper.status, 0, wrapper.stderr || wrapper.stdout);
    assert.match(wrapper.stdout, /Backfill complete/);
    const rows = await store.readEvents({ stream: 'system', type: 'storage_initialized', limit: 1 });
    assert.strictEqual(rows.length, 1, 'backup must write a retrievable MySQL record');
    console.log('Linux MySQL backup integration test passed.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    await store.close();
  }
}
main().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
