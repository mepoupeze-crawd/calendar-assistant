/**
 * agent.ts Tests — TDD
 * Tests for runAgentTurn: the main OpenAI tool-calling loop.
 */

// Mock openai BEFORE imports
jest.mock('openai');

// Mock contacts to avoid real Google API calls
jest.mock('./contacts', () => ({
  lookupContactsByName: jest.fn().mockResolvedValue({ contacts: [], error: false }),
}));

// Mock conflict-detector to avoid real Google Calendar calls
jest.mock('./conflict-detector', () => ({
  checkCalendarConflicts: jest.fn().mockResolvedValue({ has_conflicts: false, conflicts: [] }),
}));

// Mock previewer to avoid side effects
jest.mock('./previewer', () => ({
  generatePreview: jest.fn().mockReturnValue({
    event_id: 'test-event-id',
    text: 'Preview text',
  }),
}));

import OpenAI from 'openai';
import { runAgentTurn, conversationStore } from './agent';

// Helper to build a minimal OpenAI chat completion response
function makeTextResponse(text: string) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: text,
          tool_calls: undefined,
        },
        finish_reason: 'stop',
      },
    ],
  };
}

function makeToolCallResponse(toolName: string, args: Record<string, unknown>, toolCallId = 'call_1') {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: toolCallId,
              type: 'function',
              function: {
                name: toolName,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

describe('runAgentTurn', () => {
  let mockCreate: jest.Mock;

  beforeEach(() => {
    // Reset mock and clear conversation store between tests
    mockCreate = jest.fn();
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    } as any));

    // Clear any leftover conversation state
    conversationStore.clear('test-chat');
  });

  describe('1. Text response — LLM returns plain text (no tool_calls)', () => {
    it('returns { text } when LLM responds with text content', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('olá!'));

      const result = await runAgentTurn('test-chat', 'Oi');

      expect(result).toEqual({ text: 'olá!' });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Tool call → terminal — LLM calls reply_text tool', () => {
    it('returns terminal AgentResponse when tool returns terminal', async () => {
      // First call: LLM returns a tool_call for reply_text
      mockCreate.mockResolvedValueOnce(
        makeToolCallResponse('reply_text', { text: 'oi via tool' })
      );

      const result = await runAgentTurn('test-chat', 'Olá');

      expect(result).toEqual({ text: 'oi via tool' });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. MAX_ITERATIONS exceeded — LLM always returns non-terminal tool_call', () => {
    it('returns error message matching /limite/i after max iterations', async () => {
      // lookup_contact is non-terminal — always returns tool_call
      // Agent should loop and eventually hit MAX_ITERATIONS
      mockCreate.mockResolvedValue(
        makeToolCallResponse('lookup_contact', { name: 'Alguém' }, 'call_loop')
      );

      const result = await runAgentTurn('test-chat', 'Procura alguém');

      expect(result.text).toMatch(/limite/i);
      // Should have been called MAX_ITERATIONS (5) times
      expect(mockCreate).toHaveBeenCalledTimes(5);
    });
  });
});
