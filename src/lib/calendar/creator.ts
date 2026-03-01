/**
 * Calendar Creator — Google Calendar API via Service Account
 * Creates/deletes events without any CLI dependency.
 * Never called without prior user confirmation.
 */

import type {
  CalendarCreateRequest,
  CalendarCreateResult,
  ValidatedEvent,
} from './types';
import { getCalendarClient } from './google-auth';

// Fixed owner email always included as attendee
const OWNER_EMAIL = process.env.CALENDAR_OWNER_EMAIL || 'jgcalice@gmail.com';
// Service account calendar target
const DEFAULT_CALENDAR_ID = process.env.GOG_ACCOUNT || 'mepoupeze@gmail.com';

/**
 * Build RFC3339 datetime string from date (YYYY-MM-DD) and time (HH:MM).
 * Uses America/Sao_Paulo timezone (UTC-3).
 */
function buildRFC3339(date: string, time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const [Y, M, D] = date.split('-');
  const H = pad(hours);
  const min = pad(minutes);
  return `${Y}-${M}-${D}T${H}:${min}:00-03:00`;
}

/** HH:MM → total minutes since midnight. */
function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Returns the date string for the day after the given YYYY-MM-DD. */
function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00`); // noon avoids DST edge cases
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Compute end time from start + duration_minutes if end_time not specified.
 */
function computeEndTime(startTime: string, durationMinutes: number): string {
  const [h, m] = startTime.split(':').map(Number);
  const totalMinutes = h * 60 + m + durationMinutes;
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

/**
 * Build the attendees list from the event participants.
 */
function buildAttendees(event: ValidatedEvent): Array<{ email: string }> {
  const emails = new Set<string>([OWNER_EMAIL]);
  for (const p of event.participants ?? []) {
    if (p.email && p.email !== OWNER_EMAIL) {
      emails.add(p.email);
    }
  }
  return Array.from(emails).map(email => ({ email }));
}

/**
 * Create a Google Calendar event via the Calendar API.
 * Returns result with google_event_id for undo tracking.
 */
export async function createCalendarEvent(
  req: CalendarCreateRequest
): Promise<CalendarCreateResult> {
  const { event } = req;
  const calId = req.calendar_id || DEFAULT_CALENDAR_ID;

  const calendar = getCalendarClient();

  let startObj: { date?: string; dateTime?: string; timeZone?: string };
  let endObj: { date?: string; dateTime?: string; timeZone?: string };

  if (event.all_day) {
    startObj = { date: event.start_date };
    endObj = { date: event.start_date };
  } else {
    if (!event.start_time) {
      throw new Error('start_time is required for non-all-day events');
    }
    const endTime = event.end_time ?? computeEndTime(event.start_time, event.duration_minutes ?? 60);

    // Cross-midnight: if end time is before or equal to start time, end is next day
    const startMinutes = toMinutes(event.start_time);
    const endMinutes   = toMinutes(endTime);
    const endDate = endMinutes <= startMinutes ? nextDay(event.start_date) : event.start_date;

    startObj = { dateTime: buildRFC3339(event.start_date, event.start_time), timeZone: 'America/Sao_Paulo' };
    endObj   = { dateTime: buildRFC3339(endDate, endTime),                   timeZone: 'America/Sao_Paulo' };
  }

  const requestBody: any = {
    summary: event.title,
    start: startObj,
    end: endObj,
    attendees: buildAttendees(event),
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 30 }],
    },
  };

  if (event.description) requestBody.description = event.description;
  if (event.location)    requestBody.location    = event.location;

  const response = await calendar.events.insert({
    calendarId: calId,
    requestBody,
    sendUpdates: 'all',
  });

  const evt = response.data;

  if (!evt.id) {
    throw new Error('Calendar API did not return an event ID');
  }

  return {
    success: true,
    google_event_id: evt.id,
    calendar_id: calId,
    event_link: evt.htmlLink ?? '',
    title: event.title,
    start_iso: evt.start?.dateTime ?? evt.start?.date ?? '',
    end_iso:   evt.end?.dateTime   ?? evt.end?.date   ?? '',
    created_at: Date.now(),
  };
}

/**
 * Delete a Google Calendar event (used by undo).
 */
export async function deleteCalendarEvent(
  calendarId: string,
  googleEventId: string
): Promise<void> {
  const calendar = getCalendarClient();
  await calendar.events.delete({
    calendarId,
    eventId: googleEventId,
    sendUpdates: 'all',
  });
}

export { DEFAULT_CALENDAR_ID, OWNER_EMAIL };
