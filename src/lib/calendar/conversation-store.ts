/**
 * ConversationStore — in-memory per-chat conversation state with TTL and FIFO pruning.
 *
 * Used by the agent layer to maintain message history and event drafts across
 * multiple Telegram/webhook messages within the same chat session.
 */

import { ValidatedEvent } from './types';

// ─── Public types ─────────────────────────────────────────────────────────────

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentMessage {
  role: AgentRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  name?: string;
}

export interface ConversationState {
  messages: AgentMessage[];
  draft: ValidatedEvent | null;
  lastCreatedEventId?: string;
  lastUsed: number;
}

// ─── Store options ────────────────────────────────────────────────────────────

export interface ConversationStoreOptions {
  /** Time-to-live in milliseconds. A chat idle for longer than this is treated as expired. */
  ttlMs: number;
  /** Maximum number of messages to retain per chat (FIFO — oldest are pruned first). */
  maxMessages: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class ConversationStore {
  private readonly ttlMs: number;
  private readonly maxMessages: number;
  private readonly map: Map<string, ConversationState> = new Map();

  constructor(options: ConversationStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.maxMessages = options.maxMessages;
  }

  /**
   * Returns the conversation state for `chatId`, or `null` if the chat does
   * not exist or its TTL has expired.
   */
  get(chatId: string): ConversationState | null {
    const state = this.map.get(chatId);
    if (!state) return null;

    if (Date.now() - state.lastUsed > this.ttlMs) {
      // Lazy eviction: clean up the expired entry
      this.map.delete(chatId);
      return null;
    }

    return state;
  }

  /**
   * Returns the existing state for `chatId`, or creates a fresh one if it
   * doesn't exist (or has expired).
   */
  getOrCreate(chatId: string): ConversationState {
    const existing = this.get(chatId);
    if (existing) return existing;

    const fresh: ConversationState = {
      messages: [],
      draft: null,
      lastUsed: Date.now(),
    };
    this.map.set(chatId, fresh);
    return fresh;
  }

  /**
   * Appends `msg` to the message history for `chatId`.
   * If the history exceeds `maxMessages`, the oldest messages are pruned (FIFO).
   * Updates `lastUsed` to reset the TTL window.
   */
  appendMessage(chatId: string, msg: AgentMessage): void {
    const state = this.getOrCreate(chatId);
    state.messages.push(msg);

    // FIFO pruning
    if (state.messages.length > this.maxMessages) {
      state.messages.splice(0, state.messages.length - this.maxMessages);
    }

    state.lastUsed = Date.now();
  }

  /**
   * Sets (or clears) the event draft associated with `chatId`.
   * Creates the state entry if it doesn't exist yet.
   */
  setDraft(chatId: string, draft: ValidatedEvent | null): void {
    const state = this.getOrCreate(chatId);
    state.draft = draft;
    state.lastUsed = Date.now();
  }

  /**
   * Stores the Google Calendar event ID of the most recently created event for `chatId`.
   * Allows the agent to reference the real event ID when the user requests edits.
   */
  setLastCreatedEventId(chatId: string, eventId: string): void {
    const state = this.getOrCreate(chatId);
    state.lastCreatedEventId = eventId;
    state.lastUsed = Date.now();
  }

  /**
   * Removes all state for `chatId`. Subsequent `get` calls will return `null`.
   */
  clear(chatId: string): void {
    this.map.delete(chatId);
  }
}
