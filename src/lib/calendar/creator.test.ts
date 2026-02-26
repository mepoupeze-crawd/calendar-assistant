/**
 * Creator unit tests - validates argument building and gog dry-run
 * Run: npx ts-node src/lib/calendar/creator.test.ts
 */

import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

// ---- Test Helpers ----

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e: unknown) {
    const err = e as Error;
    console.log(`❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, label?: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label || "assertEqual"}: got ${a}, expected ${b}`);
  }
}

function assertIncludes(arr: string[], value: string, label?: string) {
  if (!arr.includes(value)) {
    throw new Error(`${label || "assertIncludes"}: "${value}" not in [${arr.join(", ")}]`);
  }
}

// ---- Import target functions ----
// We re-implement the private helpers here to test them directly
// (since they're not exported — they could be exported for testing)

function buildRFC3339(date: string, time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  const [year, month, day] = date.split("-");
  const H = pad(hours);
  const min = pad(minutes);
  return `${year}-${month}-${day}T${H}:${min}:00-03:00`;
}

function computeEndTime(startTime: string, durationMinutes: number): string {
  const [h, m] = startTime.split(":").map(Number);
  const totalMinutes = h * 60 + m + durationMinutes;
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

// ---- Tests ----

test("buildRFC3339: basic time", () => {
  const result = buildRFC3339("2026-02-22", "14:30");
  assertEqual(result, "2026-02-22T14:30:00-03:00");
});

test("buildRFC3339: midnight", () => {
  const result = buildRFC3339("2026-03-01", "00:00");
  assertEqual(result, "2026-03-01T00:00:00-03:00");
});

test("buildRFC3339: end of day", () => {
  const result = buildRFC3339("2026-02-22", "23:59");
  assertEqual(result, "2026-02-22T23:59:00-03:00");
});

test("computeEndTime: 1h from 14:30", () => {
  assertEqual(computeEndTime("14:30", 60), "15:30");
});

test("computeEndTime: 30min from 23:45 (wraps midnight)", () => {
  assertEqual(computeEndTime("23:45", 30), "00:15");
});

test("computeEndTime: 90min from 09:00", () => {
  assertEqual(computeEndTime("09:00", 90), "10:30");
});

test("computeEndTime: 45min from 14:30", () => {
  assertEqual(computeEndTime("14:30", 45), "15:15");
});

// ---- Gog Dry-Run Test ----

async function testGogDryRun() {
  console.log("\n--- gog calendar create --dry-run test ---");
  try {
    const { stdout, stderr } = await execFileAsync(
      "gog",
      [
        "calendar", "create", "mepoupeze@gmail.com",
        "--account", "mepoupeze@gmail.com",
        "--dry-run",
        "--summary", "Teste Calendar Assistant",
        "--from", "2026-02-28T14:30:00-03:00",
        "--to", "2026-02-28T15:30:00-03:00",
        "--attendees", "jgcalice@gmail.com",
        "--reminder", "popup:30m",
      ],
      { timeout: 15_000 }
    );
    console.log("✅ gog dry-run succeeded");
    if (stdout) console.log("  stdout:", stdout.slice(0, 200));
    if (stderr) console.log("  stderr:", stderr.slice(0, 200));
    passed++;
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    console.log("❌ gog dry-run failed:", err.stderr || err.message);
    failed++;
  }
}

// ---- Undo Store Tests ----

import { undoStore } from "./undo-store";

test("undoStore: add and consume within window", () => {
  const now = Date.now();
  undoStore.add("test-evt-1", {
    google_event_id: "gcal-abc-123",
    calendar_id: "mepoupeze@gmail.com",
    event_title: "Reunião teste",
    created_at: now,
  });

  const state = undoStore.consume("test-evt-1");
  if (!state) throw new Error("Expected UndoState, got null");
  assertEqual(state.google_event_id, "gcal-abc-123");
  assertEqual(state.event_title, "Reunião teste");
});

test("undoStore: consume returns null after consuming", () => {
  const now = Date.now();
  undoStore.add("test-evt-2", {
    google_event_id: "gcal-xyz-456",
    calendar_id: "mepoupeze@gmail.com",
    event_title: "Almoço",
    created_at: now,
  });
  undoStore.consume("test-evt-2");
  const second = undoStore.consume("test-evt-2");
  assertEqual(second, null);
});

test("undoStore: isAlive returns true for fresh entry", () => {
  undoStore.add("test-evt-3", {
    google_event_id: "gcal-999",
    calendar_id: "mepoupeze@gmail.com",
    event_title: "Jantar",
    created_at: Date.now(),
  });
  const alive = undoStore.isAlive("test-evt-3");
  assertEqual(alive, true);
  // Cleanup
  undoStore.consume("test-evt-3");
});

test("undoStore: returns null for unknown event ID", () => {
  const result = undoStore.consume("nonexistent-event-id-xyz");
  assertEqual(result, null);
});

// ---- Notifier Tests ----

import { buildNotificationMessage, buildNotificationKeyboard, buildUndoSuccessMessage } from "./notifier";

test("buildNotificationMessage: timed event", () => {
  const result = buildNotificationMessage({
    success: true,
    google_event_id: "abc123",
    calendar_id: "mepoupeze@gmail.com",
    event_link: "https://calendar.google.com/event/abc123",
    title: "Reunião com João",
    start_iso: "2026-02-22T14:30:00-03:00",
    end_iso: "2026-02-22T15:30:00-03:00",
    created_at: Date.now(),
  });
  if (!result.includes("Reunião com João")) throw new Error("Missing title");
  if (!result.includes("✅")) throw new Error("Missing check mark");
  if (!result.includes("14:30")) throw new Error("Missing start time");
  if (!result.includes("15:30")) throw new Error("Missing end time");
  if (!result.includes("1h")) throw new Error("Missing duration");
  if (!result.includes("fevereiro")) throw new Error("Missing month");
  console.log("  Preview:\n  " + result.replace(/\n/g, "\n  "));
});

test("buildNotificationMessage: all-day event", () => {
  const result = buildNotificationMessage({
    success: true,
    google_event_id: "abc456",
    calendar_id: "mepoupeze@gmail.com",
    event_link: "https://calendar.google.com/event/abc456",
    title: "Viagem para SP",
    start_iso: "2026-03-15",
    end_iso: "2026-03-15",
    created_at: Date.now(),
  });
  if (!result.includes("Viagem para SP")) throw new Error("Missing title");
  if (result.includes("⏰")) throw new Error("Should not have time for all-day");
  if (!result.includes("março")) throw new Error("Missing month");
});

test("buildNotificationKeyboard: has undo callback", () => {
  const kb = buildNotificationKeyboard("evt_123_abc", "https://cal.google.com");
  const buttons = kb.inline_keyboard.flat();
  const undoBtn = buttons.find(b => b.callback_data?.startsWith("undo:"));
  if (!undoBtn) throw new Error("Missing undo button");
  if (!undoBtn.callback_data?.includes("evt_123_abc")) throw new Error("Wrong event ID in callback");
  const linkBtn = buttons.find(b => b.url);
  if (!linkBtn) throw new Error("Missing link button");
});

test("buildUndoSuccessMessage: contains title", () => {
  const msg = buildUndoSuccessMessage("Almoço com equipe");
  if (!msg.includes("Almoço com equipe")) throw new Error("Missing title");
  if (!msg.includes("↩️")) throw new Error("Missing undo emoji");
});

// ---- Run all async tests ----

testGogDryRun().then(() => {
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
});
