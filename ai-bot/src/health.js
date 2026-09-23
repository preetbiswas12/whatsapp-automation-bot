'use strict';

// Health report for the /health endpoint: real checks against WAA and the LLM engine
// plus the current webhook-registration state.

const path = require('path');
const config = require('./config').config;
const waa = require('./waa');
const llm = require('./llm');
const { readJsonFile } = require('./utils');

const VERSION = (() => {
  try {
    const pkg = readJsonFile(path.join(__dirname, '..', 'package.json'), null);
    return pkg?.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

async function checkWaa() {
  const started = Date.now();
  try {
    const res = await fetch(`${config.waa.host}/api/health`, {
      headers: { 'x-api-key': config.waa.apiKey },
      signal: AbortSignal.timeout((config.server.timeoutSeconds || 30) * 1000),
    });
    return {
      ok: res.ok,
      latencyMs: Date.now() - started,
      httpStatus: res.status,
      url: config.waa.host,
    };
  } catch (err) {
    return { ok: false, error: err.message, url: config.waa.host };
  }
}

async function checkLlm() {
  if (config.llm.engine === 'gguf') {
    const status = llm.getModelStatus();
    return {
      ok: status.loaded,
      engine: 'gguf',
      modelPath: status.modelPath,
      contextSize: status.contextSize,
      configuredModel: config.llm.model || '(display name)',
      error: status.error || null,
      loadMs: status.loadMs ?? null,
      lastInferenceMs: status.lastInferenceMs ?? null,
      estTokensPerSec: status.estTokensPerSec ?? null,
    };
  }

  const started = Date.now();
  try {
    const headers = {};
    if (config.llm.apiKey) headers.Authorization = `Bearer ${config.llm.apiKey}`;
    const res = await fetch(`${config.llm.host}${config.llm.modelsPath}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const data = res.ok ? await res.json() : {};
    const models = (data.data || []).map(m => m.id);
    return {
      ok: res.ok,
      engine: 'http',
      latencyMs: Date.now() - started,
      httpStatus: res.status,
      models: models.slice(0, 10),
      configuredModel: config.llm.model,
      modelFound: models.includes(config.llm.model),
      url: config.llm.host,
    };
  } catch (err) {
    return { ok: false, error: err.message, url: config.llm.host };
  }
}

async function buildHealthReport() {
  const memory = process.memoryUsage();
  const [waaCheck, llmCheck] = await Promise.all([checkWaa(), checkLlm()]);
  const webhook = waa.getWebhookState();

  const checks = {
    waa: waaCheck,
    llm: llmCheck,
    webhook: {
      ok: webhook.registered,
      lastAttempt: webhook.lastAttempt || null,
      lastError: webhook.lastError || null,
      id: webhook.id || null,
    },
  };

  const healthy = waaCheck.ok && llmCheck.ok && webhook.registered;
  const degraded = Object.values(checks).some(c => !c.ok);

  return {
    status: healthy ? 'ok' : degraded ? 'degraded' : 'fail',
    ok: healthy,
    bot: 'waa-ai-bot',
    version: VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    pid: process.pid,
    memoryMb: {
      rss: Math.round(memory.rss / 1024 / 1024),
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
    },
    checks,
  };
}

module.exports = { buildHealthReport, VERSION };