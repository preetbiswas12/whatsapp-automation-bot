#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WAA AI Bot — Entry point (production)
//
//  Wires the refactored modules together:
//    src/config.js     → config & paths
//    src/logger.js     → leveled + file-backed logging
//    src/server.js     → webhook receiver + approval API + dashboard
//    src/processor.js  → incoming-message pipeline
//    src/actions.js    → approve/reject resolution
//    src/health.js     → dependency health reporting
//    src/store/*       → conversations, patterns, approvals persistence
//    src/llm.js        → LM Studio client (retries + timeouts)
//    src/waa.js        → WAA server client + webhook registration
//
//  Production behavior:
//    - API requires X-Auth-Token (WAA_BOT_API_TOKEN)
//    - retries + timeouts on LLM & WAA calls
//    - atomic JSON writes for all stores
//    - webhook self-healing (re-registers if WAA was down)
//    - graceful shutdown on SIGINT/SIGTERM
//    - leveled logging to console + optional file
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const fs = require('fs');
const path = require('path');
const { config, CONVERSATIONS_DIR, PATTERNS_PATH, APPROVALS_PATH, ROOT_DIR } = require('./src/config');
const logger = require('./src/logger');
const { log, banner } = logger;
const waa = require('./src/waa');
const server = require('./src/server');
const llm = require('./src/llm');
const patternStore = require('./src/store/patterns');
const approvalStore = require('./src/store/approvals');

// ── Logging setup ─────────────────────────────────────────────────────────────
logger.configure({
  level: config.server.logLevel,
  file: config.server.logFile || path.join(ROOT_DIR, 'bot.log'),
});

// ── Crash safety ──────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  log.error('PROCESS', 'Unhandled promise rejection', { reason: reason?.message || String(reason) });
});

process.on('uncaughtException', (err) => {
  log.error('PROCESS', 'Uncaught exception', { error: err.message, stack: err.stack });
  // Let the supervisor (run.js / PM2) restart the process cleanly.
  process.exit(1);
});

// ── Store initialization ─────────────────────────────────────────────────────
function initStores() {
  if (!fs.existsSync(CONVERSATIONS_DIR)) fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  if (!fs.existsSync(PATTERNS_PATH)) patternStore.savePatterns([]);
  if (!fs.existsSync(APPROVALS_PATH)) approvalStore.saveAll([]);
}

async function main() {
  initStores();

  banner([
    '🤖 WAA AI Bot — Approval-Based Learning System',
    '',
    `📡 WAA:           ${config.waa.host}`,
    `🧠 LLM engine:    ${config.llm.engine === 'gguf' ? `GGUF in-process (${config.llm.modelPath})` : `HTTP (${config.llm.host} / ${config.llm.model})`}`,
    `🔗 Webhook:       http://localhost:${config.webhook.port}${config.webhook.path}`,
    `📊 Dashboard:     http://localhost:${config.webhook.port}/`,
    `💬 Session:       ${config.waa.sessionId}`,
    `📚 Patterns:      ${patternStore.loadPatterns().length} learned`,
    `⏳ Pending:       ${approvalStore.listPending().length} awaiting approval`,
    `🎯 Match thresh:  ${config.approval.matchThreshold}`,
    `🛡️  Approval mode: ${config.approval.enabled ? 'human approval' : 'fully automatic'}`,
    `🗝️  API auth:      X-Auth-Token required on /api/*`,
    `📄 Log file:      ${config.server.logFile || path.join(ROOT_DIR, 'bot.log')}`,
  ]);

  // ── Start HTTP server ───────────────────────────────────────────────────────
  const httpServer = server.startServer();

  // ── Load the local GGUF model (in-process) ──────────────────────────────────
  // Warm it up so the first incoming message isn't slowed by model loading.
  // If it fails, the bot still starts and /health reports the problem.
  if (config.llm.engine === 'gguf') {
    try {
      await llm.initGguf();
    } catch (err) {
      log.error('LLM', `Failed to preload GGUF model: ${err.message}`);
    }
  }

  // ── Register webhook with WAA ───────────────────────────────────────────────
  await waa.registerWebhook();

  // Self-healing: re-ensure the webhook registration periodically (WAA might
  // have been down at boot, or the registration may have been cleared).
  const refreshMs = (config.webhook.refreshSeconds || 300) * 1000;
  if (refreshMs > 0) {
    setInterval(() => {
      waa.registerWebhook().then(() => {}); // failures are logged inside
    }, refreshMs);
  }

  banner([
    '✅ Bot is running!',
    `📊 Approve messages at: http://localhost:${config.webhook.port}/`,
    `❤️  Health check:      http://localhost:${config.webhook.port}/health`,
    '⏹  Press Ctrl+C to stop',
  ]);

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('BOT', `Received ${signal}, shutting down gracefully...`);
    // Stop accepting new work, then close the server.
    httpServer.close(() => {
      log('BOT', 'Shutdown complete.');
      process.exit(0);
    });
    // Give slow in-flight requests a hard deadline.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  log.error('FATAL', err.message);
  process.exit(1);
});