// src/lib/calendar/pending-ops-store.ts

export type PendingOp =
  | { type: 'update'; google_event_id: string; patch: Record<string, unknown>; summary: string; expiresAt: number }
  | { type: 'delete'; google_event_id: string; summary: string; expiresAt: number };

export class PendingOpsStore {
  private readonly data = new Map<string, PendingOp>();
  private readonly ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) { // 5 minutes default
    this.ttlMs = ttlMs;
  }

  set(opId: string, op: Omit<PendingOp, 'expiresAt'>): void {
    this.data.set(opId, { ...op, expiresAt: Date.now() + this.ttlMs } as PendingOp);
  }

  get(opId: string): PendingOp | null {
    const o = this.data.get(opId);
    if (!o) return null;
    if (Date.now() > o.expiresAt) {
      this.data.delete(opId);
      return null;
    }
    return o;
  }

  delete(opId: string): void {
    this.data.delete(opId);
  }
}

// Singleton exported for use in agent-tools.ts and bot.ts
export const pendingOpsStore = new PendingOpsStore();
