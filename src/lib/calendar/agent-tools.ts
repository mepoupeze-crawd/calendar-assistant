/**
 * agent-tools — OpenAI function tool schemas and handler registry for the calendar agent.
 *
 * TOOL_SCHEMAS defines the 9 tools the agent can call.
 * The handler registry maps tool names to async handler functions.
 * Stub handlers for reply_text and ask_user are registered here;
 * the remaining handlers are registered in Task 3.
 */

import type { ConversationState } from './conversation-store';

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
