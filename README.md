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
  <a href="#-ai-assistant">AI Assistant</a> •
  <a href="#-how-it-works">How It Works</a>
</p>

---

## ✨ What is WAA?

**WAA (WhatsApp Automation)** is a self-hosted WhatsApp bot that automatically drafts replies to messages using a cloud LLM (kilo.ai). It learns from your past conversations to improve reply accuracy over time — and with the approval gate on (the default), nothing is ever sent without a human pressing **Approve** in the dashboard.

### Key Capabilities

| Capability | Description |
|---|---|
| 🤖 **Auto-Reply** | Drafts replies to incoming WhatsApp messages via a cloud LLM |
| 🧠 **Self-Training** | Reads past conversation history to build context and improve reply quality |
| ✅ **Human Approval** | Every draft waits in the approvals queue until an operator approves it (default on) |
| 👥 **Group Support** | Replies when @mentioned in group chats |
| 💬 **1-on-1 Chats** | Full conversation support in private chats |
| 📊 **Conversation Memory** | Saves chat history as JSON per contact for context-aware replies |
| 🎛️ **Single Dashboard** | One web UI to manage sessions, review/approve AI drafts, and monitor the bot |

---

## 🏗️ Architecture

```
WhatsApp User
     │
     ▼
┌─────────────┐     ┌──────────────────────────────────────────┐
│   Baileys   │────▶│  OpenWA (Port 2785, one process)         │
│  (WhatsApp  │     │  ┌────────────────────────────────────┐  │
│  Connection)│     │  │ NestJS server + dashboard          │  │
└─────────────┘     │  │ AI assistant (kilo.ai cloud LLM)   │  │
                    │  │ Approval queue (human-in-the-loop) │  │
                    │  └────────────────────────────────────┘  │
                    └──────────────────────────────────────────┘
```

**Flow:**
1. WhatsApp message arrives → Baileys receives it
2. The AI assistant checks learned patterns, then sends context + message to the cloud LLM (kilo.ai)
3. LLM generates a draft reply
4. The draft lands in the **approvals queue** — nothing is sent until an operator approves it from the dashboard
5. Approved replies are saved as learned patterns for future context

---

## 🚀 Quick Start

### Prerequisites

- **Node.js 22+** ([download](https://nodejs.org))
- A **kilo.ai API key (JWT)** — set it as `AI_LLM_API_KEY` in `.env` (see [Configuration](#-configuration))
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

### Step 3: Configure the AI Assistant

The assistant is built into OpenWA — no separate bot process or local model server.
Information is set in `.env` (see [Configuration](#-configuration)); the essentials:

```bash
# .env — AI assistant (kilo.ai cloud LLM + human-in-the-loop approval)
AI_ENABLED=true              # master switch
AI_APPROVAL_ENABLED=true     # require a human Approve before ANY reply is sent (default)
AI_LLM_API_KEY=              # kilo.ai JWT bearer token (SECRET — never commit; .env only)
```

While `AI_APPROVAL_ENABLED=true`, every AI reply — even a learned-pattern match — waits in
the approvals queue until you click **Approve** on the dashboard.

### Step 4: Start Everything (one command, one server)

```bash
npm run build:all     # build WAA server + dashboard (only needed once / after changes)
npm run start:prod    # ✨ boots OpenWA in ONE process
```

That's it. One server, one dashboard:

| What | URL |
|---|---|
| OpenWA dashboard (sessions/QR, AI approvals) | http://localhost:2785 |

Ctrl+C stops everything. Send a message to your WhatsApp number — the assistant drafts a
reply! Open the **AI** page (or **http://localhost:2785/api/ai/approvals**) to **approve**
drafts — every approved reply is saved as a learned pattern that auto-replies next time.

> 🔒 The approval API is protected: all `/api/ai/*` routes require an **operator** API key
> (see `x-api-key` / API Keys in the dashboard).

---

## 🧠 How Self-Training Works

WAA doesn't train a model — it **builds context from your past conversations** to give the LLM better inputs:

### Conversation History

Every chat gets its own JSON file in `data/ai/conversations/`:

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
1. Assistant loads the last **N messages** (configurable via `AI_MAX_HISTORY_PER_CHAT`)
2. These are sent as conversation context to the cloud LLM
3. The LLM generates a draft reply that's aware of the full conversation
4. You review/approve it from the dashboard; the message + reply are appended to the history

### Improving Accuracy Over Time

| Method | How It Helps |
|---|---|
| **More conversation data** | The LLM gets better context as history grows |
| **Approved replies** | Every draft you approve becomes a learned pattern that answers instantly |
| **Custom system prompt** | Tailor the assistant's personality via `AI_SYSTEM_PROMPT` |

### Group Chat Behavior

- Assistant only responds when **@mentioned** in groups (configurable)
- Private chats get automatic replies (pending approval)
- Group context is maintained per-group chat ID

---

## 📁 Project Structure

```
OpenWA/
├── src/                    # OpenWA server (NestJS)
│   └── modules/ai/         # AI assistant: matcher, LLM client, approvals store, REST API
├── dashboard/              # React web dashboard (sessions, messages, AI approvals)
├── data/                   # SQLite database + AI state (approvals, patterns, conversations)
├── docs/                   # Documentation
├── .env                    # Server configuration (incl. AI_LLM_API_KEY — never commit)
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
| `AI_ENABLED` | `true` | AI assistant master switch |
| `AI_APPROVAL_ENABLED` | `true` | Require a human Approve before any reply is sent |
| `AI_MATCH_THRESHOLD` | `0.6` | Jaccard similarity at which a learned pattern matches |
| `AI_LLM_HOST` | `https://api.kilo.ai/api/gateway` | Cloud LLM gateway |
| `AI_LLM_MODEL` | `kilo-auto/free` | Cloud LLM model id |
| `AI_LLM_API_KEY` | *(empty)* | kilo.ai JWT bearer token — **secret, .env only, never commit** |
| `AI_MAX_HISTORY_PER_CHAT` | `20` | Per-chat turns kept for LLM context |
| `AI_COOLDOWN_SECONDS` | `5` | Min seconds between replies per chat |

Full list — including `AI_LLM_*`, `AI_MAX_PENDING_APPROVALS`, `AI_REPLY_DELAY_MS`,
`AI_IGNORE_*` and `AI_GROUP_REPLY_ONLY_ON_MENTION` — is in `.env.example`.

---

## 🛡️ Safety Notes

- **Use a dedicated number** — not your personal WhatsApp
- **Rate limiting** is built in — don't blast messages
- **Human-in-the-loop** — with `AI_APPROVAL_ENABLED=true` (default), no AI reply is ever sent without your explicit Approve
- **Conversation data** stays in `data/ai/conversations/` on your disk
- **Keep the LLM key secret** — `AI_LLM_API_KEY` lives only in `.env`, never in the repo

---

## 📄 License

MIT License — free for personal and commercial use.

---

<div align="center">

**WAA** — WhatsApp Automation Bot

Made with ❤️ for automated conversations

</div>
