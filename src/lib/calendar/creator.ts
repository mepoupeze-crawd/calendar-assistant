/**
 * Calendar Creator (t5 - Google Calendar Integration via gog)
 * Creates events using the `gog calendar create` CLI.
 * Never called without prior user confirmation.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type {
  CalendarCreateRequest,
  CalendarCreateResult,
  ValidatedEvent,
} from "./types";

const execFileAsync = promisify(execFile);

// Fixed owner email always included as attendee
const OWNER_EMAIL = "jgcalice@gmail.com";
// Default gog account (set via GOG_ACCOUNT env or explicit --account flag)
// service.json + Alf configured for mepoupz@gmail.com
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || "mepoupz@gmail.com";
// Default calendar: primary (use email as calendarId for primary calendar)
const DEFAULT_CALENDAR_ID = GOG_ACCOUNT;

/**
 * Build RFC3339 datetime string from date (YYYY-MM-DD) and time (HH:MM).
 * Uses America/Sao_Paulo timezone (UTC-3).
 */
function buildRFC3339(date: string, time: string): string {
  // date = "2026-02-22", time = "14:30"
  const [hours, minutes] = time.split(":").map(Number);
  const d = new Date(`${date}T${time}:00`);
  // Treat the input as local São Paulo time (UTC-3)
  // JavaScript Date parses without timezone as local — we adjust manually
  const utcOffset = -3 * 60; // São Paulo: UTC-3 (non-DST)
  const utcMs = d.getTime() - utcOffset * 60 * 1000;
  const utcDate = new Date(utcMs);
  // Return as RFC3339 with explicit offset
  const pad = (n: number) => String(n).padStart(2, "0");
  const Y = d.getFullYear();
  const M = pad(d.getMonth() + 1);
  const D = pad(d.getDate());
  const H = pad(hours);
  const min = pad(minutes);
  return `${Y}-${M}-${D}T${H}:${min}:00-03:00`;
}

/**
 * Compute end time from start + duration_minutes if end_time not specified.
 */
function computeEndTime(startTime: string, durationMinutes: number): string {
  const [h, m] = startTime.split(":").map(Number);
  const totalMinutes = h * 60 + m + durationMinutes;
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

/**
 * Build gog calendar create arguments from a validated event.
 */
function buildGogArgs(
  req: CalendarCreateRequest
): string[] {
  const { event, calendar_id } = req;
  const calId = calendar_id || DEFAULT_CALENDAR_ID;

  const args: string[] = [
    "calendar",
    "create",
    calId,
    "--account", GOG_ACCOUNT,
    "--json",
    "--no-input",
    "--force",
    "--summary", event.title,
  ];

  if (event.all_day) {
    // All-day event: use date-only format
    args.push("--all-day");
    args.push("--from", event.start_date);
    // For all-day events, end = same day or +1 if multi-day
    args.push("--to", event.start_date);
  } else {
    // Timed event
    if (!event.start_time) {
      throw new Error("start_time is required for non-all-day events");
    }

    let endTime = event.end_time;
    if (!endTime) {
      // Fallback: use duration or default 1h
      const duration = event.duration_minutes ?? 60;
      endTime = computeEndTime(event.start_time, duration);
    }

    const fromRFC3339 = buildRFC3339(event.start_date, event.start_time);
    const toRFC3339 = buildRFC3339(event.start_date, endTime);

    args.push("--from", fromRFC3339);
    args.push("--to", toRFC3339);
  }

  // Always add owner
  const attendees: string[] = [OWNER_EMAIL];

  // Add resolved participants (skip unresolved emails)
  if (event.participants?.length) {
    for (const p of event.participants) {
      if (p.email && p.email !== OWNER_EMAIL) {
        attendees.push(p.email);
      }
    }
  }

  args.push("--attendees", attendees.join(","));

  if (event.description) {
    args.push("--description", event.description);
  }

  if (event.location) {
    args.push("--location", event.location);
  }

  // Default: 30-min popup reminder
  args.push("--reminder", "popup:30m");

  return args;
}

/**
 * Parse gog JSON output to extract the event ID and link.
 */
function parseGogOutput(raw: string): { eventId: string; htmlLink: string; start: string; end: string } {
  try {
    const parsed = JSON.parse(raw);
    // gog returns: { event: { id, htmlLink, start: { dateTime | date }, end: { dateTime | date } } }
    const evt = parsed.event ?? parsed;
    return {
      eventId: evt.id,
      htmlLink: evt.htmlLink,
      start: evt.start?.dateTime ?? evt.start?.date ?? "",
      end: evt.end?.dateTime ?? evt.end?.date ?? "",
    };
  } catch {
    throw new Error(`Failed to parse gog output: ${raw.slice(0, 200)}`);
  }
}

/**
 * Create a Google Calendar event via gog CLI.
 * Returns result with google_event_id for undo tracking.
 */
export async function createCalendarEvent(
  req: CalendarCreateRequest
): Promise<CalendarCreateResult> {
  const args = buildGogArgs(req);

  let stdout: string;
  let stderr: string;

  try {
    const result = await execFileAsync("gog", args, {
      timeout: 30_000,
      env: { ...process.env, GOG_ACCOUNT },
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `gog calendar create failed: ${e.stderr || e.message || String(err)}`
    );
  }

  const { eventId, htmlLink, start, end } = parseGogOutput(stdout);
  const createdAt = Date.now();

  return {
    success: true,
    google_event_id: eventId,
    calendar_id: req.calendar_id || DEFAULT_CALENDAR_ID,
    event_link: htmlLink,
    title: req.event.title,
    start_iso: start,
    end_iso: end,
    created_at: createdAt,
  };
}

/**
 * Delete a Google Calendar event (used by undo).
 */
export async function deleteCalendarEvent(
  calendarId: string,
  googleEventId: string
): Promise<void> {
  try {
    await execFileAsync(
      "gog",
      ["calendar", "delete", calendarId, googleEventId, "--force", "--no-input", "--account", GOG_ACCOUNT],
      { timeout: 15_000, env: { ...process.env, GOG_ACCOUNT } }
    );
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `gog calendar delete failed: ${e.stderr || e.message || String(err)}`
    );
  }
}

export { DEFAULT_CALENDAR_ID, OWNER_EMAIL };
