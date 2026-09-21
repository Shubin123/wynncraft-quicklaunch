/**
 * Integration Tests for Wynncraft Dashboard and Bot Server
 *
 * Verifies the unified Node service, REST endpoints, static file serving, and CORS.
 */
const assert = require('assert');
const http = require('http');

const BASE_URL = 'http://localhost:8123';

console.log('\x1b[1;34m=== [INTEGRATION TESTS] Testing Unified Node Service ===\x1b[0m\n');

let passed = 0;
let total = 0;

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOptions = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const payload = body ? (typeof body === 'object' ? JSON.stringify(body) : body) : null;
    if (payload) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json
        });
      });
    });

    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function runTests() {
  async function testAsync(name, fn) {
    total++;
    try {
      await fn();
      console.log(`\x1b[32m✔ PASS:\x1b[0m ${name}`);
      passed++;
    } catch (err) {
      console.error(`\x1b[31m✘ FAIL:\x1b[0m ${name}`);
      console.error(`  Error: ${err.message}\n`);
    }
  }

  // 1. Dashboard Static Index
  await testAsync('GET / serves index.html with Bot Controller navigation tab', async () => {
    const res = await request(`${BASE_URL}/`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('href="bot.html"'), 'index.html must link to bot.html');
  });

  // 2. Bot Controller Static Page
  await testAsync('GET /bot.html serves the Bot Controller UI', async () => {
    const res = await request(`${BASE_URL}/bot.html`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('Wynncraft Bot Controller'), 'Contains title header');
    assert.ok(res.body.includes('id="btn-connect"'), 'Contains connect button');
    assert.ok(res.body.includes('id="chat-feed"'), 'Contains chat feed container');
  });

  // 3. Navigation across other dashboard pages
  await testAsync('All dashboard pages (predict, optimize) contain bot.html nav link', async () => {
    const pRes = await request(`${BASE_URL}/predict.html`);
    assert.strictEqual(pRes.statusCode, 200);
    assert.ok(pRes.body.includes('href="bot.html"'));

    const oRes = await request(`${BASE_URL}/optimize.html`);
    assert.strictEqual(oRes.statusCode, 200);
    assert.ok(oRes.body.includes('href="bot.html"'));
  });

  // 4. HTTP HEAD Method
  await testAsync('HEAD /bot.html returns 200 with Content-Length', async () => {
    const res = await request(`${BASE_URL}/bot.html`, { method: 'HEAD' });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(parseInt(res.headers['content-length'], 10) > 0, 'Content-Length must be present');
  });

  // 5. CORS OPTIONS
  await testAsync('OPTIONS /api/bot/status returns 204 with CORS headers', async () => {
    const res = await request(`${BASE_URL}/api/bot/status`, { method: 'OPTIONS' });
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers['access-control-allow-origin'], '*');
    assert.ok(res.headers['access-control-allow-methods'].includes('POST'));
  });

  // 6. Proxied GET /api/bot/status
  await testAsync('GET /api/bot/status proxied through port 8123 returns valid bot state', async () => {
    const res = await request(`${BASE_URL}/api/bot/status`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json, 'Response must be JSON');
    assert.strictEqual(typeof res.json.connected, 'boolean');
    assert.strictEqual(typeof res.json.status, 'string');
    assert.ok(res.json.prism, 'Prism metadata object present');
    assert.strictEqual(res.json.prism.instance, 'Wynncraft-1.21.11');
    assert.strictEqual(res.json.prism.minecraftVersion, '1.21.11');
    assert.strictEqual(res.json.prism.host, 'play.wynncraft.com');
    assert.strictEqual(typeof res.json.prism.account.name, 'string');
    assert.ok(res.json.prism.account.name.length > 0);
    assert.strictEqual(typeof res.json.prism.account.isTokenValid, 'boolean');
  });

  // 7. Proxied GET /api/bot/waypoints
  await testAsync('GET /api/bot/waypoints returns list of key Wynncraft POIs', async () => {
    const res = await request(`${BASE_URL}/api/bot/waypoints`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json && Array.isArray(res.json.waypoints));
    assert.ok(res.json.waypoints.length >= 8);
    const detlas = res.json.waypoints.find(w => w.name.includes('Detlas'));
    assert.ok(detlas, 'Detlas waypoint exists');
    assert.strictEqual(typeof detlas.x, 'number');
    assert.strictEqual(typeof detlas.z, 'number');
  });

  // 8. Proxied POST /api/bot/antiafk
  await testAsync('POST /api/bot/antiafk forwards body and toggles state', async () => {
    const res = await request(`${BASE_URL}/api/bot/antiafk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { enabled: true });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json && res.json.ok === true);
    assert.strictEqual(res.json.antiAfk, true);
  });

  // 9. Proxied GET /api/bot/poll
  await testAsync('GET /api/bot/poll returns status and messages array', async () => {
    const res = await request(`${BASE_URL}/api/bot/poll?since=0`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json && res.json.status);
    assert.ok(Array.isArray(res.json.messages));
  });

  // 10. Unified service parity: bot and dashboard surfaces share one listener.
  await testAsync('One Node service serves both bot API and dashboard data surfaces', async () => {
    const botRes = await request(`${BASE_URL}/api/bot/status`);
    const historyRes = await request(`${BASE_URL}/api/history_local?item=Spring`);
    assert.strictEqual(botRes.statusCode, 200);
    assert.strictEqual(historyRes.statusCode, 200);
    assert.strictEqual(typeof botRes.json.connected, 'boolean');
    assert.ok(Array.isArray(historyRes.json.points));
  });

  // 11. Proxied GET /api/bot/window
  await testAsync('GET /api/bot/window returns window schema with slots and title', async () => {
    const res = await request(`${BASE_URL}/api/bot/window`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json, 'Response must be JSON');
    assert.strictEqual(typeof res.json.open, 'boolean');
    assert.strictEqual(typeof res.json.id, 'number');
    assert.ok(Array.isArray(res.json.slots), 'slots must be an array');
  });

  // 12. Proxied POST /api/bot/autolock
  await testAsync('POST /api/bot/autolock toggles auto-lock and updates character target', async () => {
    const res = await request(`${BASE_URL}/api/bot/autolock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { enabled: true, characterTarget: 'mage' });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json && res.json.ok === true);
    assert.strictEqual(res.json.autoLock, true);
    assert.strictEqual(res.json.characterTarget, 'mage');

    // Verify in GET /api/bot/status
    const statusRes = await request(`${BASE_URL}/api/bot/status`);
    assert.strictEqual(statusRes.json.autoLock, true);
    assert.strictEqual(statusRes.json.characterTarget, 'mage');
  });

  // 13. Proxied POST /api/bot/click safety check
  await testAsync('POST /api/bot/click validates input and returns safe disconnected error', async () => {
    const res = await request(`${BASE_URL}/api/bot/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { slot: 9999, button: 0, mode: 0 });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json.ok, false);
  });

  // 14. Proxied POST /api/bot/open_inventory safety check
  await testAsync('POST /api/bot/open_inventory returns safe offline error when bot is not running', async () => {
    const res = await request(`${BASE_URL}/api/bot/open_inventory`, {
      method: 'POST'
    });
    assert.ok(res.statusCode === 200 || res.statusCode === 400);
    assert.strictEqual(typeof res.json.ok, 'boolean');
  });

  // 15. Proxied POST /api/bot/autolock with manualOverride
  await testAsync('POST /api/bot/autolock configures manualOverride for pane targeting and persists in status', async () => {
    const res = await request(`${BASE_URL}/api/bot/autolock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { enabled: true, characterTarget: 'raw:1', manualOverride: true });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json && res.json.ok === true);
    assert.strictEqual(res.json.manualOverride, true);
    assert.strictEqual(res.json.characterTarget, 'raw:1');

    // Verify in GET /api/bot/status
    const statusRes = await request(`${BASE_URL}/api/bot/status`);
    assert.strictEqual(statusRes.json.manualOverride, true);
    assert.strictEqual(statusRes.json.characterTarget, 'raw:1');

    // Reset back to default
    await request(`${BASE_URL}/api/bot/autolock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { enabled: true, characterTarget: 'first', manualOverride: false });
  });

  await testAsync('GET /api/bot/entities returns entity list or safe empty array', async () => {
    const res = await request(`${BASE_URL}/api/bot/entities`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.json.entities));
  });

  await testAsync('POST /api/bot/action executes or safely handles offline state', async () => {
    const res = await request(`${BASE_URL}/api/bot/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { action: 'right_click' });
    assert.ok(res.statusCode === 200 || res.statusCode === 400);
    assert.strictEqual(typeof res.json.ok, 'boolean');

    const badRes = await request(`${BASE_URL}/api/bot/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { action: 'invalid_action_xyz' });
    assert.strictEqual(badRes.statusCode, 400);
    assert.strictEqual(badRes.json.ok, false);
  });

  // 18. Real World Gates API
  await testAsync('GET /api/bot/gates returns real gate schema and count', async () => {
    const res = await request(`${BASE_URL}/api/bot/gates`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.ok, true);
    assert.ok(Array.isArray(res.json.gates));
    assert.strictEqual(typeof res.json.realGateFound, 'boolean');
    assert.strictEqual(typeof res.json.count, 'number');
  });

  // 19. Activity & Diagnostics Logs API
  await testAsync('GET /api/bot/logs returns activity logs and supports filtering', async () => {
    const res = await request(`${BASE_URL}/api/bot/logs`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(typeof res.json.total, 'number');
    assert.ok(Array.isArray(res.json.logs));

    // Filter by category
    const catRes = await request(`${BASE_URL}/api/bot/logs?category=SYSTEM&limit=10`);
    assert.strictEqual(catRes.statusCode, 200);
    assert.strictEqual(catRes.json.ok, true);
    assert.ok(Array.isArray(catRes.json.logs));
  });

  // 20. Gate Selection Endpoint
  await testAsync('POST /api/bot/gate handles offline/invalid world gate selection safely', async () => {
    const res = await request(`${BASE_URL}/api/bot/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { world: 999999 });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json.ok, false);
  });

  // 21. Chat Insights API (GET)
  await testAsync('GET /api/bot/chat/insights returns structured insights schema', async () => {
    const res = await request(`${BASE_URL}/api/bot/chat/insights`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.ok, true);
    assert.ok(res.json.insights, 'Insights object must exist');
    assert.strictEqual(typeof res.json.insights.currentState, 'string');
    assert.strictEqual(typeof res.json.insights.summary, 'string');
    assert.ok(Array.isArray(res.json.insights.keyTakeaways));
    assert.ok(Array.isArray(res.json.insights.actionRecommendations));
    assert.strictEqual(typeof res.json.insights.stats.filteredSpam, 'number');
  });

  // 22. Chat Insights Review API (POST)
  await testAsync('POST /api/bot/chat/insights runs AI review with options', async () => {
    const res = await request(`${BASE_URL}/api/bot/chat/insights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { limit: 25 });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.ok, true);
    assert.ok(res.json.insights);
    assert.ok(res.json.insights.engine, 'Engine description must exist');
  });

  // 23. Action Bar State & Spam Filter API
  await testAsync('GET /api/bot/actionbar returns active HUD banner and spam metrics', async () => {
    const res = await request(`${BASE_URL}/api/bot/actionbar`);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(typeof res.json.actionbar, 'string');
    assert.strictEqual(typeof res.json.filteredSpamCount, 'number');
  });

  // 24. Modernized Grid Layout Verification
  await testAsync('GET /bot.html serves modern modular grid layout with AI Insights node', async () => {
    const res = await request(`${BASE_URL}/bot.html`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes('node-grid'), 'Must include node-grid layout');
    assert.ok(res.body.includes('AI Chat Insights &amp; Review') || res.body.includes('AI Chat Insights & Review'), 'Must include AI Chat Insights');
    assert.ok(res.body.includes('actionbar-ticker'), 'Must include global action bar ticker');
    assert.ok(res.body.includes('chat-filter-tabs'), 'Must include chat category filter tabs');
  });

  // 25. Regional World Gate Selection API Handling
  await testAsync('POST /api/bot/gate handles regional world identifiers (NA11, EU2) safely', async () => {
    const res = await request(`${BASE_URL}/api/bot/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { world: 'NA11' });
    assert.strictEqual(res.statusCode, 400); // Disconnected error, but handled without throwing
    assert.strictEqual(res.json.ok, false);
    assert.ok(res.json.error.includes('not connected') || res.json.error.includes('No real world gate found'));
  });

  // 26. Zero Alert Popups in Bot Controller UI
  await testAsync('GET /bot.html has zero raw alert() calls and includes alert interceptor', async () => {
    const res = await request(`${BASE_URL}/bot.html`);
    assert.strictEqual(res.statusCode, 200);
    // Ensure raw alert(...) is not used
    assert.ok(!res.body.includes('alert(`'), 'No raw alert(`...) calls permitted in bot.html');
    assert.ok(!res.body.includes('alert("'), 'No raw alert("...) calls permitted in bot.html');
    assert.ok(!res.body.includes("alert('"), "No raw alert('...) calls permitted in bot.html");
    // Ensure alert interceptor is present
    assert.ok(res.body.includes('window.alert = function'), 'window.alert must be neutralized with custom interceptor');
  });

  console.log(`\n\x1b[1mIntegration Tests Result: ${passed}/${total} passed\x1b[0m\n`);
  if (passed !== total) process.exit(1);
}

runTests().catch(err => {
  console.error('Integration test runner error:', err);
  process.exit(1);
});
