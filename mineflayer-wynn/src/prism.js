const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

/**
 * Resolves the Prism Launcher base directory.
 */
function getPrismDir() {
  if (process.env.PRISM_DIR && fs.existsSync(process.env.PRISM_DIR)) {
    return process.env.PRISM_DIR;
  }
  const candidates = [
    // macOS default
    path.join(os.homedir(), 'Library', 'Application Support', 'PrismLauncher'),
    // Linux standard XDG
    path.join(os.homedir(), '.local', 'share', 'PrismLauncher'),
    // Linux Flatpak
    path.join(os.homedir(), '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'PrismLauncher');
  }
  return path.join(os.homedir(), '.local', 'share', 'PrismLauncher');
}

/**
 * Returns a list of all installed Prism Launcher instances.
 */
function getInstances() {
  const instancesDir = path.join(getPrismDir(), 'instances');
  if (!fs.existsSync(instancesDir)) return [];
  const entries = fs.readdirSync(instancesDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const dir = path.join(instancesDir, entry.name);
      return {
        name: entry.name,
        path: dir,
        hasConfig: fs.existsSync(path.join(dir, 'instance.cfg')),
        hasPack: fs.existsSync(path.join(dir, 'mmc-pack.json'))
      };
    });
}

/**
 * Parses simple Java .properties / INI-style config files (like instance.cfg).
 */
function parseProperties(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') || trimmed.startsWith('!')) {
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      result[key] = val;
    }
  }
  return result;
}

/**
 * Resolves configuration for a specific Wynncraft instance.
 * Defaults to 'Wynncraft-1.21.11'.
 */
function getWynnInstance(instanceName = 'Wynncraft-1.21.11') {
  const prismDir = getPrismDir();
  const instancesDir = path.join(prismDir, 'instances');
  const instanceDir = path.join(instancesDir, instanceName);

  if (!fs.existsSync(instanceDir)) {
    // Try finding any instance with 'wynn' in name
    const all = getInstances();
    const match = all.find(i => i.name.toLowerCase().includes('wynn'));
    if (match) {
      return getWynnInstance(match.name);
    }
    throw new Error(`Instance "${instanceName}" not found at ${instanceDir}`);
  }

  // Parse instance.cfg
  const cfgPath = path.join(instanceDir, 'instance.cfg');
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    cfg = parseProperties(fs.readFileSync(cfgPath, 'utf8'));
  }

  // Parse mmc-pack.json
  let minecraftVersion = '1.21.11';
  let fabricVersion = null;
  const packPath = path.join(instanceDir, 'mmc-pack.json');
  if (fs.existsSync(packPath)) {
    try {
      const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
      for (const comp of pack.components || []) {
        if (comp.uid === 'net.minecraft') {
          minecraftVersion = comp.version || comp.cachedVersion || minecraftVersion;
        } else if (comp.uid === 'net.fabricmc.fabric-loader') {
          fabricVersion = comp.version || comp.cachedVersion;
        }
      }
    } catch (e) {
      // ignore parse error
    }
  }

  // Determine host and port
  const address = cfg.JoinServerOnLaunchAddress || 'play.wynncraft.com';
  let host = address;
  let port = 25565;
  if (address.includes(':')) {
    const parts = address.split(':');
    host = parts[0];
    port = parseInt(parts[1], 10) || 25565;
  }

  const minecraftDir = path.join(instanceDir, 'minecraft');
  const wynntilsDir = path.join(minecraftDir, 'wynntils');
  const modsDir = path.join(minecraftDir, 'mods');

  return {
    name: instanceName,
    instanceDir,
    minecraftDir,
    wynntilsDir,
    modsDir,
    host,
    port,
    minecraftVersion,
    fabricVersion,
    joinOnLaunch: cfg.JoinServerOnLaunch === 'true',
    config: cfg
  };
}

/**
 * Loads accounts from Prism Launcher's accounts.json.
 */
function getPrismAccounts() {
  const accountsPath = path.join(getPrismDir(), 'accounts.json');
  if (!fs.existsSync(accountsPath)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
    return (data.accounts || []).map(acc => {
      const exp = acc.ygg?.exp || 0;
      const now = Math.floor(Date.now() / 1000);
      return {
        name: acc.profile?.name || 'Unknown',
        uuid: acc.profile?.id || '',
        type: acc.type || 'MSA',
        active: !!acc.active,
        tokenExpiresAt: exp,
        validSecondsRemaining: Math.max(0, exp - now),
        isTokenValid: exp > now + 60, // 1 minute buffer
        hasToken: !!(acc.ygg && acc.ygg.token),
        hasMsaRefresh: !!(acc.msa && acc.msa.refresh_token),
        raw: acc
      };
    });
  } catch (err) {
    console.error('Failed to parse Prism accounts.json:', err.message);
    return [];
  }
}

/**
 * Gets the active or primary Microsoft account from Prism.
 */
function getActiveAccount() {
  const accounts = getPrismAccounts();
  if (accounts.length === 0) return null;
  const active = accounts.find(a => a.active);
  return active || accounts[0];
}

/**
 * Creates a custom authentication function for mineflayer/minecraft-protocol
 * that uses the active Prism account's session token.
 */
function createPrismAuth(account) {
  if (!account || !account.raw || !account.raw.ygg || !account.raw.ygg.token) {
    throw new Error('Account does not contain a valid Yggdrasil session token.');
  }

  const profile = {
    id: account.uuid,
    name: account.name
  };

  return function (client, options) {
    client.session = {
      accessToken: account.raw.ygg.token,
      selectedProfile: profile
    };
    client.username = profile.name;
    client.uuid = profile.id;
    client.profile = profile;
    options.accessToken = account.raw.ygg.token;
    options.haveCredentials = true;
    options.connect(client);
  };
}

/**
 * Reads Wynntils player storage data for a given player UUID.
 */
function getWynntilsData(uuid, instanceName = 'Wynncraft-1.21.11') {
  try {
    const inst = getWynnInstance(instanceName);
    const storageFile = path.join(inst.wynntilsDir, 'storage', `${uuid}.data.json`);
    if (fs.existsSync(storageFile)) {
      return JSON.parse(fs.readFileSync(storageFile, 'utf8'));
    }
  } catch (e) {
    // Ignore error
  }
  return null;
}

/**
 * Checks if the quicklaunch local price proxy is running on localhost:8123.
 */
function checkQuicklaunchServer(port = 8123) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: 'localhost',
      port,
      path: '/api/stats',
      timeout: 1000
    }, (res) => {
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

module.exports = {
  getPrismDir,
  getInstances,
  getWynnInstance,
  getPrismAccounts,
  getActiveAccount,
  createPrismAuth,
  getWynntilsData,
  checkQuicklaunchServer
};
