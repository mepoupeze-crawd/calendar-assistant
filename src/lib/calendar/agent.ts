/**
 * agent.ts — Main agent loop using OpenAI tool-calling (Tools API).
 *
 * Exports:
 *  - conversationStore: singleton ConversationStore
 *  - AgentResponse: interface for agent responses
 *  - runAgentTurn: main function — runs one user turn through the agent loop
 */

import OpenAI from 'openai';
import { ConversationStore, type AgentMessage } from './conversation-store';
import { TOOL_SCHEMAS, getToolHandler, type ButtonRow } from './agent-tools';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AgentResponse {
  text: string;
  buttons?: ButtonRow[];
}

// ─── Singleton store ──────────────────────────────────────────────────────────

export const conversationStore = new ConversationStore({
  ttlMs: 30 * 60 * 1000,
  maxMessages: 20,
});

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 5;

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): AgentMessage {
  const today = new Date().toISOString().split('T')[0];
  return {
    role: 'system',
    content: `Você é um assistente de calendário em português brasileiro.
Data atual: ${today}.

Use tools para manipular o draft do evento. NUNCA anuncie ação sem chamar tool.

Regras:
- Nomes dentro de aspas no título NÃO são participantes.
- Se o usuário corrige você ("X não é a pessoa", "esquece X"), use remove_participant ANTES de pedir novos dados.
- Se o usuário diz "cancela", "esquece", "começa de novo" → clear_draft.
- Se a duração não for informada, assuma 60 minutos.
- Ações irreversíveis (criar evento no Google Calendar) são feitas por BOTÃO do usuário, NÃO por tool. Sua entrega é sempre show_preview ou reply_text.
- Se show_preview validar e não houver conflito, encerre a turn.
- Em perguntas bloqueantes (ex: pedir email), use ask_user com escape_buttons [{label:"Cancelar", action:"cancel_flow"}, {label:"Pular", action:"skip_participant"}].`,
  };
}

// ─── Main agent loop ──────────────────────────────────────────────────────────

export async function runAgentTurn(chatId: string, userText: string): Promise<AgentResponse> {
  const openai = new OpenAI();
  const state = conversationStore.getOrCreate(chatId);

  // Prepend system prompt on first turn
  if (state.messages.length === 0) {
    state.messages.push(buildSystemPrompt());
  }

  // Append user message
  const userMsg: AgentMessage = { role: 'user', content: userText };
  conversationStore.appendMessage(chatId, userMsg);

  // Draft context injection — always the current draft as a system message
  const draftContextMsg: AgentMessage = {
    role: 'system',
    content: 'DRAFT ATUAL: ' + (state.draft ? JSON.stringify(state.draft) : '(vazio)'),
  };

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const messages = [...state.messages, draftContextMsg];

    // Call OpenAI
    const response = await openai.chat.completions.create({
      model: process.env.AGENT_MODEL || 'gpt-4o-mini',
      messages: messages as Parameters<typeof openai.chat.completions.create>[0]['messages'],
      tools: TOOL_SCHEMAS,
      tool_choice: 'auto',
      temperature: 0.2,
    });

    const choice = response.choices[0];
    const message = choice.message;

    // Case 1: LLM returned plain text (no tool calls)
    if (!message.tool_calls || message.tool_calls.length === 0) {
      const content = message.content ?? '';
      const assistantMsg: AgentMessage = { role: 'assistant', content };
      conversationStore.appendMessage(chatId, assistantMsg);
      return { text: content };
    }

    // Case 2: LLM returned tool calls — execute them
    // Append the assistant message with tool_calls to history
    const assistantMsg: AgentMessage = {
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: message.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    };
    conversationStore.appendMessage(chatId, assistantMsg);

    // Execute each tool call
    for (const toolCall of message.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      const handler = getToolHandler(toolName);

      let toolResult;
      if (handler) {
        toolResult = await handler(toolArgs, state, { chatId });

        // Apply state mutations if provided
        if (toolResult.stateMutator) {
          toolResult.stateMutator(state);
        }
      } else {
        toolResult = { content: { error: 'unknown_tool', tool: toolName } };
      }

      // Append tool result to history
      const toolResultMsg: AgentMessage = {
        role: 'tool',
        content: JSON.stringify(toolResult.content),
        tool_call_id: toolCall.id,
        name: toolName,
      };
      conversationStore.appendMessage(chatId, toolResultMsg);

      // If the tool result is terminal, return immediately
      if (toolResult.terminal) {
        return {
          text: toolResult.terminal.text,
          ...(toolResult.terminal.buttons ? { buttons: toolResult.terminal.buttons } : {}),
        };
      }
    }
  }

  // MAX_ITERATIONS exceeded
  return { text: 'Desculpe, atingi o limite de iterações sem conseguir completar a solicitação.' };
}
