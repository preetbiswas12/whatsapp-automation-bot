import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';

/**
 * LLM client for the AI module — the HTTP engine of the former standalone ai-bot,
 * ported into the OpenWA process. Talks to an OpenAI-compatible chat/completions API
 * (default: kilo.ai's `kilo-auto/free` gateway).
 *
 * The GGUF engine is deliberately not ported: OpenWA has no in-process model runtime,
 * and all our sessions use the cloud API. `wapp\ai.gguf` (outside this repo) remains
 * untouched as a local fallback for bare-metal runs, but nothing here loads it.
 */

export interface AiLlmSettings {
  host: string;
  model: string;
  apiKey: string;
  completionsPath: string;
  modelsPath: string;
  maxTokens: number;
  temperature: number;
  timeoutSeconds: number;
  maxRetries: number;
  stripReasoning: boolean;
  systemPrompt: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelStatus {
  engine: 'http';
  reachable: boolean;
  error: string | null;
  model: string;
  host: string;
  lastInferenceMs: number | null;
  lastErrorAt: string | null;
}

export class LlmError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Retry an async operation with exponential backoff + jitter (ported from ai-bot utils). */
async function retry<T>(fn: () => Promise<T>, opts: { attempts: number; baseMs: number; shouldRetry: (err: unknown) => boolean }): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= opts.attempts || !opts.shouldRetry(err)) throw err;
      await sleep(Math.min(8000, opts.baseMs * 2 ** (attempt - 1)) + Math.random() * 200);
    }
  }
  throw lastErr;
}

