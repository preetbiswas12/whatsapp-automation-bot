# OpenWA AI Bot — Local LLM Integration

Fully automated WhatsApp AI bot using a local LLM (no API keys needed).

## Architecture

```
WhatsApp User → OpenWA Server → Webhook → AI Bot → LM Studio (DeepSeek R1 2B) → Reply
```

## Setup (3 steps)

### 1. Install LM Studio
Download from https://lmstudio.ai (free, ~500MB)

### 2. Load your GGUF model
1. Open LM Studio
2. Click "My Models" → drag & drop your `.gguf` file
3. Click "Start Server" (bottom left)
4. Note the port (default: 1234)
5. In the server tab, copy the model name shown

### 3. Configure the bot
Edit `config.json`:
```json
{
  "llm": {
    "model": "your-model-name-here"  ← paste model name from LM Studio
  }
}
```

## Run

```bash
cd OpenWA/ai-bot
npm start
```

The bot will:
1. Start a webhook server on port 3001
2. Register itself with OpenWA
3. Listen for incoming WhatsApp messages
4. Call your local LLM for each message
5. Reply automatically
6. Save conversation history in `conversations/`

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the bot |
| `npm run setup` | Check all connections |
| `npm run test-llm` | Test LLM response |
| `npm run test-llm "hello"` | Test with custom message |

## File Structure

```
ai-bot/
├── bot.js              # Main bot script
├── config.json         # Configuration
├── setup.js            # Setup checker
├── test-llm.js         # LLM test script
├── package.json        # Dependencies
├── conversations/      # Chat history (auto-created)
│   ├── 1234567890_c.us.json
│   └── ...
└── README.md           # This file
```

## Config Options

| Setting | Default | Description |
|---------|---------|-------------|
| `openwa.host` | `http://localhost:2785` | OpenWA server URL |
| `openwa.apiKey` | `dev-admin-key` | Your API key |
| `openwa.sessionId` | `00db2486-...` | WhatsApp session ID |
| `llm.host` | `http://localhost:1234` | LM Studio URL |
| `llm.model` | `deepseek-r1-2b` | Model name (must match LM Studio) |
| `llm.systemPrompt` | (see config) | System prompt for the AI |
| `llm.maxTokens` | `1024` | Max response length |
| `llm.temperature` | `0.7` | Response creativity (0-1) |
| `bot.cooldownSeconds` | `5` | Min seconds between replies per chat |
| `bot.maxHistoryPerChat` | `20` | Messages to remember per chat |
| `bot.ignoreGroups` | `false` | Skip group messages |
| `bot.replyDelay` | `1500` | Typing delay in ms |

## Conversation History

Each chat gets its own JSON file in `conversations/`:
```json
{
  "chatId": "1234567890@c.us",
  "lastUpdated": "2026-09-21T10:30:00.000Z",
  "messageCount": 8,
  "messages": [
    { "role": "user", "content": "Hello!" },
    { "role": "assistant", "content": "Hi! How can I help?" }
  ]
}
```

You can edit these files to:
- Add system context about specific contacts
- Pre-load conversation history
- Reset a conversation (delete the file)
