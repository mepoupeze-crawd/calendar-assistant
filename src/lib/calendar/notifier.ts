/**
 * Post-Creation Notifier (t6)
 * Sends Telegram confirmation after event creation,
 * with an Undo button that expires after 2 minutes.
 *
 * Message format:
 * ✅ Evento criado!
 *
 * 📅 *Reunião com João*
 * Segunda-feira, 22 de fevereiro de 2026
 * 14:30 - 15:30 (1h)
 *
 * [🔗 Ver no Google Calendar]  [↩️ Desfazer (2:00)]
 *
 * After 2 min: updates button to "⏱ Prazo expirado"
 */

import type { CalendarCreateResult } from "./types";
import { undoStore } from "./undo-store";
import { UNDO_WINDOW_MS } from "./undo-store";

const PORTUGUESE_DAYS = [
  "Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira",
  "Quinta-feira", "Sexta-feira", "Sábado",
];

const PORTUGUESE_MONTHS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/**
 * Format ISO datetime string to Portuguese date label.
 * Input: "2026-02-22T14:30:00-03:00" or "2026-02-22" (all-day)
 */
function formatDatePT(iso: string): string {
  const dateStr = iso.slice(0, 10); // YYYY-MM-DD
  const [year, month, day] = dateStr.split("-").map(Number);
  // Build local date (note: Date.UTC to avoid timezone shifts)
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayName = PORTUGUESE_DAYS[d.getUTCDay()];
  const monthName = PORTUGUESE_MONTHS[month - 1];
  return `${dayName}, ${day} de ${monthName} de ${year}`;
}

/**
 * Extract HH:MM from ISO datetime string.
 */
function extractTime(iso: string): string {
  const match = iso.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : "";
}

/**
 * Format duration in minutes to human-readable Portuguese string.
 */
function formatDuration(startIso: string, endIso: string): string {
  const startTime = extractTime(startIso);
  const endTime = extractTime(endIso);
  if (!startTime || !endTime) return "";

  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const totalMins = (eh * 60 + em) - (sh * 60 + sm);
  if (totalMins <= 0) return "";

  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;

  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}min`;
}

/**
 * Build the Telegram notification message text (Markdown).
 */
export function buildNotificationMessage(result: CalendarCreateResult): string {
  const isAllDay = !result.start_iso.includes("T");
  const dateLine = formatDatePT(result.start_iso);

  let timeLine = "";
  if (!isAllDay) {
    const startTime = extractTime(result.start_iso);
    const endTime = extractTime(result.end_iso);
    const duration = formatDuration(result.start_iso, result.end_iso);
    timeLine = duration
      ? `\n⏰ ${startTime} - ${endTime} (${duration})`
      : `\n⏰ ${startTime} - ${endTime}`;
  }

  return (
    `✅ *Evento criado!*\n\n` +
    `📋 *${result.title}*\n` +
    `📅 ${dateLine}` +
    timeLine
  );
}

/**
 * Build Telegram inline keyboard for post-creation notification.
 * - [🔗 Ver no Google Calendar] (URL button)
 * - [↩️ Desfazer] (callback button, expires in 2 min)
 */
export function buildNotificationKeyboard(
  frontendEventId: string,
  eventLink: string
): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        {
          text: "🔗 Ver no Google Calendar",
          url: eventLink,
        },
        {
          text: "↩️ Desfazer (2:00)",
          callback_data: `undo:${frontendEventId}`,
        },
      ],
    ],
  };
}

/**
 * Build expired keyboard (after 2-min window passes).
 */
export function buildExpiredKeyboard(eventLink: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        {
          text: "🔗 Ver no Google Calendar",
          url: eventLink,
        },
        {
          text: "⏱ Prazo expirado",
          callback_data: "undo_expired",
        },
      ],
    ],
  };
}

/**
 * Build undo success message.
 */
export function buildUndoSuccessMessage(title: string): string {
  return `↩️ *Evento cancelado*\n\n_"${title}" foi removido do Google Calendar._`;
}

/**
 * Build undo expired message (shown when user clicks after 2 min).
 */
export function buildUndoExpiredMessage(): string {
  return "⏱ *Prazo expirado*\n\n_O prazo de desfazer (2 minutos) já passou. O evento foi mantido no Google Calendar._";
}

/**
 * Register event for undo tracking and schedule keyboard expiry.
 * Returns a cancel function to stop the timer (if event is undone before expiry).
 *
 * @param frontendEventId  Frontend event ID (for Telegram callback routing)
 * @param result           CalendarCreateResult from creator
 * @param onExpiry         Callback to update the Telegram message keyboard
 */
export function registerUndoWithExpiry(
  frontendEventId: string,
  result: CalendarCreateResult,
  onExpiry: (eventLink: string) => void
): () => void {
  // Register in undo store
  undoStore.add(frontendEventId, {
    google_event_id: result.google_event_id,
    calendar_id: result.calendar_id,
    event_title: result.title,
    created_at: result.created_at,
  });

  // Schedule expiry notification
  const timer = setTimeout(() => {
    onExpiry(result.event_link);
  }, UNDO_WINDOW_MS);

  // Return cancel function (call if user undoes before expiry)
  return () => clearTimeout(timer);
}

// ---- Telegram Types (minimal, avoids external deps) ----

export interface TelegramInlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}
