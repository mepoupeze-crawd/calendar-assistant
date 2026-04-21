/**
 * agent-tools — OpenAI function tool schemas and handler registry for the calendar agent.
 *
 * TOOL_SCHEMAS defines the 9 tools the agent can call.
 * The handler registry maps tool names to async handler functions.
 * Stub handlers for reply_text and ask_user are registered here;
 * the remaining handlers are registered in Task 3.
 */

import type { ConversationState } from './conversation-store';
import type { ValidatedEvent, ParsedParticipant } from './types';
import { lookupContactsByName } from './contacts';
import { checkCalendarConflicts } from './conflict-detector';
import { generatePreview } from './previewer';

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
      description: "Set or update a participant's email address in the current draft.",
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
    duration_minutes: null,
    all_day: typeof args.all_day === 'boolean' ? args.all_day : false,
    participants,
    description: args.description != null ? String(args.description) : null,
    location: args.location != null ? String(args.location) : null,
  };

  return {
    content: { ok: true, draft },
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

registerHandler('set_participant_email', async (args) => {
  const name = String(args.name ?? '');
  const email = String(args.email ?? '');
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
    stateMutator: (s) => { (s as any).lastPreviewEventId = preview.event_id; },
  };
});

registerHandler('clear_draft', async () => ({
  content: { ok: true },
  terminal: { text: '🆕 Sessão reiniciada. Pode enviar um novo evento.' },
  stateMutator: (s) => { s.draft = null; s.messages = []; },
}));
