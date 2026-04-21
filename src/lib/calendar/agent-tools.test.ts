/**
 * agent-tools Tests
 * TDD: tests written first, then implementation.
 */

import { TOOL_SCHEMAS, getToolHandler, registerHandler } from './agent-tools';
import type { ConversationState } from './conversation-store';
import type { ValidatedEvent } from './types';

function makeState(): ConversationState {
  return { messages: [], draft: null, lastUsed: Date.now() };
}

function makeDraft(): ValidatedEvent {
  return {
    title: 't',
    start_date: '2026-05-01',
    start_time: '10:00',
    end_time: null,
    duration_minutes: null,
    all_day: false,
    participants: [],
    description: null,
    location: null,
  };
}

const EXPECTED_TOOL_NAMES = [
  'propose_event',
  'add_participant',
  'remove_participant',
  'set_participant_email',
  'lookup_contact',
  'show_preview',
  'clear_draft',
  'reply_text',
  'ask_user',
];

describe('agent-tools', () => {
  describe('1. TOOL_SCHEMAS contains the expected tool names', () => {
    it('has at least 9 original schemas', () => {
      expect(TOOL_SCHEMAS.length).toBeGreaterThanOrEqual(9);
    });

    it('contains all original expected tool names', () => {
      const names = TOOL_SCHEMAS.map((s) => s.function.name);
      for (const expectedName of EXPECTED_TOOL_NAMES) {
        expect(names).toContain(expectedName);
      }
    });
  });

  describe('2. Every schema in TOOL_SCHEMAS has a type of function', () => {
    it('all schemas have type === "function"', () => {
      for (const schema of TOOL_SCHEMAS) {
        expect(schema.type).toBe('function');
      }
    });
  });

  describe('3. reply_text and ask_user have registered handlers (stubs)', () => {
    it('reply_text handler is registered', () => {
      expect(getToolHandler('reply_text')).toBeInstanceOf(Function);
    });

    it('ask_user handler is registered', () => {
      expect(getToolHandler('ask_user')).toBeInstanceOf(Function);
    });

    it('Task 3 tools now have handlers registered', () => {
      const toolsWithHandlers = [
        'propose_event',
        'add_participant',
        'remove_participant',
        'set_participant_email',
        'lookup_contact',
        'show_preview',
        'clear_draft',
      ];
      for (const name of toolsWithHandlers) {
        expect(getToolHandler(name)).toBeInstanceOf(Function);
      }
    });
  });

  describe('4. propose_event schema has title and start_date in required array', () => {
    it('propose_event required contains title and start_date', () => {
      const schema = TOOL_SCHEMAS.find((s) => s.function.name === 'propose_event');
      expect(schema).toBeDefined();
      expect(schema!.function.parameters.required).toContain('title');
      expect(schema!.function.parameters.required).toContain('start_date');
    });
  });

  describe('5. reply_text stub handler returns terminal.text equal to text arg', () => {
    it('returns terminal.text matching the text argument', async () => {
      const handler = getToolHandler('reply_text');
      expect(handler).toBeDefined();
      const result = await handler!({ text: 'Hello world' }, makeState(), { chatId: 'chat-1' });
      expect(result.terminal).toBeDefined();
      expect(result.terminal!.text).toBe('Hello world');
    });

    it('handles missing text gracefully', async () => {
      const handler = getToolHandler('reply_text')!;
      const result = await handler({}, makeState(), { chatId: 'chat-1' });
      expect(result.terminal!.text).toBe('');
    });
  });

  describe('6. ask_user stub handler maps escape_buttons to callback_data', () => {
    it('maps escape_buttons with action cancel_flow to agent_escape_cancel_flow', async () => {
      const handler = getToolHandler('ask_user');
      expect(handler).toBeDefined();
      const result = await handler!(
        {
          text: 'What time?',
          escape_buttons: [{ label: 'Cancel', action: 'cancel_flow' }],
        },
        makeState(),
        { chatId: 'chat-1' }
      );
      expect(result.terminal).toBeDefined();
      expect(result.terminal!.text).toBe('What time?');
      expect(result.terminal!.buttons).toBeDefined();
      expect(result.terminal!.buttons![0]).toEqual([
        { text: 'Cancel', callback_data: 'agent_escape_cancel_flow' },
      ]);
    });

    it('returns no buttons when escape_buttons is absent', async () => {
      const handler = getToolHandler('ask_user')!;
      const result = await handler({ text: 'Choose' }, makeState(), { chatId: 'chat-1' });
      expect(result.terminal!.text).toBe('Choose');
      expect(result.terminal!.buttons).toBeUndefined();
    });

    it('maps skip_participant action correctly', async () => {
      const handler = getToolHandler('ask_user')!;
      const result = await handler(
        {
          text: 'Skip?',
          escape_buttons: [{ label: 'Skip', action: 'skip_participant' }],
        },
        makeState(),
        { chatId: 'chat-1' }
      );
      expect(result.terminal!.buttons![0]).toEqual([
        { text: 'Skip', callback_data: 'agent_escape_skip_participant' },
      ]);
    });
  });
});

describe('tool: propose_event', () => {
  it('creates draft from args', async () => {
    const state = makeState();
    const handler = getToolHandler('propose_event')!;
    const result = await handler(
      { title: 'Reunião', start_date: '2026-05-01', start_time: '14:30', participants: [{ name: 'João', email: null }] },
      state,
      { chatId: 'c' }
    );
    result.stateMutator?.(state);
    expect(state.draft).not.toBeNull();
    expect(state.draft!.title).toBe('Reunião');
    expect(state.draft!.participants).toHaveLength(1);
    expect(state.draft!.participants[0].name).toBe('João');
    expect(result.content).toHaveProperty('ok', true);
  });
});

