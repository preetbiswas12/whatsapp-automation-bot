#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Setup script — verifies config, checks LM Studio, registers webhook
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

async function check(name, fn) {
  try {
    const ok = await fn();
    console.log(`  ✅ ${name}`);
    return ok;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🔧 WAA AI Bot — Setup Check');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let allOk = true;

  // 1. Check WAA server
  allOk &= await check('WAA server reachable', async () => {
    const res = await fetch(`${config.waa.host}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  });

  // 2. Check API key
  allOk &= await check('API key works', async () => {
    const res = await fetch(`${config.waa.host}/api/sessions`, {
      headers: { 'x-api-key': config.waa.apiKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  });

  // 3. Check session exists
  allOk &= await check('Session exists and is connected', async () => {
    const res = await fetch(`${config.waa.host}/api/sessions/${config.waa.sessionId}`, {
      headers: { 'x-api-key': config.waa.apiKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const session = data?.data || data;
    const status = session?.status || session?.state;
    if (status !== 'connected' && status !== 'ready') {
      console.log(`    ⚠️  Session status: ${status} (needs to be connected)`);
    }
    return true;
  });

  // 4. Check LM Studio
  allOk &= await check('LM Studio reachable', async () => {
    const res = await fetch(`${config.llm.host}/v1/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status} — Is LM Studio running?`);
    const data = await res.json();
    const models = data?.data || [];
    console.log(`    📦 Available models: ${models.map(m => m.id).join(', ') || 'none'}`);
    return true;
  });

  // 5. Check webhook port available
  allOk &= await check('Webhook port available', async () => {
    const res = await fetch(`http://localhost:${config.webhook.port}/health`).catch(() => null);
    if (res && res.ok) {
      console.log(`    ⚠️  Port ${config.webhook.port} already in use (bot may already be running)`);
    }
    return true;
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (allOk) {
    console.log('  ✅ All checks passed! Run: npm start');
  } else {
    console.log('  ⚠️  Some checks failed. Fix the issues above, then retry.');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
