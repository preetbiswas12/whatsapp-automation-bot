'use strict';

// Loads and validates the bot configuration from config.json
// with environment-variable overrides for production.

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const CONVERSATIONS_DIR = path.join(ROOT_DIR, 'conversations');
const PATTERNS_PATH = path.join(ROOT_DIR, 'patterns.json');
const APPROVALS_PATH = path.join(ROOT_DIR, 'approvals.json');

// Defaults applied for any missing section. 'server' holds production options.
const DEFAULTS = {
  waa: { host: 'http://localhost:2785', apiKey: '', sessionId: '' },
  llm: {
    // engine: 'gguf' loads your .gguf in-process (node-llama-cpp).
    //         'http' talks to an OpenAI-compatible server (host/model).
    engine: 'gguf',
    host: 'http://localhost:1234',
    model: '',
    modelPath: '',
    contextSize: 8192,   // KV-cache: ~57KB/token on this model — 8192 ≈ +470MB (safe on 6GB RAM)
    stripReasoning: true,
    systemPrompt: 'You are a helpful WhatsApp assistant. Answer directly and concisely. Do NOT write out any reasoning, thinking, or chain-of-thought; just give the final answer in one or two short sentences. ALWAYS reply in English, no matter what language the incoming message is in.',
    maxTokens: 512,
    temperature: 0.7,
    timeoutSeconds: 120,   // http engine only
    maxRetries: 3,
  },
  webhook: { port: 3001, path: '/webhook', refreshSeconds: 300 },
  bot: {
    replyDelay: 1500,
    ignoreFromMe: true,
    ignoreGroups: false,
    ignoreNewsletterChats: true,
    replyInGroupsOnlyWhenMentioned: true,
    maxHistoryPerChat: 20,
    cooldownSeconds: 5,
  },
  approval: { enabled: true, matchThreshold: 0.6, maxPending: 50 },
  server: {
    // Set WAA_BOT_API_TOKEN in production; the config value is only a fallback.
    apiToken: 'waa-bot-change-me',
    logLevel: 'info',
    logFile: '',
    timeoutSeconds: 30, // WAA API request timeout
  },
};

function deepMerge(base, override) {
  if (
    override && typeof override === 'object' && !Array.isArray(override)
    && base && typeof base === 'object'
  ) {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = deepMerge(base[key], override[key]);
    }
    return out;
  }
  return override === undefined ? base : override;
}

// Env overrides: secret + deployment knobs never sit in the repo.
function applyEnvOverrides(config) {
  if (process.env.WAA_BOT_API_TOKEN) config.server.apiToken = process.env.WAA_BOT_API_TOKEN;
  if (process.env.WAA_BOT_LOG_LEVEL) config.server.logLevel = process.env.WAA_BOT_LOG_LEVEL;
  if (process.env.WAA_BOT_LOG_FILE) config.server.logFile = process.env.WAA_BOT_LOG_FILE;
  if (process.env.WAA_BOT_PORT) config.webhook.port = Number(process.env.WAA_BOT_PORT);
  if (process.env.WAA_HOST) config.waa.host = process.env.WAA_HOST;
  if (process.env.WAA_LLM_ENGINE) config.llm.engine = process.env.WAA_LLM_ENGINE;
  if (process.env.WAA_LLM_MODEL_PATH) config.llm.modelPath = process.env.WAA_LLM_MODEL_PATH;
  if (process.env.WAA_LLM_HOST) config.llm.host = process.env.WAA_LLM_HOST;
  if (process.env.WAA_LLM_MODEL) config.llm.model = process.env.WAA_LLM_MODEL;
  return config;
}

// If engine is gguf and no modelPath was set, look for a .gguf in the usual
// places and pick the largest one.
function discoverModelFile(rootDir) {
  const candidates = [
    path.join(rootDir, 'models'),
    path.join(process.env.USERPROFILE || '~', 'Downloads'),
    process.env.USERPROFILE || '~',
    path.join(process.env.USERPROFILE || '~', '.cache', 'lm-studio', 'models'),
  ];
  const found = [];
  for (const dir of candidates) {
    if (!dir || !fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        try {
          if (fs.statSync(full).isFile() && entry.toLowerCase().endsWith('.gguf')) {
            found.push(full);
          }
        } catch { /* unreadable entry — skip */ }
      }
    } catch { /* unreadable dir — skip */ }
  }
  found.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return found[0] || null;
}

function validateConfig(config) {
  if (!config.waa.host) throw new Error('config.json: waa.host is required');
  if (!config.waa.apiKey) throw new Error('config.json: waa.apiKey is required');
  if (!config.waa.sessionId) throw new Error('config.json: waa.sessionId is required');
  if (!config.server.apiToken || config.server.apiToken === 'waa-bot-change-me') {
    throw new Error('Set an API token: put WAA_BOT_API_TOKEN in your environment (or server.apiToken in config.json). The default token is not allowed in production.');
  }

  if (config.llm.engine === 'gguf') {
    if (!config.llm.modelPath || !fs.existsSync(config.llm.modelPath)) {
      throw new Error(
        `GGUF model not found: "${config.llm.modelPath}". ` +
        `Set llm.modelPath (or WAA_LLM_MODEL_PATH) to the path of your .gguf file.`
      );
    }
    // model name is just a display label for gguf mode; keep llm.model optional.
  } else if (config.llm.engine === 'http') {
    if (!config.llm.host) throw new Error('config.json: llm.host is required for engine=http');
    if (!config.llm.model) throw new Error('config.json: llm.model is required for engine=http (set it to the model name shown in LM Studio)');
  } else {
    throw new Error(`config.json: llm.engine must be "gguf" or "http" (got "${config.llm.engine}")`);
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const config = applyEnvOverrides(deepMerge(DEFAULTS, raw));

  if (config.llm.engine === 'gguf' && !config.llm.modelPath) {
    const found = discoverModelFile(ROOT_DIR);
    if (found) {
      config.llm.modelPath = found;
      console.log(`[CONFIG] Auto-discovered GGUF model: ${found}`);
    }
  }

  validateConfig(config);
  return { config, CONFIG_PATH, CONVERSATIONS_DIR, PATTERNS_PATH, APPROVALS_PATH, ROOT_DIR };
}

module.exports = loadConfig();