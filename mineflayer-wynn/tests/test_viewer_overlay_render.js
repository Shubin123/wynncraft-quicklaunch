/**
 * Runs the tracking overlay against stub DOM and stub THREE objects.
 *
 * The overlay's whole trick is reaching the viewer's private camera by
 * wrapping THREE.WebGLRenderer.prototype.render and
 * THREE.OrbitControls.prototype.update. That is precisely the part unit tests
 * on the maths cannot cover, so this drives the real file in a VM: it renders
 * a frame the way the viewer's animate() loop does, and checks the camera
 * actually follows.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../src/viewer-overlay.js'), 'utf8');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.stack.split('\n').slice(0, 3).join('\n  ')}`);
    process.exitCode = 1;
  }
}

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], style: {}, className: '',
    type: '', disabled: false, textContent: '', events: {}
  };
  node.classList = {
    toggle: (name, on) => {
      const has = node.className.split(' ').includes(name);
      if (on === undefined ? !has : on) {
        if (!has) node.className = `${node.className} ${name}`.trim();
      } else {
        node.className = node.className.split(' ').filter(c => c && c !== name).join(' ');
      }
    },
    contains: (name) => node.className.split(' ').includes(name)
  };
  node.appendChild = (child) => { node.children.push(child); return child; };
  node.addEventListener = (type, handler) => { (node.events[type] = node.events[type] || []).push(handler); };
  node.dispatch = (type, event) => (node.events[type] || []).forEach(h => h(event));
  return node;
}

/**
 * A three r128 stand-in, shaped the way the real one is:
 *  - renderer.render and controls.update are OWN properties set in the
 *    constructor, so there is no prototype to patch there;
 *  - the namespace's exports are non-configurable getters, exactly as webpack
 *    exposes them, so anything that tries to redefine one throws;
 *  - the renderer calls camera.updateMatrixWorld() each frame, and
 *    OrbitControls inherits dispatchEvent from EventDispatcher.
 * Getting this shape wrong is how an overlay can look fine in tests and
 * capture nothing in a browser.
 */
function makeThree() {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  }
  class EventDispatcher {
    dispatchEvent(event) { this.lastEvent = event; }
  }
  class PerspectiveCamera {
    constructor() { this.position = new Vector3(); this.matrixWorldUpdates = 0; }
    updateMatrixWorld() { this.matrixWorldUpdates++; }
  }
  function WebGLRenderer() {
    this.renderCalls = 0;
    this.render = function (scene, camera) {
      this.renderCalls++;
      camera.updateMatrixWorld();   // three does this every frame
    };
  }
  class OrbitControls extends EventDispatcher {
    constructor(camera) {
      super();
      this.object = camera;
      this.target = new Vector3();
      this.updateCalls = 0;
      this.update = function () {
        this.updateCalls++;
        this.dispatchEvent({ type: 'change' }); // fires when the view moves
      };
    }
  }

  // Webpack exposes an ESM namespace as non-configurable getters.
  const namespace = {};
  for (const [name, value] of Object.entries({ Vector3, EventDispatcher, PerspectiveCamera, WebGLRenderer })) {
    Object.defineProperty(namespace, name, { enumerable: true, get: () => value });
  }
  return { namespace, OrbitControls };
}

/**
 * Replays the viewer bundle's startup: publish THREE on window, let the
 * examples file attach OrbitControls, build the camera, renderer and
 * controls, then run a frame - which is when the capture happens.
 */
function startViewer(sandbox, { withControls = true } = {}) {
  const { namespace, OrbitControls } = makeThree();
  sandbox.THREE = namespace;
  const camera = new namespace.PerspectiveCamera();
  const renderer = new namespace.WebGLRenderer();
  let controls = null;
  if (withControls) {
    namespace.OrbitControls = OrbitControls; // examples/js attaches it here
    controls = new namespace.OrbitControls(camera);
  }
  renderer.render({}, camera);
  if (controls) controls.update();
  return { camera, renderer, controls, namespace };
}

