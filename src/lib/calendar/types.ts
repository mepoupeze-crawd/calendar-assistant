/**
 * Calendar Assistant - Core Types
 * Shared interfaces for parser output, validated events, and creation results
 */

/** Parsed event from LLM parser (t2 output / t3 input) */
export interface ParsedParticipant {
  name: string;
  email: string | null;
  resolved: boolean;
}

export interface ParsedEvent {
  status: "success" | "ambiguous" | "error";
  confidence: number;
  title: string | null;
  start_date: string | null; // ISO 8601 date: YYYY-MM-DD
  start_time: string | null; // HH:MM (24h)
  end_time: string | null;   // HH:MM (24h)
  duration_minutes: number | null;
  all_day: boolean;
  participants: ParsedParticipant[];
  description: string | null;
  location: string | null;
  ambiguities: string[];
  raw_input: string;
}

/** Validated event (t3 output / t4 input) */
export interface ValidatedEvent {
  title: string;
  start_date: string;    // YYYY-MM-DD
  start_time: string | null; // HH:MM or null if all_day
  end_time: string | null;
  duration_minutes: number | null;
  all_day: boolean;
  participants: ParsedParticipant[];
  description: string | null;
  location: string | null;
}

/** Event creation request (t5 input) */
export interface CalendarCreateRequest {
  event: ValidatedEvent;
  event_id: string;           // Frontend event ID (for Telegram callback tracking)
  calendar_id: string;        // Google Calendar ID (default: primary account)
  owner_email: string;        // Always auto-added as attendee
}

/** Created event result (t5 output) */
export interface CalendarCreateResult {
  success: boolean;
  google_event_id: string;    // Google Calendar event ID (for undo)
  calendar_id: string;
  event_link: string;         // Google Calendar event URL
  title: string;
  start_iso: string;          // Full RFC3339 start datetime
  end_iso: string;            // Full RFC3339 end datetime
  created_at: number;         // Unix timestamp ms (for undo window)
  error?: string;
}

/** Undo state (t6 / t12) */
export interface UndoState {
  google_event_id: string;
  calendar_id: string;
  event_title: string;
  created_at: number;         // Unix timestamp ms
  undo_deadline: number;      // created_at + 2min (120,000 ms)
  telegram_message_id?: number; // Message to edit when undo expires
}
