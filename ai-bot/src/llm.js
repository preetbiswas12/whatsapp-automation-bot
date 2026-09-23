'use strict';

// LM Studio client (OpenAI-compatible /v1/chat/completions).

const config = require('./config').config;
const { log } = require('./logger');
const { loadHistory } = require('./store/conversations');

// Low-level chat completion call.
async function chat(messages, opts = {}) {
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

// Draft reply for an incoming message, using prior conversation context.
async function generateDraft(chatId, userMessage) {
  const history = loadHistory(chatId);
  const messages = [
    { role: 'system', content: config.llm.systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];
  const draft = await chat(messages);
  log('DRAFT', `Draft generated (${draft.length} chars)`);
  return draft;
}

// One-line summary of the ongoing chat (for approval context).
async function generateChatSummary(chatId) {
  const history = loadHistory(chatId);
  if (history.length < 4) return '';

  try {
    const messages = [
      { role: 'system', content: 'Summarize this conversation in 1-2 sentences. Be factual and brief.' },
      ...history.slice(-20),
    ];
    return await chat(messages, { maxTokens: 150, temperature: 0.3 });
  } catch (err) {
    log('LLM', `Chat summary failed: ${err.message}`);
    return '';
  }
}

// One-line summary of what the message is asking (for the approver).
async function generateMessageSummary(userMessage) {
  try {
    const messages = [
      { role: 'system', content: 'Summarize what this person is asking in one short sentence.' },
      { role: 'user', content: userMessage },
    ];
    return await chat(messages, { maxTokens: 100, temperature: 0.3 });
  } catch (err) {
    log('LLM', `Message summary failed: ${err.message}`);
    return '';
  }
}

module.exports = { chat, generateDraft, generateChatSummary, generateMessageSummary };