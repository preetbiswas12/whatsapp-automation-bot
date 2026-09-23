# WAA AI Bot — kilo.ai LLM + Approval-Based Learning

Fully automated WhatsApp AI bot powered by the **kilo.ai Gateway** (OpenAI-compatible
cloud API, `kilo-auto/free` model = $0). The bot watches chats, drafts replies,
and waits for **your approval** before sending. Every approved reply becomes a
**learned pattern** that auto-replies the next time someone says something
similar — no approval needed.

## Architecture

```
WhatsApp User → WAA Server → Webhook → AI Bot → kilo.ai Gateway (free model) → Draft
                                              │
                                              ▼
                                    Needs approval?
                                        │
                          ┌─────────────┴─────────────┐
                          │ enabled: true             │ enabled: false
                          ▼                           ▼
              Approval Dashboard (3001)        Send + learn instantly
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
         ✓ Approve               ✗ Reject
          Send reply               Discard
          Learn pattern
```

## Setup (no LM Studio, no local model)

The bot calls the **kilo.ai Gateway** (`https://api.kilo.ai/api/gateway`) — an
OpenAI-compatible cloud API — so nothing heavy runs on your machine. Engine
`http` is the default; a local in-process GGUF is still supported as an
alternative (`engine: "gguf"` via node-llama-cpp).

### 1. Install

```bash
cd ai-bot
npm install          # installs deps (no llama binaries needed for engine=http)
```

### 2. Add your kilo.ai API key (gitignored — never committed)

