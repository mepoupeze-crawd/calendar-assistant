#!/usr/bin/env node

/**
 * Telegram Bot for Calendar Assistant
 * Polling-based entry point (no webhook)
 *
 * Run: OPENAI_API_KEY=... TELEGRAM_BOT_TOKEN=... npx ts-node -P tsconfig.test.json src/bot.ts
 */

import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { handleTelegramInput, handleConfirmation, handleCancellation, resolveParticipantsAndPreview, setParticipantEmail } from './handlers/telegram-calendar';
import type { TelegramMessage, TelegramResponse } from './handlers/telegram-calendar';
import type { ValidatedEvent } from './lib/calendar/types';
import { PersistentEventCache } from './lib/calendar/event-cache';
import { runAgentTurn, conversationStore } from './lib/calendar/agent';

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = 'https://api.telegram.org';
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID || '7131103597'; // Default: João Calice (PersonalAssistant)
const USE_AGENT = process.env.USE_AGENT === 'true';
if (USE_AGENT) console.log('[Bot] Agent mode enabled (USE_AGENT=true)');

if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

console.log(`[Bot] Configured to respond only in chat: ${ALLOWED_CHAT_ID}`);

let lastUpdateId = 0;
const eventCache = new PersistentEventCache(); // persiste em data/event-cache.json

// ─── Conversation Session (Fix #3) ────────────────────────────────────────────
// Tracks accumulated user messages per chat for multi-turn clarification.
// When the bot asks for more info, subsequent answers are combined with the
// original text so the LLM always has full context.

interface ChatSession {
  texts: string[];
  createdAt: number;
  timerId: NodeJS.Timeout;
}
const chatSessions = new Map<string, ChatSession>();
const SESSION_TTL_MS = 5 * 60 * 1000; // sessions expire after 5 min of inactivity
const CONTACT_EMAIL_TTL_MS = 10 * 60 * 1000; // 10 minutos para informar email

/** Returns the combined context string for a chat, or null if no active session. */
function getSessionContext(chatId: string): string | null {
  const session = chatSessions.get(chatId);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    clearTimeout(session.timerId);
    chatSessions.delete(chatId);
    return null;
  }
  return session.texts.join('. ');
}

/** Appends a new user message to the clarification session. */
function appendToSession(chatId: string, text: string): void {
  const existing = chatSessions.get(chatId);
  if (existing && Date.now() - existing.createdAt <= SESSION_TTL_MS) {
    existing.texts.push(text);
    return;
  }
  // Cancelar timer anterior se existir
  if (existing) clearTimeout(existing.timerId);

  const timerId = setTimeout(async () => {
    chatSessions.delete(chatId);
    await sendMessage(chatId, '⏰ Sessão expirou. Envie o evento completo novamente.');
  }, SESSION_TTL_MS);

  chatSessions.set(chatId, { texts: [text], createdAt: Date.now(), timerId });
}

/** Clears all pending state (session + edit + contact resolution) for a chat. */
function clearChatState(chatId: string): void {
  const session = chatSessions.get(chatId);
  if (session) clearTimeout(session.timerId);
  chatSessions.delete(chatId);
  pendingEdits.delete(chatId);
  pendingContactPicks.delete(chatId);
  const pendingEmail = pendingContactEmails.get(chatId);
  if (pendingEmail) clearTimeout(pendingEmail.timerId);
  pendingContactEmails.delete(chatId);
}

function setPendingContactEmail(chatIdStr: string, chatId: any, name: string, partialEvent: ValidatedEvent): void {
  const existing = pendingContactEmails.get(chatIdStr);
  if (existing) clearTimeout(existing.timerId);

  const timerId = setTimeout(async () => {
    const pending = pendingContactEmails.get(chatIdStr);
    if (!pending) return;
    pendingContactEmails.delete(chatIdStr);
    const eventWithout = {
      ...pending.partialEvent,
      participants: pending.partialEvent.participants.filter(p => p.name !== pending.name),
    };
    await sendMessage(chatIdStr, `⏰ Tempo esgotado — <b>${pending.name}</b> não foi adicionado. Criando evento sem ele.`);
    const resp = await resolveParticipantsAndPreview(chatIdStr, eventWithout);
    await dispatchContactResponse(chatIdStr, chatId, resp);
  }, CONTACT_EMAIL_TTL_MS);

  pendingContactEmails.set(chatIdStr, { name, partialEvent, timerId });
  chatSessions.delete(chatIdStr);
  console.log(`[Bot] Waiting for email for "${name}" (timeout: 10min)`);
}

