'use strict';

// Per-chat conversation history, persisted as JSON files under conversations/.

const fs = require('fs');
const path = require('path');
const config = require('./../config').config;
const { CONVERSATIONS_DIR } = require('./../config');
const { log } = require('./../logger');
const { writeJsonAtomic } = require('./../utils');

function ensureDir() {
  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  }
}

function getChatFile(chatId) {
  const safe = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CONVERSATIONS_DIR, `${safe}.json`);
}

function loadHistory(chatId) {
  const file = getChatFile(chatId);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')).messages || [];
  } catch {
    return [];
  }
}

function saveHistory(chatId, messages) {
  ensureDir();
  const trimmed = messages.slice(-config.bot.maxHistoryPerChat * 2);
  const data = {
    chatId,
    lastUpdated: new Date().toISOString(),
    messageCount: trimmed.length,
    messages: trimmed,
  };
  writeJsonAtomic(getChatFile(chatId), data);
}

// Record an incoming user message immediately so context builds while a draft
// waits for approval.
function addUserMessage(chatId, text) {
  const history = loadHistory(chatId);
  history.push({ role: 'user', content: text });
  saveHistory(chatId, history);
}

// Record a full user→assistant turn once a reply is actually sent.
function addTurn(chatId, userMessage, assistantReply) {
  const history = loadHistory(chatId);
  history.push({ role: 'user', content: userMessage });
  history.push({ role: 'assistant', content: assistantReply });
  saveHistory(chatId, history);
}

module.exports = { loadHistory, saveHistory, addUserMessage, addTurn, getChatFile }; // eslint-disable-line no-unused-vars