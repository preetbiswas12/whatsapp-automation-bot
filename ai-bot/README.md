# WAA AI Bot — Local LLM + Approval-Based Learning

Fully automated WhatsApp AI bot driven by a local LLM (no API keys). The bot
watches chats, drafts replies, and waits for **your approval** before sending.
Every approved reply becomes a **learned pattern** that auto-replies the next
time someone says something similar — no approval needed.

## Architecture

```
WhatsApp User → WAA Server → Webhook → AI Bot → LM Studio (local GGUF) → Draft
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

## Setup (3 steps)

### 1. Install LM Studio
Download from https://lmstudio.ai (free).

### 2. Load your GGUF model
1. Open LM Studio
2. Click "My Models" → drag & drop your `.gguf` file
3. Click **Start Server** (bottom left)
4. Note the port (default: 1234)
5. In the server tab, copy the model name shown

### 3. Configure the bot
Edit `config.json` and set `llm.model` to the model name from LM Studio.

## Run

```bash
cd ai-bot
npm install   # (no deps, but keeps things tidy)
npm start
```

Open the dashboard at **http://localhost:3001/** to approve drafts.

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
├── bot.js                  # Entry point (thin wiring)
├── config.json             # Configuration
├── setup.js                # Connection checker
├── test-llm.js             # LLM smoke test
├── patterns.json           # Learned templates (auto-created)
├── approvals.json          # Approval queue (auto-created)
├── conversations/          # Per-chat history (auto-created)
└── src/
    ├── config.js           # Load + validate config, path constants
    ├── logger.js           # Timestamped console logging
    ├── utils.js            # sleep, safe JSON read
    ├── matcher.js          # Keyword extraction + Jaccard similarity
    ├── guards.js           # Cooldown + dedup trackers
    ├── llm.js              # LM Studio client (drafts, summaries)
    ├── waa.js              # WAA server client (send, webhooks)
    ├── processor.js        # Incoming-message pipeline
    ├── actions.js          # Approve / reject resolution
    ├── server.js           # HTTP routes (webhook, API, dashboard)
    ├── dashboard.html      # Approval dashboard UI
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
| `llm.host` | `http://localhost:1234` | LM Studio URL |
| `llm.model` | *(set it)* | Model name (must match LM Studio) |
| `llm.systemPrompt` | built-in | System prompt for the AI |
| `llm.maxTokens` | `1024` | Max response length |
| `llm.temperature` | `0.7` | Response creativity (0-1) |
| `bot.replyDelay` | `1500` | Typing delay in ms |
| `bot.cooldownSeconds` | `5` | Min seconds between replies per chat |
| `bot.ignoreGroups` | `false` | Skip group messages entirely |
| `bot.replyInGroupsOnlyWhenMentioned` | `true` | Groups: only reply when @mentioned |
| `bot.maxHistoryPerChat` | `20` | Messages of context to remember |
| `approval.enabled` | `true` | `false` = fully automatic mode |
| `approval.matchThreshold` | `0.6` | Min confidence to auto-send a pattern |
| `approval.maxPending` | `50` | Max queued drafts (oldest expire) |

## Conversation History

Each chat gets its own JSON file in `conversations/`. You can edit these files
to pre-load context for specific contacts or reset a conversation by deleting
its file.