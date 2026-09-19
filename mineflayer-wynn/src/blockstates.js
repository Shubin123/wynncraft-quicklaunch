const fs = require('fs');
const path = require('path');

const BitArray = require('prismarine-chunk/src/pc/common/BitArrayNoSpan');
const neededBits = require('prismarine-chunk/src/pc/common/neededBits');

/**
 * Default Minecraft version the 3D viewer renders with.
 *
 * Wynncraft (WynnProxy) speaks protocol 775 / '26.1', which the prebuilt
 * prismarine-viewer browser bundle does not know about: its supportedVersions
 * list stops at 1.21.4 and its bundled minecraft-data has no 26.1 entry. Feeding
 * it '26.1' makes viewer.setVersion() bail out, so the renderer never receives a
 * version, the chunk worker is never initialised and the world stays empty.
 *
 * We therefore render with a version the bundle does support and translate block
 * state ids on the way out. Keep this in sync with scripts/apply_wynn_textures.py,
 * which patches the texture atlas of the very same version.
 */
const DEFAULT_RENDER_VERSION = process.env.WYNN_VIEWER_MC_VERSION || '1.21.4';

/**
 * Locates prismarine-viewer's public asset directory (textures + blocksStates).
 */
function getViewerPublicDir() {
  try {
    return path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public');
  } catch (err) {
    return null;
  }
}

/**
 * A version is only renderable if the browser bundle accepts it *and* the two
 * asset files it fetches for that version exist on disk.
 */
function hasViewerAssets(version) {
  const pub = getViewerPublicDir();
  if (!pub) return false;
  return fs.existsSync(path.join(pub, 'textures', `${version}.png`)) &&
    fs.existsSync(path.join(pub, 'blocksStates', `${version}.json`));
}

/**
 * Picks the version the browser viewer should render with for a given bot version.
 * Returns the bot's own version when it is directly supported, otherwise the
 * newest supported version that still has assets shipped with prismarine-viewer.
 */
function resolveRenderVersion(botVersion, preferred = DEFAULT_RENDER_VERSION) {
  let supported = [];
  try {
    supported = require('prismarine-viewer').supportedVersions || [];
  } catch (err) {
    supported = [];
  }

  if (botVersion && supported.includes(botVersion) && hasViewerAssets(botVersion)) {
    return botVersion;
  }
  if (preferred && supported.includes(preferred) && hasViewerAssets(preferred)) {
    return preferred;
  }
  for (let i = supported.length - 1; i >= 0; i--) {
    if (hasViewerAssets(supported[i])) return supported[i];
  }
  return null;
}

/**
 * Builds "name|prop=value,..." signatures for every block state id of a version.
 */
function stateSignatures(version) {
  const Block = require('prismarine-block')(version);
  const mcData = require('minecraft-data')(version);

  let maxStateId = 0;
  for (const block of Object.values(mcData.blocks)) {
    if (block.maxStateId > maxStateId) maxStateId = block.maxStateId;
  }

  const signatures = new Array(maxStateId + 1).fill(null);
  for (let stateId = 0; stateId <= maxStateId; stateId++) {
    try {
      const block = Block.fromStateId(stateId, 0);
      if (!block || !block.name) continue;
      const props = typeof block.getProperties === 'function' ? block.getProperties() : {};
      const suffix = Object.keys(props).sort().map(k => `${k}=${props[k]}`).join(',');
      signatures[stateId] = `${block.name}|${suffix}`;
    } catch (err) {
      // State id belongs to no block in this version; leave it null.
    }
  }
  return signatures;
}

const translatorCache = new Map();

/**
 * Builds a block state id translation table between two Minecraft versions.
 *
 * Block ids shift between versions (26.1 has 1168 blocks against 1.21.4's 1095,
 * diverging from block id 133 onwards), so forwarding raw state ids would render
 * a world made of the wrong blocks. Matching on block name + properties keeps
 * over 93% of states exact; the rest fall back to the block's default state, and
 * blocks that do not exist in the render version become stone (when they are
 * full cubes, so terrain keeps its shape) or air.
 */
