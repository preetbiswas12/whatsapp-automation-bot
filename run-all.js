#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WAA — Single-process launcher
//
//  Boots BOTH servers inside ONE process, so `npm run start:prod` loads
//  everything at once:
//    1. WAA WhatsApp server  (NestJS → http://localhost:2785, sessions, dashboard)
//    2. AI Bot + kilo.ai API (node   → http://localhost:3001, approval dashboard)
//
//  Stop everything with Ctrl+C — both shut down together.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const NEST_ENTRY = path.join(ROOT, 'dist', 'main.js');
const BOT_ENTRY = path.join(ROOT, 'ai-bot', 'bot.js');
const WAA_HEALTH = process.env.WAA_HEALTH_URL || 'http://localhost:2785/api/health';
const WAA_WAIT_MS = Number(process.env.WAA_WAIT_MS || 20000);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Wait for the WAA HTTP listener to come up before booting the bot, so the
// first webhook registration usually succeeds instead of healing later.
async function waitForWaa(maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(WAA_HEALTH, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        console.log(`[START-ALL] ✅ WAA server is up (${WAA_HEALTH})`);
        return true;
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  console.warn(
    `[START-ALL] ⚠️ WAA server did not answer within ${maxMs}ms — starting the AI bot anyway (its webhook self-heals).`
  );
  return false;
}

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🚀 WAA + AI Bot — single-process boot');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1) WAA server (NestJS). Requires the compiled build: `npm run build:all`.
  if (!fs.existsSync(NEST_ENTRY)) {
    console.error(`[START-ALL] ❌ Missing ${NEST_ENTRY}`);
    console.error('             Build first: npm run build:all');
    process.exit(1);
  }
  console.log(`[START-ALL] Booting WAA server → ${NEST_ENTRY}`);
  require(NEST_ENTRY);

  // 2) Briefly wait for WAA, then boot the AI bot in-process.
  await waitForWaa(WAA_WAIT_MS);
  console.log(`[START-ALL] Booting AI Bot → ${BOT_ENTRY} (same process)`);
  require(BOT_ENTRY);

  console.log('[START-ALL] ✅ Everything is running in this one process.');
  console.log('[START-ALL]    WAA dashboard:  http://localhost:2785');
  console.log('[START-ALL]    Approvals:      http://localhost:3001/');
})().catch(err => {
  console.error('[START-ALL] Fatal:', err);
  process.exit(1);
});