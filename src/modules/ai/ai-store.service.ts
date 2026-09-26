import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../common/services/logger.service';
import { AiPattern, extractKeywords, jaccardSimilarity } from './ai-matcher';

/**
 * JSON-file persistence for the AI module — the approvals queue, the learned reply patterns, and
 * per-chat conversation history. Ported from the standalone ai-bot's store modules and rooted below
 * the OpenWA data dir (`<dataDir>/ai/`) so the whole tree is covered by the existing `data/` ignore
 * and the standard backup paths.
 *
 * Small, personal-bot-scale files written atomically (temp file + rename), so a crash mid-write can
 * never corrupt a store. Synchronous fs is fine here: these are single-digit-KB files on the rare
 * message/approval path — the same tradeoff the standalone bot made.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type AiApprovalKind = 'draft' | 'pattern' | 'agent';

export interface AiApprovalItem {
  id: string;
  sessionId: string;
  sender: string;
  chatId: string;
  originalMessage: string;
  draftReply: string;
  /** Operator override written before approval. Approve sends this instead of draftReply. */
  customReply?: string | null;
  summary: string;
  chatSummary: string;
  status: ApprovalStatus;
  /** Kind of draft: a fresh LLM draft, a match against a learned pattern, or an agent-generated message. */
  kind: AiApprovalKind;
  /** Present only for `pattern` approvals: which pattern matched and with what confidence. */
  patternId?: string;
  confidence?: number;
  /** Present only for `agent` approvals: the phone number the message is targeted to. */
  targetPhone?: string;
  /** Present only for `agent` approvals: the operator's prompt describing what to send. */
  agentPrompt?: string;
  /** Present only for `agent` approvals: when the message is scheduled to be sent (ISO 8601). */
  sendAt?: string;
  /** Present only for `agent` approvals: error from the delayed background send, if it failed. */
  sendError?: string | null;
  createdAt: string;
  resolvedAt?: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

const STATUS: Record<'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED', ApprovalStatus> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
};

@Injectable()
export class AiStoreService {
  private readonly logger = createLogger('AiStoreService');
  private readonly aiDataDir: string;
  private readonly approvalsPath: string;
  private readonly patternsPath: string;
  private readonly conversationsDir: string;

  constructor(configService: ConfigService) {
    const dataDir = configService.get<string>('dataDir') || './data';
    this.aiDataDir = path.resolve(dataDir, 'ai');
    this.approvalsPath = path.join(this.aiDataDir, 'approvals.json');
    this.patternsPath = path.join(this.aiDataDir, 'patterns.json');
    this.conversationsDir = path.join(this.aiDataDir, 'conversations');
    fs.mkdirSync(this.conversationsDir, { recursive: true });
  }

