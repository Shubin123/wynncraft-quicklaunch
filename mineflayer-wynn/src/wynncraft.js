const http = require('http');
const { classifyItemTags, inferTier } = require('./item_metadata');

/**
 * Strips Minecraft formatting codes (§a, §l, §x etc.) from strings.
 */
function stripFormatting(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/§x(§[0-9a-fA-F]){6}/gi, '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .trim();
}

/**
 * Cleans Wynncraft custom fonts, HUD glyphs (Unicode PUA), control characters, and normalizes spacing.
 */
function cleanWynncraftText(str) {
  if (!str) return '';
  let text = typeof str === 'string' ? str : String(str);
  text = stripFormatting(text);
  return text
    .replace(/[\uE000-\uF8FF]/g, ' ')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFD]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recursively extracts plain text from Mojang JSON text / NBT chat components.
 */
function parseChatComponent(comp, isRoot = true) {
  if (!comp) return '';
  if (typeof comp === 'string') {
    try {
      const parsed = JSON.parse(comp);
      return parseChatComponent(parsed, isRoot);
    } catch (e) {
      return isRoot ? cleanWynncraftText(comp) : comp;
    }
  }
  let text = '';
  if (comp.text) {
    text += typeof comp.text === 'object' ? (comp.text.value || parseChatComponent(comp.text, false)) : comp.text;
  }
  if (comp.value !== undefined) {
    if (typeof comp.value === 'string') text += comp.value;
    else if (typeof comp.value === 'number') text += String(comp.value);
    else if (Array.isArray(comp.value)) {
      for (const item of comp.value) text += parseChatComponent(item, false);
    } else if (typeof comp.value === 'object') {
      text += parseChatComponent(comp.value, false);
    }
  }
  if (comp.extra) {
    const list = comp.extra.value ? (comp.extra.value.value || comp.extra.value) : comp.extra;
    if (Array.isArray(list)) {
      for (const item of list) text += parseChatComponent(item, false);
    } else if (typeof list === 'object') {
      text += parseChatComponent(list, false);
    }
  }
  return isRoot ? cleanWynncraftText(text) : text;
}

/**
 * Extracts plain, unformatted text from string or Mojang NBT / JSON chat component.
 */
function extractCleanText(comp) {
  if (!comp) return '';
  if (typeof comp === 'string') {
    try {
      const parsed = JSON.parse(comp);
      const res = parseChatComponent(parsed, true);
      return cleanWynncraftText(res);
    } catch (e) {
      return cleanWynncraftText(comp);
    }
  }
  const extracted = parseChatComponent(comp, true);
  return cleanWynncraftText(extracted !== undefined && extracted !== null ? extracted : (typeof comp === 'object' ? JSON.stringify(comp) : String(comp)));
}

/**
 * Wynncraft character slots in standard 54-slot Character Selection chest container.
 * Sourced from Wynntils CharacterSelectionModel.
 */
const CHARACTER_SLOTS = [9, 10, 11, 18, 19, 20, 27, 28, 29, 36, 37, 38, 45, 46, 47];

/**
 * Mineflayer plugin providing Wynncraft-specific functionality.
 */
