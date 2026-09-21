<p align="center">
  <img src="docs/logo/openwa_logo.webp" alt="WAA Logo" width="200"/>
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
│   Baileys   │────▶│  WAA Server  │────▶│  LM Studio   │
│  (WhatsApp  │     │  (Port 2785) │     │  (Port 1234) │
│  Connection)│     │              │     │  Local LLM   │
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
4. Sends context + message to local LLM (LM Studio)
5. LLM generates reply → sent back via WAA API
6. Conversation saved to JSON for future context

---

## 🚀 Quick Start

### Prerequisites

- **Node.js 22+** ([download](https://nodejs.org))
- **LM Studio** ([download](https://lmstudio.ai)) — for running the local AI model
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

### Step 3: Set Up LM Studio

1. Install LM Studio from https://lmstudio.ai
2. Download a model (e.g., **DeepSeek R1 2B GGUF** — fast, lightweight)
3. Load the model → start the local server on **port 1234**
4. Verify: open `http://localhost:1234/v1/models` in browser

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
    "host": "http://localhost:1234",
    "model": "<model-name-from-lm-studio>",
    "systemPrompt": "You are a helpful WhatsApp assistant. Be concise and friendly.",
    "maxTokens": 1024,
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

### Step 5: Start the Bot

```bash
npm start
```

Send a message to your WhatsApp number — the bot will reply automatically!

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
| `llm.host` | LM Studio API URL |
| `llm.model` | Model name (from LM Studio) |
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
