const { mineflayer: initViewer } = require('prismarine-viewer');

/**
 * Attaches prismarine-viewer 3D web viewer to the Mineflayer bot.
 */
function attachViewer(bot, options = {}) {
  const port = options.port || 3000;
  const firstPerson = options.firstPerson ?? false;

  try {
    initViewer(bot, {
      port,
      firstPerson,
      viewDistance: options.viewDistance || 6
    });

    console.log(`\x1b[36m[Viewer]\x1b[0m 3D World Visualizer running at \x1b[1mhttp://localhost:${port}\x1b[0m`);
    return {
      port,
      url: `http://localhost:${port}`
    };
  } catch (err) {
    console.warn(`\x1b[33m[Viewer Warning]\x1b[0m Failed to start prismarine-viewer: ${err.message}`);
    return null;
  }
}

module.exports = {
  attachViewer
};
