/**
 * An offline stand-in for Wynncraft that speaks the real protocol.
 *
 * Every other test in this repo replaces the game with a plain object: a
 * `currentWindow` whose slots carry `customName: 'Idol'` and `customLore:
 * ['Price: 2 le 30 eb']`. That covers the logic and nothing else, because the
 * object is written by the same people who wrote the parser. What it cannot
 * cover is the wire: since 1.20.5 an item's name and lore travel as *data
 * components* holding NBT text components, so a real bot sees
 * `{ type: 'compound', value: { text: { type: 'string', value: 'Idol' } } }`
 * where the stand-in said `'Idol'`. Code that assumes a string degrades to an
 * empty one, silently, and no unit test can tell.
 *
 * So this module starts a real Minecraft server with `minecraft-protocol`,
 * joins a real mineflayer bot to it at the same version the bot uses against
 * Wynncraft, and serves a Trade Market built out of real packets. The game
 * side owns its state: a click arrives as a `window_click` packet, and it is
 * the server that removes the listing and debits the purse. Nothing here
 * reaches Wynncraft, so the write path is exercised for the first time.
 *
 * Not a Wynncraft emulator. It serves what the market code reads - a titled
 * container of named, lored items - and enough of a join sequence to spawn.
 */

const path = require('path');
const EventEmitter = require('events');

// Game-side dependencies live in the bot package, not at the repo root.
const BOT_DIR = path.resolve(__dirname, '../../mineflayer-wynn');
const fromBot = (name) => require(require.resolve(name, { paths: [BOT_DIR] }));

const mc = fromBot('minecraft-protocol');
const mineflayer = fromBot('mineflayer');
const nbt = fromBot('prismarine-nbt');

// The version bot.js negotiates with play.wynncraft.com. Pinning the harness
// to it is the point: a protocol change that breaks the market breaks here.
const WYNN_VERSION = '26.1';

const EMPTY_SLOT = { itemCount: 0 };
const CHEST_9X6 = 5; // menu type id for a six-row generic container
const CONTAINER_SLOTS = 54;
const PLAYER_SLOTS = 36;

/** A text component, as the server puts one on the wire. */
const text = (value) => nbt.comp({ text: nbt.string(String(value)) });

/**
 * Renders emeralds the way the game writes them, not the way `formatEmeralds`
 * does. Asserting the parser against its own formatter would pass whatever
 * either of them did; this is deliberately a separate implementation of
 * Wynncraft's spacing so the lore under test is shaped like real lore.
 */
function priceText(total) {
  const units = [['stx', 262144], ['le', 4096], ['eb', 64], ['e', 1]];
  let left = Math.max(0, Math.round(total));
  const parts = [];
  for (const [label, size] of units) {
    const count = Math.floor(left / size);
    if (count > 0) {
      parts.push(`${count} ${label}`);
      left -= count * size;
    }
  }
  return parts.length ? parts.join(' ') : '0 e';
}

/**
 * Builds one slot as the protocol carries it: an item id, a count, and the
 * `custom_name` / `lore` components. Passing the strings straight through
 * would rebuild the stand-in; the components are the whole point.
 */
function slotItem(mcData, { name, count = 1, customName = null, lore = null }) {
  const item = mcData.itemsByName[name];
  if (!item) throw new Error(`Harness asked for an item the version does not have: ${name}`);
  const components = [];
  if (customName !== null) components.push({ type: 'custom_name', data: text(customName) });
  if (lore !== null) components.push({ type: 'lore', data: lore.map(text) });
  return {
    itemCount: count,
    itemId: item.id,
    addedComponentCount: components.length,
    removedComponentCount: 0,
    components,
    removeComponents: []
  };
}

/** A listing pane, lored the way the Trade Market lores one. */
function listingSlot(mcData, listing) {
  const lore = [
    `§7${listing.tier || 'Legendary'} Item`,
    `§aPrice: ${priceText(listing.price)}`,
    `§7Amount: ${listing.amount || 1}`
  ];
  if (listing.seller) lore.push(`§8Seller: ${listing.seller}`);
  return slotItem(mcData, {
    name: listing.name || 'bow',
    count: listing.amount || 1,
    customName: `§6${listing.item}`,
    lore
  });
}

/**
 * Renders a purse of N emeralds into the items Wynncraft actually uses, so
 * counting them back is a real measurement rather than a stored number.
 * Liquid emeralds are an ordinary item wearing a custom name - which is
 * exactly the case that dies when a component is treated as a string.
 */
