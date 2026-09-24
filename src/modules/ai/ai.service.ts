import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { createLogger } from '../../common/services/logger.service';
import { PLUGIN_MESSAGE_PORT, type PluginMessagePort } from '../../core/plugins/plugin-host-ports';
import { findBestMatch } from './ai-matcher';
import { AiLlmService } from './ai-llm.service';
import { AiApprovalItem, AiStoreService } from './ai-store.service';

/**
 * AI assistant orchestration — the former standalone ai-bot's processor + actions, running inside
 * OpenWA. `SessionModule` imports the module and `MessageProjector.dispatchInboundMessage` fires
 * {@link evaluateInbound} next to AutomationRulesService.evaluateInbound, so every inbound message
 * rides the same at-most-once dispatch (the projector's DB insert oracle dedupes engine re-fires).
 *
 * Human-in-the-loop by default: when `ai.approval.enabled` is true (the shipped default), NO reply
 * is ever sent without an operator clicking Approve on the dashboard / a store note — neither a
 * pattern match nor a fresh LLM draft bypasses the queue. With approval disabled the old fully
 * automatic behaviour is restored (pattern match → send, no match → send + learn).
 */

interface AiBotSettings {
  replyDelayMs: number;
  ignoreFromMe: boolean;
  ignoreGroups: boolean;
  ignoreNewsletterChats: boolean;
  replyInGroupsOnlyWhenMentioned: boolean;
  maxHistoryPerChat: number;
  cooldownSeconds: number;
}

interface AiApprovalSettings {
  enabled: boolean;
  matchThreshold: number;
  maxPending: number;
}

// Freshness gate, identical to AutomationRulesService: a message older than this (epoch seconds)
// arrived as backfill/re-fetch after a reconnect, not live traffic, and replying would confuse the
// chat. A missing timestamp counts as fresh — losing one legitimate reply is worse than answering
// an old message once.
const MAX_MESSAGE_AGE_SECONDS = 300;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Ported from ai-bot guards.js: per-chat cooldown so the bot never spams a conversation. */
class Cooldown {
  private readonly seconds: number;
  private readonly times = new Map<string, number>();

  constructor(seconds: number) {
    this.seconds = seconds;
  }

  isActive(key: string): boolean {
    if (!key) return false;
    const last = this.times.get(key);
    if (!last) return false;
    return (Date.now() - last) / 1000 < this.seconds;
  }

  set(key: string): void {
    if (!key) return;
    this.times.set(key, Date.now());
    if (this.times.size > 500) {
      const now = Date.now();
      for (const [k, ts] of this.times) {
        if ((now - ts) / 1000 >= this.seconds) this.times.delete(k);
      }
    }
  }
}

export interface AiModuleStatus {
  enabled: boolean;
  approvalEnabled: boolean;
  matchThreshold: number;
  llmReachable: boolean;
  llmModel: string;
  pendingApprovals: number;
  patternCount: number;
}

@Injectable()
export class AiService {
  private readonly logger = createLogger('AiService');
  private readonly cooldown: Cooldown;
  private messagePort?: PluginMessagePort;

