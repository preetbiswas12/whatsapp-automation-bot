#!/usr/bin/env node
// Quick test — sends a message to LM Studio and prints the response
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

async function main() {
  const testMsg = process.argv[2] || 'Hello! Who are you?';
  console.log(`\n🧪 Testing LLM: ${config.llm.model} at ${config.llm.host}`);
  console.log(`📝 Message: "${testMsg}"\n`);

  const res = await fetch(`${config.llm.host}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: 'system', content: config.llm.systemPrompt },
        { role: 'user', content: testMsg },
      ],
      max_tokens: config.llm.maxTokens,
      temperature: config.llm.temperature,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`❌ Error ${res.status}: ${err}`);
    process.exit(1);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content;
  console.log(`🤖 Reply:\n${reply}\n`);
  console.log(`📊 Tokens — prompt: ${data.usage?.prompt_tokens}, completion: ${data.usage?.completion_tokens}`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
