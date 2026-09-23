#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Setup script — verifies config, checks the LLM engine, registers webhook
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const fs = require('fs');
const { config } = require('./src/config');

async function check(name, fn) {
  try {
    const note = await fn();
    console.log(`  ✅ ${name}${note ? ` — ${note}` : ''}`);
    return true;
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

  // 1. Config
  allOk &= await check('Config valid', () => {
    if (!config.waa.apiKey) throw new Error('waa.apiKey missing');
    if (!config.waa.sessionId) throw new Error('waa.sessionId missing');
    return `engine=${config.llm.engine}, model=${config.llm.engine === 'gguf' ? (config.llm.model || config.llm.modelPath) : config.llm.model}`;
  });

  // 2. WAA server
  allOk &= await check('WAA server reachable', async () => {
    const res = await fetch(`${config.waa.host}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  });

  // 3. API key
  allOk &= await check('API key works', async () => {
    const res = await fetch(`${config.waa.host}/api/sessions`, {
      headers: { 'x-api-key': config.waa.apiKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  });

  // 4. Session exists
  allOk &= await check('Session connected', async () => {
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

  // 5. LLM engine
  if (config.llm.engine === 'gguf') {
    allOk &= await check('GGUF model file exists', () => {
      if (!config.llm.modelPath) throw new Error('llm.modelPath not set');
      if (!fs.existsSync(config.llm.modelPath)) {
        throw new Error(`file not found: ${config.llm.modelPath}`);
      }
      const mb = Math.round(fs.statSync(config.llm.modelPath).size / 1024 / 1024);
      return `${config.llm.modelPath} (${mb} MB)`;
    });
    allOk &= await check('node-llama-cpp installed', async () => {
      await import('node-llama-cpp');
      return true;
    });
  } else {
    allOk &= await check('LLM HTTP server reachable', async () => {
      const res = await fetch(`${config.llm.host}/v1/models`);
      if (!res.ok) throw new Error(`HTTP ${res.status} — is the server running?`);
      const data = await res.json();
      const models = (data?.data || []).map(m => m.id).join(', ') || 'none';
      return `models: ${models}`;
    });
  }

  // 6. Webhook port available
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