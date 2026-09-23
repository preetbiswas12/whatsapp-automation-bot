'use strict';

// HTTP server: webhook receiver, REST API for approvals/patterns, dashboard.

const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config').config;
const { log } = require('./logger');
const processor = require('./processor');
const actions = require('./actions');
const approvalStore = require('./store/approvals');
const patternStore = require('./store/patterns');

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

// Route table. Handler receives (req, res, pathname, url).
const ROUTES = [
  { method: 'GET', pattern: /^\/health$/, async handler(req, res) {
    json(res, 200, { status: 'ok', bot: 'waa-ai-bot' });
  }},

  { method: 'GET', pattern: /^(\/|\/dashboard)$/, async handler(req, res) {
    const html = fs.existsSync(DASHBOARD_PATH)
      ? fs.readFileSync(DASHBOARD_PATH, 'utf-8')
      : '<h1>Dashboard file missing</h1>';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }},

  { method: 'GET', pattern: /^\/api\/approvals$/, async handler(req, res) {
    json(res, 200, approvalStore.loadAll());
  }},

  { method: 'GET', pattern: /^\/api\/patterns$/, async handler(req, res) {
    json(res, 200, patternStore.loadPatterns());
  }},

  { method: 'POST', pattern: /^\/api\/approvals\/([^/]+)\/approve$/, async handler(req, res, pathname) {
    const id = pathname.split('/')[3];
    const result = await actions.approve(id);
    json(res, result.ok ? 200 : result.status, result);
  }},

  { method: 'POST', pattern: /^\/api\/approvals\/([^/]+)\/reject$/, async handler(req, res, pathname) {
    const id = pathname.split('/')[3];
    const result = await actions.reject(id);
    json(res, result.ok ? 200 : result.status, result);
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
      log('ERROR', 'Message processing failed', { error: err.message });
    });
  }},
];

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${config.webhook.port}`);
  const pathname = url.pathname;

  const route = ROUTES.find(r => r.method === req.method && r.pattern.test(pathname));
  if (!route) {
    res.writeHead(404);
    return res.end('Not found');
  }

  try {
    await route.handler(req, res, pathname);
  } catch (err) {
    log('ERROR', `Route ${req.method} ${pathname} failed`, { error: err.message });
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
}

function startServer() {
  const server = http.createServer(handleRequest);
  server.listen(config.webhook.port, () => {
    log('SERVER', `Bot server listening on port ${config.webhook.port}`);
  });
  return server;
}

module.exports = { startServer };