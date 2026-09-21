#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WAA AI Bot — Local LLM (LM Studio) + Conversation History
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONV_DIR = path.join(__dirname, 'conversations');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

if (!fs.existsSync(CONV_DIR)) fs.mkdirSync(CONV_DIR, { recursive: true });

// ─── Logging ─────────────────────────────────────────────────────────────────
const log = (tag, msg, data) => {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] [${tag}] ${msg}`;
  console.log(data ? `${line} ${JSON.stringify(data)}` : line);
};

// ─── Conversation Store ──────────────────────────────────────────────────────
// Saved per chatId as JSON files in conversations/ dir
function getChatFile(chatId) {
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CONV_DIR, `${safe}.json`);
}

function loadHistory(chatId) {
  const file = getChatFile(chatId);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return data.messages || [];
  } catch { return []; }
}

function saveHistory(chatId, messages) {
  const file = getChatFile(chatId);
  const trimmed = messages.slice(-config.bot.maxHistoryPerChat * 2); // user+assistant pairs
  const data = {
    chatId,
    lastUpdated: new Date().toISOString(),
    messageCount: trimmed.length,
    messages: trimmed,
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Cooldown tracker ────────────────────────────────────────────────────────
const cooldowns = new Map();

function isOnCooldown(chatId) {
  const last = cooldowns.get(chatId);
  if (!last) return false;
  return (Date.now() - last) / 1000 < config.bot.cooldownSeconds;
}

function setCooldown(chatId) {
  cooldowns.set(chatId, Date.now());
}

// ─── Deduplication ───────────────────────────────────────────────────────────
const processed = new Map(); // idempotencyKey -> timestamp
const DEDUP_TTL = 60_000; // 1 minute

function wasProcessed(key) {
  if (!key) return false;
  if (processed.has(key)) return true;
  return false;
}

function markProcessed(key) {
  if (!key) return;
  processed.set(key, Date.now());
  // Cleanup old entries every 100 marks
  if (processed.size > 100) {
    const now = Date.now();
    for (const [k, ts] of processed) {
      if (now - ts > DEDUP_TTL) processed.delete(k);
    }
  }
}

// ─── LLM Call (OpenAI-compatible API — works with LM Studio) ────────────────
async function callLLM(chatId, userMessage) {
  const history = loadHistory(chatId);

  // Build messages array with system prompt
  const messages = [
    { role: 'system', content: config.llm.systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const body = JSON.stringify({
    model: config.llm.model,
    messages,
    max_tokens: config.llm.maxTokens,
    temperature: config.llm.temperature,
    stream: false,
  });

  log('LLM', `Calling ${config.llm.host}/v1/chat/completions`, {
    model: config.llm.model,
    historyLen: history.length,
  });

  const res = await fetch(`${config.llm.host}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim();

  if (!reply) throw new Error('LLM returned empty response');

  // Save conversation history
  history.push({ role: 'user', content: userMessage });
  history.push({ role: 'assistant', content: reply });
  saveHistory(chatId, history);

  log('LLM', `Reply generated (${reply.length} chars)`);
  return reply;
}

// ─── WAA API Helper ───────────────────────────────────────────────────────
async function waaApi(method, endpoint, body) {
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

// ─── Send Reply ──────────────────────────────────────────────────────────────
async function sendReply(chatId, text) {
  return waaApi('POST', `/api/sessions/${config.waa.sessionId}/messages/send-text`, {
    chatId,
    text,
  });
}

// ─── Webhook Server ──────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleWebhook(req, res) {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', bot: 'waa-ai-bot' }));
  }

  if (req.method !== 'POST' || req.url !== config.webhook.path) {
    res.writeHead(404);
    return res.end('Not found');
  }

  let payload;
  try {
    payload = await parseBody(req);
  } catch {
    res.writeHead(400);
    return res.end('Invalid JSON');
  }

  // Respond immediately — don't block the webhook
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));

  // Process asynchronously
  processMessage(payload).catch(err => {
    log('ERROR', 'Message processing failed', { error: err.message });
  });
}

