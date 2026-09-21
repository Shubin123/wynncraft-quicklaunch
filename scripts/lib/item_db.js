'use strict';

/**
 * Wynncraft's item database, and the roll arithmetic the price model needs.
 *
 * A traded item is not one good. "Idol" is a *family* of goods: every drop
 * rolls each of its identifications independently, and two Idols can differ
 * in price by a multiple because one rolled well and the other did not.
 *
 * This module supplies the missing half. It reads the official item database
 * (https://api.wynncraft.com/v3/item/database?fullResult, 6,700-odd items),
 * which publishes, per identification, the range a roll can land in. From
 * that it can say how good a particular rolled item is, and, more usefully,
 * how *rare* that roll is.
 *
 * Two facts about the data, both verified against the whole database in
 * tests/test_roll_model.js rather than assumed:
 *
 * 1. `max` is always the better roll and `min` always the worse one, in
 *    every sign quadrant. Positive stats read `min < max` the obvious way.
 *    A penalty like `rawHealth: {min: -2340, raw: -1800, max: -1260}` still
 *    has the better roll in `max`. So does a cost reduction, where the
 *    ordering inverts numerically: `raw3rdSpellCost: {min: -1, raw: -3,
 *    max: -4}`. So quality is `(rolled - min) / (max - min)` everywhere,
 *    with no per-stat direction table to get wrong.
 *
 * 2. Not every identification rolls. Only the ones that arrive as
 *    `{min, raw, max}` (with `min !== max`) carry information about a
 *    particular drop; a plain integer is fixed and the same on every copy.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { erf } = require('./erf');

const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'wynn-dashboard');
const ITEM_DB_FILE = path.join(DATA_DIR, 'item_db.json');
const ITEM_DB_URL = 'https://api.wynncraft.com/v3/item/database?fullResult';

// Refetch weekly. Wynncraft changes item stats on game updates, not hourly.
const ITEM_DB_MAX_AGE_SECONDS = 7 * 24 * 3600;

// ---------------------------------------------------------------------------
// Attribute groups
// ---------------------------------------------------------------------------
//
// 96 identifications is far too many to weight one by one: the market has
// nothing like enough observed prices to fit 96 coefficients, and a model
// that tried would fit noise. They are collapsed into ten groups that
// players actually trade on, and it is the group weights the optimizer
// searches.
//
// Group order is part of the model file format: never reorder, only append.

const GROUP_NAMES = [
  'skill_points',   // the five attributes; gate what a build can equip at all
  'damage_pct',     // percentage damage, the usual scaling stat
  'damage_raw',     // flat damage, dominant at low levels and on some builds
  'defence',        // elemental and general damage reduction
  'health',         // health pool, regen, healing efficiency
  'mana',           // mana pool, regen, steal - the binding constraint on spellcasters
  'spell_cost',     // cost reductions; a build-defining stat when it lands
  'sustain',        // life steal and the like
  'mobility',       // walk speed, sprint, jump
  'utility',        // loot, xp, gathering; rarely what an item is bought for
];

const _SKILL_POINTS = new Set(['rawStrength', 'rawDexterity', 'rawIntelligence', 'rawDefence', 'rawAgility']);
const _HEALTH = new Set(['rawHealth', 'healthRegen', 'healthRegenRaw', 'healingEfficiency']);
const _MANA = new Set(['manaRegen', 'manaSteal', 'rawMaxMana']);
const _SUSTAIN = new Set(['lifeSteal']);
const _MOBILITY = new Set(['walkSpeed', 'sprint', 'sprintRegen', 'jumpHeight']);
const _UTILITY = new Set([
  'lootBonus', 'lootQuality', 'stealing', 'combatExperience',
  'gatherSpeed', 'gatherXpBonus', 'gatheringExperience',
]);
const _MISC_OFFENCE = new Set([
  'thorns', 'reflection', 'poison', 'exploding', 'knockback', 'slowEnemy',
  'weakenEnemy', 'mainAttackRange', 'rawAttackSpeed', 'criticalDamageBonus',
]);

/**
 * Which economic group an identification belongs to.
 *
 * Rules rather than a 96-line table, so an identification Wynncraft adds
 * later lands somewhere sensible instead of vanishing. Order matters: spell
 * costs are checked before damage, because `raw3rdSpellCost` would
 * otherwise match the raw-damage rule.
 */
