<p align="center">
  <img src="dashboard/public/logo.png" alt="WAA Logo" width="200"/>
</p>

<h1 align="center">WAA — WhatsApp Automation Bot</h1>
<p align="center">
  <strong>AI-Powered Auto-Reply System with Self-Training on Conversation History</strong>
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-ai-bot-setup">AI Bot</a> •
  <a href="#-how-it-works">How It Works</a>
</p>

---

## ✨ What is WAA?

**WAA (WhatsApp Automation)** is a self-hosted WhatsApp bot that automatically replies to messages using a local AI model (no paid APIs). It learns from your past conversations to improve reply accuracy over time.

### Key Capabilities

| Capability | Description |
|---|---|
| 🤖 **Auto-Reply** | Responds to incoming WhatsApp messages automatically using a local LLM |
| 🧠 **Self-Training** | Reads past conversation history to build context and improve reply quality |
| 👥 **Group Support** | Replies when @mentioned in group chats |
| 💬 **1-on-1 Chats** | Full conversation support in private chats |
| 📊 **Conversation Memory** | Saves chat history as JSON per contact for context-aware replies |
| 🔒 **Fully Local** | No API keys, no cloud LLMs — runs entirely on your machine |
| 🎛️ **Dashboard** | Web UI to manage sessions, view messages, and monitor the bot |

---

## 🏗️ Architecture

```
WhatsApp User
     │
     ▼
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Baileys   │────▶│  WAA Server  │────▶│  AI Bot (own │
│  (WhatsApp  │     │  (Port 2785) │     │  GGUF, in-   │
│  Connection)│     │              │     │  process LLM)│
└─────────────┘     └──────┬───────┘     └──────────────┘
                           │
                    ┌──────▼───────┐
                    │  AI Bot      │
                    │  (Port 3001) │
                    │              │
                    │  Webhook →   │
                    │  LLM → Reply │
                    │  Save History│
                    └──────────────┘
```

**Flow:**
1. WhatsApp message arrives → Baileys receives it
2. WAA webhook triggers the AI bot
3. Bot loads conversation history for that chat
4. Sends context + message to the local LLM (GGUF loaded in-process — no external server)
5. LLM generates reply → sent back via WAA API
6. Conversation saved to JSON for future context

---

## 🚀 Quick Start

### Prerequisites

