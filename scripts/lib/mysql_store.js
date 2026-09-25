'use strict';

/**
 * Optional MySQL mirror for the local append-only data files.
 *
 * Local JSONL remains authoritative: it is available offline and a database
 * outage can never interrupt a bot action. When configured, every record is
 * also queued to MySQL and retries automatically after a reconnect.
 */

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = process.env.WYNN_MYSQL_CONFIG || path.join(os.homedir(), '.config', 'wynn-dashboard', 'mysql.json');
const KEYCHAIN_SERVICE = 'wynncraft-quicklaunch/mysql';
const MAX_PENDING = 5000;
let pool = null;
let connecting = null;
let disabled = false;
let lastError = null;
const pending = [];

function readConfig() {
  if (process.env.WYNN_MYSQL_DISABLED === '1') return null;
  if (process.env.WYNN_MYSQL_URL) return { url: process.env.WYNN_MYSQL_URL };
  if (process.env.WYNN_MYSQL_HOST && process.env.WYNN_MYSQL_USER && process.env.WYNN_MYSQL_DATABASE) {
    return { host: process.env.WYNN_MYSQL_HOST, port: Number(process.env.WYNN_MYSQL_PORT || 3306),
      user: process.env.WYNN_MYSQL_USER, database: process.env.WYNN_MYSQL_DATABASE,
      ssl: process.env.WYNN_MYSQL_SSL !== 'false', sslCA: process.env.WYNN_MYSQL_SSL_CA || undefined };
  }
  try {
    const value = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return value && value.host && value.user && value.database ? value : null;
  } catch { return null; }
}

