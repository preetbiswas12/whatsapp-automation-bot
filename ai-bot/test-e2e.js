#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WAA AI Bot — End-to-end check WITHOUT needing a phone to be linked.
//
//  Drives the real webhook + approval API and verifies:
//    1. auth guard (401 without token, 200 with token)
//    2. health: WAA + GGUF LLM + webhook all green
//    3. an incoming message → GGUF draft appears in the approval queue
//    4. approve is refused cleanly while WhatsApp is NOT connected (no learning)
//    5. reject works and persists
//    6. patterns endpoint + dashboard serve
//
//  Usage:  npm run test:e2e
//          (stack must be running first: npm run start:prod at repo root)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

const TOKEN = process.env.WAA_BOT_API_TOKEN || require('./src/config').config.server.apiToken;
const BOT = `http://localhost:${process.env.WAA_BOT_PORT || 3001}`;
const TEST_CHAT_ID = process.env.WAA_E2E_CHAT_ID || '999000111222@c.us';
const TEST_SENDER = 'E2E Tester';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(path, { auth = true, method = 'GET', body } = {}) {
  const res = await fetch(BOT + path, {
    method,
    headers: {
      ...(auth ? { 'X-Auth-Token': TOKEN } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json };
}

// /api/approvals and /api/patterns return bare arrays — normalize.
const asArray = b => (Array.isArray(b) ? b : b && Array.isArray(b.items) ? b.items : []);

function sendFake(text, key) {
  return req('/webhook', {
    auth: false,
    method: 'POST',
    body: { event: 'message.received', idempotencyKey: key, data: { chatId: TEST_CHAT_ID, body: text, sender: TEST_SENDER, fromMe: false } },
  });
}

(async () => {
  const results = [];
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass, detail });
    console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // wait for stack
  console.log('⏳ waiting for stack...');
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const h = await req('/health', { auth: false }); up = h.status === 200; } catch { /* booting */ }
    if (!up) await sleep(1000);
  }
  if (!up) { console.log('❌ stack not up — run `npm run start:prod` at the repo root first'); process.exit(1); }

  // 1) auth guard
  const noAuth = await req('/api/approvals', { auth: false });
  ok('API rejects missing token (401)', noAuth.status === 401, `got ${noAuth.status}`);
  const withAuth = await req('/api/approvals');
  ok('API accepts valid token (200)', withAuth.status === 200, `got ${withAuth.status}`);

  // 2) health all green
  const h = await req('/health', { auth: false });
  ok('Health: WAA + LLM + webhook all ok', h.body?.ok === true,
    `llm=${h.body?.checks?.llm?.ok} waa=${h.body?.checks?.waa?.ok} webhook=${h.body?.checks?.webhook?.ok}`);
  ok('Health: GGUF engine in-process', h.body?.checks?.llm?.engine === 'gguf',
    `model=${h.body?.checks?.llm?.modelPath}`);

  // 3) simulate an incoming WhatsApp message → draft must be queued
  const before = asArray((await req('/api/approvals')).body);
  const key = 'e2e-' + Date.now();
  const wh = await sendFake('Hello! What are your opening hours?', key);
  ok('Webhook accepts simulated message', wh.status === 200 || wh.status === 202, `got ${wh.status}`);

  console.log('⏳ waiting for GGUF draft generation (CPU, up to ~180s)...');
  let mine;
  for (let i = 0; i < 180 && !mine; i++) {
    const all = asArray((await req('/api/approvals')).body);
    mine = all.find(it => it.chatId === TEST_CHAT_ID && it.status === 'pending' && !before.some(b => b.id === it.id));
    if (!mine) await sleep(1000);
  }
  ok('Incoming message → draft queued for approval', Boolean(mine),
    mine ? `draft: "${(mine.draftReply || '').slice(0, 80)}"` : 'no new pending item found');
  ok('Draft is non-empty (no blank replies)', Boolean(mine && (mine.draftReply || '').trim().length > 0));

  // 4) approve path — behaviour depends on whether WhatsApp is connected:
  //    connected    → approve succeeds: reply sent + pattern learned
  //    disconnected → approve refused: stays pending, nothing learned
  if (mine) {
    const patsBefore = asArray((await req('/api/patterns')).body).length;
    const ap = await req(`/api/approvals/${mine.id}/approve`, { method: 'POST' });
    const still = asArray((await req('/api/approvals')).body).find(it => it.id === mine.id);
    if (ap.status === 200) {
      const patsAfter = asArray((await req('/api/patterns')).body).length;
      ok('Approve works when WhatsApp connected (send + learn)',
        still?.status === 'approved' && patsAfter > patsBefore,
        `status=${still?.status} patterns=${patsBefore}→${patsAfter}`);
    } else {
      ok('Approve refused while WhatsApp disconnected (no send/learn)',
        ap.status >= 400 && still?.status === 'pending',
        `approve=${ap.status} status=${still?.status}`);
    }
  }

  // 5) reject path — only valid while the item is still pending
  if (mine) {
    const cur = asArray((await req('/api/approvals')).body).find(it => it.id === mine.id);
    if (cur?.status === 'pending') {
      const rj = await req(`/api/approvals/${mine.id}/reject`, { method: 'POST' });
      ok('Reject works (200)', rj.status === 200, `got ${rj.status}`);
      const after = asArray((await req('/api/approvals')).body).find(it => it.id === mine.id);
      ok('Reject persisted (status=rejected)', after?.status === 'rejected', `status=${after?.status}`);
    }
  }

  // 6) patterns + dashboard
  const pats = await req('/api/patterns');
  ok('Patterns endpoint works', pats.status === 200, `learned=${asArray(pats.body).length}`);
  const dash = await req('/', { auth: false });
  ok('Dashboard serves', dash.status === 200);

  const failed = results.filter(r => !r.pass);
  console.log(`\n━━━━ ${results.length - failed.length}/${results.length} checks passed ━━━━`);
  if (failed.length) { failed.forEach(f => console.log(`  ❌ ${f.name} — ${f.detail}`)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });