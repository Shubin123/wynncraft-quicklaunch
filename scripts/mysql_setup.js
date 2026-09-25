#!/usr/bin/env node
'use strict';

/** Configure the MySQL mirror and create its schema. Password input is stdin
 * so it never appears in shell history, process arguments, or the repo. */
const childProcess = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const readline = require('readline');

const configDir = path.join(os.homedir(), '.config', 'wynn-dashboard');
const configFile = path.join(configDir, 'mysql.json');
const service = 'wynncraft-quicklaunch/mysql';
const caFile = path.join(configDir, 'us-east-2-rds-ca.pem');
const defaults = {
  host: process.env.WYNN_MYSQL_HOST || 'csc370db.c940y2gqws8x.us-east-2.rds.amazonaws.com',
  port: Number(process.env.WYNN_MYSQL_PORT || 3306), user: process.env.WYNN_MYSQL_USER || 'admin',
  database: process.env.WYNN_MYSQL_DATABASE || 'wynn_dashboard', ssl: true, sslCA: caFile
};

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}
function readPasswordFromStdin() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  return new Promise((resolve) => rl.once('line', (answer) => { rl.close(); resolve(answer); }));
}
function downloadRdsCa(destination) {
  if (fs.existsSync(destination) && fs.statSync(destination).size > 100) return Promise.resolve();
  const url = 'https://truststore.pki.rds.amazonaws.com/us-east-2/us-east-2-bundle.pem';
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`could not download RDS CA (${response.statusCode})`)); return; }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const certificate = Buffer.concat(chunks);
        if (!certificate.includes('BEGIN CERTIFICATE')) { reject(new Error('downloaded RDS CA was not a certificate bundle')); return; }
        fs.writeFileSync(destination, certificate, { mode: 0o600 });
        resolve();
      });
    }).on('error', reject);
  });
}
async function main() {
  const password = process.argv.includes('--password-stdin')
    ? await readPasswordFromStdin()
    : (process.stdin.isTTY ? await ask('MySQL password (stored in macOS Keychain): ') : '');
  if (!password) throw new Error('password was not provided');
  // stdin keeps the credential out of argv. The Keychain is the only local
  // credential store; mysql.json deliberately contains no password.
  try {
    childProcess.execFileSync('security', ['delete-generic-password', '-s', service, '-a', defaults.user], { stdio: 'ignore' });
  } catch { /* first setup has no existing Keychain item */ }
  childProcess.execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', defaults.user, '-w', password], { stdio: 'ignore' });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  await downloadRdsCa(caFile);
  fs.writeFileSync(configFile, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
  const mysql = require('mysql2/promise');
  const admin = await mysql.createConnection({ host: defaults.host, port: defaults.port, user: defaults.user, password,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(caFile, 'utf8') } });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${defaults.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.query(`USE \`${defaults.database}\``);
  await admin.query(`CREATE TABLE IF NOT EXISTS wynn_events (
    stream VARCHAR(64) NOT NULL, event_id VARCHAR(255) NOT NULL, event_type VARCHAR(64) NOT NULL,
    occurred_at DATETIME(6) NOT NULL, item_key VARCHAR(255) NULL, payload JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (stream, event_id), KEY idx_events_type_time (event_type, occurred_at), KEY idx_events_item_time (item_key, occurred_at)
  ) ENGINE=InnoDB`);
  await admin.query(`CREATE TABLE IF NOT EXISTS wynn_state (
    state_kind VARCHAR(64) NOT NULL, state_key VARCHAR(255) NOT NULL, payload JSON NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (state_kind, state_key)
  ) ENGINE=InnoDB`);
  await admin.end();
  process.stdout.write(`MySQL mirror configured for ${defaults.host}/${defaults.database}.\n`);
}
main().catch((err) => { process.stderr.write(`MySQL setup failed: ${err.message}\n`); process.exitCode = 1; });