function attributeGroup(name) {
  if (name.includes('SpellCost')) return 'spell_cost';
  if (_SKILL_POINTS.has(name)) return 'skill_points';
  if (_HEALTH.has(name)) return 'health';
  if (_MANA.has(name)) return 'mana';
  if (_SUSTAIN.has(name)) return 'sustain';
  if (_MOBILITY.has(name)) return 'mobility';
  if (_UTILITY.has(name)) return 'utility';
  if (name.endsWith('Defence') || name === 'elementalDefence') return 'defence';
  if (_MISC_OFFENCE.has(name)) return 'damage_pct';
  if (name.startsWith('raw') && name.includes('Damage')) return 'damage_raw';
  if (name.includes('Damage') || name === 'damage') return 'damage_pct';
  // Anything new and unrecognised is treated as utility: present, weighted,
  // but not assumed to be what someone paid for.
  return 'utility';
}

// Neutral until something is learned. These are the optimizer's starting
// point, not a claim about what the market values.
const DEFAULT_GROUP_WEIGHTS = Object.fromEntries(GROUP_NAMES.map((name) => [name, 1.0]));

// ---------------------------------------------------------------------------
// Loading the database
// ---------------------------------------------------------------------------

/** One call to the official item database. Throws on failure. */
async function fetchItemDb(url = ITEM_DB_URL, timeoutMs = 60000) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'wynncraft-quicklaunch-dashboard/1.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`item database request failed with status ${response.status}`);
  }
  let payload = await response.json();
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    // The v3 endpoint has returned both a list and a name-keyed object
    // across versions; accept either and normalise to a list.
    payload = Object.values(payload);
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('item database response was not a non-empty list');
  }
  return payload;
}

/**
 * The item database, keyed by lowercased display name.
 *
 * Cached on disk because it is six megabytes and changes on game updates,
 * not between trades. A stale cache is preferred to a failed fetch: an item
 * database from last week prices a roll far better than no database at all.
 */
async function loadItemDb({
  filePath = ITEM_DB_FILE,
  refresh = false,
  maxAge = ITEM_DB_MAX_AGE_SECONDS,
} = {}) {
  let cached = null;
  if (fs.existsSync(filePath)) {
    try {
      cached = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      cached = null;
    }
  }

  const freshEnough = cached
    && !refresh
    && (Date.now() / 1000 - (cached.fetched_ts || 0)) < maxAge;

  if (!freshEnough) {
    try {
      const items = await fetchItemDb();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      cached = { fetched_ts: Date.now() / 1000, items };
      fs.writeFileSync(filePath, JSON.stringify(cached));
    } catch (err) {
      if (cached === null) throw err;
      // Keep using what we have; being offline is not a reason to stop.
    }
  }

  const byName = {};
  for (const item of cached.items) {
    const name = item.displayName || item.internalName;
    if (name) {
      byName[String(name).trim().toLowerCase()] = item;
    }
  }
  return byName;
}

// ---------------------------------------------------------------------------
// Roll arithmetic
// ---------------------------------------------------------------------------

/**
 * Only the identifications that actually roll, with their ranges.
 *
 * A fixed integer identification is the same on every copy of the item, so
 * it says nothing about whether *this* copy is a good one.
 */
function rolledSpecs(item) {
  const specs = {};
  const identifications = (item && item.identifications) || {};
  for (const [name, value] of Object.entries(identifications)) {
    if (value && typeof value === 'object' && value.min !== undefined && value.min !== null
      && value.max !== undefined && value.max !== null) {
      if (value.min !== value.max) {
        specs[name] = value;
      }
    }
  }
  return specs;
}

/**
 * Where a rolled value sits in its range: 0.0 worst, 1.0 best.
 *
 * `max` is the better roll in every quadrant (see the module docstring), so
 * this needs no knowledge of whether the stat is a bonus or a penalty.
 * Clamped, because Wynncraft rounds displayed values and a legitimate roll
 * can land a hair outside the published range.
 */
