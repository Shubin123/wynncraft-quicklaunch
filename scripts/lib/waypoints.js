'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const WAYPOINT_FILE = process.env.WYNN_WAYPOINT_FILE || path.join(os.homedir(), '.config', 'wynn-dashboard', 'waypoints.json');
const BUILTIN_WAYPOINTS = [
  { name: 'Ragni', x: -890, y: 67, z: -1565, desc: 'Starting City (Level 1+)', builtin: true },
  { name: 'Detlas', x: 470, y: 67, z: -1575, desc: 'Main Trading Hub', builtin: true },
  { name: 'Trade Market (Detlas)', x: 500, y: 68, z: -1578, desc: 'Trade Market location in Detlas', builtin: true },
  { name: 'Almuj', x: 950, y: 80, z: -1950, desc: 'Desert City (Level 50+)', builtin: true },
  { name: 'Nesaak', x: 120, y: 70, z: -800, desc: 'Snow City (Level 40+)', builtin: true },
  { name: 'Llevigar', x: -200, y: 40, z: -4400, desc: 'Gavel Portal City (Level 40+)', builtin: true },
  { name: 'Olux', x: -1680, y: 55, z: -5500, desc: 'Swamp City (Level 55+)', builtin: true },
  { name: 'Cinfras', x: -450, y: 45, z: -4900, desc: 'Gavel Capital (Level 70+)', builtin: true },
  { name: 'Thanos', x: 400, y: 80, z: -5200, desc: 'Canyon Fortress (Level 80+)', builtin: true },
  { name: 'Rodoroc', x: 1100, y: 20, z: -5100, desc: 'Dwarven Capital (Level 90+)', builtin: true },
  { name: 'Lutho', x: 800, y: 110, z: -850, desc: 'Silent Expanse Entry (Level 100+)', builtin: true },
];

function validWaypoint(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim()) return false;
  return ['x', 'y', 'z'].every((key) => Number.isFinite(Number(value[key])));
}
function readCustom() {
  try {
    const rows = JSON.parse(fs.readFileSync(WAYPOINT_FILE, 'utf8'));
    return Array.isArray(rows) ? rows.filter(validWaypoint).map((row) => ({ ...row, builtin: false })) : [];
  } catch { return []; }
}
function writeCustom(rows) {
  fs.mkdirSync(path.dirname(WAYPOINT_FILE), { recursive: true });
  fs.writeFileSync(WAYPOINT_FILE, `${JSON.stringify(rows, null, 2)}\n`);
}
function listWaypoints() { return [...BUILTIN_WAYPOINTS, ...readCustom()]; }
function saveWaypoint(value) {
  if (!validWaypoint(value)) return { ok: false, error: 'name and numeric x, y, z coordinates are required' };
  const row = { name: value.name.trim(), x: Number(value.x), y: Number(value.y), z: Number(value.z), desc: String(value.desc || 'Saved browser position') };
  const rows = readCustom().filter((item) => item.name.toLowerCase() !== row.name.toLowerCase());
  rows.push(row); writeCustom(rows); return { ok: true, waypoint: row, waypoints: listWaypoints() };
}
function deleteWaypoint(name) {
  const before = readCustom(); const rows = before.filter((item) => item.name.toLowerCase() !== String(name || '').trim().toLowerCase());
  writeCustom(rows); return { ok: rows.length !== before.length, waypoints: listWaypoints() };
}

module.exports = { WAYPOINT_FILE, BUILTIN_WAYPOINTS, listWaypoints, saveWaypoint, deleteWaypoint, validWaypoint };
