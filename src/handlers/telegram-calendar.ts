/**
 * Telegram Entry Point for Calendar Assistant
 * Flow: /add_event or voice input → parse → validate → preview → confirm → create
 */

import { parseEventFromInput } from '../lib/calendar/parser';
import { validateParsedEvent } from '../lib/calendar/validator';
import { checkCalendarConflicts } from '../lib/calendar/conflict-detector';
import { createCalendarEvent } from '../lib/calendar/creator';
import { generatePreview } from '../lib/calendar/previewer';
import type { ValidatedEvent } from '../lib/calendar/types';

export interface TelegramMessage {
  chat_id: string;
  user_id: string;
  text?: string;
  voice?: string; // Voice message file ID or transcript
  message_id: string;
}

export interface TelegramResponse {
  chat_id: string;
  message_id?: string;
  text: string;
  buttons?: Array<{ text: string; callback_data: string }>;
  action?: 'send' | 'edit' | 'delete';
}

/**
 * Handle incoming Telegram message (text or voice)
 * Returns preview + confirmation buttons
 */
export async function handleTelegramInput(
  msg: TelegramMessage
): Promise<TelegramResponse> {
  const input = msg.text || msg.voice || '';

  if (!input.trim()) {
    return {
      chat_id: msg.chat_id,
      text: 'Por favor, envie um evento ou comando. Ex: "Reunião com João amanhã às 14:30"',
      action: 'send',
    };
  }

  try {
    // Step 1: Parse
    console.log(`[Telegram] Parsing: "${input.substring(0, 50)}..."`);
    const parsed = await parseEventFromInput(input);

    // Step 2: Validate
    const validation = validateParsedEvent(parsed);

    // Step 3: Handle validation result
    if (!validation.valid) {
      if (validation.clarificationRequest) {
        return {
          chat_id: msg.chat_id,
          text: `⚠️ Preciso esclarecer:\n\n${validation.clarificationRequest}`,
          action: 'send',
        };
      }

      const errorMsg = validation.errors[0] || 'Erro ao processar evento';
      return {
        chat_id: msg.chat_id,
        text: `❌ ${errorMsg}`,
        action: 'send',
      };
    }

    // Step 4: Check conflicts
    const conflicts = await checkCalendarConflicts(validation.correctedEvent!);

    // Step 5: Generate preview
    const preview = generatePreview(
      validation.correctedEvent!,
      conflicts.has_conflicts ? conflicts.conflicts : undefined
    );

    // Step 6: Return preview + confirmation buttons
    return {
      chat_id: msg.chat_id,
      text: preview.text,
      buttons: [
        { text: '✅ Confirmar', callback_data: `confirm_${preview.event_id}` },
        { text: '❌ Cancelar', callback_data: `cancel_${preview.event_id}` },
        { text: '✏️ Editar', callback_data: `edit_${preview.event_id}` },
      ],
      action: 'send',
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Telegram] Error: ${err}`);
    return {
      chat_id: msg.chat_id,
      text: `❌ Erro ao processar: ${err}`,
      action: 'send',
    };
  }
}

/**
 * Handle confirmation button click
 * Creates the event in Google Calendar
 */
export async function handleConfirmation(
  chat_id: string,
  event_id: string,
  event: ValidatedEvent
): Promise<TelegramResponse> {
  try {
    console.log(`[Telegram] Creating event: ${event.title}`);

    const result = await createCalendarEvent({
      event,
      event_id,
      calendar_id: 'primary',
      owner_email: 'jgcalice@gmail.com',
    });

    return {
      chat_id,
      text: `✅ Evento criado!\n\n📅 ${event.title}\n🔗 ${result.event_link}\n\nEvent ID: ${result.google_event_id}`,
      action: 'send',
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Telegram] Creation error: ${err}`);
    return {
      chat_id,
      text: `❌ Erro ao criar evento: ${err}`,
      action: 'send',
    };
  }
}

/**
 * Handle cancellation
 */
export async function handleCancellation(
  chat_id: string,
  event_id: string
): Promise<TelegramResponse> {
  return {
    chat_id,
    text: '❌ Evento cancelado.',
    action: 'send',
  };
}