/**
 * Send a contact-resolution response and update the relevant state maps.
 * Used after resolveParticipantsAndPreview() in both text and callback paths.
 */
async function dispatchContactResponse(
  chatIdStr: string,
  chatId: any,
  response: TelegramResponse
): Promise<void> {
  await sendMessage(response.chat_id, response.text, response.buttons);

  if (response.event_id && response.validated_event && response.buttons) {
    clearChatState(chatIdStr);
    eventCache.set(response.event_id, {
      message: {},
      validated_event: response.validated_event,
      timestamp: Date.now(),
    });
    console.log(`[Bot] Cached event ${response.event_id} for chat ${chatId}`);
  } else if (response.contactChoice && response.validated_event) {
    pendingContactPicks.set(chatIdStr, {
      name: response.contactChoice.participantName,
      options: response.contactChoice.options,
      partialEvent: response.validated_event,
    });
    chatSessions.delete(chatIdStr);
    console.log(`[Bot] Contact pick pending: "${response.contactChoice.participantName}" (${response.contactChoice.options.length} options)`);
  } else if (response.missingEmailFor && response.validated_event) {
    setPendingContactEmail(chatIdStr, chatId, response.missingEmailFor, response.validated_event);
  }
}

// ─── Edit Mode (Fix #2) ───────────────────────────────────────────────────────
// Stores the text representation of the event being edited per chat.
// When the user replies with changes, we combine this base with their request.

const pendingEdits = new Map<string, string>(); // chat_id → event base text

// ─── Contact Resolution State ─────────────────────────────────────────────────
// Tracks per-chat contact-resolution flows so the normal message pipeline
// is not involved when the user is picking a contact or typing an email.

interface PendingContactPick {
  name: string;                                      // participant name being resolved
  options: Array<{ name: string; email: string }>;   // contacts found
  partialEvent: ValidatedEvent;                      // event with this participant unresolved
}
const pendingContactPicks = new Map<string, PendingContactPick>();   // chat_id → pick

interface PendingContactEmail {
  name: string;
  partialEvent: ValidatedEvent;
  timerId: NodeJS.Timeout;
}
const pendingContactEmails = new Map<string, PendingContactEmail>(); // chat_id → email

// ─── Processing Mutex ─────────────────────────────────────────────────────────
// Prevents race conditions when user sends messages in rapid succession.
const isProcessing = new Set<string>();

