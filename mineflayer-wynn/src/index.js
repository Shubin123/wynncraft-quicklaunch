const prism = require('./prism');
const wynncraft = require('./wynncraft');
const viewer = require('./viewer');
const bot = require('./bot');
const repl = require('./repl');

module.exports = {
  ...prism,
  ...wynncraft,
  ...viewer,
  ...bot,
  ...repl
};