function boot({ position = { x: 0, y: 64, z: 0 }, ok = true } = {}) {
  const body = makeNode('body');
  const head = makeNode('head');
  const frames = [];
  const intervals = [];
  const fetches = [];
  const posted = [];

  const document = {
    readyState: 'complete',
    head,
    body,
    createElement: makeNode,
    currentScript: { src: 'http://localhost:3000/wynn-viewer-overlay.js?api=http%3A%2F%2Flocalhost%3A8123' },
    referrer: 'http://localhost:8123/bot.html',
    events: {},
    addEventListener: (type, handler) => { (document.events[type] = document.events[type] || []).push(handler); }
  };

  const sandbox = {
    document,
    console,
    location: { href: 'http://localhost:3000/', protocol: 'http:', hostname: 'localhost' },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 1; },
    Event: class { constructor(type) { this.type = type; } },
    dispatchEvent: () => {},
    fetch: async (url) => {
      fetches.push(url);
      return { json: async () => ({ ok, position: ok ? position : null }) };
    },
    events: {},
    addEventListener: (type, handler) => { (sandbox.events[type] = sandbox.events[type] || []).push(handler); },
    dispatch: (type, event) => (sandbox.events[type] || []).forEach(h => h(event))
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.URL = URL;
  sandbox.parent = { postMessage: (message, origin) => posted.push({ message, origin }) };

  vm.runInNewContext(SOURCE, sandbox, { filename: 'viewer-overlay.js' });

  const api = sandbox.WynnViewerTracking;
  const bar = body.children.find(child => child.className === 'wynn-track-bar');
  const button = bar.children.find(child => child.tagName === 'BUTTON');

  /** Runs one animation frame the way the browser would. */
  const step = (times = 1) => {
    for (let i = 0; i < times; i++) {
      const pending = frames.splice(0, frames.length);
      for (const fn of pending) fn();
    }
  };

  return { sandbox, api, body, button, frames, intervals, fetches, posted, step, document };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  console.log('Running viewer overlay render tests...');

  await test('The overlay adds a track button without touching the canvas', () => {
    const { body, button, api } = boot();
    const bars = body.children.filter(child => child.className === 'wynn-track-bar');
    assert.strictEqual(bars.length, 1, 'one control bar');
    assert.ok(button, 'with a button in it');
    assert.match(button.textContent, /Track character/);
    assert.strictEqual(api.isTracking(), false, 'tracking starts off');
  });

  await test('Patching the THREE prototypes captures the camera and controls', async () => {
    const { sandbox, api, step } = boot();
    await flush();
    assert.strictEqual(api.state.camera, null, 'nothing is captured before the viewer starts');

    const viewer = startViewer(sandbox);
    step();                    // one animation frame: the overlay patches here
    viewer.renderer.render({}, viewer.camera);
    viewer.controls.update();

    assert.strictEqual(api.state.camera, viewer.camera, 'the rendered camera must be captured');
    assert.strictEqual(api.state.controls, viewer.controls, 'and the orbit controls with it');
    assert.ok(viewer.camera instanceof sandbox.THREE.PerspectiveCamera, 'instanceof must still hold');

    // The viewer's own calls must still do their work.
    assert.strictEqual(viewer.camera.matrixWorldUpdates, 2);
    assert.strictEqual(viewer.renderer.renderCalls, 2);
    assert.strictEqual(viewer.controls.updateCalls, 2);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(viewer.controls.lastEvent)), { type: 'change' },
      'the patched dispatchEvent must still deliver the event');
  });

  await test('The three namespace is never written to', async () => {
    // Webpack's exports are non-configurable getters: redefining one throws,
    // and the throw would happen inside the bundle's own assignment.
    const { sandbox } = boot();
    await flush();
    const viewer = startViewer(sandbox);
    const descriptor = Object.getOwnPropertyDescriptor(viewer.namespace, 'PerspectiveCamera');
    assert.strictEqual(descriptor.configurable, false, 'the stub must model the real namespace');
    assert.ok(descriptor.get, 'and it must still be the original getter, not a replacement');
  });

  await test('Tracking follows the character and preserves the orbit offset', async () => {
    const { sandbox, api, button, step } = boot({ position: { x: 100, y: 64, z: 100 } });
    await flush();

    const { camera, controls, renderer } = startViewer(sandbox);
    step();                                  // overlay patches
    renderer.render({}, camera);             // and captures on the next frame
    controls.update();
    controls.target.set(0, 64, 0);
    camera.position.set(0, 84, 20);
    step();

    const before = {
      x: camera.position.x - controls.target.x,
      y: camera.position.y - controls.target.y,
      z: camera.position.z - controls.target.z
    };

    button.dispatch('click', {});
    assert.strictEqual(api.isTracking(), true);

    step(120);

    assert.ok(Math.abs(controls.target.x - 100) < 0.5,
      `the orbit target should have reached the character, got ${controls.target.x}`);
    assert.ok(Math.abs(controls.target.z - 100) < 0.5, `got ${controls.target.z}`);
    const after = {
      x: camera.position.x - controls.target.x,
      y: camera.position.y - controls.target.y,
      z: camera.position.z - controls.target.z
    };
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(Math.abs(after[axis] - before[axis]) < 1e-6,
        `the ${axis} offset changed: ${before[axis]} -> ${after[axis]}`);
    }
  });

  await test('Turning tracking off leaves the camera where it is', async () => {
    const { sandbox, api, button, step } = boot({ position: { x: 100, y: 64, z: 100 } });
    await flush();
    const { camera, controls, renderer } = startViewer(sandbox);
    step();
    renderer.render({}, camera);
    controls.update();
    camera.position.set(0, 84, 20);
    step();

    button.dispatch('click', {});
    step(10);
    const moved = { ...camera.position };
    button.dispatch('click', {});
    assert.strictEqual(api.isTracking(), false);

    step(30);
    assert.deepStrictEqual({ x: camera.position.x, y: camera.position.y, z: camera.position.z },
      { x: moved.x, y: moved.y, z: moved.z }, 'an untracked camera must stay put');
  });

  await test('The dashboard can toggle it by postMessage, and is told the result', async () => {
    const { sandbox, api, posted, button } = boot();
    await flush();
    const DASHBOARD = 'http://localhost:8123';
    const lastPost = () => JSON.parse(JSON.stringify(posted[posted.length - 1]));

    sandbox.dispatch('message', { origin: DASHBOARD, data: { type: 'wynn:viewer:track', enabled: true } });
    assert.strictEqual(api.isTracking(), true);
    assert.deepStrictEqual(lastPost(),
      { message: { type: 'wynn:viewer:state', tracking: true }, origin: DASHBOARD },
      'state goes back to the embedding page, not to any listener');
    assert.match(button.textContent, /Tracking/);

    sandbox.dispatch('message', { origin: DASHBOARD, data: { type: 'wynn:viewer:track', enabled: false } });
    assert.strictEqual(api.isTracking(), false);

    const count = posted.length;
    sandbox.dispatch('message', { origin: DASHBOARD, data: { type: 'webpackHotUpdate' } });
    sandbox.dispatch('message', { origin: DASHBOARD, data: 'a string from some other page' });
    assert.strictEqual(api.isTracking(), false, 'unrelated messages must be ignored');
    assert.strictEqual(posted.length, count, 'and must not chatter back at the parent');
  });

  await test('A toggle from another origin is ignored', async () => {
    const { sandbox, api } = boot();
    await flush();

    sandbox.dispatch('message', {
      origin: 'http://evil.example', data: { type: 'wynn:viewer:track', enabled: true }
    });
    assert.strictEqual(api.isTracking(), false,
      'only the page that embedded the viewer may drive its camera');

    sandbox.dispatch('message', { data: { type: 'wynn:viewer:track', enabled: true } });
    assert.strictEqual(api.isTracking(), false, 'a message with no origin is not trusted either');
  });

  await test('The button polls the bot position and reports when it is unavailable', async () => {
    const live = boot({ position: { x: 5, y: 64, z: 5 } });
    await flush();
    assert.ok(live.fetches.some(url => url === 'http://localhost:8123/api/bot/position'),
      `expected a poll of the bot position endpoint, saw ${live.fetches}`);
    assert.strictEqual(live.button.disabled, false);
    assert.ok(live.intervals.some(entry => entry.ms === 250), 'position is polled on an interval');

    const offline = boot({ ok: false });
    await flush();
    assert.strictEqual(offline.button.disabled, true, 'nothing to track when the bot is offline');
    const note = offline.body.children[0].children.find(child => child.className === 'wynn-track-note');
    assert.match(note.textContent, /unavailable/);
  });

  await test('First person mode is left alone', async () => {
    const { sandbox, api, button, step } = boot({ position: { x: 100, y: 64, z: 100 } });
    await flush();

    // In first person the viewer disposes its controls and drives the camera
    // itself, so there is no orbit target to move.
    const { camera, renderer } = startViewer(sandbox, { withControls: false });
    step();
    renderer.render({}, camera);
    camera.position.set(1, 2, 3);
    step();
    assert.strictEqual(api.state.camera, camera);
    assert.strictEqual(api.state.controls, null, 'no controls were ever constructed');

    button.dispatch('click', {});
    step(20);
    assert.deepStrictEqual({ x: camera.position.x, y: camera.position.y, z: camera.position.z },
      { x: 1, y: 2, z: 3 }, 'the overlay must not fight the first person camera');
  });

  console.log(`\n\x1b[1;32mViewer overlay render tests: ${passed} passed.\x1b[0m`);
})();