/** Converts a ValidatedEvent back to a natural-language string for the LLM. */
function eventToText(event: ValidatedEvent): string {
  const parts: string[] = [event.title, event.start_date];
  if (event.all_day) {
    parts.push('o dia todo');
  } else {
    if (event.start_time) parts.push(`às ${event.start_time}`);
    if (event.end_time) parts.push(`até ${event.end_time}`);
  }
  if (event.location) parts.push(`em ${event.location}`);
  if (event.participants?.length) {
    const names = event.participants
      .map(p => p.name)
      .filter(n => n?.trim())
      .join(' e ');
    if (names) parts.push(`com ${names}`);
  }
  return parts.join(' ');
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

      // ── Agent mode (USE_AGENT=true) ──────────────────────────────────────
      if (USE_AGENT) {
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
        return; // skip legacy flow
      }

      // ── Pending email input (user typing an email after "Qual o email?") ──
      const pendingEmail = pendingContactEmails.get(chatIdStr);
      if (pendingEmail) {
        const email = rawText.trim();
        if (!email.includes('@')) {
          await sendMessage(chatIdStr, `❌ "${email}" não parece um email válido.\nQual o email de <b>${pendingEmail.name}</b>?`);
          return; // keep pendingContactEmails set
        }
        clearTimeout(pendingEmail.timerId);
        pendingContactEmails.delete(chatIdStr);
        const updated = setParticipantEmail(pendingEmail.partialEvent, pendingEmail.name, email);
        await dispatchContactResponse(chatIdStr, chatId, await resolveParticipantsAndPreview(chatIdStr, updated));
        return;
      }

      // ── Pending contact pick via text (user types "1", "2", etc.) ─────────
      const pendingPick = pendingContactPicks.get(chatIdStr);
      if (pendingPick) {
        const num = parseInt(rawText.trim(), 10);
        if (!isNaN(num) && num >= 1 && num <= pendingPick.options.length) {
          pendingContactPicks.delete(chatIdStr);
          const selected = pendingPick.options[num - 1];
          const updated = setParticipantEmail(pendingPick.partialEvent, pendingPick.name, selected.email);
          await dispatchContactResponse(chatIdStr, chatId, await resolveParticipantsAndPreview(chatIdStr, updated));
          return;
        }
        // Not a valid number — clear pick and fall through to normal processing
        pendingContactPicks.delete(chatIdStr);
      }

      // ── Step 2: Merge session / edit context before parsing ──────────────
      let inputText = rawText;

      const pendingEdit = pendingEdits.get(chatIdStr);
      if (pendingEdit) {
        inputText = `${pendingEdit}. Altere: ${rawText}`;
        pendingEdits.delete(chatIdStr);
        console.log(`[Bot] Edit mode — combined input: "${inputText.substring(0, 80)}"`);
      } else {
        const sessionCtx = getSessionContext(chatIdStr);
        if (sessionCtx) {
          inputText = `${sessionCtx}. ${rawText}`;
          console.log(`[Bot] Session context merged: "${inputText.substring(0, 80)}"`);
        }
      }

      const telegramMsg: TelegramMessage = {
        chat_id: chatIdStr,
        user_id: String(update.message.from.id),
        text: inputText,
        message_id: String(update.message.message_id),
      };

      const response = await handleTelegramInput(telegramMsg);

      // F2: Add session TTL hint to clarification messages
      const responseText = response.needsClarification
        ? `${response.text}\n\n⏳ Você tem ${Math.round(SESSION_TTL_MS / 60000)} minutos para responder.`
        : response.text;
      await sendMessage(response.chat_id, responseText, response.buttons);

      if (response.event_id && response.validated_event && response.buttons) {
        // Valid preview — clear pending state, cache the event
        clearChatState(chatIdStr);
        eventCache.set(response.event_id, {
          message: { ...telegramMsg, text: rawText },
          validated_event: response.validated_event,
          timestamp: Date.now(),
        });
        console.log(`[Bot] Cached event ${response.event_id} for chat ${chatId}`);
      } else if (response.contactChoice && response.validated_event) {
        // Multiple contacts found — waiting for user to pick one
        pendingContactPicks.set(chatIdStr, {
          name: response.contactChoice.participantName,
          options: response.contactChoice.options,
          partialEvent: response.validated_event,
        });
        chatSessions.delete(chatIdStr);
        console.log(`[Bot] Contact pick pending: "${response.contactChoice.participantName}" (${response.contactChoice.options.length} options)`);
      } else if (response.missingEmailFor && response.validated_event) {
        setPendingContactEmail(chatIdStr, chatId, response.missingEmailFor, response.validated_event);
      } else if (response.needsClarification) {
        // Regular ambiguous input — accumulate in session
        appendToSession(chatIdStr, rawText);
        console.log(`[Bot] Clarification needed — session now has ${chatSessions.get(chatIdStr)?.texts.length} messages`);
      }
      // NOTE: on parse error we intentionally keep session alive.
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

      } else if (callbackData.startsWith('pick_contact_')) {
        // ── Contact pick button ─────────────────────────────────────────────
        const suffix = callbackData.replace('pick_contact_', '');
        const pending = pendingContactPicks.get(chatIdStr);

        if (!pending) {
          await answerCallbackQuery(queryId, '⏰ Expirou. Envie o evento novamente.');
          await sendMessage(chatIdStr, '⏰ Escolha expirou. Por favor envie o evento novamente.');
          return;
        }

        if (suffix === 'manual') {
          await answerCallbackQuery(queryId, '✍️ Ok');
          pendingContactPicks.delete(chatIdStr);
          setPendingContactEmail(chatIdStr, chatId, pending.name, pending.partialEvent);
          await sendMessage(chatIdStr, `✍️ Qual o email de <b>${pending.name}</b>?\n\n<i>Ou clique em ⏭ Pular para criar o evento sem este participante.</i>`, [[{ text: `⏭ Pular ${pending.name}`, callback_data: 'skip_contact_email' }]]);
          return;
        }

        const index = parseInt(suffix, 10);
        const selected = pending.options[index];
        if (!selected) {
          await answerCallbackQuery(queryId, '❌ Opção inválida');
          return;
        }

        await answerCallbackQuery(queryId, `✅ ${selected.name}`);
        pendingContactPicks.delete(chatIdStr);
        const updated = setParticipantEmail(pending.partialEvent, pending.name, selected.email);
        await dispatchContactResponse(chatIdStr, chatId, await resolveParticipantsAndPreview(chatIdStr, updated));

      } else if (callbackData === 'skip_contact_email') {
        const pending = pendingContactEmails.get(chatIdStr);
        if (!pending) {
          await answerCallbackQuery(queryId, '⏰ Expirou. Envie o evento novamente.');
          await sendMessage(chatIdStr, '⏰ Escolha expirou. Por favor envie o evento novamente.');
          return;
        }
        clearTimeout(pending.timerId);
        pendingContactEmails.delete(chatIdStr);
        await answerCallbackQuery(queryId, `⏭ ${pending.name} pulado`);
        const eventWithout = {
          ...pending.partialEvent,
          participants: pending.partialEvent.participants.filter(p => p.name !== pending.name),
        };
        await sendMessage(chatIdStr, `⏭ <b>${pending.name}</b> não foi adicionado ao evento.`);
        const resp = await resolveParticipantsAndPreview(chatIdStr, eventWithout);
        await dispatchContactResponse(chatIdStr, chatId, resp);

      } else if (callbackData.startsWith('edit_')) {
        // ── Edit button (Fix #2) ────────────────────────────────────────────
        const eventId = callbackData.replace('edit_', '');

        if (USE_AGENT) {
          // In agent mode: tell the agent the user wants to edit
          await answerCallbackQuery(queryId, '✏️ O que quer mudar?');
          const response = await runAgentTurn(chatIdStr, `O usuário quer editar o evento. Pergunte o que ele quer mudar.`);
          await sendMessage(chatIdStr, response.text, response.buttons);
          return;
        }

        // Legacy edit flow:
        const cached = eventCache.get(eventId);

        if (!cached?.validated_event) {
          await answerCallbackQuery(queryId, '⏰ Preview expirou');
          await sendMessage(chatIdStr, '⏰ Preview expirou. Envie o evento novamente.');
          return;
        }

        await answerCallbackQuery(queryId, '✏️ O que quer mudar?');

        const evt: ValidatedEvent = cached.validated_event;
        const baseText = eventToText(evt);
        pendingEdits.set(chatIdStr, baseText);
        chatSessions.delete(chatIdStr); // clear any open clarification session

        const summary = [
          `📅 <b>${evt.title}</b>`,
          `📆 ${evt.start_date}${evt.start_time ? ` às ${evt.start_time}` : ''}${evt.end_time ? `–${evt.end_time}` : ''}`,
          evt.location ? `📍 ${evt.location}` : '',
        ].filter(Boolean).join('\n');

        await sendMessage(
          chatIdStr,
          `✏️ Editando evento:\n\n${summary}\n\nO que você quer mudar?\n<i>Ex: "muda horário para 16:00", "adiciona sala 101", "com Maria também"</i>`
        );

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
