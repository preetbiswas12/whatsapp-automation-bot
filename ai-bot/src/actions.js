'use strict';

// Resolving approval queue items (human actions triggered from the dashboard).

const config = require('./config').config;
const { log } = require('./logger');
const { Cooldown } = require('./guards');
const waa = require('./waa');
const conversations = require('./store/conversations');
const patterns = require('./store/patterns');
const approvalStore = require('./store/approvals');

const cooldown = new Cooldown(config.bot.cooldownSeconds);

// Send the approved draft, save the turn, and learn the pattern.
async function approve(id) {
  const item = approvalStore.getApproval(id);
  if (!item) return { ok: false, status: 404, error: 'Approval not found' };
  if (item.status !== approvalStore.STATUS.PENDING) {
    return { ok: false, status: 409, error: `Already ${item.status}` };
  }

  try {
    await waa.sendText(item.chatId, item.draftReply);
    conversations.addTurn(item.chatId, item.originalMessage, item.draftReply);
    patterns.learn(item.originalMessage, item.draftReply, item.summary);
    approvalStore.setStatus(id, approvalStore.STATUS.APPROVED);
    cooldown.set(item.chatId);

    log('APPROVED', 'Reply sent & pattern learned', { id, chatId: item.chatId });
    return { ok: true, message: 'Sent & learned' };
  } catch (err) {
    log('ERROR', 'Approval failed', { id, error: err.message });
    return { ok: false, status: 500, error: err.message };
  }
}

// Discard the draft without sending or learning.
function reject(id) {
  const item = approvalStore.getApproval(id);
  if (!item) return { ok: false, status: 404, error: 'Approval not found' };
  if (item.status !== approvalStore.STATUS.PENDING) {
    return { ok: false, status: 409, error: `Already ${item.status}` };
  }

  approvalStore.setStatus(id, approvalStore.STATUS.REJECTED);
  log('REJECTED', 'Draft rejected', { id });
  return { ok: true, message: 'Rejected' };
}

module.exports = { approve, reject };