// ─── Message Processor ───────────────────────────────────────────────────────
async function processMessage(payload) {
  const { event, data } = payload;

  // Only handle incoming messages
  if (event !== 'message.received') return;

  const msg = data?.data || data;
  if (!msg) return;

  // Skip own messages
  if (config.bot.ignoreFromMe && msg.fromMe) return;

  // Skip groups if configured
  if (config.bot.ignoreGroups && msg.chatId?.endsWith('@g.us')) return;

  const chatId = msg.chatId;
  const text = msg.body || msg.text;
  const sender = msg.sender || msg.pushName || 'Unknown';
  const idempotencyKey = payload.idempotencyKey;

  // Dedup
  if (wasProcessed(idempotencyKey)) {
    log('BOT', 'Duplicate message, skipping', { idempotencyKey });
    return;
  }
  markProcessed(idempotencyKey);

  if (!chatId || !text) {
    log('BOT', 'Ignoring message without chatId or text', { chatId, hasText: !!text });
    return;
  }

  // Cooldown
  if (isOnCooldown(chatId)) {
    log('BOT', 'On cooldown, skipping', { chatId });
    return;
  }

  log('MSG', `New message from ${sender}`, { chatId, text: text.slice(0, 80) });

  // Add typing delay
  await sleep(config.bot.replyDelay);

  try {
    const reply = await callLLM(chatId, text);
    await sendReply(chatId, reply);
    setCooldown(chatId);
    log('SENT', `Reply sent to ${chatId}`, { replyLen: reply.length });
  } catch (err) {
    log('ERROR', `Failed to process message`, { chatId, error: err.message });
    // Try to send an error notice
    try {
      await sendReply(chatId, '⚠️ Sorry, I encountered an error processing your message. Please try again.');
    } catch { /* silent */ }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Webhook Registration ────────────────────────────────────────────────────
async function registerWebhook() {
  const webhookUrl = `http://localhost:${config.webhook.port}${config.webhook.path}`;

  log('SETUP', 'Registering webhook on WAA...', { url: webhookUrl });

  try {
    // Check existing webhooks
    const existing = await waaApi('GET', `/api/sessions/${config.waa.sessionId}/webhooks`);
    const list = Array.isArray(existing) ? existing : existing?.data || [];

    // Remove old webhooks pointing to same host
    for (const wh of list) {
      if (wh.url && wh.url.includes(`localhost:${config.webhook.port}`)) {
        log('SETUP', `Removing old webhook: ${wh.id}`);
        await waaApi('DELETE', `/api/sessions/${config.waa.sessionId}/webhooks/${wh.id}`);
      }
    }

    // Create new webhook
    const result = await waaApi('POST', `/api/sessions/${config.waa.sessionId}/webhooks`, {
      url: webhookUrl,
      events: ['message.received'],
    });

    log('SETUP', '✅ Webhook registered!', { id: result?.id || result?.data?.id });
    return result;
  } catch (err) {
    log('ERROR', 'Failed to register webhook', { error: err.message });
    log('SETUP', '⚠️  You can register manually via the dashboard or API');
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🤖 WAA AI Bot — Local LLM Integration');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(`  📡 WAA:          ${config.waa.host}`);
  console.log(`  🧠 LLM:          ${config.llm.host} (${config.llm.model})`);
  console.log(`  🔗 Webhook:      http://localhost:${config.webhook.port}${config.webhook.path}`);
  console.log(`  💬 Session:      ${config.waa.sessionId}`);
  console.log(`  📂 Conversations: ${CONV_DIR}`);
  console.log('');

  // Start webhook server
  const server = http.createServer(handleWebhook);
  server.listen(config.webhook.port, () => {
    log('SERVER', `Webhook server listening on port ${config.webhook.port}`);
  });

  // Register webhook with WAA
  await sleep(1000); // Wait for WAA to be ready
  await registerWebhook();

  console.log('');
  console.log('  ✅ Bot is running! Send a WhatsApp message to test it.');
  console.log('  📁 Conversation history saved in: ai-bot/conversations/');
  console.log('  ⏹  Press Ctrl+C to stop');
  console.log('');

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('BOT', 'Shutting down...');
    server.close();
    process.exit(0);
  });
}

main().catch(err => {
  log('FATAL', err.message);
  process.exit(1);
});