function createStateTranslator(fromVersion, toVersion) {
  const cacheKey = `${fromVersion}->${toVersion}`;
  if (translatorCache.has(cacheKey)) return translatorCache.get(cacheKey);

  if (fromVersion === toVersion) {
    const identity = {
      identity: true,
      stats: { exact: 0, byName: 0, substituted: 0, air: 0, total: 0 },
      translate: (stateId) => stateId
    };
    translatorCache.set(cacheKey, identity);
    return identity;
  }

  const srcSignatures = stateSignatures(fromVersion);
  const dstSignatures = stateSignatures(toVersion);
  const srcData = require('minecraft-data')(fromVersion);
  const dstData = require('minecraft-data')(toVersion);

  const stateBySignature = new Map();
  for (let stateId = 0; stateId < dstSignatures.length; stateId++) {
    const sig = dstSignatures[stateId];
    if (sig && !stateBySignature.has(sig)) stateBySignature.set(sig, stateId);
  }

  const defaultStateByName = new Map();
  for (const block of Object.values(dstData.blocks)) {
    defaultStateByName.set(block.name, block.defaultState);
  }

  // Full-cube blocks missing from the render version keep their volume as stone.
  const fullCubeSourceStates = new Set();
  for (const block of Object.values(srcData.blocks)) {
    if (block.boundingBox === 'block') {
      for (let s = block.minStateId; s <= block.maxStateId; s++) fullCubeSourceStates.add(s);
    }
  }
  const stoneState = defaultStateByName.get('stone') ?? 0;

  const table = new Int32Array(srcSignatures.length);
  const stats = { exact: 0, byName: 0, substituted: 0, air: 0, total: srcSignatures.length };

  for (let stateId = 0; stateId < srcSignatures.length; stateId++) {
    const sig = srcSignatures[stateId];
    if (!sig) {
      table[stateId] = 0;
      stats.air++;
      continue;
    }
    const exact = stateBySignature.get(sig);
    if (exact !== undefined) {
      table[stateId] = exact;
      stats.exact++;
      continue;
    }
    const name = sig.slice(0, sig.indexOf('|'));
    const byName = defaultStateByName.get(name);
    if (byName !== undefined) {
      table[stateId] = byName;
      stats.byName++;
      continue;
    }
    if (fullCubeSourceStates.has(stateId)) {
      table[stateId] = stoneState;
      stats.substituted++;
    } else {
      table[stateId] = 0;
      stats.air++;
    }
  }

  const translator = {
    identity: false,
    fromVersion,
    toVersion,
    stats,
    table,
    translate: (stateId) => (stateId >= 0 && stateId < table.length ? table[stateId] : 0)
  };
  translatorCache.set(cacheKey, translator);
  return translator;
}

/**
 * Re-encodes a 'direct' palette container as an 'indirect' one, translating every
 * block state id on the way. A direct container stores global state ids packed at
 * a fixed bit width; the indirect form stores palette indices plus a palette,
 * which is what prismarine-chunk can actually read back from JSON.
 */
function directToIndirect(container, translate) {
  const source = BitArray.fromJson(container.data);
  const capacity = source.capacity;

  const palette = [];
  const paletteIndex = new Map();
  const indices = new Array(capacity);

  for (let i = 0; i < capacity; i++) {
    const stateId = translate(source.get(i));
    let index = paletteIndex.get(stateId);
    if (index === undefined) {
      index = palette.length;
      palette.push(stateId);
      paletteIndex.set(stateId, index);
    }
    indices[i] = index;
  }

  const bitsPerValue = Math.max(4, neededBits(Math.max(palette.length - 1, 1)));
  const data = new BitArray({ bitsPerValue, capacity });
  for (let i = 0; i < capacity; i++) data.set(i, indices[i]);

  return {
    type: 'indirect',
    palette,
    // Keep maxBits at or above the width we used so the reader does not try to
    // promote this container straight back to a direct one.
    maxBits: Math.max(bitsPerValue, 8),
    maxBitsPerBlock: container.maxBitsPerBlock ?? source.bitsPerValue,
    data: data.toJson()
  };
}

/**
 * Remaps the block state ids inside one serialized chunk section.
 * Sections carry a nested JSON palette container: 'single' (one state for the
 * whole section), 'indirect' (a palette of states) or 'direct' (raw packed ids).
 */
function translateSectionJson(sectionJson, translate) {
  let section;
  try {
    section = JSON.parse(sectionJson);
  } catch (err) {
    return sectionJson;
  }
  if (typeof section.data !== 'string') return sectionJson;

  let container;
  try {
    container = JSON.parse(section.data);
  } catch (err) {
    return sectionJson;
  }

  if (container.type === 'single') {
    container.value = translate(container.value);
  } else if (container.type === 'indirect' && Array.isArray(container.palette)) {
    container.palette = container.palette.map(translate);
  } else if (container.type === 'direct') {
    // prismarine-chunk's DirectPaletteContainer.fromJson discards the bit array it
    // is handed (it builds an empty one from the options instead), so a direct
    // section would arrive at the viewer completely empty even without any
    // translation. Re-encode it as an indirect container, which deserializes
    // correctly, while remapping the state ids.
    try {
      const rewritten = directToIndirect(container, translate);
      if (!rewritten) return sectionJson;
      container = rewritten;
    } catch (err) {
      return sectionJson;
    }
  } else {
    return sectionJson;
  }

  section.data = JSON.stringify(container);
  return JSON.stringify(section);
}

/**
 * Remaps every block state id in a serialized chunk column.
 */
function translateColumnJson(columnJson, translate) {
  let column;
  try {
    column = JSON.parse(columnJson);
  } catch (err) {
    return columnJson;
  }
  if (Array.isArray(column.sections)) {
    column.sections = column.sections.map(section => translateSectionJson(section, translate));
  }
  return JSON.stringify(column);
}

module.exports = {
  DEFAULT_RENDER_VERSION,
  getViewerPublicDir,
  hasViewerAssets,
  resolveRenderVersion,
  createStateTranslator,
  translateColumnJson,
  translateSectionJson
};
