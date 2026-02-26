#!/usr/bin/env node

/**
 * Telegram Bot for Calendar Assistant
 * Polling-based entry point (no webhook)
 * 
 * Run: OPENROUTER_API_KEY=... TELEGRAM_BOT_TOKEN=... npx ts-node -P tsconfig.test.json src/bot.ts
 */

import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { handleTelegramInput, handleConfirmation, handleCancellation } from './handlers/telegram-calendar';
import type { TelegramMessage } from './handlers/telegram-calendar';

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = 'https://api.telegram.org';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

let lastUpdateId = 0;
const eventCache: Map<string, any> = new Map(); // preview_id → validated event

/**
 * Fetch new messages from Telegram
 */
async function getUpdates(): Promise<any[]> {
  const url = `${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;

  try {
    const response = await fetch(url);
    const data = (await response.json()) as any;

    if (!data.ok) {
      console.error('[Bot] Telegram error:', data.description);
      return [];
    }

    return data.result || [];
  } catch (error) {
    console.error('[Bot] Fetch error:', error);
    return [];
  }
}

/**
 * Send message to Telegram
 */
async function sendMessage(
  chatId: string,
  text: string,
  buttons?: Array<{ text: string; callback_data: string }>
): Promise<void> {
  const payload: any = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };

  if (buttons && buttons.length > 0) {
    payload.reply_markup = {
      inline_keyboard: [buttons.map(btn => ({ text: btn.text, callback_data: btn.callback_data }))],
    };
  }

  const url = `${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error('[Bot] Send error:', response.statusText);
    }
  } catch (error) {
    console.error('[Bot] Network error:', error);
  }
}

/**
 * Answer callback query (button click)
 */
async function answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
  const payload = {
    callback_query_id: callbackQueryId,
    text,
  };

  const url = `${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('[Bot] Callback error:', error);
  }
}

/**
 * Handle a message update
 */
async function handleUpdate(update: any): Promise<void> {
  const message = update.message || update.callback_query?.message;
  const chatId = update.message?.chat.id || update.callback_query?.message.chat.id;
  const messageText = update.message?.text || '';
  const callbackData = update.callback_query?.data;

  if (!chatId) return;

  try {
    // Handle message (text input)
    if (update.message) {
      console.log(`[Bot] Message from ${chatId}: "${messageText.substring(0, 50)}..."`);

      const telegramMsg: TelegramMessage = {
        chat_id: String(chatId),
        user_id: String(update.message.from.id),
        text: messageText,
        message_id: String(update.message.message_id),
      };

      const response = await handleTelegramInput(telegramMsg);
      await sendMessage(response.chat_id, response.text, response.buttons);

      // Cache the event for later confirmation
      if (response.buttons) {
        const eventId = `${chatId}_${Date.now()}`;
        eventCache.set(eventId, { message: telegramMsg });
      }
    }

    // Handle callback query (button click)
    if (update.callback_query) {
      const queryId = update.callback_query.id;
      console.log(`[Bot] Callback from ${chatId}: ${callbackData}`);

      if (callbackData.startsWith('confirm_')) {
        // TODO: Retrieve cached event and confirm
        await answerCallbackQuery(queryId, '✅ Criando evento...');
        await sendMessage(String(chatId), '✅ Evento criado com sucesso!');
      } else if (callbackData.startsWith('cancel_')) {
        await answerCallbackQuery(queryId, '❌ Cancelado');
        await sendMessage(String(chatId), '❌ Evento cancelado.');
      } else if (callbackData.startsWith('edit_')) {
        await answerCallbackQuery(queryId, '✏️ Editar ainda não implementado');
        await sendMessage(String(chatId), '✏️ Editar ainda não implementado. Envie um novo comando.');
      }
    }
  } catch (error) {
    console.error('[Bot] Update error:', error);
    await sendMessage(String(chatId), '❌ Erro ao processar. Tente novamente.');
  }
}

/**
 * Main polling loop
 */
async function poll(): Promise<void> {
  console.log('[Bot] Starting polling...');

  while (true) {
    try {
      const updates = await getUpdates();

      for (const update of updates) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);
        await handleUpdate(update);
      }

      if (updates.length === 0) {
        // Small delay if no updates
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (error) {
      console.error('[Bot] Poll error:', error);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Start
poll().catch(console.error);
