'use strict';

const fs = require('fs');
const path = require('path');

const DASHBOARD_DIR = path.resolve(__dirname, '../../dashboard');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : path.posix.normalize(pathname).replace(/^\/+/, '');
  const dashboardRoot = path.resolve(DASHBOARD_DIR);
  const filePath = path.resolve(dashboardRoot, relative);
  if (filePath !== dashboardRoot && !filePath.startsWith(`${dashboardRoot}${path.sep}`)) {
    res.writeHead(403); res.end(); return true;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404); res.end(); return true;
  }
  const payload = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Content-Length': payload.length });
  if (req.method !== 'HEAD') res.end(payload); else res.end();
  return true;
}

module.exports = { DASHBOARD_DIR, MIME_TYPES, serveStatic };