function keychainPassword(account) {
  // `security` writes the password only to this child process's stdout; it is
  // never logged, exported, or placed in a project file.
  try {
    return childProcess.execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null;
  } catch { return null; }
}
function passwordFromFile() {
  const file = process.env.WYNN_MYSQL_PASSWORD_FILE;
  if (!file) return null;
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

async function getPool() {
  if (disabled) return null;
  if (pool) return pool;
  if (connecting) return connecting;
  connecting = (async () => {
    const config = readConfig();
    if (!config) return null;
    let connection;
    if (config.url) {
      connection = { uri: config.url };
    } else {
      const password = passwordFromFile() || keychainPassword(config.user);
      if (!password) {
        lastError = `MySQL password is not available in Keychain for '${config.user}'`;
        return null;
      }
      const ssl = config.ssl === false ? undefined : {
        rejectUnauthorized: true,
        ...(config.sslCA ? { ca: fs.readFileSync(config.sslCA, 'utf8') } : {})
      };
      connection = {
        host: config.host, port: Number(config.port || 3306), user: config.user, password,
        database: config.database, ssl,
        waitForConnections: true, connectionLimit: Number(config.connectionLimit || 4), queueLimit: 0
      };
    }
    try {
      // Load lazily so a normal local-only install never needs this package.
      const mysql = require('mysql2/promise');
      const created = connection.uri ? mysql.createPool(connection.uri) : mysql.createPool(connection);
      await created.query('SELECT 1');
      pool = created;
      lastError = null;
      return pool;
    } catch (err) {
      lastError = `MySQL unavailable: ${err.message}`;
      return null;
    }
  })();
  try { return await connecting; } finally { connecting = null; }
}

function timestamp(row) { return Number(row.ts || Date.now() / 1000); }
function eventId(stream, row) {
  // A scan contains one scan row and many observations; likewise a trade
  // intent and its outcome share an intent id. Type + per-listing fingerprint
  // keeps each source record independently addressable and idempotent.
  const identity = row.listing_fingerprint ? `${row.scan_id || ''}:${row.listing_fingerprint}`
    : (row.scan_id || row.intent_id || `${stream}:${timestamp(row)}:${JSON.stringify(row)}`);
  return `${row.type || stream}:${identity}`;
}

async function writeEvent(stream, row) {
  const db = await getPool();
  if (!db) throw new Error(lastError || 'MySQL is not configured');
  const itemKey = row.item_key || row.item || null;
  await db.execute(
    `INSERT INTO wynn_events (stream, event_id, event_type, occurred_at, item_key, payload)
     VALUES (?, ?, ?, FROM_UNIXTIME(?), ?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), occurred_at = VALUES(occurred_at), item_key = VALUES(item_key)`,
    [stream, eventId(stream, row), row.type || stream, timestamp(row), itemKey, JSON.stringify(row)]
  );
}

async function writeState(kind, stateKey, value) {
  const db = await getPool();
  if (!db) throw new Error(lastError || 'MySQL is not configured');
  await db.execute(
    `INSERT INTO wynn_state (state_kind, state_key, payload)
     VALUES (?, ?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = CURRENT_TIMESTAMP`,
    [kind, String(stateKey), JSON.stringify(value)]
  );
}

async function readEvents({ stream = null, type = null, item = null, since = null, limit = 100, offset = 0 } = {}) {
  const db = await getPool();
  if (!db) throw new Error(lastError || 'MySQL is not configured');
  const clauses = [];
  const values = [];
  if (stream) { clauses.push('stream = ?'); values.push(String(stream)); }
  if (type) { clauses.push('event_type = ?'); values.push(String(type)); }
  if (item) { clauses.push('item_key = ?'); values.push(String(item).toLowerCase()); }
  if (since != null && Number.isFinite(Number(since))) { clauses.push('occurred_at >= FROM_UNIXTIME(?)'); values.push(Number(since)); }
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const boundedOffset = Math.max(0, Number(offset) || 0);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await db.execute(
    `SELECT stream, event_id, event_type, UNIX_TIMESTAMP(occurred_at) AS ts, item_key, payload
     FROM wynn_events ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`,
    [...values, boundedLimit, boundedOffset]
  );
  return rows.map((row) => ({ ...(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload), _storage: {
    stream: row.stream, event_id: row.event_id, event_type: row.event_type, ts: Number(row.ts), item_key: row.item_key
  } }));
}

async function readState(kind, stateKey = null) {
  const db = await getPool();
  if (!db) throw new Error(lastError || 'MySQL is not configured');
  const sql = stateKey == null
    ? 'SELECT state_kind, state_key, payload, UNIX_TIMESTAMP(updated_at) AS updated_at FROM wynn_state WHERE state_kind = ? ORDER BY state_key'
    : 'SELECT state_kind, state_key, payload, UNIX_TIMESTAMP(updated_at) AS updated_at FROM wynn_state WHERE state_kind = ? AND state_key = ?';
  const [rows] = await db.execute(sql, stateKey == null ? [String(kind)] : [String(kind), String(stateKey)]);
  return rows.map((row) => ({ kind: row.state_kind, key: row.state_key,
    value: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload, updated_at: Number(row.updated_at) }));
}

function enqueue(work) {
  if (disabled || !readConfig()) return;
  if (pending.length >= MAX_PENDING) pending.shift();
  pending.push(work);
  void flush();
}

let flushing = false;
let flushPromise = null;
async function flush() {
  if (disabled) return;
  if (flushPromise) return flushPromise;
  flushing = true;
  flushPromise = (async () => {
    while (pending.length) {
      const work = pending[0];
      try { await work(); pending.shift(); }
      catch (err) { lastError = err.message; break; }
    }
  })();
  try { await flushPromise; }
  finally { flushing = false; flushPromise = null; }
}

function recordEvent(stream, row) { enqueue(() => writeEvent(stream, row)); }
function recordEvents(stream, rows) { for (const row of rows) recordEvent(stream, row); }
function saveState(kind, stateKey, value) { enqueue(() => writeState(kind, stateKey, value)); }
function status() {
  return { configured: !!readConfig(), connected: !!pool, pending: pending.length, lastError };
}
async function close() { if (pool) await pool.end(); pool = null; }

module.exports = { CONFIG_FILE, KEYCHAIN_SERVICE, readConfig, passwordFromFile, recordEvent, recordEvents, saveState,
  readEvents, readState, flush, status, close };
