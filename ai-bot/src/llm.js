'use strict';

// LLM client — two engines behind one API:
//
//   engine "gguf": loads your .gguf in-process via node-llama-cpp.
//                  No LM Studio, no external server. The bot IS the model host.
//   engine "http": OpenAI-compatible HTTP API (e.g. LM Studio, llama-server).
//
// Both expose the same functions used by processor/actions, with timeouts,
// retries (http engine) and R1-style reasoning stripping.

const config = require('./config').config;
const { log } = require('./logger');
const { retry } = require('./utils');
const { loadHistory } = require('./store/conversations');

// ─── Model runtime status (reported by /health) ──────────────────────────────
const modelStatus = {
  engine: config.llm.engine,
  loaded: false,
  error: null,
  modelPath: config.llm.modelPath || null,
  contextSize: config.llm.contextSize,
  loadMs: null,
  lastInferenceMs: null,
  estTokensPerSec: null,
  totalTokens: 0,
};

function getModelStatus() {
  return { ...modelStatus };
}

// ─── HTTP engine ─────────────────────────────────────────────────────────────
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

async function chatHttp(messages, opts = {}) {
  const body = JSON.stringify({
    model: config.llm.model,
    messages,
    max_tokens: opts.maxTokens || config.llm.maxTokens,
    temperature: opts.temperature ?? config.llm.temperature,
    stream: false,
  });

  return retry(async () => {
    try {
      const res = await fetchWithTimeout(
        `${config.llm.host}/v1/chat/completions`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
        (opts.timeoutMs || config.llm.timeoutSeconds) * 1000
      );
      if (!res.ok) {
        const err = await res.text();
        throw new LlmError(res.status, `LLM API error ${res.status}: ${err}`);
      }
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content?.trim();
      if (!reply) throw new LlmError(0, 'LLM returned empty response');
      return postProcess(reply);
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
      return true;
    },
    onRetry: (err, attempt) => log.warn('LLM', `Retry ${attempt} after error: ${err.message}`),
  });
}

// ─── GGUF engine (in-process, node-llama-cpp) ────────────────────────────────
let llamaModulePromise = null;
let sessionPromise = null;

function loadLlamaModule() {
  if (!llamaModulePromise) {
    llamaModulePromise = import('node-llama-cpp');
  }
  return llamaModulePromise;
}

// Warm up the GGUF model. Safe to call multiple times (idempotent).
function initGguf() {
  if (config.llm.engine !== 'gguf') return Promise.resolve(null);
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    const started = Date.now();
    log('LLM', `Loading GGUF model: ${modelStatus.modelPath}`);
    const { getLlama, LlamaChatSession } = await loadLlamaModule();
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath: modelStatus.modelPath });
    const context = await model.createContext({ contextSize: modelStatus.contextSize });
    const sequence = context.getSequence();
    modelStatus.loaded = true;
    modelStatus.error = null;
    modelStatus.loadMs = Date.now() - started;
    log('LLM', `✅ GGUF model loaded in ${(modelStatus.loadMs / 1000).toFixed(1)}s`, {
      contextSize: modelStatus.contextSize,
    });
    return new LlamaChatSession({ contextSequence: sequence });
  })();

  // Reset cache on failure so the next attempt can retry.
  sessionPromise.catch(err => {
    sessionPromise = null;
    modelStatus.loaded = false;
    modelStatus.error = err.message;
    log.error('LLM', `GGUF model load failed: ${err.message}`);
  });
  return sessionPromise;
}

// Convert OpenAI-style {role, content} messages to node-llama-cpp v3 chat history items.
function toNlcHistory(messages) {
  return (messages || [])
    .map(m => {
      if (!m || m.content === undefined || m.content === null || m.content === '') return null;
      if (m.role === 'system') return { type: 'system', text: String(m.content) };
      if (m.role === 'assistant') return { type: 'model', text: String(m.content) };
      return { type: 'user', text: String(m.content) };
    })
    .filter(Boolean);
}

