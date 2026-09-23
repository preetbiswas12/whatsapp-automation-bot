'use strict';

// HTTP server: webhook receiver, REST API for approvals/patterns, dashboard,
// and a thin WAA proxy so the single dashboard can manage the WhatsApp session
// (create / link QR / status) without exposing API keys to the browser.
//
// - /api/* requires X-Auth-Token (production-safe)
// - /webhook stays open (WAA signs nothing, so it must not require auth)
// - /health reports real dependency status
// - /api/waa/* forwards to the WAA server in the bot process (key stays server-side)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config').config;
const { log } = require('./logger');
const processor = require('./processor');
const actions = require('./actions');
const waa = require('./waa');
const approvalStore = require('./store/approvals');
const patternStore = require('./store/patterns');
const { buildHealthReport } = require('./health');

const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Bearer-style token check for the admin API. Timing-safe comparison.
function isAuthorized(req) {
  const supplied = req.headers['x-auth-token'];
  const expected = config.server.apiToken;
  if (!supplied || !expected) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Serve the dashboard with the bot token pre-injected: the page is
// same-origin admin UI, so the browser never needs to be prompted.
function serveDashboard(res) {
  const html = fs.existsSync(DASHBOARD_PATH)
    ? fs.readFileSync(DASHBOARD_PATH, 'utf-8')
    : '<h1>Dashboard file missing</h1>';
  const injected = html.split('__BOT_TOKEN__').join(config.server.apiToken);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(injected);
}

async function proxyWaa(method, pathname, search, body) {
  // /api/waa/<rest> -> WAA /api/<rest>
  const rest = pathname.replace(/^\/api\/waa\//, '');
  const target = `${config.waa.host}/api/${rest}${search || ''}`;
  const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';
  const opts = {
    method,
    headers: {
      'x-api-key': config.waa.apiKey,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout((config.server.timeoutSeconds || 30) * 1000),
  };
  if (hasBody) opts.body = JSON.stringify(body);
  const res = await fetch(target, opts);
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* keep raw text */ }
  return { status: res.status, data, raw: text };
}

// When the active WAA session has no webhook yet (fresh login), register one
// right away and report the resulting state.
async function resyncWebhook() {
  waa.invalidateActiveSession();
  const result = await waa.registerWebhook();
  return { ok: !!result, sessionId: await waa.resolveSessionId(), state: waa.getWebhookState() };
}

// Route table. Handler receives (req, res, pathname, url).
const ROUTES = [
  { method: 'GET', pattern: /^\/health$/, async handler(req, res) {
    const report = await buildHealthReport();
    json(res, report.ok ? 200 : 503, report);
  }},

  { method: 'GET', pattern: /^(\/|\/dashboard)$/, async handler(req, res) {
    serveDashboard(res);
  }},

  { method: 'GET', pattern: /^\/api\/approvals$/, auth: true, async handler(req, res) {
    json(res, 200, approvalStore.loadAll());
  }},

  { method: 'GET', pattern: /^\/api\/patterns$/, auth: true, async handler(req, res) {
    json(res, 200, patternStore.loadPatterns());
  }},

  { method: 'POST', pattern: /^\/api\/approvals\/([^/]+)\/approve$/, auth: true, async handler(req, res, pathname) {
    const id = pathname.split('/')[3];
    const result = await actions.approve(id);
    json(res, result.ok ? 200 : result.status, result);
  }},

  { method: 'POST', pattern: /^\/api\/approvals\/([^/]+)\/reject$/, auth: true, async handler(req, res, pathname) {
    const id = pathname.split('/')[3];
    const result = await actions.reject(id);
    json(res, result.ok ? 200 : result.status, result);
  }},

  // Re-register the webhook for the currently-active WhatsApp session.
  { method: 'POST', pattern: /^\/api\/resync$/, auth: true, async handler(req, res) {
    const out = await resyncWebhook();
    json(res, out.ok ? 200 : 503, out);
  }},

  { method: 'POST', pattern: new RegExp(`^${escapeRegExp(config.webhook.path)}$`), async handler(req, res) {
    let payload;
    try {
      payload = await parseBody(req);
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    json(res, 200, { ok: true });
    // Fire-and-forget so webhook delivery is acknowledged instantly.
    processor.processMessage(payload).catch(err => {
      log.error('ERROR', 'Message processing failed', { error: err.message });
    });
  }},

  // WAA proxy: session management for the merged dashboard. The browser never
  // sees the WAA API key; every call is proxied here in the bot process.
  { method: '*', pattern: /^\/api\/waa\/(.+)$/, auth: true, async handler(req, res, pathname, url) {
    let body;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
      });
      // Bodyless POST (e.g. /sessions/:id/start) is valid — only parse when present.
      if (raw.trim()) {
        try { body = JSON.parse(raw); }
        catch { return json(res, 400, { error: 'Invalid JSON' }); }
      }
    }
    try {
      const result = await proxyWaa(req.method, pathname, url.search || '', body);
      if (result.raw === '') {
        // 204-style empty body: send status only.
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        return res.end();
      }
      json(res, result.status, result.data);
    } catch (err) {
      log.error('SERVER', `WAA proxy ${req.method} ${pathname} failed`, { error: err.message });
      json(res, 502, { error: err.message });
    }
  }},
];

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${config.webhook.port}`);
  const pathname = url.pathname;

  const route = ROUTES.find(r => (r.method === '*' || r.method === req.method) && r.pattern.test(pathname));
  if (!route) {
    json(res, 404, { error: 'Not found' });
    return;
  }

  if (route.auth && !isAuthorized(req)) {
    json(res, 401, { error: 'Unauthorized: provide X-Auth-Token header' });
    log.warn('API', 'Rejected request without valid token', { path: pathname });
    return;
  }

  try {
    await route.handler(req, res, pathname, url);
  } catch (err) {
    log.error('SERVER', `Route ${req.method} ${pathname} failed`, { error: err.message });
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
}

function startServer() {
  const server = http.createServer(handleRequest);
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      log.error('SERVER', `Port ${config.webhook.port} already in use — is another bot instance running?`);
    } else {
      log.error('SERVER', `HTTP server error: ${err.message}`);
    }
  });
  server.listen(config.webhook.port, () => {
    log('SERVER', `Bot server listening on port ${config.webhook.port}`);
  });
  return server;
}

module.exports = { startServer };