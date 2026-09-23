'use strict';

// WAA server API client (send messages, manage webhooks).

const config = require('./config').config;
const { log } = require('./logger');

const SESSION_ENDPOINT = () => `/api/sessions/${config.waa.sessionId}`;

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

  log('API', `${method} ${endpoint}`);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`WAA API ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
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
async function registerWebhook() {
  const url = `http://localhost:${config.webhook.port}${config.webhook.path}`;
  log('SETUP', 'Registering webhook on WAA...', { url });

  try {
    const existing = await listWebhooks();
    for (const wh of existing) {
      if (wh.url && wh.url.includes(`localhost:${config.webhook.port}`)) {
        log('SETUP', `Removing old webhook: ${wh.id}`);
        await removeWebhook(wh.id);
      }
    }
    const result = await createWebhook(url, ['message.received']);
    log('SETUP', '✅ Webhook registered!', { id: result?.id || result?.data?.id });
    return result;
  } catch (err) {
    log('ERROR', 'Failed to register webhook', { error: err.message });
    log('SETUP', '⚠️  You can register manually via the dashboard or API');
    return null;
  }
}

module.exports = { api, sendText, listWebhooks, removeWebhook, createWebhook, registerWebhook };