describe('tool: add_participant / remove_participant', () => {
  it('adds participant to existing draft', async () => {
    const state = makeState();
    state.draft = makeDraft();
    await (getToolHandler('add_participant')!({ name: 'Aline' }, state, { chatId: 'c' })).then(r => r.stateMutator?.(state));
    expect(state.draft!.participants.map(p => p.name)).toContain('Aline');
  });

  it('does not duplicate participants (case-insensitive)', async () => {
    const state = makeState();
    state.draft = makeDraft();
    state.draft.participants = [{ name: 'Aline', email: null, resolved: false }];
    await (getToolHandler('add_participant')!({ name: 'aline' }, state, { chatId: 'c' })).then(r => r.stateMutator?.(state));
    expect(state.draft!.participants).toHaveLength(1);
  });

  it('removes participant by name', async () => {
    const state = makeState();
    state.draft = makeDraft();
    state.draft.participants = [{ name: 'Aline', email: null, resolved: false }];
    await (getToolHandler('remove_participant')!({ name: 'Aline' }, state, { chatId: 'c' })).then(r => r.stateMutator?.(state));
    expect(state.draft!.participants).toHaveLength(0);
  });
});

describe('tool: clear_draft', () => {
  it('clears draft and messages', async () => {
    const state = makeState();
    state.draft = makeDraft();
    state.messages = [{ role: 'user', content: 'oi' }];
    const r = await (getToolHandler('clear_draft')!)({}, state, { chatId: 'c' });
    r.stateMutator?.(state);
    expect(state.draft).toBeNull();
    expect(state.messages).toHaveLength(0);
    expect(r.terminal?.text).toMatch(/reiniciada/i);
  });
});

describe('tool: show_preview (no draft)', () => {
  it('returns error terminal when draft is null', async () => {
    const state = makeState();
    const r = await (getToolHandler('show_preview')!)({}, state, { chatId: 'c' });
    expect(r.terminal?.text).toMatch(/sem evento/i);
  });
});

describe('phase-2 tools', () => {
  it('TOOL_SCHEMAS now contains 13 tools (9 original + 4 new)', () => {
    const names = TOOL_SCHEMAS.map(t => t.function.name).sort();
    expect(names).toContain('list_upcoming_events');
    expect(names).toContain('search_events');
    expect(names).toContain('propose_update');
    expect(names).toContain('propose_delete');
    expect(names).toHaveLength(13);
  });

  it('propose_update returns terminal with apply_update_ button', async () => {
    const handler = getToolHandler('propose_update')!;
    const r = await handler(
      {
        google_event_id: 'e1',
        summary: 'Reunião João',
        changes_human: 'horário para 15:00',
        patch: { start: { dateTime: '2026-05-01T15:00:00-03:00' } },
      },
      { messages: [], draft: null, lastUsed: Date.now() },
      { chatId: 'c' }
    );
    expect(r.terminal?.buttons?.[0]?.[0].callback_data).toMatch(/^apply_update_/);
    expect(r.terminal?.text).toMatch(/Reunião João/);
    expect(r.terminal?.text).toMatch(/horário para 15:00/);
  });

  it('propose_delete returns terminal with apply_delete_ button', async () => {
    const handler = getToolHandler('propose_delete')!;
    const r = await handler(
      { google_event_id: 'e2', summary: 'Standup' },
      { messages: [], draft: null, lastUsed: Date.now() },
      { chatId: 'c' }
    );
    expect(r.terminal?.buttons?.[0]?.[0].callback_data).toMatch(/^apply_delete_/);
    expect(r.terminal?.text).toMatch(/Standup/);
    expect(r.terminal?.text).toMatch(/não pode ser desfeita/i);
  });

  it('list_upcoming_events returns events from calendar-ops', async () => {
    // Mock calendar-ops at module level — if not already mocked, skip this test or mock inline
    // Use jest.spyOn approach
    const calendarOps = require('./calendar-ops');
    const spy = jest.spyOn(calendarOps, 'listUpcomingEvents').mockResolvedValueOnce([
      { id: 'e1', summary: 'Reunião', start: '2026-05-01T14:00:00Z', end: '2026-05-01T15:00:00Z' },
    ]);
    const handler = getToolHandler('list_upcoming_events')!;
    const r = await handler({ days_ahead: 7 }, { messages: [], draft: null, lastUsed: Date.now() }, { chatId: 'c' });
    expect(r.content).toHaveProperty('events');
    expect((r.content as any).events).toHaveLength(1);
    spy.mockRestore();
  });

  it('search_events returns events with found count', async () => {
    const calendarOps = require('./calendar-ops');
    const spy = jest.spyOn(calendarOps, 'searchEventsByQuery').mockResolvedValueOnce([
      { id: 'e1', summary: 'Reunião João', start: '2026-05-01T14:00:00Z', end: '2026-05-01T15:00:00Z' },
    ]);
    const handler = getToolHandler('search_events')!;
    const r = await handler({ query: 'João' }, { messages: [], draft: null, lastUsed: Date.now() }, { chatId: 'c' });
    expect((r.content as any).found).toBe(1);
    spy.mockRestore();
  });
});
