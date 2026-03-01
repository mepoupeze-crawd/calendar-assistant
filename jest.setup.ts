/**
 * Jest setup file — mocks the OpenAI API so tests run without a real API key.
 * Returns deterministic responses for each test input in pipeline.test.ts.
 */

process.env.OPENAI_API_KEY = 'test-key';

const _today = new Date();
_today.setHours(0, 0, 0, 0);

function getTomorrow(): string {
  const t = new Date(_today);
  t.setDate(t.getDate() + 1);
  return t.toISOString().split('T')[0];
}

function getTodayStr(): string {
  return _today.toISOString().split('T')[0];
}

interface MockLLMData {
  title: string | null;
  start_date: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  all_day: boolean;
  participants: Array<{ name: string; email: string | null }>;
  description: string | null;
  location: string | null;
  ambiguities: string[];
  confidence: number;
}

function getMockLLMResponse(input: string): MockLLMData {
  const tomorrowStr = getTomorrow();
  const todayStr = getTodayStr();

  // Test 1: Simple event with all fields
  if (input.includes('Reunião com João amanhã às 14:30 por 1 hora no escritório')) {
    return { title: 'Reunião com João', start_date: tomorrowStr, start_time: '14:30', end_time: '15:30', duration_minutes: 60, all_day: false, participants: [{ name: 'João', email: null }], description: null, location: 'escritório', ambiguities: [], confidence: 0.95 };
  }

  // Test 2: All-day event
  if (input.includes('Congresso de TI o dia todo em 28/02')) {
    return { title: 'Congresso de TI', start_date: todayStr, start_time: null, end_time: null, duration_minutes: null, all_day: true, participants: [], description: null, location: null, ambiguities: [], confidence: 0.9 };
  }

  // Test 3: Multiple participants
  if (input.includes('Café com João, Maria e Pedro próxima segunda 10:00')) {
    return { title: 'Café', start_date: '2026-03-02', start_time: '10:00', end_time: null, duration_minutes: null, all_day: false, participants: [{ name: 'João', email: null }, { name: 'Maria', email: null }, { name: 'Pedro', email: null }], description: null, location: null, ambiguities: [], confidence: 0.9 };
  }

  // Test 4: Short event — has ambiguity (no date) so status=ambiguous, but start_time is set
  if (input.includes('Standup 9:30')) {
    return { title: 'Standup', start_date: null, start_time: '09:30', end_time: null, duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: ['data não informada'], confidence: 0.6 };
  }

  // Test 5: Vague time "à noite" (must come before generic "Reunião amanhã" check)
  if (input.includes('Reunião amanhã à noite')) {
    return { title: 'Reunião', start_date: tomorrowStr, start_time: null, end_time: null, duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: ["hora não específica: 'à noite'"], confidence: 0.5 };
  }

  // Test 6: Vague date "próxima semana"
  if (input.includes('Almoço com João próxima semana')) {
    return { title: 'Almoço com João', start_date: null, start_time: null, end_time: null, duration_minutes: null, all_day: false, participants: [{ name: 'João', email: null }], description: null, location: null, ambiguities: ["data vaga: 'próxima semana'"], confidence: 0.4 };
  }

  // Test 7: Very vague — no date or time
  if (input.trim() === 'Reunião com João') {
    return { title: 'Reunião com João', start_date: null, start_time: null, end_time: null, duration_minutes: null, all_day: false, participants: [{ name: 'João', email: null }], description: null, location: null, ambiguities: ['data não informada', 'hora não informada'], confidence: 0.3 };
  }

  // Test 8: Date without year (assumes current year)
  if (input.includes('Apresentação 25/02 14:30')) {
    return { title: 'Apresentação', start_date: '2026-02-25', start_time: '14:30', end_time: null, duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: [], confidence: 0.85 };
  }

  // Test 10: Invalid date 30/02
  if (input.includes('Reunião 30/02 14:30')) {
    return { title: 'Reunião', start_date: null, start_time: '14:30', end_time: null, duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: ['data inválida: 30/02'], confidence: 0.5 };
  }

  // Test 11: Invalid time 25:00 — return as-is so validator catches it (must come before generic "Reunião amanhã")
  if (input.includes('Reunião amanhã 25:00')) {
    return { title: 'Reunião', start_date: tomorrowStr, start_time: '25:00', end_time: null, duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: [], confidence: 0.7 };
  }

  // Test 12: End before start (must come before generic "Reunião amanhã")
  if (input.includes('Reunião amanhã 14:30 às 10:00')) {
    return { title: 'Reunião', start_date: tomorrowStr, start_time: '14:30', end_time: '10:00', duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: [], confidence: 0.8 };
  }

  // Test 13: Same-day retroactive event
  if (input.includes('Reunião hoje 14:30')) {
    return { title: 'Reunião', start_date: todayStr, start_time: '14:30', end_time: null, duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: [], confidence: 0.9 };
  }

  // Test 14: Event exactly 365 days away (25/02/2027)
  if (input.includes('Conferência 25/02/2027 10:00')) {
    return { title: 'Conferência', start_date: '2027-02-25', start_time: '10:00', end_time: null, duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: [], confidence: 0.95 };
  }

  // Test 15: Far future event (>365 days)
  if (input.includes('Event 01/01/2030 10:00')) {
    return { title: 'Event', start_date: '2030-01-01', start_time: '10:00', end_time: null, duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: [], confidence: 0.95 };
  }

  // Tests 16 & 17: Long title (100 or 101 A's) — preserve full title so validator checks length
  if (/^A{50,}/.test(input)) {
    const titleMatch = input.match(/^(A+)/);
    const title = titleMatch ? titleMatch[1] : '';
    return { title, start_date: tomorrowStr, start_time: '14:30', end_time: null, duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: [], confidence: 0.9 };
  }

  // Test 21: Valid end-to-end flow
  if (input.includes('Almoço com a equipe amanhã 12:00 1h na Cantina')) {
    return { title: 'Almoço com a equipe', start_date: tomorrowStr, start_time: '12:00', end_time: '13:00', duration_minutes: 60, all_day: false, participants: [], description: null, location: 'Cantina', ambiguities: [], confidence: 0.95 };
  }

  // Test 22: Ambiguous — missing time (generic "Reunião amanhã" catch-all, must come last)
  if (input.includes('Reunião amanhã')) {
    return { title: 'Reunião', start_date: tomorrowStr, start_time: null, end_time: null, duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: ['hora não específica'], confidence: 0.5 };
  }

  // Fallback for any unrecognised input
  return { title: null, start_date: null, start_time: null, end_time: null, duration_minutes: null, all_day: false, participants: [], description: null, location: null, ambiguities: ['input não reconhecido pelo mock'], confidence: 0.0 };
}

// Replace global fetch with a deterministic mock for the LLM API
(global as Record<string, unknown>).fetch = async (
  _url: unknown,
  options?: RequestInit
): Promise<Response> => {
  const body = JSON.parse((options?.body as string) || '{}') as {
    messages?: Array<{ role: string; content: string }>;
  };

  const userMsg = body.messages?.find((m) => m.role === 'user');
  const content = userMsg?.content ?? '';

  // Extract the original input text from the prompt template:
  // `Parse este texto e retorne JSON válido:\n\n"${input}"\n\n...`
  const match = content.match(/Parse este texto e retorne JSON v[áa]lido:\n\n"([\s\S]*?)"\n\n/);
  const input = match ? match[1] : content;

  const mockData = getMockLLMResponse(input);
  const responseContent = JSON.stringify(mockData);

  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: responseContent } }] }),
    text: async () => responseContent,
  } as unknown as Response;
};
