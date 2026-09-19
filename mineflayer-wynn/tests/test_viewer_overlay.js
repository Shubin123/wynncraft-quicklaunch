const assert = require('assert');
const fs = require('fs');
const path = require('path');

const overlay = require('../src/viewer-overlay');
const { installTrackingOverlay } = require('../src/viewer');

console.log('Running viewer tracking overlay tests...');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

const offset = (camera, target) => ({
  x: camera.x - target.x, y: camera.y - target.y, z: camera.z - target.z
});

test('The follow camera keeps the angle and zoom the user orbited to', () => {
  const start = {
    bot: { x: 100, y: 64, z: 100 },
    smoothed: { x: 0, y: 64, z: 0 },
    target: { x: 0, y: 64, z: 0 },
    camera: { x: 0, y: 84, z: 20 },
    alpha: 0.2
  };
  const before = offset(start.camera, start.target);
  const step = overlay.nextCameraFrame(start);

  assert.ok(step.moved);
  assert.deepStrictEqual(step.smoothed, { x: 20, y: 64, z: 20 }, 'smoothing approaches the bot by alpha');
  assert.deepStrictEqual(step.target, { x: 20, y: 64, z: 20 }, 'the orbit target rides with it');
  assert.deepStrictEqual(step.camera, { x: 20, y: 84, z: 40 }, 'the camera moves by the same delta');
  assert.deepStrictEqual(offset(step.camera, step.target), before,
    'the camera-to-target offset - the angle and zoom - must not change');
});

test('Following converges on the character and then stops moving', () => {
  let frame = {
    bot: { x: 50, y: 70, z: -30 },
    smoothed: { x: 0, y: 0, z: 0 },
    target: { x: 0, y: 0, z: 0 },
    camera: { x: 0, y: 20, z: 20 },
    alpha: 0.2
  };
  for (let i = 0; i < 200; i++) {
    const step = overlay.nextCameraFrame(frame);
    frame = { ...frame, smoothed: step.smoothed, target: step.target, camera: step.camera };
  }
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(frame.target[axis] - frame.bot[axis]) < 1e-6,
      `target.${axis} settled at ${frame.target[axis]}, wanted ${frame.bot[axis]}`);
  }
  const settled = overlay.nextCameraFrame(frame);
  assert.strictEqual(settled.moved, false, 'a settled camera must not jitter every frame');
});

test('A higher alpha follows harder, and no bot position means no motion', () => {
  const base = {
    bot: { x: 10, y: 0, z: 0 },
    smoothed: { x: 0, y: 0, z: 0 },
    target: { x: 0, y: 0, z: 0 },
    camera: { x: 0, y: 5, z: 5 }
  };
  const slow = overlay.nextCameraFrame({ ...base, alpha: 0.1 });
  const fast = overlay.nextCameraFrame({ ...base, alpha: 0.5 });
  assert.ok(fast.smoothed.x > slow.smoothed.x, 'alpha controls how tightly the camera follows');
  assert.strictEqual(overlay.nextCameraFrame({ ...base, bot: null }), null);
});

test('The bot API base comes from the script tag, with a sane fallback', () => {
  assert.strictEqual(
    overlay.parseApiBase('http://localhost:3000/wynn-viewer-overlay.js?api=http%3A%2F%2Flocalhost%3A8124',
      'http://localhost:3000/'),
    'http://localhost:8124'
  );
  assert.strictEqual(
    overlay.parseApiBase('http://box.local:3000/wynn-viewer-overlay.js?api=http://box.local:9001/',
      'http://box.local:3000/'),
    'http://box.local:9001', 'a trailing slash must not double up in request paths'
  );
  assert.strictEqual(
    overlay.parseApiBase('http://box.local:3000/wynn-viewer-overlay.js', 'http://box.local:3000/'),
    'http://box.local:8124', 'without the query it falls back to the default bot port on the same host'
  );
  assert.strictEqual(overlay.parseApiBase('', ''), 'http://localhost:8124');
});

test('Only the dashboard toggle message is acted on', () => {
  assert.deepStrictEqual(overlay.trackCommand({ type: 'wynn:viewer:track', enabled: true }), { enabled: true });
  assert.deepStrictEqual(overlay.trackCommand({ type: 'wynn:viewer:track', enabled: false }), { enabled: false });
  assert.deepStrictEqual(overlay.trackCommand({ type: 'wynn:viewer:track' }), { enabled: null },
    'an absent flag means toggle');
  assert.strictEqual(overlay.trackCommand({ type: 'something-else' }), null);
  assert.strictEqual(overlay.trackCommand('webpackHotUpdate'), null, 'stray string messages are ignored');
  assert.strictEqual(overlay.trackCommand(null), null);
});

test('Installing the overlay adds exactly one script tag and is idempotent', () => {
  const publicDir = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public');
  const indexPath = path.join(publicDir, 'index.html');
  const original = fs.readFileSync(indexPath, 'utf8');

  try {
    const first = installTrackingOverlay('http://localhost:8124');
    assert.ok(first.installed, `install failed: ${first.reason}`);
    assert.ok(fs.existsSync(path.join(publicDir, 'wynn-viewer-overlay.js')), 'the overlay file must be copied');

    const afterFirst = fs.readFileSync(indexPath, 'utf8');
    const count = (html) => (html.match(/wynn-viewer-overlay\.js/g) || []).length;
    assert.strictEqual(count(afterFirst), 1, 'exactly one tag after the first install');
    assert.ok(afterFirst.indexOf('wynn-viewer-overlay.js') < afterFirst.indexOf('src="index.js"'),
      'the overlay must load BEFORE the bundle so it can wrap the three constructors');
    assert.ok(afterFirst.includes('api=http%3A%2F%2Flocalhost%3A8124'), 'the api base is passed on the tag');

    installTrackingOverlay('http://localhost:8124');
    installTrackingOverlay('http://localhost:9999');
    const afterThird = fs.readFileSync(indexPath, 'utf8');
    assert.strictEqual(count(afterThird), 1, 'repeat installs must not stack tags');
    assert.ok(afterThird.includes('api=http%3A%2F%2Flocalhost%3A9999'), 'a changed api base replaces the old tag');
    assert.ok(afterThird.includes('<script type="text/javascript" src="index.js"></script>'),
      'the viewer\'s own bundle tag must survive');

    // The copy in public/ must match the repo source, not drift from it.
    assert.strictEqual(
      fs.readFileSync(path.join(publicDir, 'wynn-viewer-overlay.js'), 'utf8'),
      fs.readFileSync(path.resolve(__dirname, '../src/viewer-overlay.js'), 'utf8')
    );
  } finally {
    fs.writeFileSync(indexPath, original);
  }
});

test('Installation can be switched off', () => {
  const previous = process.env.WYNN_VIEWER_OVERLAY;
  process.env.WYNN_VIEWER_OVERLAY = '0';
  try {
    const result = installTrackingOverlay('http://localhost:8124');
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.reason, 'disabled');
  } finally {
    if (previous === undefined) delete process.env.WYNN_VIEWER_OVERLAY;
    else process.env.WYNN_VIEWER_OVERLAY = previous;
  }
});

test('The overlay loads in Node without a DOM', () => {
  assert.strictEqual(typeof overlay.nextCameraFrame, 'function');
  assert.strictEqual(typeof overlay.setTracking, 'undefined', 'browser-only API must not leak into Node');
});

console.log(`\n\x1b[1;32mViewer tracking overlay tests: ${passed} passed.\x1b[0m`);