// Strip R1-style reasoning so the sent reply is only the answer. Handles the formats R1-distill
// models actually emit: `<thinking>...</thinking>` tags, and `### Reasoning: ... ### Answer: ...`.
export function stripReasoning(output: string): string {
  let out = String(output);
  out = out.replace(
    /<\|?(?:begin_of_think|thinking|think|reasoning)\|?>[\s\S]*?<\|?(?:end_of_think|thinking|think|reasoning)\|?>/gi,
    '',
  );
  const answerSection = out.match(/^#{0,3}\s*(?:final\s+)?answer\s*:[\s\S]*$/im);
  if (answerSection) return answerSection[0].trim();
  return out.trim();
}

@Injectable()
export class AiLlmService {
  private readonly logger = createLogger('AiLlmService');

  // Serializes every LLM call FIFO: the shared cloud gateway and its token budget behave like a
  // stateful session — one call at a time avoids 429 bursts on the free tier. Same pattern (and
  // rationale) as the standalone bot's withLlmLock.
  private llmQueue: Promise<void> = Promise.resolve();

  // Cheap in-memory probe cache: /models is called once per dashboard status poll, and kilo's free
  // tier should not be hammered by page refreshes.
  private reachableCache: { ok: boolean; at: number; error: string | null } | null = null;

  constructor(private readonly configService: ConfigService) {}

  private settings(): AiLlmSettings {
    return this.configService.get<AiLlmSettings>('ai.llm')!;
  }

  getModelStatus(): ModelStatus {
    const s = this.settings();
    return {
      engine: 'http',
      reachable: this.reachableCache?.ok ?? false,
      error: this.reachableCache?.ok ? null : (this.reachableCache?.error ?? null),
      model: s.model,
      host: s.host,
      lastInferenceMs: null,
      lastErrorAt: null,
    };
  }

  withLlmLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.llmQueue.then(fn, fn);
    this.llmQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private postProcess(output: string): string {
    let out = String(output).trim();
    if (this.settings().stripReasoning) out = stripReasoning(out);
    return out;
  }

  private async chatHttp(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {}): Promise<string> {
    const s = this.settings();
    const body = JSON.stringify({
      model: s.model,
      messages,
      max_tokens: opts.maxTokens ?? s.maxTokens,
      temperature: opts.temperature ?? s.temperature,
      stream: false,
    });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;

    return retry(
      async () => {
        try {
          const res = await fetchWithTimeout(
            `${s.host}${s.completionsPath}`,
            { method: 'POST', headers, body },
            (opts.timeoutMs ?? s.timeoutSeconds * 1000) || 60_000,
          );
          if (!res.ok) {
            const errText = await res.text();
            throw new LlmError(res.status, `LLM API error ${res.status}: ${errText.slice(0, 300)}`);
          }
          const data = await res.json();
          const reply = data.choices?.[0]?.message?.content?.trim();
          if (!reply) throw new LlmError(0, 'LLM returned empty response');
          return this.postProcess(reply);
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw new LlmError(0, 'LLM request timed out');
          throw err;
        }
      },
      {
        attempts: s.maxRetries,
        baseMs: 1000,
        shouldRetry: (err: unknown) => {
          if (err instanceof LlmError) return err.status >= 500 || err.status === 429 || err.status === 0;
          return true;
        },
      },
    );
  }

  /** Serialized public call. Kept private-ish: teammates use the {generate,summarize} methods below. */
  chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<string> {
    return this.withLlmLock(() => this.chatHttp(messages, opts));
  }

  /** Best-effort reachability probe of the gateway's /models endpoint; cached 60s. */
  async probeReachable(): Promise<boolean> {
    const s = this.settings();
    if (!s.apiKey) {
      this.reachableCache = { ok: false, at: Date.now(), error: 'AI_LLM_API_KEY is not configured' };
      return false;
    }
    if (this.reachableCache && Date.now() - this.reachableCache.at < 60_000) {
      return this.reachableCache.ok;
    }
    try {
      const res = await fetchWithTimeout(
        `${s.host}${s.modelsPath}`,
        { method: 'GET', headers: { Authorization: `Bearer ${s.apiKey}` } },
        10_000,
      );
      const ok = res.ok;
      this.reachableCache = { ok, at: Date.now(), error: ok ? null : `HTTP ${res.status}` };
      return ok;
    } catch (err) {
      this.reachableCache = {
        ok: false,
        at: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      };
      return false;
    }
  }

  /** Model name behind the gateway (from the settings, not the API — avoids an extra call). */
  get model(): string {
    return this.settings().model;
  }

  // ─── Generation helpers (ported from ai-bot llm.js) ─────────────────────────

  async generateDraft(history: ChatMessage[], userMessage: string): Promise<string> {
    const s = this.settings();
    const messages: ChatMessage[] = [{ role: 'system', content: s.systemPrompt }, ...history, { role: 'user', content: userMessage }];

    let draft = await this.chat(messages);

    // R1-style models occasionally burn their whole token budget "thinking" and return nothing.
    // Retry once with a direct-answer nudge.
    if (!draft || !draft.trim()) {
      this.logger.warn('LLM', 'Empty draft generated — retrying with a direct-answer nudge');
      const nudged: ChatMessage[] = [
        ...messages.slice(0, -1),
        {
          role: 'user',
          content: `${userMessage}\n\nPlease respond NOW with a short, direct answer. No analysis, no reasoning, no thinking.`,
        },
      ];
      draft = await this.chat(nudged, { maxTokens: Math.min(s.maxTokens * 1.5, 768) });
    }

    if (!draft || !draft.trim()) {
      this.logger.warn('LLM', 'Draft still empty after retry — using fallback reply');
      draft = FALLBACK_REPLY;
    }

    const trimmed = draft.trim();
    this.logger.debug('LLM', `Draft generated (${trimmed.length} chars)`);
    return trimmed;
  }

  async generateChatSummary(history: ChatMessage[]): Promise<string> {
    if (history.length < 4) return '';
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Summarize this conversation in 1-2 sentences. Be factual and brief.' },
        ...history.slice(-20),
      ];
      return await this.chat(messages, { maxTokens: 150, temperature: 0.3 });
    } catch (err) {
      this.logger.warn('LLM', `Chat summary failed: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }

  async generateMessageSummary(userMessage: string): Promise<string> {
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Summarize what this person is asking in one short sentence.' },
        { role: 'user', content: userMessage },
      ];
      return await this.chat(messages, { maxTokens: 100, temperature: 0.3 });
    } catch (err) {
      this.logger.warn('LLM', `Message summary failed: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }
}

const FALLBACK_REPLY = 'Sorry, I didn\u2019t quite catch that. Could you rephrase it?';