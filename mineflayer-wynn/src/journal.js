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

/**
 * How long an emerald balance stays a usable witness to a trade.
 *
 * Emeralds move for reasons that have nothing to do with a pending intent - a
 * sale, a drop, another purchase - so the longer one sits unresolved, the less
 * a matching balance proves. An hour is generous for the case this exists to
 * settle, a bot reconnecting after a crash, and short enough that a
 * coincidence a week later is not mistaken for evidence.
 */
const RECONCILE_WINDOW_SECONDS = 3600;

/**
 * What the balance should have fallen by if an intent went through.
 *
 * Shared by the buy path and by reconciliation so the two cannot drift into
 * disagreeing about the same trade. Null when the intent never recorded what
 * the listing asked, which is not a number to guess at.
 */
function expectedSpend(intent) {
  if (!intent || typeof intent.observed_price !== 'number') return null;
  return intent.observed_price * (intent.units || 1);
}

/**
 * Decides what became of a pending intent, from evidence gathered afterwards.
 *
 * A pending intent is one whose click was sent and never answered: the trade
 * may or may not have happened, and until now saying which meant looking in
 * the game. The balance can usually say instead - it fell by the asking price,
 * or it did not move at all - and this is the arithmetic that reads it.
 *
 * Pure, and deliberately reluctant. Every case it cannot argue from returns
 * `unknown`, which leaves the intent pending rather than resolving it wrongly;
 * an intent wrongly marked executed loses a trade the user meant to make, and
 * one wrongly marked not-executed buys the same thing twice.
 *
 * `evidence.item_in_inventory` only ever makes it *less* decisive: holding the
 * item is not proof of this purchase, because the bot may have owned one
 * already, so it can veto a conclusion but never reach one.
 */
function reconcileIntent(intent, evidence = {}, options = {}) {
  const windowSeconds = options.windowSeconds ?? RECONCILE_WINDOW_SECONDS;
  const now = evidence.now ?? Date.now() / 1000;
  const ageSeconds = typeof intent.ts === 'number' ? now - intent.ts : null;
  const before = intent.emeralds_before;
  const after = evidence.emeralds_now;
  const expected = expectedSpend(intent);
  const pendingCount = evidence.pending_count ?? 1;

  const base = {
    intent_id: intent.intent_id,
    age_seconds: ageSeconds === null ? null : Math.round(ageSeconds),
    emeralds_before: typeof before === 'number' ? before : null,
    emeralds_after: typeof after === 'number' ? after : null,
    expected_price: expected,
    item_in_inventory: evidence.item_in_inventory ?? null
  };
  const unknown = (reason) => ({ status: 'unknown', reason, ...base });

  if (typeof before !== 'number') return unknown('no balance was recorded before the click');
  if (typeof after !== 'number') return unknown('the bot cannot read its emerald balance now');
  if (ageSeconds !== null && ageSeconds > windowSeconds) {
    return unknown(`the intent is ${Math.round(ageSeconds / 60)} minutes old; a balance no longer witnesses it`);
  }

  const moved = before - after;

  // Nothing was spent, so nothing was bought - and that holds however many
  // intents are outstanding, because none of them could have moved a balance
  // that did not move. It holds only inside the window above, though:
  // "unchanged" hours later is not "untouched", since a purchase and a later
  // sale cancel out.
  if (moved === 0) {
    if (evidence.item_in_inventory === true) {
      return unknown('the balance did not move, yet the item is held; something else paid for it');
    }
    return { status: 'not_executed', reason: 'the balance did not move at all', ...base };
  }

  if (expected === null) return unknown('the intent did not record what the listing asked');

  // A balance is one number. Once more than one trade is outstanding it cannot
  // say which of them moved it, and two intents at the same price would both
  // look settled.
  if (pendingCount > 1) {
    return unknown(`${pendingCount} intents are unresolved; one balance cannot say which of them moved it`);
  }

  if (moved === expected) {
    return { status: 'executed', reason: 'the balance fell by exactly what the listing asked', ...base };
  }
  return unknown(`the balance fell by ${moved}, not the ${expected} the listing asked`);
}

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

    /**
     * Writes the outcome reconciliation arrived at, closing a pending intent.
     *
     * An `unknown` resolution writes nothing: the intent stays pending, which
     * is the truthful state. The row is marked `resolution: 'reconciled'` so
     * an outcome inferred after the fact is never mistaken for one the buy
     * path watched happen.
     */
    resolve(intentId, resolution) {
      const intent = intents.get(intentId);
      if (!intent) return null;
      if (!resolution || resolution.status === 'unknown') return null;
      if (outcomes.has(intentId)) return null;

      const executed = resolution.status === 'executed';
      return journal.recordOutcome({
        intent_id: intentId,
        status: resolution.status,
        item: intent.item ?? null,
        actual_price: executed ? (intent.observed_price ?? null) : null,
        units: intent.units || 1,
        emeralds_before: resolution.emeralds_before,
        emeralds_after: resolution.emeralds_after,
        // Only a purchase has books to agree. Nothing happened is not a
        // reconciliation failure, so it claims neither.
        reconciled: executed ? true : null,
        resolution: 'reconciled',
        reason: resolution.reason,
        age_seconds: resolution.age_seconds,
        error: null
      });
    },

    rows() {
      return readRows(file);
    }
  };

  return journal;
}

module.exports = {
  createJournal,
  journalPath,
  readRows,
  reconcileIntent,
  expectedSpend,
  RECONCILE_WINDOW_SECONDS
};
