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
    it('prunes oldest user messages when maxMessages is exceeded', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 3 });
      store.appendMessage('chat-1', makeMsg('msg-1'));
      store.appendMessage('chat-1', makeMsg('msg-2'));
      store.appendMessage('chat-1', makeMsg('msg-3'));
      store.appendMessage('chat-1', makeMsg('msg-4'));

      const state = store.get('chat-1')!;
      expect(state.messages).toHaveLength(3);
      expect(state.messages[0].content).toBe('msg-2');
      expect(state.messages[2].content).toBe('msg-4');
    });

    it('approximately bounds growth across many appends (allows slack to preserve tool-call pairs)', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 2 });
      for (let i = 1; i <= 10; i++) {
        store.appendMessage('chat-1', makeMsg(`msg-${i}`));
      }
      const state = store.get('chat-1')!;
      // We allow more than maxMessages in worst case to avoid splitting tool pairs,
      // but with all-user messages it should hit exactly the cap.
      expect(state.messages.length).toBeLessThanOrEqual(2);
      expect(state.messages[state.messages.length - 1].content).toBe('msg-10');
    });
  });

  describe('2b. pruning preserves system messages and tool-call/tool pairs', () => {
    it('never prunes leading system messages', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 3 });
      store.appendMessage('chat-1', makeMsg('system prompt', 'system'));
      for (let i = 1; i <= 10; i++) {
        store.appendMessage('chat-1', makeMsg(`u-${i}`, 'user'));
      }
      const state = store.get('chat-1')!;
      expect(state.messages[0].role).toBe('system');
      expect(state.messages[0].content).toBe('system prompt');
    });

    it('never leaves an orphan tool message at the head of the kept region', () => {
      // Reproduce the production bug: assistant(tool_calls) + tool(result) + assistant(reply)
      // pattern repeated many times, then a small maxMessages forcing a cut.
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 4 });
      store.appendMessage('chat-1', makeMsg('system', 'system'));
      store.appendMessage('chat-1', makeMsg('u1', 'user'));
      const asst1: AgentMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'foo', arguments: '{}' } }],
      };
      const tool1: AgentMessage = { role: 'tool', content: '{}', tool_call_id: 'tc1', name: 'foo' };
      store.appendMessage('chat-1', asst1);
      store.appendMessage('chat-1', tool1);
      store.appendMessage('chat-1', makeMsg('assistant final', 'assistant'));
      store.appendMessage('chat-1', makeMsg('u2', 'user'));
      store.appendMessage('chat-1', makeMsg('assistant final 2', 'assistant'));

      const state = store.get('chat-1')!;
      // System always preserved at index 0
      expect(state.messages[0].role).toBe('system');
      // The first non-system message must be a valid head: user OR assistant-without-tool_calls.
      // It must NEVER be a `tool` message (that would orphan it from its tool_calls parent).
      const firstNonSystem = state.messages.find(m => m.role !== 'system')!;
      expect(firstNonSystem.role).not.toBe('tool');
      if (firstNonSystem.role === 'assistant') {
        expect(firstNonSystem.tool_calls).toBeUndefined();
      }
    });

    it('keeps the assistant-with-tool_calls and its tool result together when both fit', () => {
      const store = new ConversationStore({ ttlMs: 60_000, maxMessages: 5 });
      store.appendMessage('chat-1', makeMsg('system', 'system'));
      store.appendMessage('chat-1', makeMsg('old user', 'user'));
      store.appendMessage('chat-1', makeMsg('older assistant', 'assistant'));
      const asst: AgentMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'foo', arguments: '{}' } }],
      };
      const toolResult: AgentMessage = { role: 'tool', content: '{"ok":true}', tool_call_id: 'tc1', name: 'foo' };
      store.appendMessage('chat-1', asst);
      store.appendMessage('chat-1', toolResult);
      store.appendMessage('chat-1', makeMsg('final assistant', 'assistant'));

      const state = store.get('chat-1')!;
      // Validate invariant: every tool message has a preceding assistant with matching tool_call id.
      for (let i = 0; i < state.messages.length; i++) {
        if (state.messages[i].role === 'tool') {
          const tcId = state.messages[i].tool_call_id;
          const prevAsst = [...state.messages.slice(0, i)].reverse()
            .find(m => m.role === 'assistant' && m.tool_calls);
          expect(prevAsst).toBeDefined();
          expect(prevAsst!.tool_calls!.some(tc => tc.id === tcId)).toBe(true);
        }
      }
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

describe('setImageLink', () => {
  it('armazena imageLink no state', () => {
    const store = new ConversationStore({ ttlMs: 60000, maxMessages: 20 });
    store.setImageLink('chat-1', 'https://drive.google.com/file/d/abc/view');
    const state = store.get('chat-1');
    expect(state?.imageLink).toBe('https://drive.google.com/file/d/abc/view');
  });

  it('aceita undefined para limpar o link', () => {
    const store = new ConversationStore({ ttlMs: 60000, maxMessages: 20 });
    store.setImageLink('chat-1', 'https://drive.google.com/file/d/abc/view');
    store.setImageLink('chat-1', undefined);
    const state = store.get('chat-1');
    expect(state?.imageLink).toBeUndefined();
  });

  it('clear() remove o imageLink junto com o resto do state', () => {
    const store = new ConversationStore({ ttlMs: 60000, maxMessages: 20 });
    store.setImageLink('chat-1', 'https://drive.google.com/file/d/abc/view');
    store.clear('chat-1');
    expect(store.get('chat-1')).toBeNull();
  });
});
