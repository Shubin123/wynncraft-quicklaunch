const { mineflayer: initViewer } = require('prismarine-viewer');
const {
  DEFAULT_RENDER_VERSION,
  resolveRenderVersion,
  createStateTranslator,
  translateColumnJson
} = require('./blockstates');

/**
 * Wraps the bot so prismarine-viewer sees a Minecraft version its browser bundle
 * supports, translating block state ids in the chunks and block updates it reads.
 */
function createRenderBot(bot, renderVersion, translator) {
  const translate = translator.translate;

  const world = {
    async getColumnAt(pos) {
      const column = await bot.world.getColumnAt(pos);
      if (!column) return null;
      return {
        toJson: () => translateColumnJson(column.toJson(), translate)
      };
    },
    raycast: (...args) => bot.world.raycast(...args)
  };

  // prismarine-viewer removes its listeners by reference on disconnect, so the
  // wrapper we register has to be recoverable from the original listener.
  const wrappers = new WeakMap();

  function wrapListener(event, listener) {
    if (event !== 'blockUpdate') return listener;
    let wrapper = wrappers.get(listener);
    if (!wrapper) {
      wrapper = (oldBlock, newBlock) => {
        if (newBlock && typeof newBlock.stateId === 'number') {
          listener(oldBlock, Object.assign(Object.create(Object.getPrototypeOf(newBlock)), newBlock, {
            stateId: translate(newBlock.stateId)
          }));
        } else {
          listener(oldBlock, newBlock);
        }
      };
      wrappers.set(listener, wrapper);
    }
    return wrapper;
  }

  return new Proxy(bot, {
    get(target, prop, receiver) {
      if (prop === 'version') return renderVersion;
      if (prop === 'world') return world;
      if (prop === 'on' || prop === 'addListener') {
        return (event, listener) => target.on(event, wrapListener(event, listener));
      }
      if (prop === 'once') {
        return (event, listener) => target.once(event, wrapListener(event, listener));
      }
      if (prop === 'removeListener' || prop === 'off') {
        return (event, listener) => target.removeListener(event, wrapListener(event, listener));
      }
      return Reflect.get(target, prop, target);
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    }
  });
}

/**
 * Attaches prismarine-viewer 3D web viewer to the Mineflayer bot.
 */
function attachViewer(bot, options = {}) {
  const port = options.port || 3000;
  const firstPerson = options.firstPerson ?? false;
  const botVersion = bot.version;
  const renderVersion = resolveRenderVersion(botVersion, options.renderVersion || DEFAULT_RENDER_VERSION);

  if (!renderVersion) {
    console.warn(`\x1b[33m[Viewer Warning]\x1b[0m No renderable Minecraft version found for bot version ${botVersion}; 3D viewer disabled.`);
    return null;
  }

  try {
    let target = bot;
    let translator = null;

    if (renderVersion !== botVersion) {
      translator = createStateTranslator(botVersion, renderVersion);
      target = createRenderBot(bot, renderVersion, translator);
      const { exact, byName, substituted, total } = translator.stats;
      console.log(`\x1b[36m[Viewer]\x1b[0m Rendering Minecraft ${botVersion} world as ${renderVersion} ` +
        `(${exact}/${total} block states exact, ${byName} by name, ${substituted} substituted)`);
    }

    initViewer(target, {
      port,
      firstPerson,
      viewDistance: options.viewDistance || 6
    });

    // initViewer assigns bot.viewer through the proxy, which writes to the real bot.
    console.log(`\x1b[36m[Viewer]\x1b[0m 3D World Visualizer running at \x1b[1mhttp://localhost:${port}\x1b[0m`);
    return {
      port,
      url: `http://localhost:${port}`,
      botVersion,
      renderVersion,
      translated: renderVersion !== botVersion
    };
  } catch (err) {
    console.warn(`\x1b[33m[Viewer Warning]\x1b[0m Failed to start prismarine-viewer: ${err.message}`);
    return null;
  }
}

module.exports = {
  attachViewer,
  createRenderBot
};