function wynncraftPlugin(bot, options = {}) {
  const wynn = {
    currentServer: 'Unknown',
    worldState: 'UNKNOWN', // 'HUB', 'SERVER_SELECT', 'CHARACTER_SELECTION', 'WORLD'
    selectedCharacter: null,
    availableCharacters: [],
    availableGates: [],
    antiAfkTimer: null,
    autoDialogue: options.autoDialogue ?? true,
    autoResourcePack: options.autoResourcePack ?? true,
    autoQuickConnect: options.autoQuickConnect ?? true,
    autoLock: options.autoLock ?? true,
    characterTarget: options.characterSlot ?? options.character ?? 'first',
    lastLobbyCheck: 0
  };

  bot.wynn = wynn;

  // -------------------------------------------------------------
  // 1. Resource Pack Handling
  // -------------------------------------------------------------
  if (wynn.autoResourcePack) {
    bot.on('resourcePack', () => {
      try {
        bot.acceptResourcePack();
      } catch (e) {
        // ignore
      }
    });
  }

  // -------------------------------------------------------------
  // 2. Chat & Dialogue Parsing
  // -------------------------------------------------------------
  bot.on('message', (jsonMsg, position) => {
    let rawText = '';
    let cleanText = '';
    try {
      rawText = jsonMsg ? jsonMsg.toString() : '';
      const parsed = parseChatComponent(jsonMsg);
      cleanText = stripFormatting(parsed || rawText);
    } catch (e) {
      rawText = String(jsonMsg || '');
      cleanText = stripFormatting(rawText);
    }

    bot.emit('wynn:chat', cleanText, rawText, jsonMsg);

    // Detect NPC Dialogue: e.g. "Bob: Hello traveler!" or "[1/3] Bob: ..."
    const dialogueMatch = cleanText.match(/^(?:\[\d+\/\d+\]\s*)?([A-Za-z0-9 _'-]+):\s*(.+)$/);
    if (dialogueMatch) {
      const npc = dialogueMatch[1].trim();
      const speech = dialogueMatch[2].trim();
      bot.emit('wynn:dialogue', { npc, speech, raw: cleanText });
    }

    // Auto-advance dialogue when prompted: [Press SHIFT to continue]
    if (wynn.autoDialogue && cleanText.includes('[Press SHIFT to continue]')) {
      bot.setControlState('sneak', true);
      setTimeout(() => {
        bot.setControlState('sneak', false);
      }, 300);
    }

    // Detect Quest notifications
    if (cleanText.startsWith('[Quest Updated:') || cleanText.startsWith('[New Quest:')) {
      bot.emit('wynn:quest', cleanText);
    }

    // Detect Trade Market notifications
    if (cleanText.includes('[Trade Market]')) {
      bot.emit('wynn:market', cleanText);
    }

    // Detect Server switching
    const serverMatch = cleanText.match(/Connecting to (WC\d+|Hub\d*)/i);
    if (serverMatch) {
      wynn.currentServer = serverMatch[1].toUpperCase();
      bot.emit('wynn:worldchange', wynn.currentServer);
    }
  });

  // 2b. Screen Titles & Action Bar Parsing (Informed Player Experience)
  bot.on('title', (titleText) => {
    let clean = '';
    try {
      clean = cleanWynncraftText(parseChatComponent(titleText) || String(titleText || ''));
    } catch (e) {
      clean = cleanWynncraftText(String(titleText || ''));
    }
    if (clean && clean.length > 1) {
      bot.emit('wynn:title', clean);
      bot.emit('wynn:chat', `[Title] ${clean}`, clean);
    }
  });

  let lastActionBar = '';
  let lastActionBarTime = 0;

  bot.on('actionBar', (actionMsg) => {
    let clean = '';
    try {
      clean = cleanWynncraftText(parseChatComponent(actionMsg) || String(actionMsg || ''));
    } catch (e) {
      clean = cleanWynncraftText(String(actionMsg || ''));
    }
    if (clean) {
      const now = Date.now();
      const isDuplicate = clean === lastActionBar && (now - lastActionBarTime < 10000);
      lastActionBar = clean;
      lastActionBarTime = now;

      wynn.currentActionBar = clean;

      if (!isDuplicate) {
        bot.emit('wynn:actionbar', clean);
      }

      // Detect Wynncraft Character Selection Lobby HUD
      if (clean.includes('Left-Click to play') || clean.includes('Right-Click to switch')) {
        updateWorldState('CHARACTER_SELECTION');
        if (wynn.autoLock && !wynn.manualOverride) {
          scheduleLobbyAutoSelect();
        }
      }
    }
  });

  // -------------------------------------------------------------
  // 3. World State & Spawn Detection
  // -------------------------------------------------------------
  function updateWorldState(newState) {
    if (wynn.worldState !== newState) {
      const oldState = wynn.worldState;
      wynn.worldState = newState;
      bot.emit('wynn:state', newState, oldState);
      if (newState === 'WORLD') {
        bot.emit('wynn:ready', bot.entity?.position);
      }
    }
  }

  function checkWorldStateFromPosition() {
    const pos = bot.entity?.position;
    if (!pos) return;
    if (Math.abs(pos.x - 18370.9) < 100 || Math.abs(pos.x - -1337.5) < 50) {
      updateWorldState('CHARACTER_SELECTION');
    } else if (pos.x > 250 && pos.x < 350 && pos.z > 280 && pos.z < 360) {
      updateWorldState('HUB');
    } else if (pos.x < 10000 && pos.y > 0) {
      updateWorldState('WORLD');
    }
  }

  bot.on('spawn', () => {
    checkWorldStateFromPosition();
    if (wynn.worldState === 'CHARACTER_SELECTION' && wynn.autoLock) {
      scheduleLobbyAutoSelect();
    }
  });

  bot.on('forcedMove', () => {
    checkWorldStateFromPosition();
  });

  function findLobbyInteractionEntity() {
    if (!bot.entities) return null;
    const botPos = bot.entity?.position;
    if (!botPos) return null;
    let nearest = null;
    let minDist = 6;
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position) continue;
      const n = (e.name || '').toLowerCase();
      // Minecraft 1.20+ interaction hitbox or item_display or armor_stand
      if (n === 'interaction' || n === 'item_display' || n === 'armor_stand') {
        const d = botPos.distanceTo(e.position);
        if (d < minDist) {
          minDist = d;
          nearest = e;
        }
      }
    }
    return nearest;
  }

  function triggerLobbyLeftClick() {
    const target = findLobbyInteractionEntity();
    if (target && typeof bot.attack === 'function') {
      try { bot.attack(target, true); } catch (e) {}
    }
    try { bot.swingArm('right'); } catch (e) {}
  }

  function triggerLobbyRightClick() {
    const target = findLobbyInteractionEntity();
    if (target) {
      if (typeof bot.useOn === 'function') {
        try { bot.useOn(target); } catch (e) {}
      } else if (bot._client) {
        try {
          bot._client.write('use_entity', {
            target: target.id,
            mouse: 0,
            sneaking: false,
            location: { x: 0, y: 0, z: 0 }
          });
        } catch (e) {}
      }
    }
    try { bot.activateItem(); } catch (e) {}
  }

  wynn.findLobbyInteractionEntity = findLobbyInteractionEntity;
  wynn.triggerLobbyLeftClick = triggerLobbyLeftClick;
  wynn.triggerLobbyRightClick = triggerLobbyRightClick;

  function scheduleLobbyAutoSelect() {
    const now = Date.now();
    if (now - (wynn.lastLobbyCheck || 0) < 3000) return;
    wynn.lastLobbyCheck = now;

    setTimeout(async () => {
      if (wynn.worldState !== 'CHARACTER_SELECTION') return;
      if (bot.currentWindow) {
        await wynn.selectCharacter(wynn.characterTarget);
      } else {
        // In character lobby without an open container:
        if (wynn.characterTarget === 'first') {
          console.log('[Wynncraft] Lobby auto-play: Left-Clicking (interaction entity / swingArm) to enter world');
          triggerLobbyLeftClick();
        } else {
          console.log('[Wynncraft] Lobby auto-switch: Opening character GUI for target:', wynn.characterTarget);
          await wynn.selectCharacter(wynn.characterTarget);
        }
      }
    }, 1200);
  }

  // -------------------------------------------------------------
  // 4. Window & Container Manipulation (Glass Panes & Character GUI)
  /**
   * Scans an open window for world gates and character cards.
   * Can be called on windowOpen, on slot updates, or on-demand.
   */
  wynn.scanWindow = function (window = bot.currentWindow, emitEvents = true) {
    if (!window || !window.slots) {
      return { characters: wynn.availableCharacters || [], gates: wynn.availableGates || [] };
    }

    const cleanTitle = extractCleanText(window.title);
    const rawTitle = typeof window.title === 'string' ? window.title : JSON.stringify(window.title || '');

    const isServerSelect = cleanTitle.toLowerCase().includes('wynncraft servers') ||
      rawTitle.toLowerCase().includes('wynncraft servers') ||
      cleanTitle.toLowerCase().includes('server') ||
      wynn.worldState === 'SERVER_SELECT';

    const isCharWindow = cleanTitle.toLowerCase().includes('character') ||
      cleanTitle.toLowerCase().includes('select a character') ||
      rawTitle.includes('\uDF7D') || rawTitle.includes('\uE01F') ||
      rawTitle.includes('󏿕') ||
      (wynn.worldState === 'CHARACTER_SELECTION' && window.slots.length >= 54);

    const maxScanSlot = window.inventoryStart || (window.slots.length > 54 ? 54 : window.slots.length);
    const chars = [];
    const gates = [];

    for (let s = 0; s < maxScanSlot; s++) {
      const item = window.slots[s];
      if (!item) continue;

      const isPane = item.name.includes('glass_pane');
      const customName = extractCleanText(item.customName);
      const rawLore = item.customLore || [];
      const lore = Array.isArray(rawLore) ? rawLore.map(l => extractCleanText(l)).filter(Boolean) : [];

      // Only skip empty filler panes with no title and no lore
      const isFillerPane = isPane && (!customName || customName.trim() === '') && lore.length === 0;
      if (isFillerPane) continue;

      // Check for Real World Gate (matches NA11, NA | 11, EU2, WC1, World 1, World 17, AS5, etc.)
      const gateMatch = customName.match(/^(?:(NA|EU|AS|OC|SA|WC|World)\s*(?:\||-)?\s*)?(?:World|WC)?\s*(\d+)/i);
      const isGate = !!gateMatch ||
        customName.toLowerCase().includes('world') ||
        customName.toLowerCase().includes('connect to') ||
        lore.some(l => l.toLowerCase().includes('online') || l.toLowerCase().includes('connect') || l.toLowerCase().includes('wynncraft server')) ||
        ([48, 49, 50, 51, 52].includes(s) && (customName.toLowerCase().includes('world') || item.name.includes('terracotta') || item.name.includes('concrete')));

      if (isGate) {
        let worldNumber = null;
        let region = 'DEFAULT';
        if (gateMatch) {
          const regRaw = gateMatch[1] ? gateMatch[1].toUpperCase() : 'DEFAULT';
          region = (regRaw === 'WORLD' || regRaw === 'WC') ? 'DEFAULT' : regRaw;
          worldNumber = parseInt(gateMatch[2], 10);
        } else {
          const numMatch = customName.match(/\d+/) || lore.join(' ').match(/(?:World|WC)\s*(\d+)/i);
          if (numMatch) worldNumber = parseInt(numMatch[1] || numMatch[0], 10);
        }
        let onlinePlayers = null;
        let lag = null;
        for (const line of lore) {
          const pMatch = line.match(/(\d+)\s*\/\s*(\d+)/);
          if (pMatch) onlinePlayers = `${pMatch[1]}/${pMatch[2]}`;
          const lagMatch = line.match(/(\d+)%\s*lag/i);
          if (lagMatch) lag = `${lagMatch[1]}%`;
        }
        const isRecommended = customName.toLowerCase().includes('recommended') || item.name.includes('diamond');

        const gateObj = {
          slot: s,
          name: customName || `World Gate (Slot ${s})`,
          worldNumber,
          region,
          onlinePlayers,
          lag,
          recommended: isRecommended,
          lore,
          item
        };
        gates.push(gateObj);
      } else if (isCharWindow || (!isServerSelect && CHARACTER_SLOTS.includes(s))) {
        let charClass = 'Unknown';
        let charLevel = 0;

        for (const line of lore) {
          const classMatch = line.match(/Class:\s*([A-Za-z/ _-]+)/i);
          if (classMatch) charClass = classMatch[1].trim();

          const levelMatch = line.match(/(?:Combat\s*)?Level:\s*(\d+)/i);
          if (levelMatch) charLevel = parseInt(levelMatch[1], 10);
        }

        if (charClass === 'Unknown') {
          const knownClasses = ['Mage', 'Warrior', 'Archer', 'Assassin', 'Shaman'];
          for (const kc of knownClasses) {
            if (customName.toLowerCase().includes(kc.toLowerCase())) {
              charClass = kc;
              break;
            }
          }
        }

        if (charClass !== 'Unknown' || CHARACTER_SLOTS.includes(s)) {
          chars.push({
            slot: s,
            name: customName || `Character (Slot ${s})`,
            class: charClass,
            level: charLevel,
            lore,
            count: item.count,
            item
          });
        }
      }
    }

    wynn.availableGates = gates;
    if (chars.length > 0) {
      wynn.availableCharacters = chars;
    }

    if (emitEvents) {
      if (gates.length > 0) {
        bot.emit('wynn:gates', gates, window);
        for (const g of gates) {
          bot.emit('wynn:gate_found', g);
        }
      }
      if (chars.length > 0) {
        bot.emit('wynn:characters', chars, window);
      }
    }

    return { characters: chars, gates };
  };

  bot.on('windowOpen', async (window) => {
    const cleanTitle = extractCleanText(window.title);
    const rawTitle = typeof window.title === 'string' ? window.title : JSON.stringify(window.title || '');

    const isServerSelect = cleanTitle.toLowerCase().includes('wynncraft servers') ||
      rawTitle.toLowerCase().includes('wynncraft servers') ||
      cleanTitle.toLowerCase().includes('server');

    const isCharWindow = cleanTitle.toLowerCase().includes('character') ||
      cleanTitle.toLowerCase().includes('select a character') ||
      rawTitle.includes('\uDF7D') || rawTitle.includes('\uE01F') ||
      rawTitle.includes('󏿕') ||
      (wynn.worldState === 'CHARACTER_SELECTION' && window.slots.length >= 54);

    if (isServerSelect) {
      updateWorldState('SERVER_SELECT');
    } else if (isCharWindow) {
      updateWorldState('CHARACTER_SELECTION');
    }

    // Always scan window immediately for gates & characters
    const scanRes = wynn.scanWindow(window);

    // Keep gates/characters updated if slots arrive or change progressively
    const onUpdateSlot = () => {
      wynn.scanWindow(window);
    };
    if (typeof window.on === 'function') {
      window.on('updateSlot', onUpdateSlot);
      bot.once('windowClose', () => {
        if (typeof window.removeListener === 'function') {
          window.removeListener('updateSlot', onUpdateSlot);
        }
      });
    }

    // A. Auto Quick-Connect for Server Picker Window
    if (isServerSelect && wynn.autoQuickConnect) {
      setTimeout(async () => {
        try {
          if (!bot.currentWindow || bot.currentWindow.id !== window.id) return;
          const maxContainerSlot = window.inventoryStart || 54;
          let targetSlot = null;

          // 1. Search for Quick Connect / Quick Join by name
          for (let s = 0; s < maxContainerSlot; s++) {
            const it = window.slots[s];
            if (!it) continue;
            const custom = extractCleanText(it.customName).toLowerCase();
            if (custom.includes('quick connect') || custom.includes('quick join')) {
              targetSlot = s;
              break;
            }
          }

          // 2. Fallback: search for compass in container slots
          if (targetSlot === null) {
            for (let s = 0; s < maxContainerSlot; s++) {
              const it = window.slots[s];
              if (it && it.name && it.name.includes('compass')) {
                targetSlot = s;
                break;
              }
            }
          }

          // 3. Fallback: try slot 81 only if valid for this window
          if (targetSlot === null && 81 < (bot.currentWindow.inventoryEnd || 0)) {
            targetSlot = 81;
          }

          if (targetSlot !== null && targetSlot < (bot.currentWindow.inventoryEnd || 0)) {
            await bot.clickWindow(targetSlot, 0, 0);
          }
        } catch (e) {
          console.warn('[Wynncraft] Quick-connect error:', e.message);
        }
      }, 300);
      return;
    }

    // B. Character Selection auto-lock
    if (isCharWindow && wynn.autoLock && scanRes.characters.length > 0) {
      setTimeout(async () => {
        try {
          await wynn.selectCharacter(wynn.characterTarget);
        } catch (e) {
          console.warn('[Wynncraft] Auto-lock error:', e.message);
        }
      }, 300);
    }
  });

  /**
   * Returns full structured information about the currently open window,
   * including decorative glass panes, character cards, real world gates, and slot indices.
   */
  wynn.getOpenWindow = function () {
    const win = bot.currentWindow;
    if (!win) {
      const inventorySlots = bot.inventory?.slots || [];
      // Same shape whether or not a container is open: callers should not have
      // to check which branch produced the object before reading it.
      return {
        open: false,
        id: 0,
        type: 'inventory',
        title: 'Player Inventory',
        totalSlots: inventorySlots.length,
        availableCharacters: wynn.availableCharacters || [],
        availableGates: wynn.availableGates || [],
        slots: inventorySlots.map((item, idx) => formatSlot(item, idx, true))
      };
    }

    if ((!wynn.availableGates || wynn.availableGates.length === 0) && win.slots) {
      wynn.scanWindow(win, false);
    }

    const cleanTitle = extractCleanText(win.title);
    const rawTitle = typeof win.title === 'string' ? win.title : JSON.stringify(win.title || '');

    return {
      open: true,
      id: win.id,
      type: win.type || 'container',
      title: cleanTitle || rawTitle || `Window #${win.id}`,
      totalSlots: win.slots.length,
      availableCharacters: wynn.availableCharacters || [],
      availableGates: wynn.availableGates || [],
      slots: win.slots.map((item, idx) => formatSlot(item, idx, false))
    };
  };

  function formatSlot(item, idx, isPlayerInv) {
    if (!item) {
      return {
        slot: idx,
        empty: true,
        name: 'empty',
        count: 0,
        customName: '',
        lore: [],
        isGlassPane: false,
        isCharacterSlot: !isPlayerInv && CHARACTER_SLOTS.includes(idx),
        isWorldGate: false,
        gateInfo: null
      };
    }

    const name = item.name || '';
    const isGlassPane = name.includes('glass_pane');
    const customName = extractCleanText(item.customName);
    const rawLore = item.customLore || [];
    const lore = Array.isArray(rawLore) ? rawLore.map(l => extractCleanText(l)).filter(Boolean) : [];
    const tier = inferTier(customName, lore);
    const metadata = classifyItemTags(name, customName, lore, tier);
    const isCharacterSlot = !isPlayerInv && CHARACTER_SLOTS.includes(idx) && !isGlassPane;

    const gateMatch = customName.match(/^(?:([A-Z]{2,3})\s*\|\s*)?(?:World|WC)\s*(\d+)/i);
    const isWorldGate = !isPlayerInv && !isGlassPane && (!!gateMatch || (!isCharacterSlot && customName.toLowerCase().includes('world')));
    
    let onlinePlayers = null;
    let lag = null;
    if (isWorldGate) {
      for (const line of lore) {
        const pMatch = line.match(/(\d+)\s*\/\s*(\d+)/);
        if (pMatch) onlinePlayers = `${pMatch[1]}/${pMatch[2]}`;
        const lagMatch = line.match(/(\d+)%\s*lag/i);
        if (lagMatch) lag = `${lagMatch[1]}%`;
      }
    }
    const gateInfo = isWorldGate ? {
      world: gateMatch ? parseInt(gateMatch[2], 10) : (customName.match(/\d+/) ? parseInt(customName.match(/\d+/)[0], 10) : null),
      region: gateMatch ? (gateMatch[1] || 'DEFAULT') : 'DEFAULT',
      onlinePlayers,
      lag,
      recommended: customName.toLowerCase().includes('recommended') || name.includes('diamond')
    } : null;

    return {
      slot: idx,
      empty: false,
      name,
      count: item.count || 1,
      customName,
      displayName: customName || name,
      lore,
      tier,
      ...metadata,
      isGlassPane,
      isCharacterSlot,
      isWorldGate,
      gateInfo
    };
  }

  /**
   * Safely clicks a slot in the current window or player inventory.
   * If targeting container slots (0-53) and no window is open, summons the window first.
   */
  wynn.clickWindowSlot = async function (slot, button = 0, mode = 0, windowId = null) {
    let targetWindow = bot.currentWindow;

    // If no window is currently open, and slot is in 0..53, attempt to summon the lobby container window first
    if (!targetWindow && slot >= 0 && slot <= 53 && (windowId === null || windowId === 0 || windowId === undefined)) {
      triggerLobbyRightClick();
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 1000);
        bot.once('windowOpen', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      targetWindow = bot.currentWindow;
    }

    if (targetWindow && (windowId === null || windowId === undefined || windowId === targetWindow.id || windowId === 0)) {
      const maxSlot = targetWindow.inventoryEnd || targetWindow.slots.length;
      if (slot < 0 || slot >= maxSlot) {
        throw new Error(`Slot ${slot} out of bounds (window has valid slots 0-${maxSlot - 1}).`);
      }
      await bot.clickWindow(slot, button, mode);
      return { ok: true, windowId: targetWindow.id, slot };
    }

    // Fallback or explicit player inventory (window ID 0)
    const invEnd = bot.inventory?.inventoryEnd || 45;
    if (slot < 0 || slot >= invEnd) {
      throw new Error(`Slot ${slot} out of bounds for player inventory (0-${invEnd - 1}).`);
    }
    await bot.clickWindow(slot, button, mode);
    return { ok: true, windowId: 0, slot };
  };

  /**
   * Selects a character by slot number (1-15), class name, or 'first',
   * or allows manual override of any specific container slot or glass pane index.
   */
  wynn.selectCharacter = async function (slotOrClass = 'first', options = {}) {
    let window = bot.currentWindow;
    if (!window) {
      if (slotOrClass === 'first') {
        console.log('[Wynncraft] No container open: performing Left-Click (interaction entity / swingArm) to play');
        triggerLobbyLeftClick();
        return true;
      }

      console.log('[Wynncraft] No container open: opening character selection container window...');
      triggerLobbyRightClick();

      // Wait up to 1500ms for container window to open
      window = await new Promise((resolve) => {
        let timer = null;
        const onWin = (w) => {
          clearTimeout(timer);
          bot.removeListener('windowOpen', onWin);
          resolve(w);
        };
        timer = setTimeout(() => {
          bot.removeListener('windowOpen', onWin);
          resolve(bot.currentWindow);
        }, 1500);
        bot.once('windowOpen', onWin);
      });

      if (!window) {
        console.warn('[Wynncraft] Container window did not open, Left-Clicking (play) as fallback');
        triggerLobbyLeftClick();
        return false;
      }
    }

    try {
      const maxContainerSlot = window.inventoryStart || 54;
      const maxValidSlot = window.inventoryEnd || window.slots.length;

      // A. Manual Override: direct slot or pane index (e.g. 'raw:1', 'pane:0', 'slot:9', or options.rawSlot)
      let rawSlotIndex = null;
      if (typeof slotOrClass === 'string') {
        const rawMatch = slotOrClass.match(/^(?:raw|slot|pane):(\d+)$/i);
        if (rawMatch) {
          rawSlotIndex = parseInt(rawMatch[1], 10);
        }
      }
      if (rawSlotIndex === null && options.rawSlot !== undefined && options.rawSlot !== false) {
        rawSlotIndex = typeof options.rawSlot === 'number' ? options.rawSlot : parseInt(slotOrClass, 10);
      }
      if (rawSlotIndex === null && options.manualSlot !== undefined) {
        rawSlotIndex = parseInt(options.manualSlot, 10);
      }

      if (rawSlotIndex !== null && !isNaN(rawSlotIndex)) {
        if (rawSlotIndex >= 0 && rawSlotIndex < maxValidSlot) {
          console.log(`[Wynncraft] Manual Override: Clicking container slot/pane #${rawSlotIndex}`);
          await bot.clickWindow(rawSlotIndex, 0, 0);
          return true;
        }
        return false;
      }

      // B. If target is 'first' (automatic character card discovery)
      if (slotOrClass === 'first' || slotOrClass === '' || slotOrClass === null || slotOrClass === undefined) {
        // Look through CHARACTER_SLOTS first
        for (const slot of CHARACTER_SLOTS) {
          if (slot < maxContainerSlot && slot < maxValidSlot) {
            const item = window.slots[slot];
            if (item) {
              const cName = extractCleanText(item.customName);
              const cLore = Array.isArray(item.customLore) ? item.customLore.map(l => extractCleanText(l)).filter(Boolean) : [];
              const isFiller = item.name.includes('glass_pane') && !cName && cLore.length === 0;
              if (!isFiller) {
                console.log(`[Wynncraft] Auto-selecting character at slot ${slot} (${cName || item.name})`);
                await bot.clickWindow(slot, 0, 0);
                return true;
              }
            }
          }
        }
        // Fallback: any non-filler item in container slots (0 to maxContainerSlot - 1)
        for (let s = 0; s < maxContainerSlot; s++) {
          const item = window.slots[s];
          if (item) {
            const cName = extractCleanText(item.customName);
            const cLore = Array.isArray(item.customLore) ? item.customLore.map(l => extractCleanText(l)).filter(Boolean) : [];
            const isFiller = item.name.includes('glass_pane') && !cName && cLore.length === 0;
            if (!isFiller) {
              console.log(`[Wynncraft] Fallback auto-selecting slot ${s} (${cName || item.name})`);
              await bot.clickWindow(s, 0, 0);
              return true;
            }
          }
        }
        return false;
      }

      // C. Target is 'char:N' (1-indexed character slot)
      if (typeof slotOrClass === 'string') {
        const charMatch = slotOrClass.match(/^char:?(\d+)$/i);
        if (charMatch) {
          const charIdx = parseInt(charMatch[1], 10);
          if (charIdx >= 1 && charIdx <= CHARACTER_SLOTS.length) {
            const targetSlot = CHARACTER_SLOTS[charIdx - 1];
            if (targetSlot < maxValidSlot) {
              await bot.clickWindow(targetSlot, 0, 0);
              return true;
            }
          }
        }
      }

      // D. Target is a numeric index
      const num = parseInt(slotOrClass, 10);
      if (!isNaN(num)) {
        let targetSlot = num;
        // Default: if between 1 and 15 and not explicitly raw, map to CHARACTER_SLOTS
        if (!options.rawSlot && num >= 1 && num <= CHARACTER_SLOTS.length) {
          targetSlot = CHARACTER_SLOTS[num - 1];
        }
        if (targetSlot >= 0 && targetSlot < maxValidSlot) {
          await bot.clickWindow(targetSlot, 0, 0);
          return true;
        }
        return false;
      }

      // E. If target is a class string (e.g. 'warrior', 'mage', 'archer', 'assassin', 'shaman')
      const search = String(slotOrClass).toLowerCase().trim();
      for (let i = 0; i < maxContainerSlot; i++) {
        const item = window.slots[i];
        if (!item) continue;

        const custom = extractCleanText(item.customName).toLowerCase();
        const lore = (item.customLore ? (Array.isArray(item.customLore) ? item.customLore.map(l => extractCleanText(l)).join(' ') : extractCleanText(item.customLore)) : '').toLowerCase();
        const isFiller = item.name.includes('glass_pane') && !custom && !lore;
        if (isFiller) continue;

        if (custom.includes(search) || lore.includes(search)) {
          console.log(`[Wynncraft] Found character matching '${search}' at slot ${i}`);
          await bot.clickWindow(i, 0, 0);
          return true;
        }
      }

      // Fallback: first available
      return wynn.selectCharacter('first');
    } catch (err) {
      console.warn('[Wynncraft] Error selecting character:', err.message);
      return false;
    }
  };

  /**
   * Finds a discovered real world gate in the character/gate lobby container.
   * Matches by world number (e.g. 1, 17, 'World 1', 'WC1') or returns the first discovered gate.
   */
  wynn.findRealGate = function (targetWorld = null) {
    if ((!wynn.availableGates || wynn.availableGates.length === 0) && bot.currentWindow) {
      wynn.scanWindow(bot.currentWindow, false);
    }
    if (!wynn.availableGates || wynn.availableGates.length === 0) return null;

    if (targetWorld === null || targetWorld === undefined || targetWorld === 'first') {
      return wynn.availableGates[0];
    }
    if (targetWorld === 'recommended') {
      const rec = wynn.availableGates.find(g => g.recommended);
      if (rec) return rec;
      return wynn.availableGates[0];
    }

    const targetStr = String(targetWorld).toLowerCase().trim();
    const regNumMatch = targetStr.match(/^(?:(na|eu|as|oc|sa|wc|world)\s*(?:\||-)?\s*)?(\d+)$/i);
    const targetRegion = regNumMatch && regNumMatch[1] ? regNumMatch[1].toUpperCase() : null;
    const targetWorldNum = regNumMatch ? parseInt(regNumMatch[2], 10) : parseInt(targetStr.replace(/^(?:wc|world)\s*/i, ''), 10);

    if (!isNaN(targetWorldNum)) {
      // 1. Try exact worldNumber + matching region
      for (const gate of wynn.availableGates) {
        if (gate.worldNumber === targetWorldNum) {
          if (!targetRegion || targetRegion === 'WORLD' || targetRegion === 'WC' || gate.region === targetRegion) {
            return gate;
          }
        }
      }
      // 2. Try exact worldNumber any region
      for (const gate of wynn.availableGates) {
        if (gate.worldNumber === targetWorldNum) return gate;
      }
      // 3. Try exact slot match
      for (const gate of wynn.availableGates) {
        if (gate.slot === targetWorldNum) return gate;
      }
    }
    // 4. Try name substring match
    for (const gate of wynn.availableGates) {
      const gName = gate.name.toLowerCase();
      if (gName === targetStr || gName.includes(targetStr) || gName.includes(`world ${targetStr}`) || gName.includes(`wc ${targetStr}`)) return gate;
    }
    return null;
  };

  /**
   * Clicks and enters a discovered real world gate in the lobby container.
   */
  wynn.selectGate = async function (targetWorld = null) {
    const gate = wynn.findRealGate(targetWorld);
    if (!gate) {
      console.warn('[Wynncraft] No real world gate found to select.');
      return { ok: false, error: 'No real world gate found' };
    }
    console.log(`[Wynncraft] Selecting Real World Gate: ${gate.name} (World ${gate.worldNumber}) at slot ${gate.slot}`);
    if (bot.currentWindow) {
      await bot.clickWindow(gate.slot, 0, 0);
      return { ok: true, gate };
    }
    if (typeof wynn.clickWindowSlot === 'function') {
      try {
        await wynn.clickWindowSlot(gate.slot, 0, 0);
        return { ok: true, gate };
      } catch (err) {
        if (typeof bot.clickWindow === 'function') {
          await bot.clickWindow(gate.slot, 0, 0);
          return { ok: true, gate };
        }
        throw err;
      }
    }
    if (typeof bot.clickWindow === 'function') {
      await bot.clickWindow(gate.slot, 0, 0);
    }
    return { ok: true, gate };
  };

  /**
   * Opens the character selection menu.
   */
  wynn.openClassMenu = function () {
    bot.chat('/class');
  };

  /**
   * Switches to a specific Wynncraft world (e.g. 'WC1' or '1').
   */
  wynn.switchServer = function (serverNumber) {
    const s = String(serverNumber).replace(/^WC/i, '');
    bot.chat(`/server WC${s}`);
  };

  /**
   * Returns to the Wynncraft Hub.
   */
  wynn.goToHub = function () {
    bot.chat('/hub');
  };

  // -------------------------------------------------------------
  // 5. Anti-AFK
  // -------------------------------------------------------------
  wynn.startAntiAfk = function (intervalMs = 45000) {
    if (wynn.antiAfkTimer) clearInterval(wynn.antiAfkTimer);
    wynn.antiAfkTimer = setInterval(() => {
      if (!bot.entity) return;
      const originalYaw = bot.entity.yaw;
      const originalPitch = bot.entity.pitch;

      // Small jitter look
      const jitterYaw = originalYaw + (Math.random() * 0.2 - 0.1);
      const jitterPitch = Math.max(-1.5, Math.min(1.5, originalPitch + (Math.random() * 0.2 - 0.1)));

      bot.look(jitterYaw, jitterPitch, true).then(() => {
        // Sneak briefly
        bot.setControlState('sneak', true);
        setTimeout(() => {
          bot.setControlState('sneak', false);
          bot.look(originalYaw, originalPitch, true).catch(() => {});
        }, 200);
      }).catch(() => {});
    }, intervalMs);
  };

  wynn.stopAntiAfk = function () {
    if (wynn.antiAfkTimer) {
      clearInterval(wynn.antiAfkTimer);
      wynn.antiAfkTimer = null;
    }
  };

  // -------------------------------------------------------------
  // 6. Currency Tracking
  // -------------------------------------------------------------
  /**
   * Calculates total Emeralds in bot's inventory (Emeralds, Blocks, LE).
   */
  wynn.countEmeralds = function () {
    let emeralds = 0;
    const items = bot.inventory?.items() || [];

    for (const item of items) {
      const name = item.name.toLowerCase();
      // A custom name arrives as a text component on 1.20.5+ and as a plain
      // string before that; extractCleanText reads both. stripFormatting reads
      // only the string and returns '' for anything else, which made every
      // liquid emerald invisible here - 4096 emeralds each, counted as none.
      // Nothing caught it until the bot was run against a real server
      // (tests/test_protocol_harness.js); the stand-in hands over a string.
      const custom = extractCleanText(item.customName).toLowerCase();

      if (name.includes('emerald_block') || custom.includes('emerald block')) {
        emeralds += item.count * 64;
      } else if (name.includes('emerald') || custom.includes('liquid emerald')) {
        if (custom.includes('liquid emerald')) {
          emeralds += item.count * 4096;
        } else {
          emeralds += item.count;
        }
      }
    }

    const le = Math.floor(emeralds / 4096);
    const eb = Math.floor((emeralds % 4096) / 64);
    const e = emeralds % 64;

    return {
      total: emeralds,
      le,
      eb,
      e,
      formatted: `${le} LE, ${eb} EB, ${e} E`
    };
  };

  // -------------------------------------------------------------
  // 7. Wynncraft / Quicklaunch Price Lookup
  // -------------------------------------------------------------
  /**
   * Queries the local quicklaunch price server or returns null.
   */
  wynn.getPrice = function (itemName, port = 8123) {
    return new Promise((resolve) => {
      const encoded = encodeURIComponent(itemName);
      const req = http.get({
        hostname: 'localhost',
        port,
        path: `/api/price?item=${encoded}`,
        timeout: 2500
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data);
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  };

  if (options.antiAfk) {
    bot.on('spawn', () => {
      wynn.startAntiAfk();
    });
  }
}

module.exports = {
  wynncraftPlugin,
  stripFormatting,
  cleanWynncraftText,
  parseChatComponent,
  extractCleanText,
  CHARACTER_SLOTS
};
