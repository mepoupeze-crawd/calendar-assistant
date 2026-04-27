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
  imageLink?: string;          // ← add this line
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
   * Appends `msg` to the message history for `chatId`. When over `maxMessages`,
   * prunes the oldest messages — but never:
   *  (a) drops leading `system` messages, and
   *  (b) leaves a `tool` message at the head of the kept region (orphaning it
   *      from its `assistant(tool_calls)` parent triggers OpenAI 400).
   * The cap is therefore soft: the history may briefly exceed `maxMessages`
   * to keep tool-call/tool pairs intact.
   */
  appendMessage(chatId: string, msg: AgentMessage): void {
    const state = this.getOrCreate(chatId);
    state.messages.push(msg);
    this.pruneSafely(state.messages);
    state.lastUsed = Date.now();
  }

  private pruneSafely(messages: AgentMessage[]): void {
    if (messages.length <= this.maxMessages) return;

    let dropStart = 0;
    while (dropStart < messages.length && messages[dropStart].role === 'system') {
      dropStart++;
    }

    let dropEnd = Math.min(
      messages.length,
      dropStart + (messages.length - this.maxMessages)
    );

    // Advance dropEnd until the kept head is a safe boundary:
    //   - role 'user': start of a fresh turn
    //   - role 'assistant' WITHOUT tool_calls: a final reply
    // Skip past tool messages and assistant-with-tool_calls (would be orphaned).
    while (dropEnd < messages.length) {
      const head = messages[dropEnd];
      if (head.role === 'user') break;
      if (head.role === 'assistant' && !head.tool_calls) break;
      dropEnd++;
    }

    if (dropEnd >= messages.length) return; // would prune all non-system; abort
    if (dropEnd <= dropStart) return;

    messages.splice(dropStart, dropEnd - dropStart);
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
   * Pass `undefined` to clear stale event IDs after a successful update.
   */
  setLastCreatedEventId(chatId: string, eventId: string | undefined): void {
    const state = this.getOrCreate(chatId);
    state.lastCreatedEventId = eventId;
    state.lastUsed = Date.now();
  }

  setImageLink(chatId: string, imageLink: string | undefined): void {
    const state = this.getOrCreate(chatId);
    state.imageLink = imageLink;
    state.lastUsed = Date.now();
  }

  /**
   * Removes all state for `chatId`. Subsequent `get` calls will return `null`.
   */
  clear(chatId: string): void {
    this.map.delete(chatId);
  }
}
