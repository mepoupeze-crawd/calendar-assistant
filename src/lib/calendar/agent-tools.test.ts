/**
 * agent-tools Tests
 * TDD: tests written first, then implementation.
 */

import { TOOL_SCHEMAS, getToolHandler, registerHandler } from './agent-tools';
import type { ConversationState } from './conversation-store';

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

const makeState = (): ConversationState => ({
  messages: [],
  draft: null,
  lastUsed: Date.now(),
});

describe('agent-tools', () => {
  describe('1. TOOL_SCHEMAS contains exactly the 9 expected tool names', () => {
    it('has exactly 9 schemas', () => {
      expect(TOOL_SCHEMAS).toHaveLength(9);
    });

    it('contains all expected tool names', () => {
      const names = TOOL_SCHEMAS.map((s) => s.function.name);
      expect(names.sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
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

    it('other tools do not have handlers yet (Task 3 adds them)', () => {
      const toolsWithoutHandlers = [
        'propose_event',
        'add_participant',
        'remove_participant',
        'set_participant_email',
        'lookup_contact',
        'show_preview',
        'clear_draft',
      ];
      for (const name of toolsWithoutHandlers) {
        expect(getToolHandler(name)).toBeUndefined();
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
