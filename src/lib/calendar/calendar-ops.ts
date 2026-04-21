import { google, calendar_v3 } from 'googleapis';
import { getGoogleAuth } from './google-auth';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

export interface CalendarEventSummary {
  id: string;
  summary: string;
  start: string | null; // ISO datetime or date
  end: string | null;
  location?: string | null;
  attendees?: Array<{ email: string; displayName?: string }>;
}

// Internal helper
function client(): calendar_v3.Calendar {
  return google.calendar({ version: 'v3', auth: getGoogleAuth() });
}

function toRange(daysAhead: number): { timeMin: string; timeMax: string } {
  const now = new Date();
  const max = new Date(now);
  max.setDate(max.getDate() + daysAhead);
  return { timeMin: now.toISOString(), timeMax: max.toISOString() };
}

function toSummary(e: calendar_v3.Schema$Event): CalendarEventSummary {
  return {
    id: e.id!,
    summary: e.summary ?? '(sem título)',
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    location: e.location ?? null,
    attendees: e.attendees?.map(a => ({
      email: a.email!,
      displayName: a.displayName ?? undefined,
    })),
  };
}

export async function listUpcomingEvents(
  opts: { daysAhead?: number }
): Promise<CalendarEventSummary[]> {
  const { timeMin, timeMax } = toRange(opts.daysAhead ?? 7);
  const cal = client();
  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return (res.data.items ?? []).map(toSummary);
}

export async function searchEventsByQuery(
  opts: { query: string; daysAhead?: number }
): Promise<CalendarEventSummary[]> {
  const { timeMin, timeMax } = toRange(opts.daysAhead ?? 30);
  const cal = client();
  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    q: opts.query,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return (res.data.items ?? []).map(toSummary);
}

export async function updateEvent(
  eventId: string,
  patch: calendar_v3.Schema$Event
): Promise<{ google_event_id: string; event_link: string }> {
  const cal = client();
  const res = await cal.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: patch,
  });
  return {
    google_event_id: res.data.id!,
    event_link: res.data.htmlLink ?? '',
  };
}

export async function deleteEvent(eventId: string): Promise<void> {
  const cal = client();
  await cal.events.delete({
    calendarId: CALENDAR_ID,
    eventId,
  });
}
