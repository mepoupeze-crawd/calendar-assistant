/**
 * agent-tools — OpenAI function tool schemas and handler registry for the calendar agent.
 *
 * TOOL_SCHEMAS defines the 9 tools the agent can call.
 * The handler registry maps tool names to async handler functions.
 * All handlers (reply_text, ask_user, and the calendar-specific tools) are
 * registered here.
 */

import type { ConversationState } from './conversation-store';
import type { ValidatedEvent, ParsedParticipant } from './types';
import { lookupContactsByName } from './contacts';
import { checkCalendarConflicts } from './conflict-detector';
import { generatePreview } from './previewer';
import { listUpcomingEvents, searchEventsByQuery } from './calendar-ops';
import { pendingOpsStore } from './pending-ops-store';
import { randomUUID } from 'crypto';

// ─── Public types ─────────────────────────────────────────────────────────────

export type ButtonRow = Array<{ text: string; callback_data: string }>;

export interface ToolResult {
  content: Record<string, unknown>;
  terminal?: { text: string; buttons?: ButtonRow[] };
  stateMutator?: (state: ConversationState) => void;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  state: ConversationState,
  ctx: { chatId: string }
) => Promise<ToolResult>;

// ─── Handler registry ─────────────────────────────────────────────────────────

const handlerRegistry = new Map<string, ToolHandler>();

export function registerHandler(name: string, fn: ToolHandler): void {
  handlerRegistry.set(name, fn);
}

export function getToolHandler(name: string): ToolHandler | undefined {
  return handlerRegistry.get(name);
}

// ─── Tool schemas ─────────────────────────────────────────────────────────────

