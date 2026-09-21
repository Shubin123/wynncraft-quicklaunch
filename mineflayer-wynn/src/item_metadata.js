'use strict';

function inferTier(customName, lore) {
  const text = `${customName || ''} ${(lore || []).join(' ')}`;
  return (text.match(/\b(mythic|fabled|legendary|rare|set|unique|normal)\b/i) || [])[1]?.toLowerCase() || null;
}

function classifyItemTags(name, customName, lore, tier = null) {
  const material = String(name || '').toLowerCase();
  const display = String(customName || '').trim();
  const text = `${material} ${display} ${(lore || []).join(' ')}`.toLowerCase();
  const tags = [];
  const add = (tag) => { if (tag && !tags.includes(tag)) tags.push(tag); };
  const knownWeapon = /^(pure|depressing\s+(stick|bow|dagger|spear|wand|relik))$/i.test(display);
  if (knownWeapon || /(sword|bow|dagger|spear|wand|relik|weapon|stick)/i.test(text)) add('weapon');
  if (/(helmet|chestplate|leggings|boots|armor|armour)/i.test(text)) add('armor');
  if (/(ring|bracelet|necklace|accessory)/i.test(text)) add('accessory');
  if (/(tome|guild|champion|loot|emerald|ingredient|relic|material)/i.test(text)) add('item');
  if (/shiny/i.test(text)) add('shiny');
  if (tier) add(String(tier).toLowerCase());
  if (!tags.includes('weapon') && !tags.includes('armor') && !tags.includes('accessory')) add('misc');
  const itemType = tags.find((tag) => ['weapon', 'armor', 'accessory', 'item', 'misc'].includes(tag)) || 'misc';
  return { itemType, typeTags: tags };
}

module.exports = { classifyItemTags, inferTier };
