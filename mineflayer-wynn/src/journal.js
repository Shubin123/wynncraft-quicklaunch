const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The trade journal: `trade_intent` and `trade_outcome` from
 * docs/DATA_DICTIONARY.md, on disk.
 *
 * Two jobs. First, idempotency that survives a restart - an intent id is
 * written down *before* anything is clicked, so a retry after a crash can be
 * recognised as a repeat rather than executed again. Second, reconciliation:
 * an intent with no outcome is a trade whose result nobody knows, which is
 * exactly the state a disconnect mid-purchase leaves behind, and it stays
 * visible until someone resolves it.
 *
 * Append-only JSONL, like the rest of the project's records.
 */

const DEFAULT_PATH = path.join(os.homedir(), '.local', 'share', 'wynn-dashboard', 'journal.jsonl');

function journalPath() {
  return process.env.WYNN_JOURNAL_FILE || DEFAULT_PATH;
}

/**
 * Reads a JSONL file, tolerating a line torn by a crash mid-write.
 */
function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      // A half-written final line loses itself, not the rest of the journal.
    }
  }
  return rows;
}

function appendRow(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Close a line torn by an earlier crash before adding to it, or the two
  // would fuse and both would be lost.
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const handle = fs.openSync(file, 'r');
      const tail = Buffer.alloc(1);
      fs.readSync(handle, tail, 0, 1, size - 1);
      fs.closeSync(handle);
      if (tail.toString() !== '\n') fs.appendFileSync(file, '\n');
    }
  }
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/**
 * Opens the journal and indexes what is already in it.
 */
function createJournal(options = {}) {
  const file = options.path || journalPath();
  const outcomes = new Map();   // intent_id -> outcome row
  const intents = new Map();    // intent_id -> intent row

  for (const row of readRows(file)) {
    if (row.type === 'trade_intent' && row.intent_id) intents.set(row.intent_id, row);
    if (row.type === 'trade_outcome' && row.intent_id) outcomes.set(row.intent_id, row);
  }

  const journal = {
    file,

    /** Written before the first click, so a crash still leaves evidence. */
    recordIntent(intent) {
      const row = { type: 'trade_intent', ts: Date.now() / 1000, ...intent };
      intents.set(row.intent_id, row);
      try {
        appendRow(file, row);
      } catch (err) {
        // A journal that cannot be written must not stop a trade the user
        // asked for; it degrades to in-memory idempotency for this session.
        journal.lastError = err.message;
      }
      return row;
    },

    recordOutcome(outcome) {
      const row = { type: 'trade_outcome', ts: Date.now() / 1000, ...outcome };
      outcomes.set(row.intent_id, row);
      try {
        appendRow(file, row);
      } catch (err) {
        journal.lastError = err.message;
      }
      return row;
    },

    /**
     * Whether this intent already went through. Only a completed outcome
     * counts: a failure is not a reason to refuse a deliberate retry.
     */
    isCompleted(intentId) {
      const outcome = outcomes.get(intentId);
      return !!outcome && outcome.status === 'executed';
    },

    outcomeFor(intentId) {
      return outcomes.get(intentId) || null;
    },

    intentFor(intentId) {
      return intents.get(intentId) || null;
    },

    /**
     * Intents with no outcome at all: a click that was sent and never
     * answered, usually because the connection went down mid-purchase. The
     * trade may or may not have happened, so it is surfaced for
     * reconciliation rather than guessed at in either direction.
     */
    pending() {
      return [...intents.values()]
        .filter(intent => !outcomes.has(intent.intent_id))
        .sort((a, b) => a.ts - b.ts);
    },

    rows() {
      return readRows(file);
    }
  };

  return journal;
}

module.exports = { createJournal, journalPath, readRows };
