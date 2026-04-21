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
import { TOOL_SCHEMAS, getToolHandler, type ButtonRow, type ToolResult } from './agent-tools';

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
  const ownerEmail = process.env.CALENDAR_OWNER_EMAIL || 'jgcalice@gmail.com';
  return {
    role: 'system',
    content: `Você é um assistente de calendário em português brasileiro.
Data atual: ${today}.
Usuário do calendário: ${ownerEmail}

Você pode: criar eventos, editar o rascunho atual, E consultar/atualizar/excluir eventos existentes no Google Calendar.

REGRAS GERAIS:
- Nomes dentro de aspas no título NÃO são participantes.
- Se o usuário corrige você ("X não é a pessoa", "esquece X"), use remove_participant ANTES de pedir novos dados.
- Se o usuário diz "cancela", "esquece", "começa de novo" → clear_draft.
- Duração não informada = 60 minutos.
- Ações irreversíveis (criar/atualizar/excluir no Google Calendar) são feitas por BOTÃO do usuário, NÃO por tool direta.

CRIAR EVENTO:
- Use propose_event para definir o rascunho.
- Termine com show_preview (gera botão ✅ Confirmar).

CONSULTAR AGENDA:
- Use list_upcoming_events para responder "quais meus compromissos?".
- Formate como lista legível com reply_text.

ATUALIZAR EVENTO EXISTENTE:
- SEMPRE chame search_events primeiro para localizar o evento e obter google_event_id.
- Se 0 resultados → avise com reply_text.
- Se >1 resultado → pergunte qual com reply_text (liste as opções).
- Após localizar → use propose_update (gera botão ✓ Aplicar).

EXCLUIR EVENTO EXISTENTE:
- SEMPRE chame search_events primeiro.
- Após localizar → use propose_delete (gera botão 🗑 Confirmar exclusão).

EM PERGUNTAS BLOQUEANTES (ex: pedir email de contato):
- Use ask_user com escape_buttons: [{label:"Cancelar", action:"cancel_flow"}, {label:"Pular", action:"skip_participant"}].

PARTICIPANTES E EMAILS:
- Quando receber mensagem que contenha principalmente um email (ex: "Adicione x@y.com", "x@y.com"), sem o usuário nomear explicitamente um participante do draft:
  1. Use ask_user: "Para qual participante é o email x@y.com? Se quiser adicionar como novo participante, me diga o nome." + escape_buttons: [{label:"Cancelar", action:"cancel_flow"}]
  2. Só chame set_participant_email APÓS o usuário confirmar o nome do participante.
  3. NUNCA atribua email automaticamente ao último participante sem perguntar.
- Caso o usuário associe email e nome na mesma mensagem (ex: "o email da Maria é maria@x.com"), use set_participant_email diretamente — não precisa perguntar.

ADICIONAR PARTICIPANTE POR NOME:
- Após chamar add_participant, SEMPRE chame lookup_contact imediatamente com o mesmo nome.
  • Se lookup retornar 1 contato: chame set_participant_email com o email encontrado.
  • Se lookup retornar 0 contatos: use ask_user "Não encontrei [nome] nos seus contatos. Qual é o email?" + escape_buttons [{label:"Pular", action:"skip_participant"}, {label:"Cancelar", action:"cancel_flow"}].
  • Se lookup retornar >1 contato: use ask_user listando as opções numeradas para o usuário escolher.
- NUNCA encerre o turno com participante adicionado e sem email resolvido.

MEU EMAIL / ADICIONAR EU MESMO:
- "meu email", "me adiciona", "inclua eu", "eu também" → use set_participant_email com email="${ownerEmail}" para o participante correspondente, ou add_participant("eu") + set_participant_email("eu", "${ownerEmail}") se ainda não estiver no draft. NÃO peça confirmação.

IMAGEM FONTE:
- Se o contexto incluir a chave de imagem de origem, coloque no campo description do propose_event:
  "📸 Criado a partir de foto: [URL do link de imagem]"
- Coloque o link no início do description, seguido de quebra de linha dupla e qualquer descrição adicional.
- Não mencione a imagem de origem para o usuário — apenas inclua no description silenciosamente.`,
  };
}

// ─── Main agent loop ──────────────────────────────────────────────────────────

export async function runAgentTurn(
  chatId: string,
  userText: string,
  opts?: { imageLink?: string }
): Promise<AgentResponse> {
  const openai = new OpenAI();
  const state = conversationStore.getOrCreate(chatId);

  // Store imageLink only on the first turn where it's provided (photo turns)
  if (opts?.imageLink) {
    conversationStore.setImageLink(chatId, opts.imageLink);
  }

  // Prepend system prompt on first turn
  if (state.messages.length === 0) {
    state.messages.push(buildSystemPrompt());
  }

  // Append user message
  const userMsg: AgentMessage = { role: 'user', content: userText };
  conversationStore.appendMessage(chatId, userMsg);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Draft context injection — rebuilt each iteration to reflect mutations from previous iteration
    const contextLines = [
      `DRAFT ATUAL: ${state.draft ? JSON.stringify(state.draft) : '(vazio)'}`,
      `ULTIMO_EVENTO_CRIADO_ID: ${state.lastCreatedEventId ?? '(nenhum)'}`,
    ];
    if (state.imageLink) {
      contextLines.push(`IMAGEM_FONTE: ${state.imageLink}`);
    }
    const draftContextMsg: AgentMessage = {
      role: 'system' as const,
      content: contextLines.join('\n'),
    };
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
      const handler = getToolHandler(toolName);

      let toolResult: ToolResult;
      try {
        const toolArgs = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) as Record<string, unknown> : {};
        toolResult = handler ? await handler(toolArgs, state, { chatId }) : { content: { error: 'unknown_tool', tool: toolName } };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        conversationStore.appendMessage(chatId, {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: JSON.stringify({ error: errMsg }),
        });
        continue; // skip to next tool call
      }

      // Apply state mutations if provided
      if (toolResult.stateMutator) {
        toolResult.stateMutator(state);
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
