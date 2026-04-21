/**
 * ConversationStore Tests
 * TDD: tests written first, then implementation.
 */

import { ConversationStore, AgentMessage } from './conversation-store';
import { ValidatedEvent } from './types';

const makeMsg = (content: string, role: AgentMessage['role'] = 'user'): AgentMessage => ({
  role,
  content,
});

const sampleDraft: ValidatedEvent = {
  title: 'Meeting',
  start_date: '2026-04-21',
  start_time: '10:00',
  end_time: '11:00',
  duration_minutes: 60,
  all_day: false,
  participants: [],
  description: null,
  location: null,
};

describe('ConversationStore', () => {
  describe('1. stores and retrieves per chat (isolated chats)', () => {
    it('returns null for unknown chat', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 10 });
      expect(store.get('chat-unknown')).toBeNull();
    });

    it('getOrCreate creates fresh state for new chat', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 10 });
      const state = store.getOrCreate('chat-1');
      expect(state.messages).toEqual([]);
      expect(state.draft).toBeNull();
      expect(typeof state.lastUsed).toBe('number');
    });

    it('two chats are isolated from each other', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 10 });
      store.appendMessage('chat-A', makeMsg('hello from A'));
      store.appendMessage('chat-B', makeMsg('hello from B'));

      const stateA = store.get('chat-A')!;
      const stateB = store.get('chat-B')!;

      expect(stateA.messages).toHaveLength(1);
      expect(stateA.messages[0].content).toBe('hello from A');
      expect(stateB.messages).toHaveLength(1);
      expect(stateB.messages[0].content).toBe('hello from B');
    });

    it('getOrCreate returns existing state on second call', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 10 });
      store.appendMessage('chat-1', makeMsg('first'));
      const state = store.getOrCreate('chat-1');
      expect(state.messages).toHaveLength(1);
    });
  });

  describe('2. FIFO pruning when exceeding maxMessages', () => {
    it('prunes oldest messages when maxMessages is exceeded', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 3 });
      store.appendMessage('chat-1', makeMsg('msg-1'));
      store.appendMessage('chat-1', makeMsg('msg-2'));
      store.appendMessage('chat-1', makeMsg('msg-3'));
      store.appendMessage('chat-1', makeMsg('msg-4')); // should prune msg-1

      const state = store.get('chat-1')!;
      expect(state.messages).toHaveLength(3);
      expect(state.messages[0].content).toBe('msg-2');
      expect(state.messages[2].content).toBe('msg-4');
    });

    it('keeps exactly maxMessages after many appends', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 2 });
      for (let i = 1; i <= 10; i++) {
        store.appendMessage('chat-1', makeMsg(`msg-${i}`));
      }
      const state = store.get('chat-1')!;
      expect(state.messages).toHaveLength(2);
      expect(state.messages[0].content).toBe('msg-9');
      expect(state.messages[1].content).toBe('msg-10');
    });
  });

  describe('3. expires after TTL → get returns null', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('get returns state before TTL expires', () => {
      const store = new ConversationStore({ ttlMs: 5_000, maxMessages: 10 });
      store.getOrCreate('chat-ttl');
      jest.advanceTimersByTime(4_000);
      expect(store.get('chat-ttl')).not.toBeNull();
    });

    it('get returns null after TTL expires', () => {
      const store = new ConversationStore({ ttlMs: 5_000, maxMessages: 10 });
      store.getOrCreate('chat-ttl');
      jest.advanceTimersByTime(5_001);
      expect(store.get('chat-ttl')).toBeNull();
    });

    it('appendMessage updates lastUsed, resetting TTL window', () => {
      const store = new ConversationStore({ ttlMs: 5_000, maxMessages: 10 });
      store.getOrCreate('chat-ttl');
      jest.advanceTimersByTime(4_000);
      store.appendMessage('chat-ttl', makeMsg('ping')); // resets lastUsed
      jest.advanceTimersByTime(4_000); // total 8s but only 4s since last activity
      expect(store.get('chat-ttl')).not.toBeNull();
    });
  });

  describe('4. clear removes conversation', () => {
    it('clear makes get return null', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 10 });
      store.appendMessage('chat-1', makeMsg('hello'));
      store.clear('chat-1');
      expect(store.get('chat-1')).toBeNull();
    });

    it('clear on non-existent chat does not throw', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 10 });
      expect(() => store.clear('chat-nonexistent')).not.toThrow();
    });

    it('after clear, getOrCreate creates a fresh state', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 10 });
      store.appendMessage('chat-1', makeMsg('hello'));
      store.setDraft('chat-1', sampleDraft);
      store.clear('chat-1');
      const fresh = store.getOrCreate('chat-1');
      expect(fresh.messages).toHaveLength(0);
      expect(fresh.draft).toBeNull();
    });
  });

  describe('5. setDraft', () => {
    it('sets and retrieves draft on state', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 10 });
      store.setDraft('chat-1', sampleDraft);
      const state = store.get('chat-1')!;
      expect(state.draft).toEqual(sampleDraft);
    });

    it('setDraft with null clears the draft', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 10 });
      store.setDraft('chat-1', sampleDraft);
      store.setDraft('chat-1', null);
      const state = store.get('chat-1')!;
      expect(state.draft).toBeNull();
    });
  });

  describe('6. setLastCreatedEventId', () => {
    it('stores and retrieves lastCreatedEventId', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 20 });
      store.setLastCreatedEventId('c', 'abc-123');
      expect(store.get('c')?.lastCreatedEventId).toBe('abc-123');
    });

    it('overwrites with a second call', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 20 });
      store.setLastCreatedEventId('c', 'id-1');
      store.setLastCreatedEventId('c', 'id-2');
      expect(store.get('c')?.lastCreatedEventId).toBe('id-2');
    });

    it('clear removes lastCreatedEventId', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 20 });
      store.setLastCreatedEventId('c', 'abc-123');
      store.clear('c');
      expect(store.get('c')).toBeNull();
    });
  });
});