  constructor(
    private readonly store: AiStoreService,
    private readonly llm: AiLlmService,
    private readonly configService: ConfigService,
    // Optional so the service can be constructed standalone in specs. Resolved lazily like
    // AutomationRulesService — a constructor value-import of MessageService would close the
    // module cycle (projector -> automation/ai -> message -> session).
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {
    this.cooldown = new Cooldown(this.botSettings().cooldownSeconds);
  }

  private botSettings(): AiBotSettings {
    return this.configService.get<AiBotSettings>('ai.bot')!;
  }

  /** Master switch, defined at `ai.enabled` (not `ai.bot.*`). */
  private enabled(): boolean {
    return this.configService.get<boolean>('ai.enabled') ?? true;
  }

  private approvalSettings(): AiApprovalSettings {
    return this.configService.get<AiApprovalSettings>('ai.approval')!;
  }

  // ─── Inbound pipeline (called by MessageProjector) ─────────────────────────

  /**
   * Evaluate one inbound message. Fire-and-forget from the projector — nothing here may throw to
   * the caller, so every LLM/store error is caught and logged. The signature mirrors
   * AutomationRulesService.evaluateInbound.
   */
  async evaluateInbound(sessionId: string, message: Record<string, unknown>): Promise<void> {
    try {
      await this.evaluateInboundInner(sessionId, message);
    } catch (error) {
      this.logger.warn('AI evaluateInbound failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async evaluateInboundInner(sessionId: string, message: Record<string, unknown>): Promise<void> {
    const bot = this.botSettings();
    if (!this.enabled()) return;
    if (message.fromMe === true && bot.ignoreFromMe) return;

    const chatId = typeof message.chatId === 'string' ? message.chatId : null;
    if (!chatId) return;
    const text = typeof message.body === 'string' && message.body ? message.body : null;
    if (!text) return;

    // Freshness gate (see MAX_MESSAGE_AGE_SECONDS).
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
    if (timestamp !== null && Date.now() / 1000 - timestamp > MAX_MESSAGE_AGE_SECONDS) return;

    const isGroup = message.isGroup === true || chatId.endsWith('@g.us');
    if (bot.ignoreGroups && isGroup) return;
    if (bot.ignoreNewsletterChats && (chatId.endsWith('@newsletter') || chatId.endsWith('@broadcast'))) {
      this.logger.debug('AI ignoring channel/newsletter message', { sessionId, chatId });
      return;
    }
    if (bot.replyInGroupsOnlyWhenMentioned && isGroup && !this.isMentionedInGroup(message, text)) {
      this.logger.debug('AI not mentioned in group, skipping', { sessionId, chatId });
      return;
    }

    const cooldownKey = `${sessionId}:${chatId}`;
    if (this.cooldown.isActive(cooldownKey)) return;

    const sender = this.resolveSender(message);
    this.logger.log('AI new message', { sessionId, chatId, sender, text: text.slice(0, 80), isGroup });
    await sleep(bot.replyDelayMs);

    const approval = this.approvalSettings();

    // STEP 1 — a learned pattern matches?
    const match = findBestMatch(this.store.listPatterns(), text, approval.matchThreshold);
    if (match) {
      if (approval.enabled) {
        // Human-in-the-loop: even a confident pattern match waits for an Approve click.
        this.store.enqueue(
          {
            sessionId,
            sender,
            chatId,
            originalMessage: text,
            draftReply: match.pattern.reply,
            summary: match.pattern.summary,
            chatSummary: '',
            kind: 'pattern',
            patternId: match.pattern.id,
            confidence: match.confidence,
          },
          approval.maxPending,
        );
      } else {
        await this.sendReplyAndRecord(sessionId, chatId, text, match.pattern.reply, {
          patternMatch: { patternId: match.pattern.id, confidence: match.confidence },
        });
      }
      return;
    }

    // STEP 2 — no pattern match: generate a fresh draft.
    this.logger.log('AI no pattern match, generating draft', { sessionId, chatId });

    const history = this.store
      .loadHistory(sessionId, chatId)
      .map(t => ({ role: t.role, content: t.content }));

    // Draft + both summaries can run concurrently; the FIFO queue serializes the HTTP calls but the
    // three (successful) calls preserve ordering free-tier friendly.
    const [draft, messageSummary, chatSummary] = await Promise.all([
      this.llm.generateDraft(history, text),
      this.llm.generateMessageSummary(text),
      this.llm.generateChatSummary(history),
    ]);

    // Record the incoming message immediately so context keeps building while the draft is reviewed.
    this.store.addUserMessage(sessionId, chatId, text, bot.maxHistoryPerChat);

    if (approval.enabled) {
      const item = this.store.enqueue(
        {
          sessionId,
          sender,
          chatId,
          originalMessage: text,
          draftReply: draft,
          summary: messageSummary,
          chatSummary,
          kind: 'draft',
        },
        approval.maxPending,
      );
      this.logger.log('AI awaiting approval', { sessionId, id: item.id, sender, draft: draft.slice(0, 100) });
    } else {
      await this.sendReplyAndRecord(sessionId, chatId, text, draft, { summary: messageSummary });
    }
  }

  // ─── Human actions (approvals) ─────────────────────────────────────────────

  /** Send the approved draft, save the turn, and learn/refresh the pattern. */
  async approve(id: string): Promise<AiApprovalItem> {
    const item = this.store.getApproval(id);
    if (!item) throw new NotFoundException('Approval not found');
    if (item.status !== 'pending') throw new ConflictException(`Already ${item.status}`);

    try {
      await this.send(item.sessionId, item.chatId, item.draftReply);
      const bot = this.botSettings();
      this.store.addAssistantMessage(item.sessionId, item.chatId, item.draftReply, bot.maxHistoryPerChat);
      if (item.kind === 'pattern' && item.patternId) {
        this.store.incrementPatternUsage(item.patternId);
      } else {
        this.store.learnPattern(item.originalMessage, item.draftReply, item.summary);
      }
      this.store.setApprovalStatus(id, 'approved');
      this.cooldown.set(`${item.sessionId}:${item.chatId}`);
      this.logger.log('AI reply sent & pattern learned', { id, chatId: item.chatId });
      return this.store.getApproval(id)!;
    } catch (err) {
      this.logger.warn('AI approval send failed', { id, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** Discard the draft without sending or learning. */
  async reject(id: string): Promise<AiApprovalItem> {
    const item = this.store.getApproval(id);
    if (!item) throw new NotFoundException('Approval not found');
    if (item.status !== 'pending') throw new ConflictException(`Already ${item.status}`);
    this.store.setApprovalStatus(id, 'rejected');
    this.logger.log('AI draft rejected', { id });
    return this.store.getApproval(id)!;
  }

  // ─── Read surfaces ─────────────────────────────────────────────────────────

  listApprovals(): AiApprovalItem[] {
    return this.store.listApprovals();
  }

  listPendingApprovals(): AiApprovalItem[] {
    return this.store.listPending();
  }

  listResolvedApprovals(): AiApprovalItem[] {
    return this.store.listResolved();
  }

  async listPatterns() {
    return this.store.listPatterns();
  }

  async deletePattern(patternId: string): Promise<boolean> {
    const patterns = this.store.listPatterns();
    const next = patterns.filter(p => p.id !== patternId);
    if (next.length === patterns.length) return false;
    this.store.deletePatterns(next);
    return true;
  }

  /** Status card for the dashboard: gate config + LLM reachability + queue shape. */
  async getStatus(): Promise<AiModuleStatus> {
    const approval = this.approvalSettings();
    const [reachable] = await Promise.all([this.llm.probeReachable()]);
    return {
      enabled: this.enabled(),
      approvalEnabled: approval.enabled,
      matchThreshold: approval.matchThreshold,
      llmReachable: reachable,
      llmModel: this.llm.getModelStatus().model,
      pendingApprovals: this.store.listPending().length,
      patternCount: this.store.listPatterns().length,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private resolveSender(message: Record<string, unknown>): string {
    const contact = (typeof message.contact === 'object' && message.contact !== null ? message.contact : {}) as {
      pushName?: string;
      name?: string;
    };
    return contact?.pushName || contact?.name || 'Unknown';
  }

  private isMentionedInGroup(message: Record<string, unknown>, text: string): boolean {
    const mentions = Array.isArray(message.mentionedIds) ? (message.mentionedIds as string[]) : [];
    const myNumber = typeof message.to === 'string' ? message.to : '';
    const mentioned = mentions.some(m => m.includes(myNumber));
    if (mentioned) return true;
    // Fallback: any @ mention present at all.
    return Boolean(text.includes('@') && mentions.length > 0);
  }

  private async sendReplyAndRecord(
    sessionId: string,
    chatId: string,
    originalMessage: string,
    reply: string,
    opts: { summary?: string; patternMatch?: { patternId: string; confidence: number } } = {},
  ): Promise<void> {
    try {
      await this.send(sessionId, chatId, reply);
      this.cooldown.set(`${sessionId}:${chatId}`);
      const bot = this.botSettings();
      this.store.addAssistantMessage(sessionId, chatId, reply, bot.maxHistoryPerChat);
      if (opts.patternMatch) {
        this.store.incrementPatternUsage(opts.patternMatch.patternId);
      } else {
        this.store.learnPattern(originalMessage, reply, opts.summary ?? '');
      }
      this.logger.log('AI auto-reply sent', { sessionId, chatId, patternMatch: Boolean(opts.patternMatch) });
    } catch (err) {
      this.logger.warn('AI auto-reply failed', { sessionId, chatId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async send(sessionId: string, chatId: string, text: string): Promise<void> {
    const messagePort = this.resolveMessagePort();
    if (!messagePort) throw new Error('MessageService is not resolvable; AI replies are disabled');
    await messagePort.sendText(sessionId, { chatId, text });
  }

  private resolveMessagePort(): PluginMessagePort | undefined {
    if (!this.messagePort) {
      try {
        // Resolved lazily, exactly like AutomationRulesService: a value-import of MessageService
        // here would close the module cycle, and by send time every module is loaded.
        this.messagePort = this.moduleRef?.get<typeof PLUGIN_MESSAGE_PORT, PluginMessagePort>(PLUGIN_MESSAGE_PORT, {
          strict: false,
        });
      } catch (error) {
        this.logger.warn('MessageService is not resolvable; AI replies are disabled', {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    }
    return this.messagePort;
  }
}