async function chatGguf(messages, opts = {}) {
  const session = await initGguf();
  const items = toNlcHistory(messages);
  if (!items.length) return '';
  const last = items[items.length - 1];
  const prior = items.slice(0, -1);

  // Set the conversation history explicitly (stateless — like the http engine),
  // then prompt with just the newest user message.
  session.setChatHistory(prior);

  const started = Date.now();
  const rawOutput = await session.prompt(String(last.text), {
    temperature: opts.temperature ?? config.llm.temperature,
    maxTokens: opts.maxTokens || config.llm.maxTokens,
  });

  const elapsedMs = Date.now() - started;
  modelStatus.lastInferenceMs = elapsedMs;
  // Rough tokens/sec estimate (chars/4) for the health report.
  const estTokens = Math.max(1, Math.round(rawOutput.length / 4));
  modelStatus.estTokensPerSec = Math.round((estTokens / (elapsedMs / 1000)) * 10) / 10;
  modelStatus.totalTokens += estTokens;

  log.debug('LLM', `Generated ${String(rawOutput).length} chars in ${elapsedMs}ms (${modelStatus.estTokensPerSec} tok/s)`);
  log.debug('LLM', `Raw output preview: ${JSON.stringify(String(rawOutput).slice(0, 160))}`);
  return postProcess(rawOutput);
}

// ─── Shared post-processing ──────────────────────────────────────────────────
function postProcess(output) {
  let out = String(output).trim();
  if (config.llm.stripReasoning) out = stripReasoning(out);
  return out;
}

// Strip R1-style reasoning so the sent reply is only the answer.
// Handles the formats R1-distill models actually emit:
//   <thinking>...</thinking> style tags, and
//   "### Reasoning: ... ### Answer: ..." header style.
function stripReasoning(output) {
  let out = String(output);

  // 1) Paired thinking tags.
  out = out.replace(
    /<\|?(?:begin_of_think|thinking|think|reasoning)\|?>[\s\S]*?<\|?(?:end_of_think|thinking|think|reasoning)\|?>/gi,
    ''
  );

  // 2) Header style — keep everything from the answer header onward.
  const answerSection = out.match(/^#{0,3}\s*(?:final\s+)?answer\s*:[\s\S]*$/im);
  if (answerSection) {
    return answerSection[0].trim();
  }

  return out.trim();
}

// ─── Public API (used by processor / actions) ────────────────────────────────
async function chat(messages, opts = {}) {
  const reply = config.llm.engine === 'gguf'
    ? await chatGguf(messages, opts)
    : await chatHttp(messages, opts);
  return reply;
}

// Shown when the model returns empty output even after a retry.
const FALLBACK_REPLY = 'Sorry, I didn\u2019t quite catch that. Could you rephrase it?';

async function generateDraft(chatId, userMessage) {
  const history = loadHistory(chatId);
  const messages = [
    { role: 'system', content: config.llm.systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  let draft = await chat(messages);

  // R1-style models occasionally burn their whole token budget "thinking"
  // and return nothing. Retry once with a direct-answer nudge.
  if (!draft || !draft.trim()) {
    log.warn('LLM', 'Empty draft generated — retrying with a direct-answer nudge');
    const nudged = [
      ...messages.slice(0, -1),
      {
        role: 'user',
        content: `${userMessage}\n\nPlease respond NOW with a short, direct answer. No analysis, no reasoning, no thinking.`,
      },
    ];
    draft = await chat(nudged, {
      maxTokens: Math.min(config.llm.maxTokens * 1.5, 768),
    });
  }

  if (!draft || !draft.trim()) {
    log.warn('LLM', 'Draft still empty after retry — using fallback reply');
    draft = FALLBACK_REPLY;
  }

  const trimmed = draft.trim();
  log.debug('LLM', `Draft generated (${trimmed.length} chars)`);
  return trimmed;
}

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

module.exports = {
  chat,
  generateDraft,
  generateChatSummary,
  generateMessageSummary,
  initGguf,
  getModelStatus,
  stripReasoning,
  LlmError,
};