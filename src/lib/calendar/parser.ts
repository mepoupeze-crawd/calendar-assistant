/**
 * Calendar Assistant - LLM-based Natural Language Parser (t2)
 * Converts Portuguese text/voice input to structured ParsedEvent
 */

import { ParsedEvent, ParsedParticipant } from './types';

interface LLMParserRequest {
  input: string;
  model?: string;
}

interface LLMParserResponse {
  title: string | null;
  start_date: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  all_day: boolean;
  participants: ParsedParticipant[];
  description: string | null;
  location: string | null;
  ambiguities: string[];
  confidence: number;
}

/**
 * Parse Portuguese text/voice into structured event using LLM
 * Handles: natural language, colloquialisms, time expressions, participant names
 */
export async function parseEventFromInput(
  input: string,
  model: string = 'google/gemini-2.5-flash-lite'
): Promise<ParsedEvent> {
  if (!input || input.trim().length === 0) {
    return {
      status: 'error',
      confidence: 0,
      title: null,
      start_date: null,
      start_time: null,
      end_time: null,
      duration_minutes: null,
      all_day: false,
      participants: [],
      description: null,
      location: null,
      ambiguities: ['Input vazio'],
      raw_input: input,
    };
  }

  const currentYear = new Date().getFullYear();
  const today = new Date().toISOString().split('T')[0];

  const systemPrompt = `Você é um parser inteligente para eventos de calendário em português.
Sua tarefa: converter texto natural em JSON estruturado.

DATA ATUAL: ${today} (ano atual: ${currentYear})

INSTRUÇÕES:
1. Extrair: título, data, hora, duração, participantes, descrição, local
2. Detectar ambiguidades (datas vagas, horários imprecisos) e listá-las
3. Retornar confiança (0-1) baseada na clareza do input
4. Para datas: sempre retornar YYYY-MM-DD. Se o ano não for informado, assumir ${currentYear}.
5. Para horas: sempre retornar HH:MM em formato 24h
6. DATAS INVÁLIDAS: Se a data não existe no calendário (ex: 30/02, 31/04), retornar start_date como null e adicionar "data inválida: [data]" em ambiguities.
7. Participantes: [{name, email: null ou "email@"}] — resolver emails se possível
8. all_day: true se "o dia todo", "dia inteiro", ou sem hora específica
9. ambiguities: lista de frases vagas encontradas

FORMATO DE RESPOSTA (JSON válido):
{
  "title": "título ou null",
  "start_date": "YYYY-MM-DD ou null",
  "start_time": "HH:MM ou null se all_day",
  "end_time": "HH:MM ou null",
  "duration_minutes": número ou null,
  "all_day": boolean,
  "participants": [{"name": "João", "email": null}],
  "description": "str ou null",
  "location": "str ou null",
  "ambiguities": ["lista de ambiguidades detectadas"],
  "confidence": 0.95
}

EXEMPLOS:
- "reunião com João amanhã às 14:30" → ✅ claro (conf: 0.95)
- "reunião amanhã à noite" → ⚠️ ambíguo (ambiguities: ["hora não específica: 'à noite'"])
- "próxima segunda com Maria" → ⚠️ ambíguo (ambiguities: ["data vaga: 'próxima segunda'"])
- "João" → ❌ insuficiente (ambiguities: ["nenhum título, data ou hora"])`;

  const userPrompt = `Parse este texto e retorne JSON válido:

"${input}"

Responda APENAS com JSON, sem markdown ou explicações.`;

  try {
    // Simula chamada a LLM (em produção, usaria OpenAI/Claude API)
    const response = await callLLMParser(userPrompt, systemPrompt, model);
    const parsed = response as LLMParserResponse;

    // Validar resposta básica
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid LLM response');
    }

    const status = determineStatus(parsed);

    return {
      status,
      confidence: parsed.confidence || 0,
      title: parsed.title || null,
      start_date: parsed.start_date || null,
      start_time: parsed.start_time || null,
      end_time: parsed.end_time || null,
      duration_minutes: parsed.duration_minutes || null,
      all_day: parsed.all_day || false,
      participants: parsed.participants || [],
      description: parsed.description || null,
      location: parsed.location || null,
      ambiguities: parsed.ambiguities || [],
      raw_input: input,
    };
  } catch (error) {
    return {
      status: 'error',
      confidence: 0,
      title: null,
      start_date: null,
      start_time: null,
      end_time: null,
      duration_minutes: null,
      all_day: false,
      participants: [],
      description: null,
      location: null,
      ambiguities: [`Parse error: ${error instanceof Error ? error.message : 'Unknown'}`],
      raw_input: input,
    };
  }
}

function determineStatus(parsed: LLMParserResponse): ParsedEvent['status'] {
  // Se há ambiguidades detectadas, marcar como ambíguo
  if (parsed.ambiguities && parsed.ambiguities.length > 0) {
    return 'ambiguous';
  }

  // Se confiança baixa, marcar como ambíguo
  if (parsed.confidence < 0.7) {
    return 'ambiguous';
  }

  return 'success';
}

/**
 * Call LLM API via OpenRouter
 */
async function callLLMParser(
  userPrompt: string,
  systemPrompt: string,
  model: string
): Promise<LLMParserResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set');
  }

  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 1024,
  };

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'mission-control-calendar-assistant',
      'X-Title': 'Mission Control Calendar Parser',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${error}`);
  }

  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new Error('Empty response from LLM');
  }

  console.log('[PARSER] Raw LLM response:', content.substring(0, 500));

  // Try to extract JSON — handle markdown code blocks too
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                    content.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    throw new Error(`Could not extract JSON from LLM response: ${content.substring(0, 200)}`);
  }

  const jsonStr = jsonMatch[1] || jsonMatch[0];
  const parsed = JSON.parse(jsonStr) as LLMParserResponse;
  return parsed;
}

export type { LLMParserRequest, LLMParserResponse };
