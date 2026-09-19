const assert = require('assert');
const { Vec3 } = require('vec3');

const {
  resolveRenderVersion,
  hasViewerAssets,
  createStateTranslator,
  translateColumnJson
} = require('../src/blockstates');

const BOT_VERSION = '26.1';

console.log('Running 3D viewer block-state translation tests...');

// Test 1: the viewer bundle cannot render Wynncraft's protocol version directly
const { supportedVersions } = require('prismarine-viewer');
assert.ok(!supportedVersions.includes(BOT_VERSION),
  `prismarine-viewer unexpectedly supports ${BOT_VERSION}; the translation layer can be dropped`);
console.log(`✔ Test 1 passed: prismarine-viewer does not support ${BOT_VERSION} (max ${supportedVersions[supportedVersions.length - 1]})`);

// Test 2: a renderable version is resolved and its assets exist
const renderVersion = resolveRenderVersion(BOT_VERSION);
assert.ok(renderVersion, 'A render version should be resolved');
assert.ok(supportedVersions.includes(renderVersion), 'Render version must be supported by the viewer');
assert.ok(hasViewerAssets(renderVersion), 'Render version must have texture + blocksStates assets');
console.log(`✔ Test 2 passed: ${BOT_VERSION} renders as ${renderVersion}`);

// Test 3: a directly supported version is passed through untouched
assert.strictEqual(resolveRenderVersion(renderVersion), renderVersion, 'Supported versions render as themselves');
console.log('✔ Test 3 passed: supported bot versions are not remapped');

// Test 4: the translation table maps the vast majority of states exactly
const translator = createStateTranslator(BOT_VERSION, renderVersion);
const { exact, byName, substituted, air, total } = translator.stats;
assert.ok(exact / total > 0.9, `Expected >90% exact state matches, got ${(100 * exact / total).toFixed(1)}%`);
console.log(`✔ Test 4 passed: ${exact}/${total} exact (${(100 * exact / total).toFixed(1)}%), ${byName} by name, ${substituted} substituted, ${air} air`);

// Test 5: raw state ids really do differ between the versions (the actual bug)
const srcBlocks = require('minecraft-data')(BOT_VERSION).blocksByName;
const dstBlocks = require('minecraft-data')(renderVersion).blocksByName;
const shifted = Object.keys(srcBlocks).filter(name =>
  dstBlocks[name] && srcBlocks[name].defaultState !== dstBlocks[name].defaultState);
assert.ok(shifted.length > 100, 'Expected many block states to shift between versions');
console.log(`✔ Test 5 passed: ${shifted.length} blocks have different state ids across versions`);

// Test 6: chunk round-trip - blocks survive translation with the right identity
const SrcChunk = require('prismarine-chunk')(BOT_VERSION);
const DstChunk = require('prismarine-chunk')(renderVersion);

const commonSamples = ['stone', 'oak_log', 'water', 'glass', 'oak_leaves'];
// Blocks whose state ids moved between the two versions exercise the remap itself.
const shiftedSamples = shifted.slice().sort().filter(name => {
  const block = srcBlocks[name];
  return block && block.boundingBox === 'block' && block.defaultState > 0;
}).slice(0, 5);
assert.ok(shiftedSamples.length === 5, 'Expected at least 5 shifted full-cube blocks to sample');

const samples = [...commonSamples, ...shiftedSamples].map((name, idx) => ({
  name,
  pos: new Vec3(idx % 16, 10 + idx * 7, (idx * 3) % 16)
}));

const column = new SrcChunk({ minY: -64, worldHeight: 384 });
for (const sample of samples) {
  const block = srcBlocks[sample.name];
  assert.ok(block, `${sample.name} should exist in ${BOT_VERSION}`);
  sample.srcState = block.defaultState;
  column.setBlockStateId(sample.pos, sample.srcState);
}

const translated = DstChunk.fromJson(translateColumnJson(column.toJson(), translator.translate));
for (const sample of samples) {
  const rendered = translated.getBlock(sample.pos);
  assert.strictEqual(rendered.name, sample.name,
    `${sample.name} at ${sample.pos} rendered as ${rendered.name}`);
}
console.log(`✔ Test 6 passed: ${samples.length} sample blocks round-trip to the correct block in ${renderVersion} (incl. ${shiftedSamples.join(', ')})`);

// Test 7: untranslated state ids would render the wrong blocks (regression guard)
const untranslated = DstChunk.fromJson(column.toJson());
const wrong = samples.filter(s => untranslated.getBlock(s.pos).name !== s.name);
assert.ok(wrong.length > 0, 'Expected raw state ids to render incorrectly without translation');
console.log(`✔ Test 7 passed: ${wrong.length}/${samples.length} sample blocks would be wrong without translation (${wrong.map(w => `${w.name}->${untranslated.getBlock(w.pos).name}`).join(', ')})`);

// Test 8: sections with more than 256 distinct states use a direct palette
const dense = new SrcChunk({ minY: -64, worldHeight: 384 });
const denseStates = [];
const allSrc = Object.values(srcBlocks).filter(b => b.defaultState > 0).slice(0, 400);
let i = 0;
for (let x = 0; x < 16 && i < allSrc.length; x++) {
  for (let z = 0; z < 16 && i < allSrc.length; z++) {
    for (let y = 0; y < 2 && i < allSrc.length; y++) {
      const pos = new Vec3(x, 16 + y, z);
      dense.setBlockStateId(pos, allSrc[i].defaultState);
      denseStates.push({ pos, name: allSrc[i].name });
      i++;
    }
  }
}
const denseJson = JSON.parse(dense.toJson());
const containerTypes = denseJson.sections.map(s => JSON.parse(JSON.parse(s).data).type);
assert.ok(containerTypes.includes('direct'), `Expected a direct palette section, got ${[...new Set(containerTypes)].join(', ')}`);

const denseTranslated = DstChunk.fromJson(translateColumnJson(dense.toJson(), translator.translate));
let matched = 0;
for (const { pos, name } of denseStates) {
  if (denseTranslated.getBlock(pos).name === name) matched++;
}
assert.ok(matched / denseStates.length > 0.85,
  `Direct palette translation kept only ${matched}/${denseStates.length} blocks`);
console.log(`✔ Test 8 passed: direct palette section translated, ${matched}/${denseStates.length} blocks kept their identity`);

console.log('\n\x1b[1;32mAll viewer translation tests passed.\x1b[0m');
