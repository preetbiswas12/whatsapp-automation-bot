'use strict';

// WAA server API client (send messages, manage webhooks) with timeouts,
// retry on transient failures, and shared webhook-registration state so the
// health report can report real status.
//
// Session resolution is DYNAMIC: if the pinned config id (config.waa.sessionId)
// still exists it wins; otherwise the bot auto-adopts the first connected
// session. That makes the fresh-login flow work: wipe old sessions, create a
// new one from the dashboard, scan the QR, and the bot attaches automatically.

const config = require('./config').config;
const { log } = require('./logger');
const { retry } = require('./utils');

const SESSION_ENDPOINT = id => `/api/sessions/${id}`;

// HTTP errors carry status; network/timeout errors are plain Error.
class WaaApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WaaApiError';
    this.status = status;
  }
}

// Latest webhook registration result (used by /health).
let webhookState = { registered: false, lastAttempt: null, lastError: null };

// Cached active session (id + when we last verified it).
let activeSessionId = null;
let activeSessionCheckedAt = 0;
const ACTIVE_SESSION_TTL_MS = 15000;

function getWebhookState() {
  return { ...webhookState };
}

// Force the webhook state back to "not registered" (e.g. the session was
// deleted/logged out from the dashboard). Keeps /health truthful.
function markWebhookUnregistered(reason) {
  webhookState = { registered: false, lastAttempt: new Date().toISOString(), lastError: reason };
  log('SETUP', 'Webhook unregistered', { reason });
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function api(method, endpoint, body) {
  const url = `${config.waa.host}${endpoint}`;
  const opts = {
    method,
    headers: {
      'x-api-key': config.waa.apiKey,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  return retry(async () => {
    try {
      log.debug('API', `${method} ${endpoint}`);
      const res = await fetchWithTimeout(
        url,
        opts,
        (config.server.timeoutSeconds || 30) * 1000
      );
      const text = await res.text();
      if (!res.ok) throw new WaaApiError(res.status, `WAA API ${res.status}: ${text}`);
      try { return JSON.parse(text); } catch { return text; }
    } catch (err) {
      if (err.name === 'AbortError') throw new WaaApiError(0, `WAA request timed out: ${method} ${endpoint}`);
      if (err instanceof WaaApiError) throw err;
      throw new WaaApiError(0, `WAA unreachable (${method} ${endpoint}): ${err.message}`);
    }
  }, {
    attempts: 3,
    baseMs: 500,
    shouldRetry: err => err instanceof WaaApiError && (err.status >= 500 || err.status === 429 || err.status === 0),
    onRetry: (err, attempt) => log.warn('API', `Retry ${attempt} for ${method} ${endpoint}: ${err.message}`),
  });
}

// List every session on the WAA server.
async function listSessions() {
  const data = await api('GET', '/api/sessions?limit=1000');
  return Array.isArray(data) ? data : data?.data || [];
}

// Auto-discovery: pinned config id if it still exists, otherwise the first
// connected/ready session, otherwise the first session at all, else null.
// Cached briefly to avoid hammering the WAA API on every send.
async function resolveSessionId() {
  if (activeSessionId && activeSessionCheckedAt && Date.now() - activeSessionCheckedAt < ACTIVE_SESSION_TTL_MS) {
    return activeSessionId;
  }
  try {
    const sessions = await listSessions();
    let chosen = null;
    if (config.waa.sessionId) {
      chosen = sessions.find(s => s.id === config.waa.sessionId) || null;
    }
    if (!chosen) {
      chosen = sessions.find(s => s.status === 'ready' || s.status === 'connected')
        || sessions.find(s => s.status !== 'error' && s.status !== 'deleted')
        || sessions[0]
        || null;
    }
    activeSessionId = chosen ? chosen.id : null;
    activeSessionCheckedAt = Date.now();
    return activeSessionId;
  } catch (err) {
    // WAA unreachable: keep whatever we had cached, else null.
    return activeSessionId;
  }
}

// Force re-resolution on the next call (used after a dashboard session change).
function invalidateActiveSession() {
  activeSessionId = null;
  activeSessionCheckedAt = 0;
}

async function sendText(chatId, text) {
  const id = await resolveSessionId();
  if (!id) throw new WaaApiError(503, 'No active WhatsApp session — create/scan one from the dashboard first');
  return api('POST', `${SESSION_ENDPOINT(id)}/messages/send-text`, { chatId, text });
}

async function listWebhooks(sessionId) {
  const id = sessionId || await resolveSessionId();
  if (!id) return [];
  const data = await api('GET', `${SESSION_ENDPOINT(id)}/webhooks`);
  return Array.isArray(data) ? data : data?.data || [];
}

async function removeWebhook(webhookId, sessionId) {
  const id = sessionId || await resolveSessionId();
  return api('DELETE', `${SESSION_ENDPOINT(id)}/webhooks/${webhookId}`);
}

async function createWebhook(url, events, sessionId) {
  const id = sessionId || await resolveSessionId();
  return api('POST', `${SESSION_ENDPOINT(id)}/webhooks`, { url, events });
}

// Replace any stale webhook pointing at this bot with one fresh registration.
// Safe to call repeatedly (also used by the periodic self-healing refresh).
async function registerWebhook() {
  const id = await resolveSessionId();
  if (!id) {
    webhookState.registered = false;
    webhookState.lastAttempt = new Date().toISOString();
    webhookState.lastError = 'No WhatsApp session yet — create & scan from the dashboard';
    log.error('SETUP', 'Webhook not registered (no session)', { hint: 'Open http://localhost:3001/ and connect WhatsApp' });
    return null;
  }

  const url = `http://localhost:${config.webhook.port}${config.webhook.path}`;
  webhookState.lastAttempt = new Date().toISOString();

  try {
    const existing = await listWebhooks(id);
    for (const wh of existing) {
      if (wh.url && wh.url.includes(`localhost:${config.webhook.port}`)) {
        log('SETUP', `Removing old webhook: ${wh.id}`);
        await removeWebhook(wh.id, id);
      }
    }
    const result = await createWebhook(url, ['message.received'], id);
    webhookState.registered = true;
    webhookState.lastError = null;
    webhookState.id = result?.id || result?.data?.id;
    log('SETUP', '✅ Webhook registered!', { id: webhookState.id, sessionId: id });
    return result;
  } catch (err) {
    webhookState.registered = false;
    webhookState.lastError = err.message;
    log.error('SETUP', 'Failed to register webhook', { error: err.message });
    return null;
  }
}

module.exports = {
  api,
  sendText,
  listSessions,
  resolveSessionId,
  invalidateActiveSession,
  listWebhooks,
  removeWebhook,
  createWebhook,
  registerWebhook,
  getWebhookState,
  markWebhookUnregistered,
  WaaApiError,
};