# WAA AI Bot — Local LLM + Approval-Based Learning

Fully automated WhatsApp AI bot driven by a local LLM (no API keys). The bot
watches chats, drafts replies, and waits for **your approval** before sending.
Every approved reply becomes a **learned pattern** that auto-replies the next
time someone says something similar — no approval needed.

## Architecture

```
WhatsApp User → WAA Server → Webhook → AI Bot → Local LLM (GGUF) → Draft
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

## Setup (no LM Studio required)

The bot loads your `.gguf` **in-process** via `node-llama-cpp` — there is no
separate LLM server to run. One command starts everything.

### 1. Install the model runtime

```bash
cd ai-bot
npm install          # installs node-llama-cpp (downloads llama.cpp binaries)
```

### 2. Point the bot at your GGUF file

Edit `config.json`:

```json
"llm": {
  "engine": "gguf",
  "modelPath": "C:/path/to/your/model.gguf",
  "contextSize": 2048,
  "stripReasoning": true,
  "maxTokens": 512
}
```

- `engine: "gguf"` → run the model directly inside the bot process (default)
- `engine: "http"` → talk to any OpenAI-compatible server (`llm.host`/`llm.model`,
  e.g. LM Studio or llama-server)
- `modelPath` can also be set with `WAA_LLM_MODEL_PATH`; if left empty, the bot
  auto-discovers the largest `.gguf` in `models/`, your Downloads folder, etc.

> **R1-style models** (like DeepSeek-R1-Distill): they "think" for many tokens
> before answering. The bot strips the reasoning block automatically and the
> system prompt tells the model to answer directly. `stripReasoning: true`
> keeps only the final answer.

### 3. Run

```bash
npm install   # (no deps, but keeps things tidy)
npm start     # dev (single process)
```

Open the dashboard at **http://localhost:3001/** to approve drafts.
The dashboard will ask for the API token (see `server.apiToken` below).

## Run in Production

```bash
cd ai-bot
npm run start:prod     # supervisor: auto-restarts bot.js on crash
# or, for richer process management:
npx pm2 start ecosystem.config.js && npx pm2 save
```

Health check: `npm run health` → hits `GET /health` and exits non-zero when degraded.

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
   `WAA_LLM_MODEL_PATH`, `WAA_LLM_HOST`, `WAA_LLM_MODEL`.
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
├── patterns.json           # Learned templates (auto-created)
├── approvals.json          # Approval queue (auto-created)
├── conversations/          # Per-chat history (auto-created)
├── bot.log                 # Runtime log (auto-created, rotated)
└── src/
    ├── config.js           # Load + validate config, env overrides, path constants
    ├── logger.js           # Leveled logging (console + file, rotation)
    ├── utils.js            # sleep, atomic JSON writes, retry w/ backoff
    ├── matcher.js          # Keyword extraction + Jaccard similarity
    ├── guards.js           # Cooldown + dedup trackers
    ├── llm.js              # LLM client: in-process GGUF (node-llama-cpp) or HTTP
    ├── waa.js              # WAA server client (timeouts + retries, webhook state)
    ├── health.js           # Dependency health report
    ├── processor.js        # Incoming-message pipeline
    ├── actions.js          # Approve / reject resolution
    ├── server.js           # HTTP routes (auth, webhook, API, dashboard)
    ├── dashboard.html      # Approval dashboard UI (token-prompting)
    └── store/
        ├── conversations.js  # History persistence
        ├── patterns.js       # Pattern persistence + learning
        └── approvals.js      # Approval queue persistence
```

## Dashboard API (localhost:3001)

| Method | Path | Description |
|---|---|---|
| GET | `/` or `/dashboard` | Approval dashboard |
| GET | `/health` | Health check |
| GET | `/api/approvals` | List all approvals |
| GET | `/api/patterns` | List learned patterns |
| POST | `/api/approvals/:id/approve` | Send draft + learn pattern |
| POST | `/api/approvals/:id/reject` | Discard draft |
| POST | `/webhook` | WAA webhook receiver |

## Config Options

| Setting | Default | Description |
|---------|---------|-------------|
| `waa.host` | `http://localhost:2785` | WAA server URL |
| `waa.apiKey` | `dev-admin-key` | Your API key |
| `waa.sessionId` | *(yours)* | WhatsApp session ID |
| `llm.engine` | `gguf` | `gguf` = run the model in-process; `http` = OpenAI-compatible server |
| `llm.host` | `http://localhost:1234` | LLM server URL (engine `http` only) |
| `llm.model` | *(set it)* | Model name (engine `http`; display label for `gguf`) |
| `llm.modelPath` | *(auto-discovered)* | Path to your `.gguf` file (engine `gguf`) |
| `llm.contextSize` | `2048` | Context window for the in-process model |
| `llm.stripReasoning` | `true` | Strip R1-style thinking blocks from replies |
| `llm.systemPrompt` | built-in | System prompt for the AI |
| `llm.maxTokens` | `512` | Max response length |
| `llm.temperature` | `0.7` | Response creativity (0-1) |
| `llm.timeoutSeconds` | `120` | LLM request timeout (LLMs can be slow on CPU) |
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