function purseSlots(mcData, total) {
  const slots = [];
  let left = Math.max(0, Math.round(total));
  const le = Math.floor(left / 4096);
  left -= le * 4096;
  const eb = Math.floor(left / 64);
  left -= eb * 64;

  // Real inventories hold stacks of at most 64, so a large purse spans slots.
  // Counting has to add them up rather than read one number.
  const stacks = (count, item) => {
    while (count > 0) {
      const take = Math.min(count, 64);
      slots.push(slotItem(mcData, { ...item, count: take }));
      count -= take;
    }
  };

  stacks(le, { name: 'experience_bottle', customName: '§aLiquid Emerald', lore: ['§7Currency'] });
  stacks(eb, { name: 'emerald_block' });
  stacks(left, { name: 'emerald' });
  return slots;
}

/**
 * Starts the server and resolves once it is listening.
 *
 * `pages` is an array of pages, each an array of listings; a page turn is a
 * click on the next/prev pane like any other, and the server decides what the
 * bot then sees.
 */
async function startWynnServer(options = {}) {
  const version = options.version || WYNN_VERSION;
  const mcData = fromBot('minecraft-data')(version);

  const state = {
    emeralds: options.emeralds ?? 500000,
    pages: (options.pages || [options.listings || []]).map(page => page.slice()),
    page: 0,
    sold: [],
    title: options.title || 'Trade Market',
    // Every packet the game received, for tests that ask what actually left
    // the bot rather than what the bot said it did.
    clicks: [],
    closes: [],
    chat: []
  };

  const events = new EventEmitter();
  // EventEmitter throws on an unhandled 'error', and a client going away is
  // routine here - tests that care listen, and the rest must not be killed.
  events.on('error', () => {});
  let windowId = 0;
  let stateId = 1;
  let client = null;
  let marketOpen = false;

  const server = mc.createServer({
    'online-mode': false,
    version,
    port: options.port || 0,
    motd: 'wynn harness',
    maxPlayers: 2
  });

  /** The container as it stands right now. */
  function marketSlots() {
    const slots = new Array(CONTAINER_SLOTS).fill(EMPTY_SLOT);
    state.pages[state.page].forEach((listing, index) => {
      if (listing) slots[10 + index] = listingSlot(mcData, listing);
    });
    // Controls sit where Wynncraft puts them, named rather than numbered -
    // the market code matches on the name for exactly this reason.
    slots[45] = slotItem(mcData, {
      name: 'gray_stained_glass_pane', customName: '§ePrevious Page', lore: ['§7Go back']
    });
    slots[49] = slotItem(mcData, {
      name: 'compass', customName: '§bSearch', lore: ['§7Find an item']
    });
    slots[53] = slotItem(mcData, {
      name: 'gray_stained_glass_pane', customName: '§eNext Page', lore: ['§7See more']
    });
    slots[48] = slotItem(mcData, { name: 'black_stained_glass_pane' }); // filler
    return slots;
  }

  function playerSlots() {
    const slots = new Array(PLAYER_SLOTS + 10).fill(EMPTY_SLOT);
    const purse = purseSlots(mcData, state.emeralds);
    // Slots 9-44 are the main inventory and hotbar; a purse that does not fit
    // would otherwise be quietly truncated and every count read low.
    if (purse.length > 36) {
      throw new Error(`Harness purse of ${state.emeralds} needs ${purse.length} slots; only 36 exist`);
    }
    purse.forEach((item, index) => {
      slots[9 + index] = item;
    });
    return slots;
  }

  /** Pushes the player's inventory (window 0) as it now stands. */
  function sendInventory() {
    if (!client) return;
    client.write('window_items', {
      windowId: 0, stateId: stateId++, items: playerSlots(), carriedItem: EMPTY_SLOT
    });
  }

  /** Pushes the open container's contents as they now stand. */
  function sendMarket() {
    if (!client || !marketOpen) return;
    client.write('window_items', {
      windowId,
      stateId: stateId++,
      items: marketSlots().concat(new Array(PLAYER_SLOTS).fill(EMPTY_SLOT)),
      carriedItem: EMPTY_SLOT
    });
  }

  /**
   * A click on a listing is a purchase: the listing leaves the board and the
   * purse is debited, and both are pushed back. That is what makes "did the
   * world change" answerable here instead of assumed.
   */
  function handleClick(packet) {
    state.clicks.push(packet);
    events.emit('click', packet);
    if (!marketOpen || packet.windowId !== windowId) return;

    const index = packet.slot - 10;
    const page = state.pages[state.page];
    const listing = index >= 0 && index < page.length ? page[index] : null;

    if (listing) {
      if (state.emeralds < listing.price) {
        // Wynncraft refuses and leaves the board alone; so does this.
        sendMarket();
        return;
      }
      state.emeralds -= listing.price;
      state.sold.push({ ...listing, ts: Date.now() });
      page[index] = null;
      sendInventory();
      sendMarket();
      return;
    }

    if (packet.slot === 53 && state.page < state.pages.length - 1) {
      state.page += 1;
      sendMarket();
      return;
    }
    if (packet.slot === 45 && state.page > 0) {
      state.page -= 1;
      sendMarket();
    }
  }

  server.on('playerJoin', (joined) => {
    client = joined;
    client.on('error', (err) => events.emit('error', err));
    client.write('login', {
      ...mcData.loginPacket,
      entityId: client.id,
      gameMode: 0,
      previousGameMode: 255,
      dimension: 0,
      hashedSeed: [0, 0],
      isDebug: false,
      isFlat: false,
      portalCooldown: 0,
      seaLevel: 64
    });
    // mineflayer spawns on the first non-zero health, not on the login packet.
    setImmediate(() => {
      client.write('position', {
        x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, flags: 0, teleportId: 1, dismountVehicle: false,
        change: { x: 0.5, y: 64, z: 0.5 }, movementDelta: { x: 0, y: 0, z: 0 },
        rotation: { yaw: 0, pitch: 0 }
      });
      client.write('update_health', { health: 20, food: 20, foodSaturation: 5 });
      sendInventory();
      events.emit('spawned');
    });

    client.on('window_click', handleClick);
    client.on('close_window', (packet) => {
      state.closes.push(packet);
      if (packet.windowId === windowId) marketOpen = false;
    });
    const onChat = (packet) => state.chat.push(packet.message);
    client.on('chat', onChat);
    client.on('chat_message', onChat);
  });

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const handle = {
    version,
    mcData,
    state,
    events,
    port: server.socketServer.address().port,

    /** Opens the Trade Market in front of the bot. */
    openMarket() {
      if (!client) throw new Error('No bot has joined the harness yet');
      windowId += 1;
      marketOpen = true;
      client.write('open_window', {
        windowId, inventoryType: CHEST_9X6, windowTitle: text(state.title)
      });
      sendMarket();
      return windowId;
    },

    /** Opens something that is not the market, to test the title guard. */
    openWindow(title) {
      if (!client) throw new Error('No bot has joined the harness yet');
      windowId += 1;
      marketOpen = false;
      client.write('open_window', { windowId, inventoryType: CHEST_9X6, windowTitle: text(title) });
      client.write('window_items', {
        windowId,
        stateId: stateId++,
        items: new Array(CONTAINER_SLOTS + PLAYER_SLOTS).fill(EMPTY_SLOT),
        carriedItem: EMPTY_SLOT
      });
      return windowId;
    },

    /** Reprices or replaces a listing under the bot, and pushes the change. */
    setListing(index, listing, page = state.page) {
      state.pages[page][index] = listing;
      if (page === state.page) sendMarket();
    },

    /** Sets the purse and pushes it, for tests about what the bot can afford. */
    setEmeralds(total) {
      state.emeralds = total;
      sendInventory();
    },

    resendInventory: sendInventory,
    resendMarket: sendMarket,

    async close() {
      await new Promise((resolve) => {
        server.on('close', resolve);
        server.close();
      });
    }
  };

  return handle;
}

/**
 * Joins a real mineflayer bot, with the real Wynncraft plugin and the real
 * market controller, and resolves once it has spawned.
 *
 * The plugin's lobby automation is off: it would answer dialogue and pick a
 * character against a server that has neither, and the harness is here for the
 * market, not for the login flow.
 */
function connectBot(harness, options = {}) {
  const { wynncraftPlugin } = require(path.join(BOT_DIR, 'src/wynncraft.js'));
  const { attachMarket } = require(path.join(BOT_DIR, 'src/market.js'));

  const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port: harness.port,
    username: options.username || 'harness',
    version: harness.version,
    auth: 'offline',
    viewDistance: 2,
    checkTimeoutInterval: 60 * 1000
  });

  wynncraftPlugin(bot, {
    autoDialogue: false, autoResourcePack: false, autoQuickConnect: false,
    autoLock: false, antiAfk: false
  });
  attachMarket(bot, options.market || {});

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bot did not spawn against the harness')), 20000);
    bot.once('spawn', () => {
      clearTimeout(timer);
      resolve(bot);
    });
    bot.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { startWynnServer, connectBot, priceText, WYNN_VERSION };