function rollQuality(rolled, spec) {
  if (!spec || spec.min === undefined || spec.min === null
    || spec.max === undefined || spec.max === null) {
    return null;
  }
  const low = Number(spec.min);
  const high = Number(spec.max);
  const value = Number(rolled);
  if (Number.isNaN(low) || Number.isNaN(high) || Number.isNaN(value)) return null;
  if (high === low) return null;
  return Math.max(0.0, Math.min(1.0, (value - low) / (high - low)));
}

function _normalCdf(z) {
  return 0.5 * (1.0 + erf(z / Math.sqrt(2.0)));
}

/**
 * How rare a roll this good is, among the rolls this item can produce.
 *
 * This is the feature that matters, and the reason a plain average of
 * percentages misleads. Each attribute rolls roughly uniformly, so a
 * weighted mean of k of them concentrates around 0.5 with standard
 * deviation falling like 1/sqrt(k). A mean quality of 0.85 on a
 * one-attribute item is simply the 85th percentile. The same 0.85 across
 * five attributes is about 2.7 standard deviations out - better than 99% of
 * that item's drops. Identical "85%", wildly different scarcity, and it is
 * scarcity that people pay for.
 *
 * Exact for a single attribute. For more it is a normal approximation to a
 * weighted sum of uniforms, which is good in the middle and optimistic in
 * the extreme tail; it is used as a ranking signal, not as a probability
 * quoted to anyone.
 */
function rollPercentile(qualities, weights) {
  const pairs = [];
  for (let i = 0; i < qualities.length; i++) {
    const w = weights[i];
    if (w > 0) pairs.push([qualities[i], w]);
  }
  if (pairs.length === 0) return 0.5;
  if (pairs.length === 1) return pairs[0][0];

  const totalWeight = pairs.reduce((sum, [, w]) => sum + w, 0);
  const meanQuality = pairs.reduce((sum, [q, w]) => sum + q * w, 0) / totalWeight;
  // Var of a weighted mean of independent U(0,1) variables.
  const variance = pairs.reduce((sum, [, w]) => sum + (w / totalWeight) ** 2, 0) / 12.0;
  if (variance <= 0) return 0.5;
  return _normalCdf((meanQuality - 0.5) / Math.sqrt(variance));
}

/**
 * Everything the price model wants to know about one rolled item.
 *
 * `rolledValues` is what the listing actually shows, by identification
 * name. Attributes the item does not roll are ignored, and attributes it
 * rolls that the listing does not mention are treated as unobserved rather
 * than as zero - a lore line the parser missed must not read as a terrible
 * roll.
 */
function scoreRoll(item, rolledValues, weights = null) {
  const useWeights = weights || DEFAULT_GROUP_WEIGHTS;
  const specs = rolledSpecs(item);

  const qualities = [];
  const attrWeights = [];
  const groupsSeen = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (!(name in rolledValues)) continue;
    const quality = rollQuality(rolledValues[name], spec);
    if (quality === null) continue;
    const group = attributeGroup(name);
    const weight = Number(useWeights[group] !== undefined ? useWeights[group] : 1.0);
    qualities.push(quality);
    attrWeights.push(weight);
    if (!groupsSeen[group]) groupsSeen[group] = [];
    groupsSeen[group].push(quality);
  }

  const observed = qualities.length;
  const rollable = Object.keys(specs).length;
  if (qualities.length === 0) {
    return {
      quality_weighted: null, quality_mean: null, quality_max: null,
      percentile: null, n_rolled: rollable, n_observed: 0,
      coverage: 0.0, group_quality: {},
    };
  }

  const totalWeight = attrWeights.reduce((sum, w) => sum + w, 0) || 1.0;
  const groupQuality = {};
  for (const [group, values] of Object.entries(groupsSeen)) {
    groupQuality[group] = values.reduce((sum, v) => sum + v, 0) / values.length;
  }
  return {
    quality_weighted: qualities.reduce((sum, q, i) => sum + q * attrWeights[i], 0) / totalWeight,
    quality_mean: qualities.reduce((sum, q) => sum + q, 0) / qualities.length,
    quality_max: Math.max(...qualities),
    percentile: rollPercentile(qualities, attrWeights),
    n_rolled: rollable,
    n_observed: observed,
    // How much of the item we actually got to look at. A roll scored from
    // two of six attributes deserves less confidence than one scored from
    // all six, and the model is given the number rather than left to guess.
    coverage: rollable ? observed / rollable : 0.0,
    group_quality: groupQuality,
  };
}

