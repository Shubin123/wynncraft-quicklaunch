/**
 * End-to-end check of what the 3D viewer actually sends to the browser.
 *
 * The earlier translation tests verified the functions; they did not verify
 * that attachViewer puts a *renderable* version on the socket. That gap is
 * exactly the bug this guards: prismarine-viewer's client calls
 * getVersion(version) and, when that returns null, alerts "null is not
 * supported" and never starts the chunk worker, leaving an empty world.
 *
 * So this starts the real viewer against a stand-in bot, connects a real
 * socket.io client the way the browser does, and asserts on the frames.
 */

const assert = require('assert');
const EventEmitter = require('events');
const { Vec3 } = require('vec3');
const { io } = require('socket.io-client');

const { attachViewer } = require('../src/viewer');
const { supportedVersions } = require('prismarine-viewer');
const { getVersion } = require('prismarine-viewer/viewer/lib/version');

const BOT_VERSION = '26.1';
const PORT = parseInt(process.env.WYNN_TEST_VIEWER_PORT || '3711', 10);

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

/**
 * A bot stand-in with exactly the surface prismarine-viewer touches.
 */
function fakeBot(version) {
  const Chunk = require('prismarine-chunk')(version);
  const mcData = require('minecraft-data')(version);

  const column = new Chunk({ minY: -64, worldHeight: 384 });
  // Landmarks whose state ids differ between 26.1 and the render version.
  const planted = [
    { name: 'stone', pos: new Vec3(0, 60, 0) },
    { name: 'acacia_fence', pos: new Vec3(3, 61, 4) },
    { name: 'oak_log', pos: new Vec3(8, 62, 9) }
  ];
  for (const item of planted) {
    column.setBlockStateId(item.pos, mcData.blocksByName[item.name].defaultState);
  }

  const bot = new EventEmitter();
  bot.version = version;
  bot.username = 'WireTestBot';
  bot.entity = { id: 1, position: new Vec3(8, 64, 8), yaw: 0, pitch: 0 };
  bot.entities = { 1: bot.entity };
  bot.world = {
    async getColumnAt() { return column; },
    raycast() { return null; }
  };
  return { bot, planted };
}

/**
 * Collects the frames a freshly connected browser would receive.
 */
function collectFrames(port, { waitForChunk = true, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://localhost:${port}`, { transports: ['websocket', 'polling'] });
    const frames = { version: null, chunks: [] };
    const finish = () => {
      clearTimeout(timer);
      socket.close();
      resolve(frames);
    };
    const timer = setTimeout(() => {
      socket.close();
      if (frames.version === null) reject(new Error('no version frame arrived'));
      else resolve(frames);
    }, timeoutMs);

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
    socket.on('version', (version) => {
      frames.version = version;
      if (!waitForChunk) finish();
    });
    socket.on('loadChunk', (payload) => {
      frames.chunks.push(payload);
      if (frames.chunks.length >= 1 && frames.version !== null) finish();
    });
  });
}

(async () => {
  console.log('Running viewer wire tests...');

  const { bot, planted } = fakeBot(BOT_VERSION);
  const handle = attachViewer(bot, { port: PORT, viewDistance: 2 });

  try {
    await test('attachViewer reports the translation it is applying', () => {
      assert.ok(handle, 'the viewer should start');
      assert.strictEqual(handle.botVersion, BOT_VERSION);
      assert.ok(handle.translated, 'a 26.1 bot must be translated for the viewer');
      assert.notStrictEqual(handle.renderVersion, BOT_VERSION);
    });

    const frames = await collectFrames(PORT);

    await test('The browser receives a version its bundle can render', () => {
      assert.strictEqual(frames.version, handle.renderVersion, 'the wire version must be the render version');
      assert.ok(supportedVersions.includes(frames.version),
        `${frames.version} is not in the viewer's supported list`);

      // This is the exact call the client makes before rendering anything.
      // When it returns null the client alerts "null is not supported".
      assert.notStrictEqual(getVersion(frames.version), null,
        `the client would reject ${frames.version} and render an empty world`);
      assert.strictEqual(getVersion(frames.version), frames.version);
    });

    await test('The raw bot version would still break the client (regression guard)', () => {
      assert.strictEqual(getVersion(BOT_VERSION), null,
        'if upstream ever supports 26.1 directly, the translation layer can be dropped');
    });

    await test('Chunks arrive and decode against the render version', () => {
      assert.ok(frames.chunks.length > 0, 'the viewer must send at least one chunk column');
      const RenderChunk = require('prismarine-chunk')(frames.version);
      const decoded = RenderChunk.fromJson(frames.chunks[0].chunk);
      assert.ok(decoded, 'the browser must be able to parse the chunk payload');

      // The chunk the viewer sends is the column repeated at every position,
      // so the landmarks are present in whichever one arrived first.
      for (const item of planted) {
        const block = decoded.getBlock(item.pos);
        assert.strictEqual(block.name, item.name,
          `${item.name} arrived as ${block.name}; the state id translation is wrong on the wire`);
      }
    });

    await test('Untranslated chunks would render the wrong blocks (regression guard)', () => {
      const SourceChunk = require('prismarine-chunk')(BOT_VERSION);
      const RenderChunk = require('prismarine-chunk')(frames.version);
      const mcData = require('minecraft-data')(BOT_VERSION);
      const raw = new SourceChunk({ minY: -64, worldHeight: 384 });
      const fence = planted.find(p => p.name === 'acacia_fence');
      raw.setBlockStateId(fence.pos, mcData.blocksByName.acacia_fence.defaultState);

      const wrong = RenderChunk.fromJson(raw.toJson()).getBlock(fence.pos);
      assert.notStrictEqual(wrong.name, 'acacia_fence',
        'this version pair no longer diverges; the wire test would pass for the wrong reason');
    });
  } finally {
    if (bot.viewer && bot.viewer.close) bot.viewer.close();
  }

  console.log(`\n\x1b[1;32mViewer wire tests: ${passed} passed.\x1b[0m`);
  // socket.io's server keeps handles alive briefly; do not hang the suite.
  setTimeout(() => process.exit(process.exitCode || 0), 250);
})();