- **Node.js 22+** ([download](https://nodejs.org))
- A **GGUF model file** (e.g. a DeepSeek-R1-Distill Q4/Q6 `.gguf` you downloaded)
- A **dedicated WhatsApp number** (not your personal number)

### Step 1: Install & Start WAA Server

```bash
cd OpenWA
npm ci
npm run start:prod
```

Dashboard available at: **http://localhost:2785**

### Step 2: Connect WhatsApp

1. Open the dashboard → **Sessions** page
2. Click **Create Session** → name it (e.g., `preet`)
3. Click the session → **Start**
4. Scan the QR code with WhatsApp on your phone
5. Wait for "Connected" status

### Step 3: Point the Bot at Your GGUF (no LM Studio)

The bot loads your `.gguf` **inside its own process** — no separate LLM server
to run or configure.

1. Download a model (e.g., **DeepSeek R1 Distill 1.5B GGUF** — runs on CPU)
2. Set its path in `config.json` (see below)
3. Check setup with `cd ai-bot && npm run setup` — it verifies the model file
   and everything else

### Step 4: Configure the AI Bot

```bash
cd ai-bot
npm install
```

Edit `config.json`:
```json
{
  "waa": {
    "host": "http://localhost:2785",
    "apiKey": "dev-admin-key",
    "sessionId": "<your-session-uuid>"
  },
  "llm": {
    "engine": "gguf",
    "modelPath": "C:/path/to/your/model.gguf",
    "contextSize": 2048,
    "stripReasoning": true,
    "systemPrompt": "You are a helpful WhatsApp assistant. Answer directly and concisely. Do NOT write out any reasoning, thinking, or chain-of-thought; just give the final answer in one or two short sentences. Reply in the same language the user writes in.",
    "maxTokens": 512,
    "temperature": 0.7
  },
  "bot": {
    "replyDelay": 1500,
    "ignoreFromMe": true,
    "ignoreGroups": false,
    "maxHistoryPerChat": 20,
    "cooldownSeconds": 5
  }
}
```

### Step 5: Start Everything (one command, one server)

```bash
npm run build:all     # build WAA server + dashboard (only needed once / after changes)
npm run start:prod    # ✨ boots WAA server + AI bot (with your GGUF) in ONE process
```

That's it. Both run inside a single server process:

| What | URL |
|---|---|
| WAA dashboard (sessions/QR) | http://localhost:2785 |
| Approval dashboard | http://localhost:3001/ |
| Bot health check | http://localhost:3001/health |

Ctrl+C stops both together. Still want them separate? `npm run start:server`
starts only the WAA server; then boot the bot from `ai-bot/` as before.

Send a message to your WhatsApp number — the bot drafts a reply!
Open **http://localhost:3001/** to **approve** drafts — every approved reply is
saved as a learned pattern that auto-replies next time.

> 💡 The approval API is protected by `X-Auth-Token`. Set a strong token in
> production via the `WAA_BOT_API_TOKEN` environment variable (see
> `ai-bot/README.md` → "Run in Production").

---

## 🧠 How Self-Training Works

WAA doesn't train a model — it **builds context from your past conversations** to give the LLM better inputs:

### Conversation History

Every chat gets its own JSON file in `ai-bot/conversations/`:

```json
{
  "chatId": "917439163739@c.us",
  "history": [
    { "role": "user", "content": "What are your timings?" },
    { "role": "assistant", "content": "We're open 9 AM to 6 PM, Monday to Saturday." },
    { "role": "user", "content": "Do you offer delivery?" },
    { "role": "assistant", "content": "Yes! Free delivery on orders above ₹500." }
  ],
  "lastUpdated": "2026-09-21T10:30:00Z"
}
```

### Context Window

When a new message arrives:
1. Bot loads the last **N messages** (configurable via `maxHistoryPerChat`)
2. These are sent as conversation context to the LLM
3. The LLM generates a reply that's aware of the full conversation
4. New message + reply are appended to the history

### Improving Accuracy Over Time

| Method | How It Helps |
|---|---|
| **More conversation data** | The LLM gets better context as history grows |
| **Custom system prompt** | Tailor the bot's personality and knowledge |
| **Larger models** | Swap to bigger GGUF models as your hardware allows |
| **Few-shot examples** | Add example Q&A pairs to the system prompt |

### Group Chat Behavior

- Bot only responds when **@mentioned** in groups (configurable)
- Private chats get automatic replies
- Group context is maintained per-group chat ID

---

## 📁 Project Structure

```
OpenWA/
├── src/                    # WAA server (NestJS)
├── dashboard/              # React web dashboard
├── ai-bot/                 # AI auto-reply bot
│   ├── bot.js              # Main bot script
│   ├── config.json         # Bot configuration
│   ├── setup.js            # Pre-flight checks
│   ├── test-llm.js         # Quick LLM test
│   └── conversations/      # Per-chat history (auto-created)
├── data/                   # SQLite database
├── docs/                   # Documentation
├── .env                    # Server configuration
├── package.json            # Server dependencies
└── README.md               # This file
```

---

## ⚙️ Configuration

### Environment Variables (`.env`)

| Variable | Default | Description |
|---|---|---|
| `ENGINE_TYPE` | `baileys` | WhatsApp connection engine |
| `PORT` | `2785` | Server port |
| `DB_ENGINE` | `sqlite` | Database engine (`sqlite` or `postgres`) |
| `CSP_UPGRADE_INSECURE_REQUESTS` | `false` | Set to `false` for local dev |

### Bot Configuration (`ai-bot/config.json`)

| Key | Description |
|---|---|
| `waa.host` | WAA server URL |
| `waa.apiKey` | API authentication key |
| `waa.sessionId` | WhatsApp session UUID |
| `llm.engine` | `gguf` (in-process) or `http` (external server) |
| `llm.modelPath` | Path to your `.gguf` (engine `gguf`) |
| `llm.host` | LLM server URL (engine `http` only) |
| `llm.model` | Model name (engine `http` only) |
| `llm.systemPrompt` | Bot personality/instructions |
| `bot.maxHistoryPerChat` | Messages to keep for context |
| `bot.cooldownSeconds` | Min seconds between replies per chat |

---

## 🛡️ Safety Notes

- **Use a dedicated number** — not your personal WhatsApp
- **Rate limiting** is built in — don't blast messages
- **Local only** — the LLM runs on your machine, no data leaves
- **Conversation data** stays in `ai-bot/conversations/` on your disk

---

## 📄 License

MIT License — free for personal and commercial use.

---

<div align="center">

**WAA** — WhatsApp Automation Bot

Made with ❤️ for automated conversations

</div>
