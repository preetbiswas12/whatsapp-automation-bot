'use strict';

// Loads and validates the bot configuration from config.json

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const CONVERSATIONS_DIR = path.join(ROOT_DIR, 'conversations');
const PATTERNS_PATH = path.join(ROOT_DIR, 'patterns.json');
const APPROVALS_PATH = path.join(ROOT_DIR, 'approvals.json');

// Defaults applied for any missing top-level section.
const DEFAULTS = {
  waa: { host: 'http://localhost:2785', apiKey: '', sessionId: '' },
  llm: {
    host: 'http://localhost:1234',
    model: '',
    systemPrompt: 'You are a helpful WhatsApp assistant. Be concise and friendly. Reply in the same language the user writes in.',
    maxTokens: 1024,
    temperature: 0.7,
  },
  webhook: { port: 3001, path: '/webhook' },
  bot: {
    replyDelay: 1500,
    ignoreFromMe: true,
    ignoreGroups: false,
    replyInGroupsOnlyWhenMentioned: true,
    maxHistoryPerChat: 20,
    cooldownSeconds: 5,
  },
  approval: { enabled: true, matchThreshold: 0.6, maxPending: 50 },
};

function deepMerge(base, override) {
  if (override && typeof override === 'object' && !Array.isArray(override)
      && base && typeof base === 'object') {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = deepMerge(base[key], override[key]);
    }
    return out;
  }
  return override === undefined ? base : override;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const config = deepMerge(DEFAULTS, raw);

  // Validate the values the bot cannot run without.
  if (!config.waa.host) throw new Error('config.json: waa.host is required');
  if (!config.waa.apiKey) throw new Error('config.json: waa.apiKey is required');
  if (!config.waa.sessionId) throw new Error('config.json: waa.sessionId is required');
  if (!config.llm.host) throw new Error('config.json: llm.host is required');
  if (!config.llm.model) throw new Error('config.json: llm.model is required (set it to the model name shown in LM Studio)');

  return { config, CONFIG_PATH, CONVERSATIONS_DIR, PATTERNS_PATH, APPROVALS_PATH, ROOT_DIR };
}

module.exports = loadConfig();