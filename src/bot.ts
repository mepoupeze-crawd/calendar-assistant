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
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID || '7131103597'; // Default: João Calice (PersonalAssistant)

if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

console.log(`[Bot] Configured to respond only in chat: ${ALLOWED_CHAT_ID}`);

let lastUpdateId = 0;
const eventCache: Map<string, any> = new Map(); // event_id → { message, validated_event, conflicts }

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

  // Only respond in allowed chat
  if (String(chatId) !== ALLOWED_CHAT_ID) {
    console.log(`[Bot] Ignoring message from chat ${chatId} (allowed: ${ALLOWED_CHAT_ID})`);
    return;
  }

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
        // Parse the validated event from the response (embedded in preview)
        // For now, store the message and re-parse on confirmation
        eventCache.set(eventId, { 
          message: telegramMsg,
          timestamp: Date.now(),
        });
        console.log(`[Bot] Cached event ${eventId} for chat ${chatId}`);
      }
    }

    // Handle callback query (button click)
    if (update.callback_query) {
      const queryId = update.callback_query.id;
      console.log(`[Bot] Callback from ${chatId}: ${callbackData}`);

      if (callbackData.startsWith('confirm_')) {
        const eventId = callbackData.replace('confirm_', '');
        const cached = eventCache.get(eventId);

        if (!cached) {
          await answerCallbackQuery(queryId, '⏰ Preview expirou. Envie o evento novamente.');
          await sendMessage(String(chatId), '⏰ Preview expirou. Por favor, envie o evento novamente.');
          return;
        }

        try {
          await answerCallbackQuery(queryId, '✅ Criando evento...');
          
          // Re-parse and validate the message
          const { parsed } = await handleTelegramInput(cached.message);
          
          // Actually use handleConfirmation
          const response = await handleConfirmation(String(chatId), eventId, parsed);
          await sendMessage(response.chat_id, response.text);
          
          // Clean up cache
          eventCache.delete(eventId);
          console.log(`[Bot] Cleared cache for ${eventId}`);
        } catch (error) {
          const err = error instanceof Error ? error.message : 'Unknown error';
          await answerCallbackQuery(queryId, '❌ Erro ao criar evento');
          await sendMessage(String(chatId), `❌ Erro: ${err}`);
        }
      } else if (callbackData.startsWith('cancel_')) {
        const eventId = callbackData.replace('cancel_', '');
        await answerCallbackQuery(queryId, '❌ Cancelado');
        await handleCancellation(String(chatId), eventId);
        await sendMessage(String(chatId), '❌ Evento cancelado.');
        eventCache.delete(eventId);
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
