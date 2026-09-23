'use strict';

// Learned reply patterns. Stored as JSON at patterns.json.

const fs = require('fs');
const crypto = require('crypto');
const { PATTERNS_PATH } = require('./../config');
const { log } = require('./../logger');
const { jaccardSimilarity, extractKeywords } = require('./../matcher');

const MERGE_THRESHOLD = 0.8; // patterns this similar share one entry

function loadPatterns() {
  try {
    const data = JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function savePatterns(patterns) {
  fs.writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2), 'utf-8');
}

// Learn from an approved reply. Merges into an existing near-identical pattern,
// otherwise appends a new one. Returns the stored pattern.
function learn(originalMessage, approvedReply, summary) {
  const patterns = loadPatterns();
  const keywords = extractKeywords(originalMessage);

  const existingIndex = patterns.findIndex(
    p => jaccardSimilarity(p.keywords || [], keywords) > MERGE_THRESHOLD
  );

  if (existingIndex >= 0) {
    const existing = patterns[existingIndex];
    existing.reply = approvedReply;
    existing.uses = (existing.uses || 0) + 1;
    existing.lastUsed = new Date().toISOString();
    savePatterns(patterns);
    log('LEARN', 'Updated existing pattern', { keywords: existing.keywords });
    return existing;
  }

  const pattern = {
    id: crypto.randomUUID(),
    keywords,
    originalMessage: originalMessage.slice(0, 500),
    reply: approvedReply,
    summary: summary || '',
    uses: 1,
    createdAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
  };
  patterns.push(pattern);
  savePatterns(patterns);
  log('LEARN', 'New pattern saved', { keywords, replyLen: approvedReply.length });
  return pattern;
}

// Bump usage stats after an auto-reply.
function incrementUsage(patternId) {
  const patterns = loadPatterns();
  const pattern = patterns.find(p => p.id === patternId);
  if (!pattern) return;
  pattern.uses = (pattern.uses || 0) + 1;
  pattern.lastUsed = new Date().toISOString();
  savePatterns(patterns);
}

module.exports = { loadPatterns, savePatterns, learn, incrementUsage };