'use strict';

// LM Studio client (OpenAI-compatible /v1/chat/completions).
// Wraps calls with timeouts and retry-on-transient-failure.

const config = require('./config').config;
const { log } = require('./logger');
const { retry } = require('./utils');
const { loadHistory } = require('./store/conversations');

// HTTP errors carry a numeric status so callers can decide retryability.
class LlmError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Low-level chat completion call (with retry).
async function chat(messages, opts = {}) {
  const body = JSON.stringify({
    model: config.llm.model,
    messages,
    max_tokens: opts.maxTokens || config.llm.maxTokens,
    temperature: opts.temperature ?? config.llm.temperature,
    stream: false,
  });

  return retry(async attempt => {
    try {
      const res = await fetchWithTimeout(
        `${config.llm.host}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
        (opts.timeoutMs || config.llm.timeoutSeconds) * 1000
      );

      if (!res.ok) {
        const err = await res.text();
        throw new LlmError(res.status, `LLM API error ${res.status}: ${err}`);
      }

      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content?.trim();
      if (!reply) throw new LlmError(0, 'LLM returned empty response');
      return reply;
    } catch (err) {
      if (err.name === 'AbortError') throw new LlmError(0, 'LLM request timed out');
      throw err;
    }
  }, {
    attempts: config.llm.maxRetries,
    baseMs: 1000,
    shouldRetry: err => {
      if (err instanceof LlmError) {
        return err.status >= 500 || err.status === 429 || err.status === 0;
      }
      return true; // network-level failures are worth one more try
    },
    onRetry: (err, attempt) => log.warn('LLM', `Retry ${attempt} after error: ${err.message}`),
  });
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
  log.debug('LLM', `Draft generated (${draft.length} chars)`);
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
    log.warn('LLM', `Chat summary failed: ${err.message}`);
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
    log.warn('LLM', `Message summary failed: ${err.message}`);
    return '';
  }
}

module.exports = { chat, generateDraft, generateChatSummary, generateMessageSummary, LlmError };