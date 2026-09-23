'use strict';

// Incoming-message pipeline:
//   1. Filter (ignore own messages, groups, duplication, cooldown)
//   2. Check learned patterns → auto-send on match
//   3. No match → generate draft + summaries → queue for approval
//      (or auto-send+learn directly when approval.enabled is false)

const config = require('./config').config;
const { log } = require('./logger');
const { sleep } = require('./utils');
const { Cooldown, Deduplicator } = require('./guards');
const matcher = require('./matcher');
const llm = require('./llm');
const waa = require('./waa');
const conversations = require('./store/conversations');
const patterns = require('./store/patterns');
const approvals = require('./store/approvals');

const cooldown = new Cooldown(config.bot.cooldownSeconds);
const dedup = new Deduplicator();

// ─── Incoming message ────────────────────────────────────────────────────────
async function processMessage(payload) {
  if (!payload || payload.event !== 'message.received') return;

  const msg = payload.data?.data || payload.data;
  if (!msg) return;

  const chatId = msg.chatId;
  const text = msg.body || msg.text;
  const sender = msg.sender || msg.pushName || 'Unknown';
  const isGroup = Boolean(chatId && chatId.endsWith('@g.us'));

  // Filters
  if (config.bot.ignoreFromMe && msg.fromMe) return;
  if (config.bot.ignoreGroups && isGroup) return;
  if (!chatId || !text) {
    log('BOT', 'Ignoring message without chatId or text', { chatId, hasText: Boolean(text) });
    return;
  }
  if (dedup.has(payload.idempotencyKey)) {
    log('BOT', 'Duplicate message, skipping', { idempotencyKey: payload.idempotencyKey });
    return;
  }
  dedup.add(payload.idempotencyKey);

  if (isGroup && config.bot.replyInGroupsOnlyWhenMentioned && !isMentionedInGroup(msg, text)) {
    log('GROUP', 'Not mentioned in group, skipping', { chatId });
    return;
  }
  if (cooldown.isActive(chatId)) {
    log('BOT', 'On cooldown, skipping', { chatId });
    return;
  }

  log('MSG', `New message from ${sender}`, { chatId, text: text.slice(0, 80), isGroup });
  await sleep(config.bot.replyDelay);

  // STEP 1 — auto-reply from a learned pattern?
  const match = matcher.findBestMatch(patterns.loadPatterns(), text, config.approval.matchThreshold);
  if (match) {
    await autoReply(chatId, text, match);
    return;
  }

  // STEP 2 — AI-generated reply, then approve digitally or fully automatically.
  log('QUEUE', 'No pattern match, generating draft');

  try {
    const [draft, messageSummary, chatSummary] = await Promise.all([
      llm.generateDraft(chatId, text),
      llm.generateMessageSummary(text),
      llm.generateChatSummary(chatId),
    ]);

    const context = { chatId, sender, originalMessage: text, draft, messageSummary, chatSummary };

    if (config.approval.enabled) {
      const item = approvals.enqueue(
        {
          chatId,
          sender,
          originalMessage: text,
          draftReply: draft,
          summary: messageSummary,
          chatSummary,
        },
        config.approval.maxPending
      );
      log('QUEUE', `⏳ Awaiting approval: ${item.id}`, { sender, draft: draft.slice(0, 100) });
    } else {
      await autoSendAndLearn(context);
    }

    // Record the incoming message immediately so context keeps building.
    conversations.addUserMessage(chatId, text);
  } catch (err) {
    log('ERROR', 'Failed to generate draft', { chatId, error: err.message });
    try {
      await waa.sendText(chatId, '⚠️ Sorry, I encountered an error. Please try again.');
    } catch { /* already handled upstream */ }
  }
}

// Send the learned-pattern reply, record the turn, bump usage.
async function autoReply(chatId, originalMessage, match) {
  log('AUTO', `Pattern match found (${(match.confidence * 100).toFixed(0)}%)`, {
    keywords: match.pattern.keywords.slice(0, 5),
  });
  try {
    await waa.sendText(chatId, match.pattern.reply);
    cooldown.set(chatId);
    conversations.addTurn(chatId, originalMessage, match.pattern.reply);
    patterns.incrementUsage(match.pattern.id);
    log('SENT', `Auto-reply sent to ${chatId}`, { patternUses: match.pattern.uses + 1 });
  } catch (err) {
    log('ERROR', 'Auto-reply failed', { error: err.message });
  }
}

// Send the AI draft, record the turn, and learn a new pattern.
async function autoSendAndLearn(context) {
  try {
    await waa.sendText(context.chatId, context.draft);
    cooldown.set(context.chatId);
    conversations.addTurn(context.chatId, context.originalMessage, context.draft);
    patterns.learn(context.originalMessage, context.draft, context.messageSummary);
    log('SENT', `Auto-reply sent to ${context.chatId} (auto mode)`);
  } catch (err) {
    log('ERROR', 'Auto-mode send failed', { chatId: context.chatId, error: err.message });
  }
}

function isMentionedInGroup(msg, text) {
  const mentions = msg.mentions || [];
  const myNumber = msg.to || '';
  const mentioned = mentions.some(m => m.includes(myNumber));
  if (mentioned) return true;
  // Fallback: any @ mention present at all.
  return Boolean(text.includes('@') && mentions.length > 0);
}

module.exports = { processMessage, autoSendAndLearn };