// ---------------------------------------------------------------------------
// Model features
// ---------------------------------------------------------------------------

// Tier order, low to high. Part of the model file format: never renumber.
const TIER_ORDINAL = {
  normal: 0, unique: 1, set: 2, rare: 3,
  legendary: 4, fabled: 5, mythic: 6,
};

/**
 * The feature row for one rolled listing.
 *
 * Lives here, next to the arithmetic it summarises, because both the
 * trainer and the engine build it. Two copies of this function that
 * drifted apart would train on one set of numbers and predict on another,
 * which fails silently and looks like a bad model.
 */
function rollFeatures(tier, level, scored) {
  if (scored.quality_weighted === null || scored.quality_weighted === undefined) return null;
  const percentile = scored.percentile;
  return {
    tier_ordinal: TIER_ORDINAL[tier] !== undefined ? TIER_ORDINAL[tier] : 1,
    log_level: Math.log1p(Number(level || 1)),
    n_observed: Number(scored.n_observed),
    coverage: scored.coverage,
    quality_mean: scored.quality_mean,
    quality_max: scored.quality_max,
    quality_weighted: scored.quality_weighted,
    percentile,
    // The premium is convex in percentile, and a small tanh net fits a
    // convex curve far more readily when handed the square as well.
    percentile_sq: percentile * percentile,
  };
}

// ---------------------------------------------------------------------------
// Reading rolls off a listing
// ---------------------------------------------------------------------------

// Wynncraft writes identifications into item lore as lines like
//
//     +55 Strength          -12% Walk Speed        +8/5s Mana Regen
//
// and the API's camelCase keys have to be recovered from those display
// labels. The `%` matters: identifications come in a percentage form and a
// flat form that *share a display label* - "Spell Damage" is `spellDamage`
// with a percent sign and `rawSpellDamage` without, "Health Regen" is
// `healthRegen` or `healthRegenRaw`. A parser that ignored the sign would
// quietly score a flat roll against a percentage range, which is not a
// small error: the ranges are different sizes and the quality would be
// meaningless rather than merely wrong.
//
// Each label maps to [percentage form, flat form]. Where only one form
// exists the unit does not disambiguate anything and either reading is
// accepted.

const _ELEMENTS = ['earth', 'thunder', 'water', 'fire', 'air', 'neutral', 'elemental'];
const _SPELL_ORDINALS = ['1st', '2nd', '3rd', '4th'];

function _capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function _buildLoreNames() {
  const forms = {
    // skill points and pools: flat only
    strength: [null, 'rawStrength'],
    dexterity: [null, 'rawDexterity'],
    intelligence: [null, 'rawIntelligence'],
    defence: [null, 'rawDefence'],
    defense: [null, 'rawDefence'],
    agility: [null, 'rawAgility'],
    health: [null, 'rawHealth'],
    'max mana': [null, 'rawMaxMana'],
    // both forms share a label
    'health regen': ['healthRegen', 'healthRegenRaw'],
    'spell damage': ['spellDamage', 'rawSpellDamage'],
    'main attack damage': ['mainAttackDamage', 'rawMainAttackDamage'],
    damage: ['damage', 'rawDamage'],
    // single form
    'mana regen': [null, 'manaRegen'],
    'mana steal': [null, 'manaSteal'],
    'life steal': [null, 'lifeSteal'],
    'walk speed': ['walkSpeed', null],
    sprint: ['sprint', null],
    'sprint regen': ['sprintRegen', null],
    'jump height': [null, 'jumpHeight'],
    'attack speed': [null, 'rawAttackSpeed'],
    'main attack range': [null, 'mainAttackRange'],
    'healing efficiency': ['healingEfficiency', null],
    'critical damage bonus': ['criticalDamageBonus', null],
    'critical damage': ['criticalDamageBonus', null],
    'elemental defence': ['elementalDefence', null],
    poison: [null, 'poison'],
    thorns: ['thorns', null],
    reflection: ['reflection', null],
    exploding: ['exploding', null],
    knockback: ['knockback', null],
    'slow enemy': ['slowEnemy', null],
    'weaken enemy': ['weakenEnemy', null],
    stealing: ['stealing', null],
    'loot bonus': ['lootBonus', null],
    'loot quality': ['lootQuality', null],
    'xp bonus': ['combatExperience', null],
    'combat xp bonus': ['combatExperience', null],
    'gather xp bonus': ['gatherXpBonus', null],
    'gathering xp bonus': ['gatheringExperience', null],
    'gather speed': ['gatherSpeed', null],
  };
  for (const element of _ELEMENTS) {
    const title = _capitalize(element);
    forms[`${element} damage`] = [`${element}Damage`, `raw${title}Damage`];
    forms[`${element} spell damage`] = [`${element}SpellDamage`, `raw${title}SpellDamage`];
    forms[`${element} main attack damage`] = [`${element}MainAttackDamage`, `raw${title}MainAttackDamage`];
    if (element !== 'neutral') {
      forms[`${element} defence`] = [`${element}Defence`, null];
    }
  }
  for (const ordinal of _SPELL_ORDINALS) {
    const title = ordinal[0].toUpperCase() + ordinal.slice(1);
    forms[`${ordinal} spell cost`] = [`${ordinal}SpellCost`, `raw${title}SpellCost`];
  }
  return forms;
}

