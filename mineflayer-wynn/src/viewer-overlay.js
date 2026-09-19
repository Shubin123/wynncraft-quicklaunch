/**
 * Character tracking overlay for the prismarine-viewer page.
 *
 * The stock viewer centres its orbit camera on the bot exactly once, on the
 * first position packet, and never again - walk twenty blocks and the
 * character wanders off the edge of the view. This adds a Track toggle that
 * keeps the camera on the character while preserving whatever angle and zoom
 * you have orbited to.
 *
 * Reaching the viewer's camera takes some care. The bundle keeps it
 * module-private; in three r128 renderer.render and controls.update are own
 * properties assigned in their constructors, so there is no prototype to patch
 * there; and the three namespace the bundle publishes on window exposes its
 * exports as non-configurable getters, so the constructors cannot be swapped
 * either - redefining one throws, and the throw would take the viewer down
 * with it.
 *
 * What is writable is the class prototypes. The renderer calls
 * camera.updateMatrixWorld() every frame, and OrbitControls inherits
 * dispatchEvent() from EventDispatcher and fires 'change' whenever the view
 * moves, so patching those two methods hands over the live camera and
 * controls. Nothing in the bundle is modified and it does not need
 * rebuilding.
 *
 * mineflayer-wynn/src/viewer.js copies this file into prismarine-viewer's
 * public directory and adds the script tag; this copy in the repo is the
 * source of truth. Node gets the pure helpers for testing, a browser gets the
 * overlay.
 */
