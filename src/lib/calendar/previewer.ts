/**
 * Calendar Assistant - Preview UI Builder (t4)
 * Generates Telegram message + inline keyboard for event preview
 * 
 * DESIGN (Confirmed 25/02/2026):
 * - Message template: header + event summary + footer + buttons
 * - Inline keyboard: ✅ Confirmar, ✏️ Editar, ❌ Cancelar
 * - Edit mode: inline (same message)
 * - Show conflicts if detected
 */

import { ValidatedEvent } from './types';

export interface PreviewMessage {
  text: string;
  keyboard: InlineKeyboard;
  event_id: string; // Timestamp + 6-char random
}

export interface InlineKeyboard {
  buttons: InlineButton[][];
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/**
 * Generate preview message for Telegram
 */
export function generatePreview(
  event: ValidatedEvent,
  conflicts?: ConflictInfo[]
): PreviewMessage {
  const eventId = generateEventId();
  const text = buildPreviewText(event, conflicts);
  const keyboard = buildInlineKeyboard(eventId);

  return {
    text,
    keyboard,
    event_id: eventId,
  };
}

/**
 * Build preview message text
 */
function buildPreviewText(event: ValidatedEvent, conflicts?: ConflictInfo[]): string {
  const lines: string[] = [];

  // Header
  lines.push('📅 **Evento**');
  lines.push('');

  // Title
  lines.push(`**Título:** ${escapeMarkdown(event.title)}`);

  // Date + Day of week
  const dayOfWeek = getDayOfWeek(event.start_date);
  lines.push(
    `**Data:** ${dayOfWeek}, ${formatDatePT(event.start_date)}`
  );

  // Time or All-day
  if (event.all_day) {
    lines.push(`**Horário:** O dia todo`);
  } else {
    const timeStr = formatTimeRange(event.start_time, event.end_time, event.duration_minutes);
    lines.push(`**Horário:** ${timeStr}`);
  }

  // Participants
  if (event.participants && event.participants.length > 0) {
    const participantStr = formatParticipants(event.participants);
    lines.push(`**Participantes:** ${participantStr}`);
  }

  // Description (if present)
  if (event.description && event.description.trim().length > 0) {
    const desc = truncate(event.description, 200);
    lines.push(`**Descrição:** ${escapeMarkdown(desc)}`);
  }

  // Location (if present)
  if (event.location && event.location.trim().length > 0) {
    lines.push(`**Local:** ${escapeMarkdown(event.location)}`);
  }

  // Conflict warning
  if (conflicts && conflicts.length > 0) {
    lines.push('');
    lines.push('⚠️ **Conflito Detectado:**');
    conflicts.forEach((c) => {
      lines.push(
        `• ${escapeMarkdown(c.title)} (${c.start_time}–${c.end_time})`
      );
    });
  }

  // Footer
  lines.push('');
  lines.push('_Confirme, edite ou cancele:_');

  return lines.join('\n');
}

/**
 * Build inline keyboard
 */
function buildInlineKeyboard(eventId: string): InlineKeyboard {
  return {
    buttons: [
      [
        {
          text: '✅ Confirmar',
          callback_data: `confirm:${eventId}`,
        },
        {
          text: '✏️ Editar',
          callback_data: `edit:${eventId}`,
        },
        {
          text: '❌ Cancelar',
          callback_data: `cancel:${eventId}`,
        },
      ],
    ],
  };
}

/**
 * Generate event ID: timestamp (10 digits) + 6-char random
 * Total: 16 chars (within Telegram's 64-char callback limit)
 */
function generateEventId(): string {
  const timestamp = Math.floor(Date.now() / 1000); // 10 digits (until ~year 2286)
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${timestamp}${random}`;
}

/**
 * Format helpers
 */
function getDayOfWeek(date: string): string {
  const dayMap: { [key: number]: string } = {
    0: 'Domingo',
    1: 'Segunda-feira',
    2: 'Terça-feira',
    3: 'Quarta-feira',
    4: 'Quinta-feira',
    5: 'Sexta-feira',
    6: 'Sábado',
  };

  const d = new Date(date + 'T00:00:00Z'); // Parse as UTC to avoid timezone issues
  return dayMap[d.getUTCDay()];
}

function formatDatePT(date: string): string {
  // YYYY-MM-DD -> DD/MM/YYYY
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

function formatTimeRange(
  startTime: string | null,
  endTime: string | null,
  durationMinutes: number | null
): string {
  if (!startTime) return 'N/A';

  if (endTime) {
    return `${startTime}–${endTime}`;
  }

  if (durationMinutes) {
    const hours = Math.floor(durationMinutes / 60);
    const mins = durationMinutes % 60;

    const durationStr =
      hours > 0 ? `${hours}h${mins > 0 ? ` ${mins}min` : ''}` : `${mins}min`;

    return `${startTime} (~${durationStr})`;
  }

  return startTime;
}

function formatParticipants(participants: Array<{ name: string; email?: string | null }>): string {
  const MAX_SHOW = 3;

  if (participants.length === 0) return 'Nenhum';

  const names = participants.slice(0, MAX_SHOW).map((p) => p.name).join(', ');

  if (participants.length > MAX_SHOW) {
    return `${names} +${participants.length - MAX_SHOW} outros`;
  }

  return names;
}

function escapeMarkdown(text: string): string {
  // Escape special markdown chars for Telegram
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/\-/g, '\\-')
    .replace(/\=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.');
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Conflict info (from calendar check)
 */
export interface ConflictInfo {
  title: string;
  start_time: string;
  end_time: string;
  calendar_event_id: string;
}

/**
 * Build edit field menu (for ✏️ Editar flow)
 */
export function buildEditMenu(eventId: string): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const text = '✏️ **Qual campo deseja editar?**\n\n_Clique abaixo para alterar:_';

  const keyboard: InlineKeyboard = {
    buttons: [
      [
        {
          text: '📌 Título',
          callback_data: `edit_field:${eventId}:title`,
        },
      ],
      [
        {
          text: '📅 Data',
          callback_data: `edit_field:${eventId}:date`,
        },
      ],
      [
        {
          text: '⏰ Horário',
          callback_data: `edit_field:${eventId}:time`,
        },
      ],
      [
        {
          text: '👥 Participantes',
          callback_data: `edit_field:${eventId}:participants`,
        },
      ],
      [
        {
          text: '📝 Descrição',
          callback_data: `edit_field:${eventId}:description`,
        },
      ],
      [
        {
          text: '📍 Local',
          callback_data: `edit_field:${eventId}:location`,
        },
      ],
      [
        {
          text: '🔙 Voltar',
          callback_data: `back_to_preview:${eventId}`,
        },
      ],
    ],
  };

  return { text, keyboard };
}
