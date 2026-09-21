'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PATH_FILE = process.env.WYNN_MANUAL_PATH_FILE || path.join(os.homedir(), '.config', 'wynn-dashboard', 'manual_paths.json');

function validPoint(point) {
  return point && ['x', 'y', 'z'].every((key) => Number.isFinite(Number(point[key])));
}
function readPaths() {
  try {
    const data = JSON.parse(fs.readFileSync(PATH_FILE, 'utf8'));
    return Array.isArray(data) ? data.filter((item) => item && typeof item.name === 'string' && Array.isArray(item.points) && item.points.every(validPoint)) : [];
  } catch { return []; }
}
function writePaths(paths) {
  fs.mkdirSync(path.dirname(PATH_FILE), { recursive: true });
  fs.writeFileSync(PATH_FILE, `${JSON.stringify(paths, null, 2)}\n`);
}
function listPaths() { return readPaths(); }
function savePath(name, points, description = '') {
  const cleanName = String(name || '').trim();
  if (!cleanName) return { ok: false, error: 'path name is required' };
  if (!Array.isArray(points) || points.length < 2 || !points.every(validPoint)) return { ok: false, error: 'a path needs at least two valid recorded positions' };
  const pathData = { name: cleanName, description: String(description || ''), points: points.map((p) => ({ x: Number(p.x), y: Number(p.y), z: Number(p.z) })), savedAt: new Date().toISOString() };
  const paths = readPaths().filter((item) => item.name.toLowerCase() !== cleanName.toLowerCase());
  paths.push(pathData); writePaths(paths); return { ok: true, path: pathData, paths };
}
function deletePath(name) {
  const before = readPaths(); const paths = before.filter((item) => item.name.toLowerCase() !== String(name || '').trim().toLowerCase());
  writePaths(paths); return { ok: paths.length !== before.length, paths };
}

module.exports = { PATH_FILE, validPoint, listPaths, savePath, deletePath };
