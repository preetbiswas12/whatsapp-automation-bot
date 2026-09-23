'use strict';

// Human-approval queue. Stored as JSON at approvals.json.

const fs = require('fs');
const crypto = require('crypto');
const { APPROVALS_PATH } = require('./../config');
const { log } = require('./../logger');
const { writeJsonAtomic } = require('./../utils');

const STATUS = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected', EXPIRED: 'expired' };

function loadAll() {
  try {
    const data = JSON.parse(fs.readFileSync(APPROVALS_PATH, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveAll(approvals) {
  writeJsonAtomic(APPROVALS_PATH, approvals);
}

function listPending(maxPending) {
  const pending = loadAll().filter(a => a.status === STATUS.PENDING);
  return maxPending == null ? pending : pending.slice(0, maxPending);
}

function listResolved() {
  return loadAll().filter(a => a.status !== STATUS.PENDING);
}

function getApproval(id) {
  return loadAll().find(a => a.id === id);
}

// Enqueue a draft awaiting review. Oldest pending items expire beyond maxPending.
function enqueue(entry, maxPending) {
  const approvals = loadAll();
  const item = {
    id: crypto.randomUUID(),
    chatId: entry.chatId,
    sender: entry.sender,
    originalMessage: entry.originalMessage,
    draftReply: entry.draftReply,
    summary: entry.summary,
    chatSummary: entry.chatSummary,
    status: STATUS.PENDING,
    createdAt: new Date().toISOString(),
  };
  approvals.unshift(item); // newest first

  if (maxPending && maxPending > 0) {
    let expired = 0;
    for (const a of approvals) {
      if (a.status !== STATUS.PENDING) continue;
      if (++expired > maxPending) a.status = STATUS.EXPIRED;
    }
  }

  saveAll(approvals);
  log('QUEUE', `Approval queued: ${item.id}`, { sender: entry.sender, draftLen: entry.draftReply.length });
  return item;
}

function setStatus(id, status) {
  const approvals = loadAll();
  const item = approvals.find(a => a.id === id);
  if (!item) return null;
  item.status = status;
  item.resolvedAt = new Date().toISOString();
  saveAll(approvals);
  return item;
}

module.exports = { STATUS, loadAll, saveAll, listPending, listResolved, getApproval, enqueue, setStatus };