(function (global) {
  'use strict';

  const DEFAULT_POLL_MS = 250;
  const DEFAULT_ALPHA = 0.2; // per-frame approach rate toward the bot

  /**
   * Reads the bot API base out of the script tag's own query string, which is
   * how viewer.js passes the (configurable) bot server port across origins.
   */
  function parseApiBase(scriptSrc, fallbackOrigin) {
    try {
      const url = new URL(scriptSrc, fallbackOrigin);
      const api = url.searchParams.get('api');
      if (api) return api.replace(/\/$/, '');
    } catch (err) {
      // Fall through to the default below.
    }
    try {
      const origin = new URL(fallbackOrigin);
      return `${origin.protocol}//${origin.hostname}:8124`;
    } catch (err) {
      return 'http://localhost:8124';
    }
  }

  /**
   * One frame of follow-camera motion.
   *
   * `smoothed` chases the bot so the camera does not snap between position
   * samples, and the camera is translated by the same vector as the orbit
   * target, which is what preserves the user's chosen angle and zoom: only the
   * point being orbited moves.
   */
  function nextCameraFrame({ bot, smoothed, target, camera, alpha = DEFAULT_ALPHA }) {
    if (!bot) return null;
    const next = {
      x: smoothed.x + (bot.x - smoothed.x) * alpha,
      y: smoothed.y + (bot.y - smoothed.y) * alpha,
      z: smoothed.z + (bot.z - smoothed.z) * alpha
    };
    const delta = { x: next.x - target.x, y: next.y - target.y, z: next.z - target.z };
    const moved = (delta.x * delta.x + delta.y * delta.y + delta.z * delta.z) > 1e-8;
    return {
      smoothed: next,
      delta,
      moved,
      target: { x: target.x + delta.x, y: target.y + delta.y, z: target.z + delta.z },
      camera: { x: camera.x + delta.x, y: camera.y + delta.y, z: camera.z + delta.z }
    };
  }

  /**
   * Recognises the parent dashboard's toggle messages. Anything else on the
   * message channel is ignored - the page sits in an iframe on a different
   * origin and will see unrelated traffic.
   */
  function trackCommand(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.type !== 'wynn:viewer:track') return null;
    return { enabled: data.enabled === undefined ? null : !!data.enabled };
  }

  const helpers = { parseApiBase, nextCameraFrame, trackCommand, DEFAULT_POLL_MS, DEFAULT_ALPHA };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
  }
  if (typeof document === 'undefined') return;

  const state = {
    tracking: false,
    camera: null,
    controls: null,
    bot: null,
    smoothed: null,
    button: null,
    note: null,
    instrumented: false,
    apiBase: parseApiBase(
      (document.currentScript && document.currentScript.src) || '',
      global.location ? global.location.href : 'http://localhost:3000'
    ),
    pollTimer: null
  };

  /**
   * Wraps one prototype method so every call reports its receiver. Prototype
   * methods are plain writable properties, unlike the namespace's exports.
   */
  function patchMethod(Ctor, name, onCall) {
    if (!Ctor || !Ctor.prototype) return false;
    const proto = Ctor.prototype;
    const marker = `__wynnPatched_${name}`;
    if (proto[marker]) return true;
    const original = proto[name]; // may be inherited; apply() keeps that working
    if (typeof original !== 'function') return false;
    try {
      proto[name] = function (...args) {
        try { onCall(this); } catch (err) { /* never break the viewer */ }
        return original.apply(this, args);
      };
      Object.defineProperty(proto, marker, { value: true, configurable: true });
    } catch (err) {
      return false;
    }
    return true;
  }

  /**
   * An OrbitControls instance, as opposed to anything else that inherits
   * dispatchEvent: it owns an orbit target, the camera it drives, and update().
   */
  function looksLikeOrbitControls(candidate) {
    return !!(candidate && candidate.object && candidate.target &&
      typeof candidate.target.set === 'function' && typeof candidate.update === 'function');
  }

  function instrument(namespace) {
    if (!namespace) return false;
    const camera = patchMethod(namespace.PerspectiveCamera, 'updateMatrixWorld', (instance) => {
      state.camera = instance;
    });
    const controls = patchMethod(namespace.EventDispatcher, 'dispatchEvent', (instance) => {
      if (looksLikeOrbitControls(instance)) state.controls = instance;
    });
    return camera && controls;
  }

  /**
   * Patches as soon as the viewer bundle has published THREE. The frame loop
   * below retries every frame until it takes, so the patch lands within one
   * frame of the bundle starting - no timer race with the first position
   * packet, whichever order the two scripts happen to load in.
   */
  function trapThree() {
    state.instrumented = instrument(global.THREE);
    return state.instrumented;
  }

  async function pollPosition() {
    try {
      const response = await fetch(`${state.apiBase}/api/bot/position`);
      const body = await response.json();
      if (body && body.ok && body.position) {
        state.bot = body.position;
        if (!state.smoothed) state.smoothed = { ...body.position };
      } else {
        state.bot = null;
      }
    } catch (err) {
      state.bot = null;
    }
    render();
  }

  function frame() {
    global.requestAnimationFrame(frame);
    if (!state.instrumented) state.instrumented = instrument(global.THREE);
    if (!state.tracking || !state.bot || !state.camera) return;

    // First person disposes the orbit controls and the camera is the
    // character already, so there is nothing to follow.
    if (!state.controls || !state.controls.target) return;

    const step = nextCameraFrame({
      bot: state.bot,
      smoothed: state.smoothed || state.bot,
      target: state.controls.target,
      camera: state.camera.position
    });
    if (!step) return;
    state.smoothed = step.smoothed;
    if (!step.moved) return;

    state.controls.target.set(step.target.x, step.target.y, step.target.z);
    state.camera.position.set(step.camera.x, step.camera.y, step.camera.z);
  }

  function render() {
    if (!state.button) return;
    const live = !!state.bot;
    state.button.textContent = state.tracking ? '◉ Tracking' : '◎ Track character';
    state.button.classList.toggle('on', state.tracking);
    state.button.disabled = !live && !state.tracking;
    state.note.textContent = live
      ? ''
      : 'bot position unavailable';
  }

  function setTracking(enabled) {
    state.tracking = enabled === null ? !state.tracking : !!enabled;
    if (state.tracking && state.bot) state.smoothed = { ...state.bot };
    render();
    // Keep the dashboard's own button in step with this one.
    if (global.parent && global.parent !== global) {
      global.parent.postMessage({ type: 'wynn:viewer:state', tracking: state.tracking }, '*');
    }
  }

  function install() {
    // By now the viewer bundle's script has run, so THREE is usually already
    // there; the frame loop covers the case where it is not.
    trapThree();

    const style = document.createElement('style');
    style.textContent = `
      .wynn-track-bar {
        position: fixed; top: 10px; right: 10px; z-index: 40;
        display: flex; gap: 8px; align-items: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wynn-track-bar button {
        background: rgba(12, 18, 26, 0.82); color: #e8f3ff;
        border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 7px;
        padding: 6px 12px; font-size: 0.78rem; font-weight: 600; cursor: pointer;
        backdrop-filter: blur(3px);
      }
      .wynn-track-bar button:hover { border-color: #22c55e; }
      .wynn-track-bar button.on { background: #15803d; border-color: #22c55e; }
      .wynn-track-bar button:disabled { opacity: 0.45; cursor: not-allowed; }
      .wynn-track-note {
        color: #ffd666; font-size: 0.72rem; text-shadow: 0 1px 2px #000;
      }
    `;
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.className = 'wynn-track-bar';
    state.note = document.createElement('span');
    state.note.className = 'wynn-track-note';
    state.button = document.createElement('button');
    state.button.type = 'button';
    state.button.addEventListener('click', () => setTracking(null));
    bar.appendChild(state.note);
    bar.appendChild(state.button);
    document.body.appendChild(bar);

    global.addEventListener('message', (event) => {
      const command = trackCommand(event.data);
      if (command) setTracking(command.enabled);
    });

    render();
    pollPosition();
    state.pollTimer = setInterval(pollPosition, DEFAULT_POLL_MS);
    global.requestAnimationFrame(frame);
  }

  global.WynnViewerTracking = Object.assign({}, helpers, {
    setTracking,
    isTracking: () => state.tracking,
    state
  });

  // The bundle publishes THREE as soon as it runs; patch whenever it shows up.
  trapThree();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})(typeof window !== 'undefined' ? window : globalThis);
