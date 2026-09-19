const prism = require('./prism');
const wynncraft = require('./wynncraft');
const viewer = require('./viewer');
const market = require('./market');
const bot = require('./bot');
const repl = require('./repl');

module.exports = {
  ...prism,
  ...wynncraft,
  ...viewer,
  ...market,
  ...bot,
  ...repl
};
