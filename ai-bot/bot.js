#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WAA AI Bot — Approval-Based Learning System
//
//  Flow:
//    1. Message arrives → check learned patterns first
//    2. Pattern match found (confidence ≥ threshold) → AUTO-SEND instantly
//    3. No match → AI drafts reply + summary → queue for human approval
//    4. Human approves → send reply → SAVE pattern for future auto-sends
//    5. Human rejects → discard
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONV_DIR = path.join(__dirname, 'conversations');
const PATTERNS_PATH = path.join(__dirname, 'patterns.json');
const APPROVALS_PATH = path.join(__dirname, 'approvals.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

if (!fs.existsSync(CONV_DIR)) fs.mkdirSync(CONV_DIR, { recursive: true });

// ─── Logging ─────────────────────────────────────────────────────────────────
const log = (tag, msg, data) => {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] [${tag}] ${msg}`;
  console.log(data ? `${line} ${JSON.stringify(data)}` : line);
};

// ─── Conversation Store ──────────────────────────────────────────────────────
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
  const trimmed = messages.slice(-config.bot.maxHistoryPerChat * 2);
  const data = {
    chatId,
    lastUpdated: new Date().toISOString(),
    messageCount: trimmed.length,
    messages: trimmed,
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Pattern Store (Learned Templates) ───────────────────────────────────────
function loadPatterns() {
  if (!fs.existsSync(PATTERNS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf-8')); }
  catch { return []; }
}

function savePatterns(patterns) {
  fs.writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2), 'utf-8');
}

function savePattern(originalMessage, approvedReply, summary) {
  const patterns = loadPatterns();
  const keywords = extractKeywords(originalMessage);

  // Check if a similar pattern already exists
  const existing = patterns.findIndex(p => similarity(p.keywords, keywords) > 0.8);
  if (existing >= 0) {
    // Update existing pattern
    patterns[existing].reply = approvedReply;
    patterns[existing].uses = (patterns[existing].uses || 0) + 1;
    patterns[existing].lastUsed = new Date().toISOString();
    savePatterns(patterns);
    log('LEARN', 'Updated existing pattern', { keywords: patterns[existing].keywords });
    return patterns[existing];
  }

  const pattern = {
    id: crypto.randomUUID(),
    keywords,
    originalMessage: originalMessage.slice(0, 500),
    reply: approvedReply,
    summary: summary || '',
    uses: 1,
    createdAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
  };
  patterns.push(pattern);
  savePatterns(patterns);
  log('LEARN', 'New pattern saved', { keywords, replyLen: approvedReply.length });
  return pattern;
}

// ─── Approval Queue ──────────────────────────────────────────────────────────
function loadApprovals() {
  if (!fs.existsSync(APPROVALS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(APPROVALS_PATH, 'utf-8')); }
  catch { return []; }
}

function saveApprovals(approvals) {
  fs.writeFileSync(APPROVALS_PATH, JSON.stringify(approvals, null, 2), 'utf-8');
}

function addApproval(entry) {
  const approvals = loadApprovals();
  const item = {
    id: crypto.randomUUID(),
    chatId: entry.chatId,
    sender: entry.sender,
    originalMessage: entry.originalMessage,
    draftReply: entry.draftReply,
    summary: entry.summary,
    chatSummary: entry.chatSummary,
    status: 'pending', // pending | approved | rejected
    createdAt: new Date().toISOString(),
  };
  approvals.unshift(item); // newest first

  // Cap pending approvals
  const pending = approvals.filter(a => a.status === 'pending');
  if (pending.length > config.approval.maxPending) {
    const toRemove = pending.slice(config.approval.maxPending);
    for (const r of toRemove) r.status = 'expired';
  }

  saveApprovals(approvals);
  log('QUEUE', `Approval queued: ${item.id}`, { sender: entry.sender, draftLen: entry.draftReply.length });
  return item;
}

function getApproval(id) {
  return loadApprovals().find(a => a.id === id);
}

function updateApprovalStatus(id, status) {
  const approvals = loadApprovals();
  const item = approvals.find(a => a.id === id);
  if (!item) return null;
  item.status = status;
  item.resolvedAt = new Date().toISOString();
  saveApprovals(approvals);
  return item;
}

// ─── Text Similarity / Keyword Matching ──────────────────────────────────────
const STOP_WORDS = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them',
  'their', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and',
  'but', 'if', 'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by',
  'for', 'with', 'about', 'against', 'between', 'through', 'during', 'before',
  'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on',
  'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should',
  'now', 'hi', 'hello', 'hey', 'thanks', 'thank', 'please', 'yes', 'no', 'ok',
  'okay', 'bye', 'hello', 'morning', 'evening', 'night',
]);

function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 20);
}

function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

function findMatchingPattern(text) {
  const keywords = extractKeywords(text);
  if (!keywords.length) return null;

  const patterns = loadPatterns();
  let bestMatch = null;
  let bestScore = 0;

  for (const p of patterns) {
    const score = similarity(p.keywords, keywords);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = p;
    }
  }

  if (bestMatch && bestScore >= config.approval.matchThreshold) {
    return { pattern: bestMatch, confidence: bestScore };
  }
  return null;
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
const processed = new Map();
const DEDUP_TTL = 60_000;

function wasProcessed(key) {
  if (!key) return false;
  return processed.has(key);
}

function markProcessed(key) {
  if (!key) return;
  processed.set(key, Date.now());
  if (processed.size > 100) {
    const now = Date.now();
    for (const [k, ts] of processed) {
      if (now - ts > DEDUP_TTL) processed.delete(k);
    }
  }
}

// ─── LLM Calls ───────────────────────────────────────────────────────────────
async function callLLMMessages(messages, opts = {}) {
  const body = JSON.stringify({
    model: config.llm.model,
    messages,
    max_tokens: opts.maxTokens || config.llm.maxTokens,
    temperature: opts.temperature ?? config.llm.temperature,
    stream: false,
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
  return reply;
}

// Generate a reply draft (does NOT save history — that happens on approval)
async function generateDraft(chatId, userMessage) {
  const history = loadHistory(chatId);
  const messages = [
    { role: 'system', content: config.llm.systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];
  const draft = await callLLMMessages(messages);
  log('DRAFT', `Draft generated (${draft.length} chars)`);
  return draft;
}

// Generate a summary of the current chat for context
async function generateChatSummary(chatId) {
  const history = loadHistory(chatId);
  if (history.length < 4) return '';

  try {
    const messages = [
      { role: 'system', content: 'Summarize this conversation in 1-2 sentences. Be factual and brief.' },
      ...history.slice(-20),
    ];
    const summary = await callLLMMessages(messages, { maxTokens: 150, temperature: 0.3 });
    return summary;
  } catch {
    return '';
  }
}

// Generate a summary of what this specific message is asking
async function generateMessageSummary(userMessage) {
  try {
    const messages = [
      { role: 'system', content: 'Summarize what this person is asking in one short sentence.' },
      { role: 'user', content: userMessage },
    ];
    return await callLLMMessages(messages, { maxTokens: 100, temperature: 0.3 });
  } catch {
    return '';
  }
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

// ─── Save conversation history (called on approval) ─────────────────────────
function saveConversationTurn(chatId, userMessage, assistantReply) {
  const history = loadHistory(chatId);
  history.push({ role: 'user', content: userMessage });
  history.push({ role: 'assistant', content: assistantReply });
  saveHistory(chatId, history);
}

// ─── Message Processor ───────────────────────────────────────────────────────
async function processMessage(payload) {
  const { event, data } = payload;

  if (event !== 'message.received') return;

  const msg = data?.data || data;
  if (!msg) return;

  if (config.bot.ignoreFromMe && msg.fromMe) return;
  if (config.bot.ignoreGroups && msg.chatId?.endsWith('@g.us')) return;

  const chatId = msg.chatId;
  const text = msg.body || msg.text;
  const sender = msg.sender || msg.pushName || 'Unknown';
  const isGroup = chatId?.endsWith('@g.us');
  const idempotencyKey = payload.idempotencyKey;

  if (wasProcessed(idempotencyKey)) {
    log('BOT', 'Duplicate message, skipping', { idempotencyKey });
    return;
  }
  markProcessed(idempotencyKey);

  if (!chatId || !text) {
    log('BOT', 'Ignoring message without chatId or text', { chatId, hasText: !!text });
    return;
  }

  // In groups: only respond if mentioned (or config says always)
  if (isGroup && config.bot.replyInGroupsOnlyWhenMentioned) {
    const mentions = msg.mentions || [];
    const myNumber = msg.to || '';
    const mentionedMe = mentions.some(m => m.includes(myNumber)) ||
                        text.includes('@') && mentions.length > 0;
    if (!mentionedMe) {
      log('GROUP', 'Not mentioned in group, skipping', { chatId });
      return;
    }
  }

  if (isOnCooldown(chatId)) {
    log('BOT', 'On cooldown, skipping', { chatId });
    return;
  }

  log('MSG', `New message from ${sender}`, { chatId, text: text.slice(0, 80), isGroup });

  await sleep(config.bot.replyDelay);

  // ── STEP 1: Check learned patterns ────────────────────────────────────
  const match = findMatchingPattern(text);
  if (match) {
    log('AUTO', `Pattern match found (${(match.confidence * 100).toFixed(0)}%)`, {
      keywords: match.pattern.keywords.slice(0, 5),
    });
    try {
      await sendReply(chatId, match.pattern.reply);
      setCooldown(chatId);
      saveConversationTurn(chatId, text, match.pattern.reply);

      // Update usage stats
      const patterns = loadPatterns();
      const p = patterns.find(x => x.id === match.pattern.id);
      if (p) {
        p.uses = (p.uses || 0) + 1;
        p.lastUsed = new Date().toISOString();
        savePatterns(patterns);
      }

      log('SENT', `Auto-reply sent to ${chatId}`, { patternUses: match.pattern.uses + 1 });
    } catch (err) {
      log('ERROR', 'Auto-reply failed', { error: err.message });
    }
    return;
  }

  // ── STEP 2: No pattern match → AI drafts + queue for approval ─────────
  log('QUEUE', 'No pattern match, generating draft for approval');

  try {
    const [draft, msgSummary, chatSummary] = await Promise.all([
      generateDraft(chatId, text),
      generateMessageSummary(text),
      generateChatSummary(chatId).catch(() => ''),
    ]);

    const approval = addApproval({
      chatId,
      sender,
      originalMessage: text,
      draftReply: draft,
      summary: msgSummary,
      chatSummary,
    });

    log('QUEUE', `⏳ Awaiting approval: ${approval.id}`, {
      sender,
      draft: draft.slice(0, 100),
    });

    // Save the incoming message to history immediately (so context builds)
    const history = loadHistory(chatId);
    history.push({ role: 'user', content: text });
    saveHistory(chatId, history);

  } catch (err) {
    log('ERROR', 'Failed to generate draft', { chatId, error: err.message });
    try {
      await sendReply(chatId, '⚠️ Sorry, I encountered an error. Please try again.');
    } catch { /* silent */ }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Approval API + Web Dashboard ────────────────────────────────────────────
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

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Approval dashboard HTML
function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WAA — Approval Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .header { background: linear-gradient(135deg, #25D366, #128C7E); padding: 1.5rem 2rem; display: flex; align-items: center; gap: 1rem; }
  .header h1 { font-size: 1.4rem; color: white; }
  .header .stats { margin-left: auto; display: flex; gap: 1.5rem; color: white; font-size: 0.875rem; }
  .header .stat { text-align: center; }
  .header .stat b { display: block; font-size: 1.3rem; }
  .container { max-width: 900px; margin: 0 auto; padding: 1.5rem; }
  .tabs { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
  .tab { padding: 0.6rem 1.2rem; background: #1e293b; border: 1px solid #334155; border-radius: 8px;
         color: #94a3b8; cursor: pointer; font-size: 0.875rem; font-weight: 600; transition: all 0.15s; }
  .tab.active { background: #25D366; color: white; border-color: #25D366; }
  .tab:hover:not(.active) { background: #334155; color: #e2e8f0; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.25rem;
          margin-bottom: 1rem; transition: border-color 0.15s; }
  .card:hover { border-color: #475569; }
  .card .meta { display: flex; gap: 1rem; font-size: 0.75rem; color: #64748b; margin-bottom: 0.75rem; }
  .card .sender { color: #25D366; font-weight: 600; }
  .card .msg { background: #0f172a; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.75rem;
               font-size: 0.875rem; color: #cbd5e1; border-left: 3px solid #475569; }
  .card .msg-label { font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
                     color: #64748b; margin-bottom: 0.375rem; }
  .card .draft { background: #0f172a; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.75rem;
                 font-size: 0.875rem; color: #86efac; border-left: 3px solid #25D366; white-space: pre-wrap; }
  .card .summary { font-size: 0.8125rem; color: #94a3b8; font-style: italic; margin-bottom: 0.75rem; }
  .actions { display: flex; gap: 0.5rem; }
  .btn { padding: 0.5rem 1.25rem; border: none; border-radius: 8px; font-size: 0.875rem; font-weight: 600;
         cursor: pointer; transition: all 0.15s; }
  .btn-approve { background: #25D366; color: white; }
  .btn-approve:hover { background: #1da851; box-shadow: 0 4px 14px rgba(37,211,102,0.3); }
  .btn-reject { background: transparent; color: #f87171; border: 1px solid #dc2626; }
  .btn-reject:hover { background: rgba(239,68,68,0.1); }
  .status-badge { padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.6875rem; font-weight: 700;
                  text-transform: uppercase; }
  .status-pending { background: rgba(245,158,11,0.15); color: #fbbf24; }
  .status-approved { background: rgba(34,197,94,0.15); color: #4ade80; }
  .status-rejected { background: rgba(239,68,68,0.15); color: #f87171; }
  .empty { text-align: center; padding: 3rem; color: #475569; }
  .empty svg { margin-bottom: 1rem; opacity: 0.3; }
  .pattern-keywords { display: flex; flex-wrap: wrap; gap: 0.375rem; margin-top: 0.5rem; }
  .keyword { padding: 0.15rem 0.5rem; background: #334155; border-radius: 4px; font-size: 0.75rem; color: #94a3b8; }
  .refresh-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .btn-refresh { background: #334155; color: #cbd5e1; border: 1px solid #475569; padding: 0.4rem 1rem;
                 border-radius: 6px; cursor: pointer; font-size: 0.8125rem; }
  .btn-refresh:hover { background: #475569; }
</style>
</head>
<body>
<div class="header">
  <h1>🤖 WAA Approval Dashboard</h1>
  <div class="stats">
    <div class="stat"><b id="pendingCount">-</b>Pending</div>
    <div class="stat"><b id="approvedCount">-</b>Approved</div>
    <div class="stat"><b id="patternCount">-</b>Patterns</div>
  </div>
</div>
<div class="container">
  <div class="tabs">
    <button class="tab active" onclick="showTab('pending', this)">⏳ Pending</button>
    <button class="tab" onclick="showTab('resolved', this)">📋 History</button>
    <button class="tab" onclick="showTab('patterns', this)">📚 Patterns</button>
  </div>
  <div class="refresh-bar">
    <span style="font-size:0.8125rem;color:#64748b" id="lastRefresh"></span>
    <button class="btn-refresh" onclick="loadAll()">↻ Refresh</button>
  </div>
  <div id="content">Loading...</div>
</div>
<script>
let currentTab = 'pending';

function showTab(tab, el) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  loadAll();
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

async function loadAll() {
  try {
    const [approvals, patterns] = await Promise.all([
      fetchJSON('/api/approvals'),
      fetchJSON('/api/patterns'),
    ]);

    const pending = approvals.filter(a => a.status === 'pending');
    const resolved = approvals.filter(a => a.status !== 'pending');

    document.getElementById('pendingCount').textContent = pending.length;
    document.getElementById('approvedCount').textContent = approvals.filter(a => a.status === 'approved').length;
    document.getElementById('patternCount').textContent = patterns.length;
    document.getElementById('lastRefresh').textContent = 'Updated ' + new Date().toLocaleTimeString();

    const el = document.getElementById('content');

    if (currentTab === 'pending') {
      if (!pending.length) {
        el.innerHTML = '<div class="empty"><p>🎉 No pending approvals</p><p style="font-size:0.8125rem;margin-top:0.5rem">New messages will appear here for review</p></div>';
      } else {
        el.innerHTML = pending.map(a => approvalCard(a, true)).join('');
      }
    } else if (currentTab === 'resolved') {
      if (!resolved.length) {
        el.innerHTML = '<div class="empty"><p>No resolved approvals yet</p></div>';
      } else {
        el.innerHTML = resolved.map(a => approvalCard(a, false)).join('');
      }
    } else if (currentTab === 'patterns') {
      if (!patterns.length) {
        el.innerHTML = '<div class="empty"><p>📚 No patterns learned yet</p><p style="font-size:0.8125rem;margin-top:0.5rem">Approve a reply to teach the bot a new pattern</p></div>';
      } else {
        el.innerHTML = patterns.map(p => patternCard(p)).join('');
      }
    }
  } catch (e) {
    document.getElementById('content').innerHTML = '<div class="empty">Error loading: ' + e.message + '</div>';
  }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function approvalCard(a, showActions) {
  const statusClass = a.status === 'pending' ? 'status-pending' : a.status === 'approved' ? 'status-approved' : 'status-rejected';
  return '<div class="card">' +
    '<div class="meta">' +
      '<span class="sender">' + esc(a.sender) + '</span>' +
      '<span>' + new Date(a.createdAt).toLocaleString() + '</span>' +
      '<span class="status-badge ' + statusClass + '">' + a.status + '</span>' +
      '<span style="margin-left:auto;font-size:0.7rem;color:#475569">' + a.id.slice(0,8) + '</span>' +
    '</div>' +
    (a.chatSummary ? '<div class="summary">💬 ' + esc(a.chatSummary) + '</div>' : '') +
    '<div class="msg-label">📨 Incoming Message</div>' +
    '<div class="msg">' + esc(a.originalMessage) + '</div>' +
    '<div class="msg-label">🤖 AI Draft Reply</div>' +
    '<div class="draft">' + esc(a.draftReply) + '</div>' +
    (a.summary ? '<div class="summary">📋 ' + esc(a.summary) + '</div>' : '') +
    (showActions ? '<div class="actions">' +
      '<button class="btn btn-approve" onclick="approve(\'' + a.id + '\', this)">✓ Approve & Learn</button>' +
      '<button class="btn btn-reject" onclick="reject(\'' + a.id + '\', this)">✗ Reject</button>' +
    '</div>' : '') +
  '</div>';
}

function patternCard(p) {
  return '<div class="card">' +
    '<div class="meta">' +
      '<span>Uses: <b style="color:#25D366">' + p.uses + '</b></span>' +
      '<span>Created: ' + new Date(p.createdAt).toLocaleDateString() + '</span>' +
      '<span>Last used: ' + (p.lastUsed ? new Date(p.lastUsed).toLocaleString() : 'never') + '</span>' +
      '<span style="margin-left:auto;font-size:0.7rem;color:#475569">' + p.id.slice(0,8) + '</span>' +
    '</div>' +
    '<div class="msg-label">📨 Original Message</div>' +
    '<div class="msg">' + esc(p.originalMessage) + '</div>' +
    '<div class="msg-label">✅ Learned Reply</div>' +
    '<div class="draft">' + esc(p.reply) + '</div>' +
    '<div class="pattern-keywords">' + p.keywords.map(k => '<span class="keyword">' + esc(k) + '</span>').join('') + '</div>' +
  '</div>';
}

async function approve(id, btn) {
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    await fetchJSON('/api/approvals/' + id + '/approve', { method: 'POST' });
    btn.textContent = '✅ Sent!';
    setTimeout(loadAll, 800);
  } catch (e) {
    btn.textContent = '❌ Error: ' + e.message;
    btn.disabled = false;
  }
}

async function reject(id, btn) {
  btn.disabled = true; btn.textContent = 'Rejecting...';
  try {
    await fetchJSON('/api/approvals/' + id + '/reject', { method: 'POST' });
    btn.textContent = '❌ Rejected';
    setTimeout(loadAll, 800);
  } catch (e) {
    btn.textContent = 'Error: ' + e.message;
    btn.disabled = false;
  }
}

loadAll();
setInterval(loadAll, 10000);
</script>
</body>
</html>`;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${config.webhook.port}`);
  const pathname = url.pathname;

  // ── Health check ──
  if (req.method === 'GET' && pathname === '/health') {
    return json(res, 200, { status: 'ok', bot: 'waa-ai-bot' });
  }

  // ── Dashboard ──
  if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(dashboardHTML());
  }

  // ── List approvals ──
  if (req.method === 'GET' && pathname === '/api/approvals') {
    return json(res, 200, loadApprovals());
  }

  // ── List patterns ──
  if (req.method === 'GET' && pathname === '/api/patterns') {
    return json(res, 200, loadPatterns());
  }

  // ── Approve one ──
  if (req.method === 'POST' && pathname.match(/^\/api\/approvals\/[^/]+\/approve$/)) {
    const id = pathname.split('/')[3];
    const item = getApproval(id);
    if (!item) return json(res, 404, { error: 'Not found' });
    if (item.status !== 'pending') return json(res, 409, { error: 'Already ' + item.status });

    try {
      // Send the approved reply
      await sendReply(item.chatId, item.draftReply);
      // Save conversation turn
      saveConversationTurn(item.chatId, item.originalMessage, item.draftReply);
      // Learn the pattern
      savePattern(item.originalMessage, item.draftReply, item.summary);
      // Update status
      updateApprovalStatus(id, 'approved');
      setCooldown(item.chatId);

      log('APPROVED', `Reply sent & pattern learned`, { id, chatId: item.chatId });
      return json(res, 200, { ok: true, message: 'Sent & learned' });
    } catch (err) {
      log('ERROR', 'Approval failed', { id, error: err.message });
      return json(res, 500, { error: err.message });
    }
  }

  // ── Reject one ──
  if (req.method === 'POST' && pathname.match(/^\/api\/approvals\/[^/]+\/reject$/)) {
    const id = pathname.split('/')[3];
    const item = getApproval(id);
    if (!item) return json(res, 404, { error: 'Not found' });
    if (item.status !== 'pending') return json(res, 409, { error: 'Already ' + item.status });

    updateApprovalStatus(id, 'rejected');
    log('REJECTED', `Draft rejected`, { id });
    return json(res, 200, { ok: true, message: 'Rejected' });
  }

  // ── Webhook ──
  if (req.method === 'POST' && pathname === config.webhook.path) {
    let payload;
    try { payload = await parseBody(req); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    processMessage(payload).catch(err => {
      log('ERROR', 'Message processing failed', { error: err.message });
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// ─── Webhook Registration ────────────────────────────────────────────────────
async function registerWebhook() {
  const webhookUrl = `http://localhost:${config.webhook.port}${config.webhook.path}`;
  log('SETUP', 'Registering webhook on WAA...', { url: webhookUrl });

  try {
    const existing = await waaApi('GET', `/api/sessions/${config.waa.sessionId}/webhooks`);
    const list = Array.isArray(existing) ? existing : existing?.data || [];

    for (const wh of list) {
      if (wh.url && wh.url.includes(`localhost:${config.webhook.port}`)) {
        log('SETUP', `Removing old webhook: ${wh.id}`);
        await waaApi('DELETE', `/api/sessions/${config.waa.sessionId}/webhooks/${wh.id}`);
      }
    }

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
  const patternCount = loadPatterns().length;
  const pendingCount = loadApprovals().filter(a => a.status === 'pending').length;

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🤖 WAA AI Bot — Approval-Based Learning System');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(`  📡 WAA:           ${config.waa.host}`);
  console.log(`  🧠 LLM:           ${config.llm.host} (${config.llm.model})`);
  console.log(`  🔗 Webhook:       http://localhost:${config.webhook.port}${config.webhook.path}`);
  console.log(`  📊 Dashboard:     http://localhost:${config.webhook.port}/`);
  console.log(`  💬 Session:       ${config.waa.sessionId}`);
  console.log(`  📚 Patterns:      ${patternCount} learned`);
  console.log(`  ⏳ Pending:       ${pendingCount} awaiting approval`);
  console.log(`  🎯 Match thresh:  ${config.approval.matchThreshold}`);
  console.log('');

  // Initialize stores
  if (!fs.existsSync(PATTERNS_PATH)) savePatterns([]);
  if (!fs.existsSync(APPROVALS_PATH)) saveApprovals([]);

  // Start server
  const server = http.createServer(handleRequest);
  server.listen(config.webhook.port, () => {
    log('SERVER', `Bot server listening on port ${config.webhook.port}`);
  });

  // Register webhook with WAA
  await sleep(1000);
  await registerWebhook();

  console.log('');
  console.log('  ✅ Bot is running!');
  console.log('  📊 Approve messages at: http://localhost:' + config.webhook.port + '/');
  console.log('  ⏹  Press Ctrl+C to stop');
  console.log('');

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
