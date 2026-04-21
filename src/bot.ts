#!/usr/bin/env node

/**
 * Telegram Bot for Calendar Assistant
 * Polling-based entry point (no webhook)
 *
 * Run: OPENAI_API_KEY=... TELEGRAM_BOT_TOKEN=... npx ts-node -P tsconfig.test.json src/bot.ts
 */

import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { handleConfirmation, handleCancellation } from './handlers/telegram-calendar';
import type { TelegramMessage, TelegramResponse } from './handlers/telegram-calendar';
import type { ValidatedEvent } from './lib/calendar/types';
import { PersistentEventCache } from './lib/calendar/event-cache';
import { runAgentTurn, conversationStore } from './lib/calendar/agent';
import { updateEvent, deleteEvent } from './lib/calendar/calendar-ops';
import { pendingOpsStore } from './lib/calendar/pending-ops-store';

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = 'https://api.telegram.org';
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID || '7131103597'; // Default: João Calice (PersonalAssistant)
const USE_AGENT = process.env.USE_AGENT !== 'false'; // default true; set USE_AGENT=false to revert
if (USE_AGENT) console.log('[Bot] Agent mode enabled (USE_AGENT default=true)');

if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

console.log(`[Bot] Configured to respond only in chat: ${ALLOWED_CHAT_ID}`);

let lastUpdateId = 0;
const eventCache = new PersistentEventCache(); // persiste em data/event-cache.json

// ─── Processing Mutex ─────────────────────────────────────────────────────────
// Prevents race conditions when user sends messages in rapid succession.
const isProcessing = new Set<string>();

/** Clears all pending state for a chat. All state is now in conversationStore. */
function clearChatState(chatId: string): void {
  // All state is now in conversationStore; cleared separately via conversationStore.clear()
}

// ─── Telegram API Helpers ─────────────────────────────────────────────────────

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

async function sendMessage(
  chatId: string,
  text: string,
  buttons?: Array<Array<{ text: string; callback_data: string }>>
): Promise<void> {
  const payload: any = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };

  if (buttons && buttons.length > 0) {
    payload.reply_markup = {
      inline_keyboard: buttons,
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

async function answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (error) {
    console.error('[Bot] Callback error:', error);
  }
}

// ─── Media Helpers ────────────────────────────────────────────────────────────

/** Returns the HTTPS download URL for a Telegram file. */
async function getTelegramFileUrl(fileId: string): Promise<string> {
  const url = `${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
  const res = await fetch(url);
  const data = (await res.json()) as any;
  if (!data.ok) throw new Error(`getFile failed: ${data.description}`);
  return `${TELEGRAM_API}/file/bot${TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
}

/** Downloads a Telegram file by file_id and returns its Buffer. */
async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const fileUrl = await getTelegramFileUrl(fileId);
  const res = await fetch(fileUrl);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Transcribes a voice message Buffer using OpenAI Whisper. */
async function transcribeVoice(buffer: Buffer): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'voice.ogg');
  formData.append('model', 'whisper-1');
  formData.append('language', 'pt');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData as any,
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`Whisper error: ${data.error?.message ?? res.statusText}`);
  return data.text as string;
}

/** Extracts event information from an image Buffer using OpenAI Vision. */
async function extractTextFromImage(buffer: Buffer): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const base64 = buffer.toString('base64');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Esta imagem contém informações sobre um evento de agenda/calendário. Extraia e retorne apenas as informações do evento em português simples (título, data, hora, local, participantes). Se não houver nenhuma informação de evento, responda exatamente: sem evento',
          },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      }],
      max_tokens: 300,
    }),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`Vision error: ${data.error?.message ?? res.statusText}`);
  return (data.choices[0]?.message?.content ?? '') as string;
}

// ─── Update Handler ───────────────────────────────────────────────────────────