  /** Read + parse a JSON file, returning fallback on any error (missing file first time = fallback). */
  private readJson<T>(filePath: string, fallback: T): T {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return data === null || data === undefined ? fallback : data;
    } catch {
      return fallback;
    }
  }

  /** Atomic write: temp file, then rename over the target. A crash mid-write cannot corrupt the store. */
  private writeJson(filePath: string, data: unknown): void {
    const tmp = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }

  // ─── Approvals ─────────────────────────────────────────────────────────────

  get STATUS(): typeof STATUS {
    return STATUS;
  }

  listApprovals(): AiApprovalItem[] {
    return this.readJson<AiApprovalItem[]>(this.approvalsPath, []);
  }

  listPending(): AiApprovalItem[] {
    return this.listApprovals().filter(a => a.status === STATUS.PENDING);
  }

  listResolved(): AiApprovalItem[] {
    return this.listApprovals().filter(a => a.status !== STATUS.PENDING);
  }

  getApproval(id: string): AiApprovalItem | null {
    return this.listApprovals().find(a => a.id === id) ?? null;
  }

  /** Enqueue a draft awaiting review. Oldest pending items expire beyond maxPending. */
  enqueue(
    entry: {
      sessionId: string;
      sender: string;
      chatId: string;
      originalMessage: string;
      draftReply: string;
      summary: string;
      chatSummary: string;
      kind?: AiApprovalKind;
      patternId?: string;
      confidence?: number;
      customReply?: string | null;
      targetPhone?: string;
      agentPrompt?: string;
    },
    maxPending: number,
  ): AiApprovalItem {
    const approvals = this.listApprovals();
    const item: AiApprovalItem = {
      id: randomUUID(),
      sessionId: entry.sessionId,
      sender: entry.sender,
      chatId: entry.chatId,
      originalMessage: entry.originalMessage,
      draftReply: entry.draftReply,
      customReply: entry.customReply ?? null,
      summary: entry.summary,
      chatSummary: entry.chatSummary,
      kind: entry.kind ?? 'draft',
      ...(entry.patternId ? { patternId: entry.patternId } : {}),
      ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
      ...(entry.targetPhone ? { targetPhone: entry.targetPhone } : {}),
      ...(entry.agentPrompt ? { agentPrompt: entry.agentPrompt } : {}),
      status: STATUS.PENDING,
      createdAt: new Date().toISOString(),
    };
    approvals.unshift(item); // newest first

    if (maxPending > 0) {
      let expired = 0;
      for (const a of approvals) {
        if (a.status !== STATUS.PENDING) continue;
        if (++expired > maxPending) a.status = STATUS.EXPIRED;
      }
    }

    this.writeJson(this.approvalsPath, approvals);
    this.logger.log('AI approval queued', { id: item.id, sender: item.sender, kind: item.kind });
    return item;
  }

  setApprovalStatus(id: string, status: ApprovalStatus): AiApprovalItem | null {
    const approvals = this.listApprovals();
    const item = approvals.find(a => a.id === id);
    if (!item) return null;
    item.status = status;
    item.resolvedAt = new Date().toISOString();
    this.writeJson(this.approvalsPath, approvals);
    return item;
  }

  /** Record when an approved item is scheduled to actually fire (only used for agent sends). */
  setSendAt(id: string, sendAt: string): AiApprovalItem | null {
    const approvals = this.listApprovals();
    const item = approvals.find(a => a.id === id);
    if (!item) return null;
    item.sendAt = sendAt;
    this.writeJson(this.approvalsPath, approvals);
    return item;
  }

  /** Record (or clear) the outcome of an agent's delayed background send. */
  setSendError(id: string, error: string | null): AiApprovalItem | null {
    const approvals = this.listApprovals();
    const item = approvals.find(a => a.id === id);
    if (!item) return null;
    item.sendError = error;
    this.writeJson(this.approvalsPath, approvals);
    return item;
  }

  /** Set an operator-edited reply on a pending approval. */
  setCustomReply(id: string, customReply: string | null): AiApprovalItem | null {
    const approvals = this.listApprovals();
    const item = approvals.find(a => a.id === id);
    if (!item) return null;
    item.customReply = customReply;
    this.writeJson(this.approvalsPath, approvals);
    return item;
  }

  // ─── Patterns ──────────────────────────────────────────────────────────────

  listPatterns(): AiPattern[] {
    return this.readJson<AiPattern[]>(this.patternsPath, []);
  }

  /** Learn from an approved reply. Merges into a near-identical pattern, else appends a new one. */
  learnPattern(originalMessage: string, approvedReply: string, summary: string): AiPattern {
    const patterns = this.listPatterns();
    const keywords = extractKeywords(originalMessage);

    const existingIndex = patterns.findIndex(p => jaccardSimilarity(p.keywords || [], keywords) > MERGE_THRESHOLD);

    if (existingIndex >= 0) {
      const existing = patterns[existingIndex];
      existing.reply = approvedReply;
      existing.uses = (existing.uses || 0) + 1;
      existing.lastUsed = new Date().toISOString();
      this.writeJson(this.patternsPath, patterns);
      this.logger.log('AI pattern updated', { id: existing.id, keywords: existing.keywords });
      return existing;
    }

    const pattern: AiPattern = {
      id: randomUUID(),
      keywords,
      originalMessage: originalMessage.slice(0, 500),
      reply: approvedReply,
      summary: summary || '',
      uses: 1,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    };
    patterns.push(pattern);
    this.writeJson(this.patternsPath, patterns);
    this.logger.log('AI pattern saved', { id: pattern.id, replyLen: approvedReply.length });
    return pattern;
  }

  /** Bump usage stats after an auto-reply. */
  incrementPatternUsage(patternId: string): void {
    const patterns = this.listPatterns();
    const pattern = patterns.find(p => p.id === patternId);
    if (!pattern) return;
    pattern.uses += 1;
    pattern.lastUsed = new Date().toISOString();
    this.writeJson(this.patternsPath, patterns);
  }

  /** Replace the whole pattern set (used by delete). Keeps the store the single writer. */
  deletePatterns(nextPatterns: AiPattern[]): void {
    this.writeJson(this.patternsPath, nextPatterns);
  }

  // ─── Conversations ─────────────────────────────────────────────────────────

  private chatFile(sessionId: string, chatId: string): string {
    const safe = `${sessionId}__${chatId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.conversationsDir, `${safe}.json`);
  }

  loadHistory(sessionId: string, chatId: string): ChatTurn[] {
    const file = this.chatFile(sessionId, chatId);
    if (!fs.existsSync(file)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(data?.messages) ? data.messages : [];
    } catch {
      return [];
    }
  }

  private saveHistory(sessionId: string, chatId: string, messages: ChatTurn[], maxPerChat: number): void {
    const trimmed = messages.slice(-maxPerChat * 2);
    const data = {
      sessionId,
      chatId,
      lastUpdated: new Date().toISOString(),
      messageCount: trimmed.length,
      messages: trimmed,
    };
    this.writeJson(this.chatFile(sessionId, chatId), data);
  }

  /** Record an incoming user message immediately so context builds while a draft waits for approval. */
  addUserMessage(sessionId: string, chatId: string, text: string, maxPerChat: number): void {
    const history = this.loadHistory(sessionId, chatId);
    history.push({ role: 'user', content: text, at: new Date().toISOString() });
    this.saveHistory(sessionId, chatId, history, maxPerChat);
  }

  /** Record the assistant turn once a reply is actually sent. */
  addAssistantMessage(sessionId: string, chatId: string, text: string, maxPerChat: number): void {
    const history = this.loadHistory(sessionId, chatId);
    history.push({ role: 'assistant', content: text, at: new Date().toISOString() });
    this.saveHistory(sessionId, chatId, history, maxPerChat);
  }
}

const MERGE_THRESHOLD = 0.8; // patterns this similar share one entry