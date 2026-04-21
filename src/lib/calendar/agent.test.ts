/**
 * agent.ts Tests — TDD
 * Tests for runAgentTurn: the main OpenAI tool-calling loop.
 */

// Mock openai BEFORE imports
jest.mock('openai');

// Mock calendar-ops to avoid real Google Calendar API calls
jest.mock('./calendar-ops', () => ({
  listUpcomingEvents: jest.fn().mockResolvedValue([]),
  searchEventsByQuery: jest.fn().mockResolvedValue([
    { id: 'e1', summary: 'Reunião com João', start: '2026-05-01T14:00:00Z', end: '2026-05-01T15:00:00Z' },
  ]),
  updateEvent: jest.fn().mockResolvedValue({ google_event_id: 'e1', event_link: 'https://cal.google.com/e1' }),
  deleteEvent: jest.fn().mockResolvedValue(undefined),
}));

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

describe('anti-regression: name inside quoted title is NOT extracted as participant', () => {
  let mockCreate: jest.Mock;

  beforeEach(() => {
    mockCreate = jest.fn();
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    } as any));

    conversationStore.clear('chat-regression');
    conversationStore.clear('chat-regression-2');
  });

  it('when LLM proposes event with Aline but not Manuela from title, agent calls propose_event correctly', async () => {
    // Simulate the LLM correctly calling propose_event with ONLY Aline as participant
    // (Manuela appears in the title "aniversário Manuela Frego" — NOT as participant)
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc1',
            type: 'function',
            function: {
              name: 'propose_event',
              arguments: JSON.stringify({
                title: 'aniversário Manuela Frego',
                start_date: '2026-05-23',
                start_time: '13:30',
                participants: [{ name: 'Aline', email: null }],  // only Aline, NOT Manuela
              }),
            },
          }, {
            id: 'tc2',
            type: 'function',
            function: {
              name: 'show_preview',
              arguments: '{}',
            },
          }],
        },
      }],
    });

    const response = await runAgentTurn(
      'chat-regression',
      'Adicionar Aline e mudar nome do evento para "aniversário Manuela Frego"'
    );

    // Verify the conversation store has the draft
    const state = conversationStore.get('chat-regression');
    expect(state).not.toBeNull();

    // The draft should have Aline but NOT Manuela as participant
    const participantNames = state?.draft?.participants.map(p => p.name) ?? [];
    expect(participantNames).toContain('Aline');
    expect(participantNames).not.toContain('Manuela');
    expect(participantNames).not.toContain('Manuela Frego');

    // Title should be set correctly
    expect(state?.draft?.title).toBe('aniversário Manuela Frego');
  });

  it('when user corrects a wrong participant ("Manuela nao é a pessoa"), agent removes them', async () => {
    // Setup: draft already has Manuela incorrectly added
    const store = conversationStore.getOrCreate('chat-regression-2');
    store.draft = {
      title: 'aniversário Manuela Frego',
      start_date: '2026-05-23',
      start_time: '13:30',
      end_time: null,
      duration_minutes: null,
      all_day: false,
      participants: [{ name: 'Manuela', email: null, resolved: false }],
      description: null,
      location: null,
    };

    // LLM correctly calls remove_participant then ask_user
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc3',
            type: 'function',
            function: {
              name: 'remove_participant',
              arguments: JSON.stringify({ name: 'Manuela' }),
            },
          }, {
            id: 'tc4',
            type: 'function',
            function: {
              name: 'reply_text',
              arguments: JSON.stringify({ text: 'Ok, removi Manuela. Quem você quer adicionar?' }),
            },
          }],
        },
      }],
    });

    const response = await runAgentTurn(
      'chat-regression-2',
      'Manuela nao é a pessoa a ser adicionada'
    );

    // Manuela should be removed from participants
    const state = conversationStore.get('chat-regression-2');
    const participantNames = state?.draft?.participants.map(p => p.name) ?? [];
    expect(participantNames).not.toContain('Manuela');

    // Response should be the reply_text content
    expect(response.text).toBe('Ok, removi Manuela. Quem você quer adicionar?');
  });
});

describe('fase 2 — CRUD de eventos existentes', () => {
  let mockCreate: jest.Mock;

  beforeEach(() => {
    mockCreate = jest.fn();
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    } as any));

    conversationStore.clear('chat-fase2');
  });

  it('cancela evento: search_events → propose_delete → botão apply_delete_', async () => {
    mockCreate
      // First call: LLM calls search_events
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'search1',
              type: 'function',
              function: {
                name: 'search_events',
                arguments: JSON.stringify({ query: 'João', days_ahead: 14 }),
              },
            }],
          },
        }],
      })
      // Second call: LLM receives search results and calls propose_delete
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'del1',
              type: 'function',
              function: {
                name: 'propose_delete',
                arguments: JSON.stringify({
                  google_event_id: 'e1',
                  summary: 'Reunião com João',
                }),
              },
            }],
          },
        }],
      });

    const response = await runAgentTurn('chat-fase2', 'cancela minha reunião com João');

    // Should return terminal with apply_delete_ button
    expect(response.buttons).toBeDefined();
    expect(response.buttons!.flat().some(b => b.callback_data.startsWith('apply_delete_'))).toBe(true);
    expect(response.text).toMatch(/Reunião com João/);
    expect(response.text).toMatch(/excluir/i);
  });
});