const _LORE_NAME_FORMS = _buildLoreNames();

// "<number>[%][/Ns] <label>". The sign is part of the number; the percent
// sign and the "/3s" cadence are units, not part of the label.
const _LORE_LINE = /^([+-]?\d+(?:\.\d+)?)\s*(%)?(?:\s*\/\s*\d+s)?\s+(.+)$/;

// Colour codes, and the bracketed roll percentage or star rating Wynncraft
// appends to an identified item.
const _COLOUR = /§[0-9a-fk-or]/gi;
const _BRACKETED = /[[(][^\])]*[\])]/g;
const _TRAILING_MARKS = /[☀-➿⬀-⯿*+\s]+$/;

/** The API key for a display label, given whether the line carried a `%`. */
function loreKey(label, isPercent) {
  const forms = _LORE_NAME_FORMS[label.trim().toLowerCase()];
  if (!forms) return null;
  const [percentForm, flatForm] = forms;
  if (isPercent && percentForm) return percentForm;
  if (!isPercent && flatForm) return flatForm;
  // Only one form exists, so the unit distinguishes nothing.
  return percentForm || flatForm;
}

/**
 * Pulls rolled identifications out of a listing's lore.
 *
 * Deliberately forgiving. Lore carries colour codes, glyphs, requirement
 * lines, flavour text and the price, and anything that is not recognisably
 * "<number> <known stat>" is skipped rather than guessed at. A skipped line
 * costs coverage, which `scoreRoll` reports and the model is given; a
 * misread line would poison a price, which nothing reports.
 */
function parseIdentificationLore(lines) {
  const found = {};
  for (const line of lines || []) {
    if (typeof line !== 'string') continue;
    const text = line.replace(_COLOUR, '').replace(_BRACKETED, ' ').trim();
    if (!text || text.includes(':')) continue; // "Price: ...", "Seller: ...", "Combat Lv. Min: ..."
    const match = _LORE_LINE.exec(text);
    if (!match) continue;
    const [, number, percent, label] = match;
    const key = loreKey(label.replace(_TRAILING_MARKS, ''), Boolean(percent));
    if (!key) continue;
    const value = Number(number);
    if (Number.isNaN(value) || !Number.isFinite(value)) continue;
    // First reading wins: Wynncraft lists each identification once, and a
    // second match is more likely a flavour line that happened to parse.
    if (!(key in found)) found[key] = value;
  }
  return found;
}

module.exports = {
  DATA_DIR,
  ITEM_DB_FILE,
  ITEM_DB_URL,
  ITEM_DB_MAX_AGE_SECONDS,
  GROUP_NAMES,
  DEFAULT_GROUP_WEIGHTS,
  TIER_ORDINAL,
  attributeGroup,
  fetchItemDb,
  loadItemDb,
  rolledSpecs,
  rollQuality,
  rollPercentile,
  scoreRoll,
  rollFeatures,
  loreKey,
  parseIdentificationLore,
};