export const TOOL_SCHEMAS: Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      required?: string[];
      properties: Record<string, unknown>;
    };
  };
}> = [
  {
    type: 'function',
    function: {
      name: 'propose_event',
      description: 'Propose a new calendar event draft with all known details.',
      parameters: {
        type: 'object',
        required: ['title', 'start_date'],
        properties: {
          title: { type: 'string', description: 'Event title' },
          start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
          start_time: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Start time (HH:MM) or null' },
          end_time: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'End time (HH:MM) or null' },
          duration_minutes: {
            anyOf: [{ type: 'integer' }, { type: 'null' }],
            description: 'Duration in minutes or null',
          },
          all_day: { type: 'boolean', description: 'Whether the event is all-day' },
          location: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Event location or null' },
          description: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Event description or null' },
          participants: {
            type: 'array',
            description: 'List of participants',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['name'],
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_participant',
      description: 'Add a participant to the current event draft.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Participant name' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_participant',
      description: 'Remove a participant from the current event draft.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Participant name to remove' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_participant_email',
      description: 'Define o email de um participante já presente no draft. Use SOMENTE quando o usuário associou explicitamente o email a um nome (ex: "o email da Maria é x@y.com"). Se o usuário enviou apenas um email sem nomear o participante, use ask_user primeiro para disambiguar.',
      parameters: {
        type: 'object',
        required: ['name', 'email'],
        properties: {
          name: { type: 'string', description: 'Participant name' },
          email: { type: 'string', description: 'Email address to assign' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_contact',
      description: 'Look up a contact by name to retrieve their email address.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Contact name to look up' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_preview',
      description: 'Show the user a preview of the current event draft.',
      parameters: {
        type: 'object',
        required: [],
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_draft',
      description: 'Clear the current event draft and start fresh.',
      parameters: {
        type: 'object',
        required: [],
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reply_text',
      description: 'Send a plain text reply to the user.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'The message text to send to the user' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user a question, optionally providing escape action buttons.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'The question to ask the user' },
          escape_buttons: {
            type: 'array',
            description: 'Optional escape action buttons',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Button label displayed to user' },
                action: {
                  type: 'string',
                  enum: ['cancel_flow', 'skip_participant'],
                  description: 'Action identifier',
                },
              },
              required: ['label', 'action'],
            },
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_upcoming_events',
      description: 'Lista eventos futuros do calendário do usuário. Use para responder "quais meus próximos compromissos?" e para verificar disponibilidade antes de propor horário.',
      parameters: {
        type: 'object',
        properties: {
          days_ahead: { type: 'integer', default: 7, description: 'Quantos dias à frente buscar (default: 7)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_events',
      description: 'Busca eventos existentes por texto (título, local, participantes). Use SEMPRE antes de propose_update ou propose_delete para localizar o evento correto.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Termo de busca (nome do evento, participante, etc)' },
          days_ahead: { type: 'integer', default: 14 },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_update',
      description: 'Prepara atualização de evento EXISTENTE. NÃO executa — gera botão para o usuário confirmar. Requer chamar search_events antes para obter google_event_id.',
      parameters: {
        type: 'object',
        required: ['google_event_id', 'summary', 'changes_human', 'patch'],
        properties: {
          google_event_id: { type: 'string' },
          summary: { type: 'string', description: 'Nome do evento para exibir ao usuário' },
          changes_human: { type: 'string', description: 'Descrição das mudanças em português (ex: "horário para 15:00, local Sala 101")' },
          patch: { type: 'object', description: 'Patch parcial no formato da Google Calendar API (campos a atualizar)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_delete',
      description: 'Prepara exclusão de evento EXISTENTE. NÃO executa — gera botão para o usuário confirmar. Requer chamar search_events antes. Ação irreversível.',
      parameters: {
        type: 'object',
        required: ['google_event_id', 'summary'],
        properties: {
          google_event_id: { type: 'string' },
          summary: { type: 'string', description: 'Nome do evento para exibir ao usuário na confirmação' },
        },
      },
    },
  },
];

// ─── Stub handlers ────────────────────────────────────────────────────────────

registerHandler('reply_text', async (args) => {
  return {
    content: { ok: true },
    terminal: { text: String(args.text ?? '') },
  };
});

registerHandler('ask_user', async (args) => {
  const text = String(args.text ?? '');
  const escapeButtons = args.escape_buttons as
    | Array<{ label: string; action: string }>
    | undefined;

  const buttons: ButtonRow[] | undefined =
    escapeButtons && escapeButtons.length > 0
      ? escapeButtons.map((b) => [
          { text: b.label, callback_data: `agent_escape_${b.action}` },
        ])
      : undefined;

  return {
    content: { ok: true },
    terminal: buttons !== undefined ? { text, buttons } : { text },
  };
});

// ─── Task 3 handlers ──────────────────────────────────────────────────────────

registerHandler('propose_event', async (args) => {
  const rawParticipants = (args.participants as Array<{ name: string; email?: string | null }> | undefined) ?? [];
  const participants: ParsedParticipant[] = rawParticipants.map((p) => ({
    name: p.name,
    email: p.email ?? null,
    resolved: !!p.email,
  }));

  const draft: ValidatedEvent = {
    title: String(args.title ?? ''),
    start_date: String(args.start_date ?? ''),
    start_time: args.start_time != null ? String(args.start_time) : null,
    end_time: args.end_time != null ? String(args.end_time) : null,
    duration_minutes: typeof (args as any).duration_minutes === 'number' ? (args as any).duration_minutes : null,
    all_day: typeof args.all_day === 'boolean' ? args.all_day : false,
    participants,
    description: args.description != null ? String(args.description) : null,
    location: args.location != null ? String(args.location) : null,
  };

  return {
    content: { ok: true, draft: { ...draft, participants: [...draft.participants] } },
    stateMutator: (s) => { s.draft = draft; },
  };
});

registerHandler('add_participant', async (args, state) => {
  const name = String(args.name ?? '');
  return {
    content: { ok: true, name },
    stateMutator: (s) => {
      if (s.draft === null) return;
      const already = s.draft.participants.some(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (!already) {
        s.draft.participants.push({ name, email: null, resolved: false });
      }
    },
  };
});

registerHandler('remove_participant', async (args) => {
  const name = String(args.name ?? '');
  return {
    content: { ok: true, name },
    stateMutator: (s) => {
      if (s.draft === null) return;
      s.draft.participants = s.draft.participants.filter(
        (p) => p.name.toLowerCase() !== name.toLowerCase()
      );
    },
  };
});

registerHandler('set_participant_email', async (args, state) => {
  const name = String(args.name ?? '');
  const email = String(args.email ?? '');

  if (state.draft === null) {
    return { content: { ok: false, reason: 'no_draft' } };
  }

  const exists = state.draft.participants.some(
    (p) => p.name.toLowerCase() === name.toLowerCase()
  );
  if (!exists) {
    return { content: { ok: false, reason: 'participant_not_found', name } };
  }

  return {
    content: { ok: true, name, email },
    stateMutator: (s) => {
      if (s.draft === null) return;
      const participant = s.draft.participants.find(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (participant) {
        participant.email = email;
        participant.resolved = true;
      }
    },
  };
});

registerHandler('lookup_contact', async (args) => {
  const name = String(args.name ?? '');
  const result = await lookupContactsByName(name);
  return {
    content: { name, contacts: result.contacts, error: result.error },
  };
});

registerHandler('show_preview', async (_args, state) => {
  if (state.draft === null) {
    return {
      content: { error: 'no_draft' },
      terminal: { text: '⚠️ Sem evento para mostrar preview.' },
    };
  }

  const conflicts = await checkCalendarConflicts(state.draft);
  const preview = generatePreview(
    state.draft,
    conflicts.has_conflicts ? conflicts.conflicts : undefined
  );

  return {
    content: { ok: true, event_id: preview.event_id, conflicts: conflicts.has_conflicts },
    terminal: {
      text: preview.text,
      buttons: [
        [
          { text: '✅ Confirmar', callback_data: `confirm_${preview.event_id}` },
          { text: '❌ Cancelar', callback_data: `cancel_${preview.event_id}` },
          { text: '✏️ Editar', callback_data: `edit_${preview.event_id}` },
        ],
      ],
    },
  };
});

registerHandler('clear_draft', async () => ({
  content: { ok: true },
  terminal: { text: '🆕 Sessão reiniciada. Pode enviar um novo evento.' },
  stateMutator: (s) => { s.draft = null; s.messages = []; },
}));

// ─── Phase-2 handlers ─────────────────────────────────────────────────────────

registerHandler('list_upcoming_events', async (args) => {
  const daysAhead = typeof (args as any).days_ahead === 'number' ? (args as any).days_ahead : 7;
  const events = await listUpcomingEvents({ daysAhead });
  return { content: { events } };
});

registerHandler('search_events', async (args) => {
  const { query, days_ahead } = args as { query: string; days_ahead?: number };
  const events = await searchEventsByQuery({ query, daysAhead: days_ahead ?? 14 });
  return { content: { events, found: events.length } };
});

registerHandler('propose_update', async (args) => {
  const { google_event_id, summary, changes_human, patch } = args as {
    google_event_id: string;
    summary: string;
    changes_human: string;
    patch: Record<string, unknown>;
  };
  const opId = randomUUID();
  pendingOpsStore.set(opId, { type: 'update', google_event_id, patch, summary });
  return {
    content: { ok: true, op_id: opId },
    terminal: {
      text: `✏️ Vou atualizar <b>${summary}</b>:\n\n• ${changes_human}\n\nConfirma?`,
      buttons: [[
        { text: '✓ Aplicar mudança', callback_data: `apply_update_${opId}` },
        { text: '✗ Cancelar',        callback_data: `abort_op_${opId}` },
      ]],
    },
  };
});

registerHandler('propose_delete', async (args) => {
  const { google_event_id, summary } = args as { google_event_id: string; summary: string };
  const opId = randomUUID();
  pendingOpsStore.set(opId, { type: 'delete', google_event_id, summary });
  return {
    content: { ok: true, op_id: opId },
    terminal: {
      text: `🗑 Tem certeza que quer excluir <b>${summary}</b>?\n\nEssa ação não pode ser desfeita.`,
      buttons: [[
        { text: '🗑 Confirmar exclusão', callback_data: `apply_delete_${opId}` },
        { text: '✗ Cancelar',            callback_data: `abort_op_${opId}` },
      ]],
    },
  };
});