Your key goes in **`ai-bot/config.local.json`** (already in `.gitignore`, so it
can't be pushed to GitHub):

```json
{
  "llm": {
    "apiKey": "your-kilo-api-key"
  }
}
```

Alternatively set the `WAA_LLM_API_KEY` environment variable.

### 3. Confirm the LLM config (`config.json` already ships set up)

```json
"llm": {
  "engine": "http",
  "host": "https://api.kilo.ai/api/gateway",
  "model": "kilo-auto/free",
  "apiKey": "",
  "completionsPath": "/chat/completions",
  "modelsPath": "/models",
  "maxTokens": 512
}
```

- `model: "kilo-auto/free"` → kilo's free auto-routed model ($0 prompt/completion)
- Other kilo models: `anthropic/claude-sonnet-4.5`, `openai/gpt-4o-mini`,
  `google/gemini-2.0-flash`, `mistralai/mistral-small-latest`, …
  (full list: `GET https://api.kilo.ai/api/gateway/models`)
- `engine: "gguf"` → fall back to a local `.gguf` (set `modelPath`; auto-discovers
  the largest `.gguf` in `models/`, Downloads, etc.)

> **R1-style models** (like DeepSeek-R1-Distill): they "think" for many tokens
> before answering. The bot strips the reasoning block automatically and the
> system prompt tells the model to answer directly. `stripReasoning: true`
> keeps only the final answer.

### 3. Run

```bash
npm install   # (no deps, but keeps things tidy)
npm start     # dev (single process)
```

Open the **single dashboard** at **http://localhost:3001/** — it combines the
WhatsApp connection panel (create a session, scan the QR, see status) with the
approval center (approve/reject AI drafts). No token prompt: the bot injects
the API token into the page itself.

## Run in Production

```bash
cd ai-bot
npm run start:prod     # supervisor: auto-restarts bot.js on crash
# or, for richer process management:
npx pm2 start ecosystem.config.js && npx pm2 save
```

> **One-command option:** from the repo root (`OpenWA`), `npm run start:prod`
> boots the **WAA server + this bot inside a single process** (see `run-all.js`).
> Use that if you want everything to start and stop together.

Health check: `npm run health` → hits `GET /health` and exits non-zero when degraded.

### Check & test (three commands)

With the stack running (`npm run start:prod` at the repo root), from `ai-bot/`:

```bash
npm run setup       # config valid? kilo.ai reachable? WAA reachable? API key works?
npm run test-llm    # sends one prompt through kilo.ai, prints reply + seconds
npm run test:e2e    # 12 automated checks: auth, health, webhook→draft,
                    # approve-guard, reject, patterns, dashboard (no phone needed)
```

- `test:e2e` simulates an incoming WhatsApp message through the real webhook,
  waits for the **actual AI draft**, verifies approval is refused while
  WhatsApp isn't linked (nothing is learned on a failed send), then verifies
  reject persists. It cleans up after itself.
- `test-llm` and `test:e2e` respect `WAA_LLM_API_KEY` / `WAA_BOT_API_TOKEN` /
  `WAA_BOT_PORT` env vars if you've overridden config.

### Production checklist

1. **Set a real API token** — the dashboard and `/api/*` endpoints require
   `X-Auth-Token`. Never leave the default token in production:
   ```bash
   # Windows
   setx WAA_BOT_API_TOKEN "your-strong-token"
   # Linux / macOS / WSL
   export WAA_BOT_API_TOKEN="your-strong-token"
   ```
   Env vars override `config.json` for: `WAA_BOT_API_TOKEN`, `WAA_BOT_PORT`,
   `WAA_BOT_LOG_LEVEL`, `WAA_BOT_LOG_FILE`, `WAA_HOST`, `WAA_LLM_ENGINE`,
   `WAA_LLM_MODEL_PATH`, `WAA_LLM_HOST`, `WAA_LLM_MODEL`, `WAA_LLM_API_KEY`,
   `WAA_LLM_COMPLETIONS_PATH`, `WAA_LLM_MODELS_PATH`.
2. **Keep it alive** — `npm run start:prod` (built-in supervisor) or PM2.
3. **Watch the health endpoint** — `GET /health` returns:
   - `200 ok` — WAA reachable, LLM reachable, webhook registered
   - `503 degraded` — one of the above failed (details in `checks`)
4. **Logs** — leveled logging (info/warn/error/debug) to console **and**
   `bot.log` (rotated at 5 MB, kept as `bot.log.old`). Set `WAA_BOT_LOG_LEVEL`.
5. **Config validation** — boot fails fast with a clear message if
   `waa.*`, `llm.model`, or the API token are missing/misconfigured.

### Resilience built in

| Concern | Mitigation |
|---|---|
| Crashes | Supervisor (`run.js`) restarts with backoff; PM2 option included |
| HTTP hangs | Timeouts on all WAA & LLM calls |
| Transient failures | Exponential-backoff retries on 5xx/429/network errors |
| Corrupted JSON stores | Atomic writes (temp file + rename) in all stores |
| WAA down at boot | Webhook registration self-heals every `refreshSeconds` (300s) |
| Duplicate webhooks | Idempotency dedup + per-chat cooldown |
| Unauthorized API access | `X-Auth-Token` required on all `/api/*` routes (timing-safe compare) |
| Unhandled errors | Global rejection/exception handlers log before exit |

## Behaviors

| Behavior | How it works |
|---|---|
| Learned-pattern auto-reply | Message keywords vs stored patterns (Jaccard similarity). ≥60% match → instant auto-send |
| Human approval | No pattern match → AI drafts a reply + chat summary → queued until you approve/reject |
| Learning | Every approval stores the message + reply as a reusable pattern |
| Fully automatic mode | Set `approval.enabled` to `false` → drafts are sent & learned with no human input |
| Group @mentions | Only replies in groups when the bot is mentioned |
| Conversation memory | Per-chat history in `conversations/` feeds the AI for better drafts |
| Anti-spam | 5s cooldown per chat + idempotency dedup on webhook payloads |

## File Structure

```
ai-bot/
├── bot.js                  # Entry point (thin wiring, graceful shutdown)
├── run.js                  # Process supervisor (auto-restart on crash)
├── ecosystem.config.js     # PM2 production config
├── config.json             # Configuration
├── setup.js                # Connection checker
├── test-llm.js             # LLM smoke test
├── test-e2e.js             # End-to-end check (12 checks, no phone needed)
├── patterns.json           # Learned templates (auto-created)
├── approvals.json          # Approval queue (auto-created)
├── conversations/          # Per-chat history (auto-created)
├── bot.log                 # Runtime log (auto-created, rotated)
├── src/
│   ├── config.js           # Load + validate config, env overrides, path constants
│   ├── logger.js           # Leveled logging (console + file, rotation)
│   ├── utils.js            # sleep, atomic JSON writes, retry w/ backoff
│   ├── matcher.js          # Keyword extraction + Jaccard similarity
│   ├── guards.js           # Cooldown + dedup trackers
│   ├── llm.js              # LLM client: kilo.ai HTTP (OpenAI-compatible) or in-process GGUF
│   ├── waa.js              # WAA client (timeouts/retries, session auto-discovery, webhook state)
│   ├── health.js           # Dependency health report
│   ├── processor.js        # Incoming-message pipeline
│   ├── actions.js          # Approve / reject resolution
│   ├── server.js           # HTTP routes (auth, webhook, API, WAA proxy, dashboard)
│   ├── dashboard.html      # Merged dashboard UI (WhatsApp connect + approvals)
    └── store/
        ├── conversations.js  # History persistence
        ├── patterns.js       # Pattern persistence + learning
        └── approvals.js      # Approval queue persistence
```

## Dashboard API (localhost:3001)

| Method | Path | Description |
|---|---|---|
| GET | `/` or `/dashboard` | Merged dashboard (WhatsApp connect + approvals) |
| GET | `/health` | Health check |
| GET | `/api/approvals` | List all approvals |
| GET | `/api/patterns` | List learned patterns |
| POST | `/api/approvals/:id/approve` | Send draft + learn pattern |
| POST | `/api/approvals/:id/reject` | Discard draft |
| POST | `/api/resync` | (Re-)register the webhook for the active session |
| ANY | `/api/waa/*` | WAA proxy (sessions, QR, start/stop/logout) — key stays server-side |
| POST | `/webhook` | WAA webhook receiver |

## Config Options

| Setting | Default | Description |
|---------|---------|-------------|
| `waa.host` | `http://localhost:2785` | WAA server URL |
| `waa.apiKey` | `dev-admin-key` | Your API key |
| `waa.sessionId` | `""` (auto) | Optional pin; when empty the bot adopts whatever session is connected |
| `llm.engine` | `http` | `http` = kilo.ai / OpenAI-compatible API; `gguf` = in-process local model |
| `llm.host` | `https://api.kilo.ai/api/gateway` | LLM API base URL (engine `http`) |
| `llm.model` | `kilo-auto/free` | Model ID for the API (engine `http`; display label for `gguf`) |
| `llm.apiKey` | *(from `config.local.json`)* | Bearer token — set in `config.local.json` or `WAA_LLM_API_KEY`, never in `config.json` |
| `llm.completionsPath` | `/chat/completions` | Chat-completions endpoint suffix (engine `http`) |
| `llm.modelsPath` | `/models` | Health-check model-list endpoint suffix (engine `http`) |
| `llm.modelPath` | *(auto-discovered)* | Path to your `.gguf` file (engine `gguf`) |
| `llm.contextSize` | `8192` | Context window for the in-process model (~470MB KV cache on 6GB RAM) |
| `llm.stripReasoning` | `true` | Strip R1-style thinking blocks from replies |
| `llm.systemPrompt` | built-in | System prompt for the AI |
| `llm.maxTokens` | `512` | Max response length |
| `llm.temperature` | `0.7` | Response creativity (0-1) |
| `llm.timeoutSeconds` | `120` | LLM request timeout (kilo.ai / slow models) |
| `llm.maxRetries` | `3` | Retries for LLM 5xx/429/network errors |
| `webhook.refreshSeconds` | `300` | Self-healing re-registration interval |
| `bot.replyDelay` | `1500` | Typing delay in ms |
| `bot.cooldownSeconds` | `5` | Min seconds between replies per chat |
| `bot.ignoreGroups` | `false` | Skip group messages entirely |
| `bot.replyInGroupsOnlyWhenMentioned` | `true` | Groups: only reply when @mentioned |
| `bot.maxHistoryPerChat` | `20` | Messages of context to remember |
| `approval.enabled` | `true` | `false` = fully automatic mode |
| `approval.matchThreshold` | `0.6` | Min confidence to auto-send a pattern |
| `approval.maxPending` | `50` | Max queued drafts (oldest expire) |
| `server.apiToken` | `waa-bot-local-admin` | `X-Auth-Token` for dashboard & API (**use `WAA_BOT_API_TOKEN` env in prod**) |
| `server.logLevel` | `info` | `debug`, `info`, `warn`, or `error` |
| `server.logFile` | `bot.log` | Log file path (`""` = use default) |
| `server.timeoutSeconds` | `30` | WAA API request timeout |

## Conversation History

Each chat gets its own JSON file in `conversations/`. You can edit these files
to pre-load context for specific contacts or reset a conversation by deleting
its file.