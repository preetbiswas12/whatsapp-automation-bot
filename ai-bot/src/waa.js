'use strict';

// WAA server API client (send messages, manage webhooks) with timeouts,
// retry on transient failures, and shared webhook-registration state so the
// health report can report real status.

const config = require('./config').config;
const { log } = require('./logger');
const { retry } = require('./utils');

const SESSION_ENDPOINT = () => `/api/sessions/${config.waa.sessionId}`;

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

function getWebhookState() {
  return { ...webhookState };
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

async function sendText(chatId, text) {
  return api('POST', `${SESSION_ENDPOINT()}/messages/send-text`, { chatId, text });
}

async function listWebhooks() {
  const data = await api('GET', `${SESSION_ENDPOINT()}/webhooks`);
  return Array.isArray(data) ? data : data?.data || [];
}

async function removeWebhook(webhookId) {
  return api('DELETE', `${SESSION_ENDPOINT()}/webhooks/${webhookId}`);
}

async function createWebhook(url, events) {
  return api('POST', `${SESSION_ENDPOINT()}/webhooks`, { url, events });
}

// Replace any stale webhook pointing at this bot with one fresh registration.
// Safe to call repeatedly (also used by the periodic self-healing refresh).
async function registerWebhook() {
  const url = `http://localhost:${config.webhook.port}${config.webhook.path}`;
  webhookState.lastAttempt = new Date().toISOString();

  try {
    const existing = await listWebhooks();
    for (const wh of existing) {
      if (wh.url && wh.url.includes(`localhost:${config.webhook.port}`)) {
        log('SETUP', `Removing old webhook: ${wh.id}`);
        await removeWebhook(wh.id);
      }
    }
    const result = await createWebhook(url, ['message.received']);
    webhookState.registered = true;
    webhookState.lastError = null;
    webhookState.id = result?.id || result?.data?.id;
    log('SETUP', '✅ Webhook registered!', { id: webhookState.id });
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
  listWebhooks,
  removeWebhook,
  createWebhook,
  registerWebhook,
  getWebhookState,
  WaaApiError,
};