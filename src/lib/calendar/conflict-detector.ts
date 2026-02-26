/**
 * Calendar Assistant - Conflict Detection (t8)
 * Checks Google Calendar for overlapping events
 * 
 * BUSINESS RULE (João's decisions):
 * - Detect overlaps in event time window
 * - Exact boundary OK: end of one = start of another
 * - Return conflicting event details (title, time)
 */

import { ValidatedEvent } from './types';

export interface CalendarEvent {
  id: string;
  title: string;
  start: {
    dateTime?: string; // RFC3339
    date?: string;     // YYYY-MM-DD (all-day)
  };
  end: {
    dateTime?: string;
    date?: string;
  };
}

export interface ConflictCheck {
  has_conflicts: boolean;
  conflicts: ConflictInfo[];
}

export interface ConflictInfo {
  title: string;
  start_time: string; // HH:MM
  end_time: string;   // HH:MM
  calendar_event_id: string;
  event_date: string; // YYYY-MM-DD
}

/**
 * Check for conflicts in Google Calendar
 * Calls gog CLI to fetch events for the event's date, then checks overlaps
 */
export async function checkCalendarConflicts(
  event: ValidatedEvent,
  calendarId: string = 'primary'
): Promise<ConflictCheck> {
  try {
    // Fetch all events on the event's date from Google Calendar
    const dayEvents = await fetchEventsForDate(event.start_date, calendarId);

    // If all-day event, no time-based conflicts
    if (event.all_day) {
      return {
        has_conflicts: false,
        conflicts: [],
      };
    }

    // Check for overlaps (excluding exact boundaries)
    const conflicts = findOverlappingEvents(
      event,
      dayEvents
    );

    return {
      has_conflicts: conflicts.length > 0,
      conflicts,
    };
  } catch (error) {
    console.error('[ConflictDetector] Error:', error);
    // Fail open: don't block event creation on API error
    return {
      has_conflicts: false,
      conflicts: [],
    };
  }
}

/**
 * Helper: Fetch events for a specific date via gog CLI
 * (In production, uses `gog calendar events <calendarId> --from <date>T00:00 --to <date>T23:59`)
 */
async function fetchEventsForDate(
  date: string, // YYYY-MM-DD
  calendarId: string
): Promise<CalendarEvent[]> {
  // TODO: Integrate with gog CLI
  // Example command:
  // gog calendar events <calendarId> \
  //   --from <date>T00:00:00-03:00 \
  //   --to <date>T23:59:59-03:00 \
  //   --json

  console.log(`[ConflictDetector] Fetching events for ${date} (calendar: ${calendarId})`);

  // Mock: return empty list (will be replaced with gog integration)
  return [];
}

/**
 * Helper: Find overlapping events
 * Overlap = (newStart < existingEnd) AND (newEnd > existingStart)
 * Exact boundary is OK: (newStart == existingEnd) or (newEnd == existingStart)
 */
function findOverlappingEvents(
  newEvent: ValidatedEvent,
  existingEvents: CalendarEvent[]
): ConflictInfo[] {
  if (!newEvent.start_time || newEvent.all_day) {
    return [];
  }

  const newStart = timeToMinutes(newEvent.start_time);
  const newEnd = newEvent.end_time
    ? timeToMinutes(newEvent.end_time)
    : calculateEndTime(newEvent.start_time, newEvent.duration_minutes);

  const conflicts: ConflictInfo[] = [];

  existingEvents.forEach((evt) => {
    if (!evt.start.dateTime && !evt.start.date) {
      return; // Skip malformed events
    }

    // Extract time from event
    const existingStart = extractTimeFromEvent(evt.start);
    const existingEnd = extractTimeFromEvent(evt.end);

    if (!existingStart || !existingEnd) {
      return; // Skip all-day or malformed events
    }

    const existingStartMin = timeToMinutes(existingStart);
    const existingEndMin = timeToMinutes(existingEnd);

    // Check overlap (excluding exact boundaries)
    if (isOverlapping(newStart, newEnd, existingStartMin, existingEndMin)) {
      conflicts.push({
        title: evt.title,
        start_time: existingStart,
        end_time: existingEnd,
        calendar_event_id: evt.id,
        event_date: newEvent.start_date,
      });
    }
  });

  return conflicts;
}

/**
 * Helper: Check if two time ranges overlap
 * Overlap = (start1 < end2) AND (start2 < end1)
 * Exact boundaries are NOT overlaps
 */
function isOverlapping(
  start1: number,
  end1: number,
  start2: number,
  end2: number
): boolean {
  // Strict overlap (exact boundaries don't count)
  return start1 < end2 && start2 < end1;
}

/**
 * Helper: Convert HH:MM to minutes since midnight
 */
function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

/**
 * Helper: Calculate end time from start + duration
 */
function calculateEndTime(startTime: string, durationMinutes?: number | null): number {
  const startMin = timeToMinutes(startTime);
  return startMin + (durationMinutes || 0);
}

/**
 * Helper: Extract HH:MM from RFC3339 datetime
 */
function extractTimeFromEvent(
  timeObj: { dateTime?: string; date?: string }
): string | null {
  if (!timeObj.dateTime) {
    return null; // All-day event
  }

  // RFC3339: 2026-02-25T14:30:00-03:00
  const match = timeObj.dateTime.match(/T(\d{2}):(\d{2})/);
  if (!match) return null;

  return `${match[1]}:${match[2]}`;
}

/**
 * Helper: Format conflict info for user display
 */
export function formatConflictForUser(conflict: ConflictInfo): string {
  return `• ${conflict.title} (${conflict.start_time}–${conflict.end_time})`;
}
