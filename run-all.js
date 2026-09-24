#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WAA — Single-process launcher
//
//  Boots the OpenWA server in ONE process, so `npm run start:prod` loads
//  everything at once. The AI assistant now lives inside NestJS (src/modules/ai,
//  served from the :2785 dashboard) — there is no separate bot process anymore.
//
//  Stop with Ctrl+C.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const NEST_ENTRY = path.join(ROOT, 'dist', 'main.js');

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🚀 OpenWA — single-process boot');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Requires the compiled build: `npm run build:all`.
  if (!fs.existsSync(NEST_ENTRY)) {
    console.error(`[START] ❌ Missing ${NEST_ENTRY}`);
    console.error('           Build first: npm run build:all');
    process.exit(1);
  }
  console.log(`[START] Booting OpenWA server → ${NEST_ENTRY}`);
  require(NEST_ENTRY);

  console.log('[START] ✅ OpenWA is running.');
  console.log('[START]    Dashboard:  http://localhost:2785');
})().catch(err => {
  console.error('[START] Fatal:', err);
  process.exit(1);
});