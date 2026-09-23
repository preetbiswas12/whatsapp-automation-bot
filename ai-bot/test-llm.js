#!/usr/bin/env node
// Quick LLM smoke test — sends one prompt through the configured engine
// (in-process GGUF, or an HTTP OpenAI-compatible server when engine=http)
// and prints the reply + timing.

const { config } = require('./src/config');
const llm = require('./src/llm');

async function main() {
  const testMsg = process.argv[2] || 'Hello! Who are you?';
  const label = config.llm.engine === 'gguf'
    ? `GGUF in-process (${config.llm.modelPath})`
    : `HTTP ${config.llm.host} (${config.llm.model})`;

  console.log(`\n🧪 Testing LLM: engine=${config.llm.engine} — ${label}`);
  console.log(`💬 Message: "${testMsg}"\n`);

  const started = Date.now();
  const reply = await llm.chat([
    { role: 'system', content: config.llm.systemPrompt },
    { role: 'user', content: testMsg },
  ]);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`✅ Reply (${secs}s): ${reply}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ LLM test failed:', err.message);
    process.exit(1);
  });