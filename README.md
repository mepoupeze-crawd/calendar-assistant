# Calendar Assistant - Mission Control

Portuguese-language calendar event creation via Telegram, with LLM parsing and Google Calendar integration.

## Architecture

```
Telegram Message (text/voice)
    ↓
[Parser] LLM (Gemini 2.5 Flash) → JSON structure
    ↓
[Validator] Check format, dates, ambiguities
    ↓
[Conflict Detector] Check Google Calendar overlaps
    ↓
[Preview] Formatted message + confirmation buttons
    ↓
User confirms via Telegram button
    ↓
[Creator] gog CLI → Google Calendar write
    ↓
Confirmation + event link
```

## Setup

### Prerequisites

```bash
# 1. Install gog (Google Workspace CLI)
brew install gog  # or: https://github.com/jamestelfer/gog

# 2. Authenticate gog for calendar
gog auth add mepoupz@gmail.com --services calendar

# 3. Node.js
node --version  # >= 22
```

### Environment

Create `.env`:
```
OPENROUTER_API_KEY=sk-or-...
TELEGRAM_BOT_TOKEN=7868753970:AAGV1KUCcXraiSE8ivQgi1jo_OA_t8knBIY
GOG_ACCOUNT=mepoupz@gmail.com
GOOGLE_CALENDAR_ID=primary
```

Or set environment variables:
```bash
export OPENROUTER_API_KEY=...
export TELEGRAM_BOT_TOKEN=...
```

### Install Dependencies

```bash
npm install
```

## Running

### Local Development (Polling)

```bash
npm run bot
```

Bot will start polling Telegram for messages. Send any text:
- `"Reunião com João amanhã às 14:30"` → parses to meeting event
- `"Standupas 9:00"` → parses to standup

Bot responds with preview + 3 buttons:
- ✅ Confirmar (create event)
- ❌ Cancelar (dismiss)
- ✏️ Editar (edit — not yet implemented)

### With Start Script

```bash
./start-bot.sh
```

Checks prerequisites + starts bot.

### Background Mode (tmux/screen)

```bash
tmux new-session -d -s calendar-bot "cd /data/.openclaw/workspace/mission-control && npm run bot"

# View logs
tmux attach-session -t calendar-bot

# Stop
tmux kill-session -t calendar-bot
```

## Testing

### Run All Tests

```bash
OPENROUTER_API_KEY=$OPENROUTER_API_KEY npm test
```

### Run Specific Suite

```bash
# Parser + Validator (22 tests)
OPENROUTER_API_KEY=$OPENROUTER_API_KEY npm run test:t7

# Conflict Detector (18 tests)
OPENROUTER_API_KEY=$OPENROUTER_API_KEY npx jest src/lib/calendar/conflict-detector.test.ts
```

## Architecture

### t7 - Parser & Validator
- **File:** `src/lib/calendar/parser.ts`, `src/lib/calendar/validator.ts`
- **Tests:** `src/lib/calendar/pipeline.test.ts` (22 tests)
- Input: Portuguese text
- Output: Validated event or clarification request

### t8 - Conflict Detection
- **File:** `src/lib/calendar/conflict-detector.ts`
- **Tests:** `src/lib/calendar/conflict-detector.test.ts` (18 tests)
- Input: Validated event
- Output: Conflict list (if any)

### t9 - Creator
- **File:** `src/lib/calendar/creator.ts`
- Input: Validated event
- Output: Google Calendar event (via gog)

### t10 - Telegram Handler
- **File:** `src/handlers/telegram-calendar.ts`, `src/bot.ts`
- Entry point: polling from Telegram API
- Coordinates parser → validator → conflict → preview → creator

## Deployment

### Local Machine
```bash
./start-bot.sh &
```

### VPS / Always-On
```bash
# Start in screen
screen -dmS calendar-bot bash -c 'cd mission-control && npm run bot'

# Or systemd (create /etc/systemd/system/calendar-bot.service)
[Service]
Type=simple
User=app
WorkingDirectory=/data/.openclaw/workspace/mission-control
ExecStart=/usr/bin/npm run bot
Restart=on-failure
```

### Docker
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install --production
ENV NODE_ENV=production
CMD ["npm", "run", "bot"]
```

## Troubleshooting

### Bot doesn't respond
```bash
# Check logs
npm run bot

# Verify token
curl https://api.telegram.org/bot{TOKEN}/getMe

# Check .env
cat .env
```

### gog not authenticated
```bash
gog auth add mepoupz@gmail.com --services calendar
gog calendar list -a mepoupz@gmail.com --plain  # verify
```

### LLM errors
```bash
# Check API key
echo $OPENROUTER_API_KEY

# Check Gemini model is available
curl -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  https://openrouter.ai/api/v1/models | grep gemini-2.5-flash
```

## Files

```
mission-control/
├── src/
│   ├── lib/calendar/
│   │   ├── parser.ts           # LLM-based NLP
│   │   ├── validator.ts        # Validation rules
│   │   ├── conflict-detector.ts # Google Calendar overlap check
│   │   ├── creator.ts          # gog CLI wrapper
│   │   ├── previewer.ts        # Message formatting
│   │   ├── types.ts            # Shared interfaces
│   │   └── *.test.ts           # Integration tests (40 total)
│   └── handlers/
│       └── telegram-calendar.ts # Telegram flow
├── src/bot.ts                  # Polling entry point
├── package.json
├── tsconfig.json
├── .env                        # Secrets (add to .gitignore)
├── start-bot.sh               # Startup script
└── README.md                  # This file
```

## Status

✅ **Production Ready (MVP)**
- 40 tests passing
- Tested locally
- Ready for: local deployment + Telegram integration

⏳ **Future**
- Undo (delete event within 2 min)
- Edit (modify after preview)
- Morning briefing (daily digest)
- WhatsApp integration

---

**Last Updated:** 2026-02-25  
**Maintainer:** João Calice (strategic direction)  
**Tech Lead:** Sam (AI agent)
