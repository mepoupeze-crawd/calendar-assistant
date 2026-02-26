/**
 * Undo Store (t12 / t6)
 * In-memory store for pending undo states.
 * Entries expire after UNDO_WINDOW_MS (2 minutes).
 *
 * Usage:
 *   - After event creation: undoStore.add(eventId, state)
 *   - When user clicks undo: undoStore.consume(eventId) → UndoState | null
 *   - Automatic cleanup via expiry check
 */

import type { UndoState } from "./types";

const UNDO_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

class UndoStore {
  private store = new Map<string, UndoState>();

  /**
   * Add an undo entry after event creation.
   * @param frontendEventId  The event ID from Telegram callback (evt_{ts}_{hex})
   * @param state            UndoState with Google event ID + metadata
   */
  add(frontendEventId: string, state: Omit<UndoState, "undo_deadline">): void {
    const entry: UndoState = {
      ...state,
      undo_deadline: state.created_at + UNDO_WINDOW_MS,
    };
    this.store.set(frontendEventId, entry);

    // Auto-remove after window expires (+ 5s grace)
    setTimeout(() => {
      this.store.delete(frontendEventId);
    }, UNDO_WINDOW_MS + 5_000);
  }

  /**
   * Consume an undo entry (removes it from store).
   * Returns null if expired or not found.
   */
  consume(frontendEventId: string): UndoState | null {
    const entry = this.store.get(frontendEventId);
    if (!entry) return null;

    if (Date.now() > entry.undo_deadline) {
      this.store.delete(frontendEventId);
      return null;
    }

    this.store.delete(frontendEventId);
    return entry;
  }

  /**
   * Peek at an undo entry without consuming it.
   * Returns null if expired or not found.
   */
  peek(frontendEventId: string): UndoState | null {
    const entry = this.store.get(frontendEventId);
    if (!entry) return null;
    if (Date.now() > entry.undo_deadline) {
      this.store.delete(frontendEventId);
      return null;
    }
    return entry;
  }

  /**
   * Check if an undo entry is still valid (within window).
   */
  isAlive(frontendEventId: string): boolean {
    return this.peek(frontendEventId) !== null;
  }

  /**
   * Get remaining time in seconds for undo window.
   */
  remainingSeconds(frontendEventId: string): number {
    const entry = this.peek(frontendEventId);
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.undo_deadline - Date.now()) / 1000));
  }
}

// Singleton (shared across all imports in the same process)
export const undoStore = new UndoStore();
export { UNDO_WINDOW_MS };