describe('Bug B — disambiguação de email sem destinatário', () => {
  let mockCreate: jest.Mock;

  beforeEach(() => {
    mockCreate = jest.fn();
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    } as any));

    conversationStore.clear('bug-b-1');
    conversationStore.clear('bug-b-2');
  });

  it('agente chama ask_user (não set_participant_email) quando email enviado sem nome de participante', async () => {
    // Simular: usuário enviou apenas um email — agente deve responder com ask_user
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'a1',
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({
                text: 'Para qual participante é o email jgcalice@gmail.com? Se quiser adicionar como novo participante, me diga o nome.',
                escape_buttons: [{ label: 'Cancelar', action: 'cancel_flow' }],
              }),
            },
          }],
        },
      }],
    });

    const r = await runAgentTurn('bug-b-1', 'Adicione jgcalice@gmail.com');
    // ask_user é terminal — deve retornar texto com a pergunta
    expect(r.text).toContain('jgcalice@gmail.com');
    // Verificar que agente respondeu com ask_user (não com set_participant_email)
    expect(r.text).toMatch(/participante|email|jgcalice/i);
    // Apenas 1 chamada ao LLM (ask_user é terminal)
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('agente usa set_participant_email diretamente quando email e nome estão na mesma mensagem', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'b1',
            type: 'function',
            function: {
              name: 'set_participant_email',
              arguments: JSON.stringify({ name: 'Maria', email: 'maria@example.com' }),
            },
          }],
        },
      }],
    }).mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'Email da Maria atualizado!', tool_calls: undefined } }],
    });

    // Setup draft with Maria as participant so set_participant_email succeeds
    const store = conversationStore.getOrCreate('bug-b-2');
    store.draft = {
      title: 'Reunião',
      start_date: '2026-05-01',
      start_time: null,
      end_time: null,
      duration_minutes: null,
      all_day: false,
      participants: [{ name: 'Maria', email: null, resolved: false }],
      description: null,
      location: null,
    };

    const r = await runAgentTurn('bug-b-2', 'o email da Maria é maria@example.com');
    // set_participant_email não é terminal, mas o texto final deve existir
    expect(r.text).toBeTruthy();
  });
});

describe('contexto do owner no system prompt', () => {
  let mockCreate: jest.Mock;

  beforeEach(() => {
    mockCreate = jest.fn();
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    } as any));

    conversationStore.clear('chat-owner-test');
  });

  it('inclui email do owner no sistema quando CALENDAR_OWNER_EMAIL está definido', async () => {
    process.env.CALENDAR_OWNER_EMAIL = 'test-owner@example.com';
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    await runAgentTurn('chat-owner-test', 'oi');
    const callArgs = mockCreate.mock.calls[0][0];
    const systemMsgs = callArgs.messages.filter((m: any) => m.role === 'system');
    const hasOwnerEmail = systemMsgs.some((m: any) =>
      m.content?.includes('test-owner@example.com')
    );
    expect(hasOwnerEmail).toBe(true);
    delete process.env.CALENDAR_OWNER_EMAIL;
  });
});

describe('contexto ULTIMO_EVENTO_CRIADO_ID', () => {
  let mockCreate: jest.Mock;

  beforeEach(() => {
    mockCreate = jest.fn();
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    } as any));

    conversationStore.clear('chat-ctx');
  });

  it('4. contexto inclui "(nenhum)" quando lastCreatedEventId não está definido', async () => {
    // Fresh session — no event created yet
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: undefined } }],
    });

    await runAgentTurn('chat-ctx', 'oi');

    const callArgs = mockCreate.mock.calls[0][0];
    const systemMessages = callArgs.messages.filter((m: any) => m.role === 'system');
    const contextMsg = systemMessages.find((m: any) =>
      m.content?.includes('ULTIMO_EVENTO_CRIADO_ID')
    );
    expect(contextMsg?.content).toContain('ULTIMO_EVENTO_CRIADO_ID: (nenhum)');
  });

  it('5. contexto inclui o ID real quando lastCreatedEventId está definido', async () => {
    // Set the last created event ID before the turn
    conversationStore.setLastCreatedEventId('chat-ctx', 'cal_real123');

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: undefined } }],
    });

    await runAgentTurn('chat-ctx', 'oi');

    const callArgs = mockCreate.mock.calls[0][0];
    const systemMessages = callArgs.messages.filter((m: any) => m.role === 'system');
    const contextMsg = systemMessages.find((m: any) =>
      m.content?.includes('ULTIMO_EVENTO_CRIADO_ID')
    );
    expect(contextMsg?.content).toContain('ULTIMO_EVENTO_CRIADO_ID: cal_real123');
  });
});
