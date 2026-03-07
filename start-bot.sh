#!/bin/bash

# Calendar Assistant Bot - Local Startup
# Prerequisites:
# - OPENAI_API_KEY set
# - TELEGRAM_BOT_TOKEN set (or in .env)
# - gog configured: gog auth add mepoupeze@gmail.com --services calendar

set -e

echo "🤖 Starting Calendar Assistant Bot..."

# Load .env if exists
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# Check requirements
if [ -z "$OPENAI_API_KEY" ]; then
  echo "❌ OPENAI_API_KEY not set"
  exit 1
fi

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "❌ TELEGRAM_BOT_TOKEN not set"
  exit 1
fi

# Check gog
if ! command -v gog &> /dev/null; then
  echo "❌ gog CLI not installed"
  exit 1
fi

# Check gog auth
if ! gog calendar list -a mepoupeze@gmail.com --plain &>/dev/null; then
  echo "⚠️  gog not authenticated for mepoupz@gmail.com"
  echo "Run: gog auth add mepoupeze@gmail.com --services calendar"
  exit 1
fi

echo "✅ All checks passed"
echo ""
echo "🚀 Bot polling..."
echo "   Token: ${TELEGRAM_BOT_TOKEN:0:20}..."
echo "   API Key: ${OPENAI_API_KEY:0:20}..."
echo ""
echo "Press Ctrl+C to stop"
echo ""

npm run bot
