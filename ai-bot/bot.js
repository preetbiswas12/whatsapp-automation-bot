#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WAA AI Bot — Entry point
//
//  Wires the refactored modules together:
//    src/config.js     → config & paths
//    src/server.js     → webhook receiver + approval API + dashboard
//    src/processor.js  → incoming-message pipeline
//    src/actions.js    → approve/reject resolution
//    src/store/*       → conversations, patterns, approvals persistence
//    src/llm.js        → LM Studio client
//    src/waa.js        → WAA server client + webhook registration
//
//  Flow:
//    1. Message arrives → check learned patterns first
//    2. Pattern match (confidence ≥ threshold) → AUTO-SEND instantly
//    3. No match → AI drafts reply + summary → queue for approval
//    4. Human approves → send reply → SAVE pattern for future auto-sends
//    5. Human rejects → discard
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const fs = require('fs');
const { config, CONVERSATIONS_DIR, PATTERNS_PATH, APPROVALS_PATH } = require('./src/config');
const { log, banner } = require('./src/logger');
const { sleep } = require('./src/utils');
const waa = require('./src/waa');
const server = require('./src/server');
const patternStore = require('./src/store/patterns');
const approvalStore = require('./src/store/approvals');

async function main() {
  // ── Initialize stores ──────────────────────────────────────────────────────
  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  }
  if (!fs.existsSync(PATTERNS_PATH)) patternStore.savePatterns([]);
  if (!fs.existsSync(APPROVALS_PATH)) approvalStore.saveAll([]);

  // ── Banner ─────────────────────────────────────────────────────────────────
  banner([
    '🤖 WAA AI Bot — Approval-Based Learning System',
    '',
    `📡 WAA:           ${config.waa.host}`,
    `🧠 LLM:           ${config.llm.host} (${config.llm.model})`,
    `🔗 Webhook:       http://localhost:${config.webhook.port}${config.webhook.path}`,
    `📊 Dashboard:     http://localhost:${config.webhook.port}/`,
    `💬 Session:       ${config.waa.sessionId}`,
    `📚 Patterns:      ${patternStore.loadPatterns().length} learned`,
    `⏳ Pending:       ${approvalStore.listPending().length} awaiting approval`,
    `🎯 Match thresh:  ${config.approval.matchThreshold}`,
    `🛡️  Approval mode: ${config.approval.enabled ? 'human approval' : 'fully automatic'}`,
  ]);

  // ── Start server ───────────────────────────────────────────────────────────
  const httpServer = server.startServer();

  // ── Register webhook with WAA ──────────────────────────────────────────────
  await sleep(1000);
  await waa.registerWebhook();

  banner([
    '✅ Bot is running!',
    `📊 Approve messages at: http://localhost:${config.webhook.port}/`,
    '⏹  Press Ctrl+C to stop',
  ]);

  process.on('SIGINT', () => {
    log('BOT', 'Shutting down...');
    httpServer.close();
    process.exit(0);
  });
}

main().catch(err => {
  log('FATAL', err.message);
  process.exit(1);
});