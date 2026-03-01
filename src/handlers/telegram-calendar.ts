/**
 * Telegram Entry Point for Calendar Assistant
 * Flow: /add_event or voice input → parse → validate → preview → confirm → create
 */

import { parseEventFromInput } from '../lib/calendar/parser';
import { validateParsedEvent } from '../lib/calendar/validator';
import { checkCalendarConflicts } from '../lib/calendar/conflict-detector';
import { createCalendarEvent } from '../lib/calendar/creator';
import { generatePreview } from '../lib/calendar/previewer';
import { lookupContactsByName } from '../lib/calendar/contacts';
import type { Contact } from '../lib/calendar/contacts';
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
  event_id?: string;
  validated_event?: ValidatedEvent;
  needsClarification?: boolean;
  /** Set when multiple contacts match a participant name — user must pick one. */
  contactChoice?: {
    participantName: string;
    options: Contact[];
  };
  /** Set when no contact was found — user must type the email for this name. */
  missingEmailFor?: string;
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
          needsClarification: true,
        };
      }

      const errorMsg = validation.errors[0] || 'Erro ao processar evento';
      return {
        chat_id: msg.chat_id,
        text: `❌ ${errorMsg}`,
        action: 'send',
      };
    }

    // Steps 3.5-6: Resolve participant emails (contacts lookup) then preview
    return resolveParticipantsAndPreview(msg.chat_id, validation.correctedEvent!);
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
      calendar_id: process.env.GOG_ACCOUNT || 'mepoupeze@gmail.com',
      owner_email: process.env.CALENDAR_OWNER_EMAIL || 'jgcalice@gmail.com',
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

// ─── Contact Resolution + Preview ─────────────────────────────────────────────

/**
 * Resolve participant emails one by one via contacts lookup, then show preview.
 * - 0 contacts found  → ask user to type the email
 * - 1 contact found   → auto-resolve, continue
 * - 2+ contacts found → ask user to pick one (buttons + numbered list)
 * - all resolved      → conflict check + event preview
 */
export async function resolveParticipantsAndPreview(
  chat_id: string,
  event: ValidatedEvent
): Promise<TelegramResponse> {
  const unresolved = event.participants.find(p => !p.email);

  if (!unresolved) {
    return previewEvent(chat_id, event);
  }

  const contacts = await lookupContactsByName(unresolved.name);

  if (contacts.length === 0) {
    return {
      chat_id,
      text: `⚠️ Não encontrei "<b>${unresolved.name}</b>" nos seus contatos.\n\nQual o email?`,
      action: 'send',
      needsClarification: true,
      missingEmailFor: unresolved.name,
      validated_event: event,
    };
  }

  if (contacts.length === 1) {
    console.log(`[Telegram] Auto-resolved "${unresolved.name}" → ${contacts[0].email}`);
    return resolveParticipantsAndPreview(chat_id, setParticipantEmail(event, unresolved.name, contacts[0].email));
  }

  // Multiple matches
  const optionsList = contacts.map((c, i) => `${i + 1}. ${c.name} (${c.email})`).join('\n');
  return {
    chat_id,
    text: `👥 Encontrei ${contacts.length} contatos com o nome "<b>${unresolved.name}</b>":\n\n${optionsList}\n\nQual deles você quer adicionar?`,
    buttons: [
      ...contacts.map((c, i) => ({ text: c.name, callback_data: `pick_contact_${i}` })),
      { text: '✍️ Digitar email', callback_data: 'pick_contact_manual' },
    ],
    action: 'send',
    contactChoice: { participantName: unresolved.name, options: contacts },
    validated_event: event,
  };
}

/** Returns a new ValidatedEvent with the email resolved for the first matching participant. */
export function setParticipantEmail(
  event: ValidatedEvent,
  participantName: string,
  email: string
): ValidatedEvent {
  return {
    ...event,
    participants: event.participants.map(p =>
      p.name === participantName && !p.email
        ? { ...p, email, resolved: true }
        : p
    ),
  };
}

/** Conflict check + preview for a fully-resolved event. */
async function previewEvent(chat_id: string, event: ValidatedEvent): Promise<TelegramResponse> {
  const conflicts = await checkCalendarConflicts(event);
  const preview = generatePreview(event, conflicts.has_conflicts ? conflicts.conflicts : undefined);
  return {
    chat_id,
    text: preview.text,
    buttons: [
      { text: '✅ Confirmar', callback_data: `confirm_${preview.event_id}` },
      { text: '❌ Cancelar', callback_data: `cancel_${preview.event_id}` },
      { text: '✏️ Editar', callback_data: `edit_${preview.event_id}` },
    ],
    action: 'send',
    event_id: preview.event_id,
    validated_event: event,
  };
}