async function handleUpdate(update: any): Promise<void> {
  const chatId = update.message?.chat.id || update.callback_query?.message.chat.id;
  const messageText = update.message?.text || '';
  const callbackData = update.callback_query?.data;

  if (!chatId) return;

  if (String(chatId) !== ALLOWED_CHAT_ID) {
    console.log(`[Bot] Ignoring message from chat ${chatId} (allowed: ${ALLOWED_CHAT_ID})`);
    return;
  }

  const chatIdStr = String(chatId);

  try {
    // ── /new command — reset session ─────────────────────────────────────────
    if (update.message && messageText === '/new') {
      clearChatState(chatIdStr);
      conversationStore.clear(chatIdStr);
      await sendMessage(chatIdStr, '🆕 Sessão reiniciada. Pode enviar um novo evento.');
      return;
    }

    // ── Incoming message (text / voice / photo) ──────────────────────────────
    if (update.message) {
      // ── Step 0: Mutex — prevent parallel processing ──────────────────────
      if (isProcessing.has(chatIdStr)) {
        await sendMessage(chatIdStr, '⏳ Ainda processando sua mensagem anterior. Aguarde.');
        return;
      }
      isProcessing.add(chatIdStr);
      try {
      // ── Step 1: Resolve raw text from message type ───────────────────────
      let rawText = '';

      if (messageText) {
        rawText = messageText;

      } else if (update.message.voice) {
        await sendMessage(chatIdStr, '🎤 Transcrevendo áudio...');
        try {
          const buf = await downloadTelegramFile(update.message.voice.file_id);
          rawText = await transcribeVoice(buf);
          console.log(`[Bot] Voice transcribed: "${rawText.substring(0, 60)}"`);
          await sendMessage(chatIdStr, `🎤 <i>"${rawText}"</i>`);
        } catch (err) {
          await sendMessage(chatIdStr, `❌ Não consegui transcrever o áudio.\n\nTente escrever o evento em texto. Ex: <i>"reunião com João amanhã às 14h"</i>`);
          return;
        }

      } else if (update.message.photo) {
        await sendMessage(chatIdStr, '🖼 Lendo imagem...');
        try {
          const photos = update.message.photo as any[];
          const buf = await downloadTelegramFile(photos[photos.length - 1].file_id);
          const extracted = await extractTextFromImage(buf);
          const caption: string = update.message.caption || '';
          rawText = caption ? `${caption}. ${extracted}` : extracted;
          console.log(`[Bot] Image extracted: "${rawText.substring(0, 60)}"`);
          if (rawText.trim().toLowerCase() === 'sem evento') {
            await sendMessage(chatIdStr, '⚠️ Não encontrei informações de evento na imagem. Descreva o evento em texto.');
            return;
          }
          await sendMessage(chatIdStr, `🖼 <i>"${rawText}"</i>`);
        } catch (err) {
          await sendMessage(chatIdStr, `❌ Não consegui ler a imagem.\n\nTente descrever o evento em texto. Ex: <i>"reunião com João amanhã às 14h"</i>`);
          return;
        }

      } else {
        // sticker, document, location, etc.
        await sendMessage(chatIdStr, '⚠️ Tipo de mensagem não suportado. Envie texto, áudio ou imagem.');
        return;
      }

      if (!rawText.trim()) return;

      console.log(`[Bot] Message from ${chatId}: "${rawText.substring(0, 60)}"`);

      // ── Agent mode ───────────────────────────────────────────────────────
      try {
        const response = await runAgentTurn(chatIdStr, rawText);
        await sendMessage(chatIdStr, response.text, response.buttons);

        // Cache event for confirm button if preview was shown
        if (response.buttons?.some(row => row.some(b => b.callback_data?.startsWith('confirm_')))) {
          const state = conversationStore.get(chatIdStr);
          const evt = state?.draft;
          const btnRow = response.buttons.flat().find(b => b.callback_data?.startsWith('confirm_'));
          const eventId = btnRow?.callback_data.replace('confirm_', '');
          if (evt && eventId) {
            eventCache.set(eventId, { message: {}, validated_event: evt, timestamp: Date.now() });
            console.log(`[Bot/Agent] Cached event ${eventId} for chat ${chatId}`);
          }
        }
      } catch (err) {
        console.error('[Bot/Agent] error', err);
        await sendMessage(chatIdStr, '❌ Erro no agente. Tente /new e envie de novo.');
      }
      } finally {
        isProcessing.delete(chatIdStr);
      }
    }

    // ── Button callback ──────────────────────────────────────────────────────
    if (update.callback_query) {
      const queryId = update.callback_query.id;
      console.log(`[Bot] Callback from ${chatId}: ${callbackData}`);

      if (callbackData.startsWith('confirm_')) {
        const eventId = callbackData.replace('confirm_', '');
        const cached = eventCache.get(eventId);

        if (!cached) {
          await answerCallbackQuery(queryId, '⏰ Preview expirou. Envie o evento novamente.');
          await sendMessage(chatIdStr, '⏰ Preview expirou. Por favor, envie o evento novamente.');
          return;
        }

        try {
          await answerCallbackQuery(queryId, '✅ Criando evento...');
          const response = await handleConfirmation(chatIdStr, eventId, cached.validated_event);
          await sendMessage(response.chat_id, response.text);
          eventCache.delete(eventId);
          console.log(`[Bot] Cleared cache for ${eventId}`);
        } catch (error) {
          const err = error instanceof Error ? error.message : 'Unknown error';
          eventCache.delete(eventId);
          clearChatState(chatIdStr);
          await answerCallbackQuery(queryId, '❌ Erro ao criar evento');
          await sendMessage(chatIdStr, `❌ Erro: ${err}\n\nTente enviar o evento novamente.`);
        }

      } else if (callbackData.startsWith('cancel_')) {
        const eventId = callbackData.replace('cancel_', '');
        await answerCallbackQuery(queryId, '❌ Cancelado');
        await handleCancellation(chatIdStr, eventId);
        await sendMessage(chatIdStr, '❌ Evento cancelado.');
        eventCache.delete(eventId);
        clearChatState(chatIdStr);

      } else if (callbackData.startsWith('edit_')) {
        // ── Edit button ─────────────────────────────────────────────────────
        // In agent mode: tell the agent the user wants to edit
        await answerCallbackQuery(queryId, '✏️ O que quer mudar?');
        const response = await runAgentTurn(chatIdStr, `O usuário quer editar o evento. Pergunte o que ele quer mudar.`);
        await sendMessage(chatIdStr, response.text, response.buttons);

      } else if (callbackData === 'agent_escape_cancel_flow') {
        await answerCallbackQuery(queryId, '❌ Fluxo cancelado');
        conversationStore.clear(chatIdStr);
        clearChatState(chatIdStr);
        await sendMessage(chatIdStr, '❌ Fluxo cancelado. Envie um novo evento quando quiser.');

      } else if (callbackData === 'agent_escape_skip_participant') {
        if (isProcessing.has(chatIdStr)) {
          await answerCallbackQuery(queryId, '⏳ Aguarde...');
          return;
        }
        isProcessing.add(chatIdStr);
        try {
          await answerCallbackQuery(queryId, '⏭ Participante pulado');
          const response = await runAgentTurn(chatIdStr, 'ok, pode pular esse participante e seguir sem ele');
          await sendMessage(chatIdStr, response.text, response.buttons);
          // Cache new preview if agent returned confirm button
          if (response.buttons?.some(row => row.some(b => b.callback_data?.startsWith('confirm_')))) {
            const state = conversationStore.get(chatIdStr);
            const evt = state?.draft;
            const btnRow = response.buttons.flat().find(b => b.callback_data?.startsWith('confirm_'));
            const eventId = btnRow?.callback_data.replace('confirm_', '');
            if (evt && eventId) {
              eventCache.set(eventId, { message: {}, validated_event: evt, timestamp: Date.now() });
            }
          }
        } finally {
          isProcessing.delete(chatIdStr);
        }

      } else if (callbackData.startsWith('apply_update_')) {
        const opId = callbackData.replace('apply_update_', '');
        const op = pendingOpsStore.get(opId);

        if (!op || op.type !== 'update') {
          await answerCallbackQuery(queryId, '⏰ Operação expirou');
          await sendMessage(chatIdStr, '⏰ Operação expirou. Peça novamente.');
          return;
        }

        await answerCallbackQuery(queryId, '✏️ Atualizando...');
        try {
          const { event_link } = await updateEvent(op.google_event_id, op.patch as any);
          pendingOpsStore.delete(opId);
          await sendMessage(chatIdStr, `✅ Atualizado: <b>${op.summary}</b>\n🔗 ${event_link}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await sendMessage(chatIdStr, `❌ Erro ao atualizar: ${msg}`);
        }

      } else if (callbackData.startsWith('apply_delete_')) {
        const opId = callbackData.replace('apply_delete_', '');
        const op = pendingOpsStore.get(opId);

        if (!op || op.type !== 'delete') {
          await answerCallbackQuery(queryId, '⏰ Operação expirou');
          await sendMessage(chatIdStr, '⏰ Operação expirou. Peça novamente.');
          return;
        }

        await answerCallbackQuery(queryId, '🗑 Excluindo...');
        try {
          await deleteEvent(op.google_event_id);
          pendingOpsStore.delete(opId);
          await sendMessage(chatIdStr, `🗑 Excluído: <b>${op.summary}</b>`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await sendMessage(chatIdStr, `❌ Erro ao excluir: ${msg}`);
        }

      } else if (callbackData.startsWith('abort_op_')) {
        const opId = callbackData.replace('abort_op_', '');
        const op = pendingOpsStore.get(opId);
        if (!op) {
          await answerCallbackQuery(queryId, '⏰ Expirou');
          await sendMessage(chatIdStr, '⏰ Operação já expirou ou foi processada.');
          return;
        }
        pendingOpsStore.delete(opId);
        await answerCallbackQuery(queryId, '✗ Cancelado');
        await sendMessage(chatIdStr, '✗ Operação cancelada.');
      }
    }
  } catch (error) {
    console.error('[Bot] Update error:', error);
    await sendMessage(chatIdStr, '❌ Erro ao processar. Tente novamente.');
  }
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

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
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (error) {
      console.error('[Bot] Poll error:', error);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function main() {
  await eventCache.load();
  poll().catch(console.error);
}
main().catch(console.error);
