/**
 * telegram-calendar.test.ts — Integration tests for handleConfirmation
 * Focuses on the event_id contract returned after event creation (Bug A fix).
 */

// Mock createCalendarEvent (called inside handleConfirmation)
jest.mock('../lib/calendar/creator', () => ({
  createCalendarEvent: jest.fn(),
}));

// Mock google-auth to avoid real credentials
jest.mock('../lib/calendar/google-auth', () => ({
  getGoogleAuth: jest.fn().mockReturnValue({}),
  getCalendarClient: jest.fn().mockReturnValue({}),
}));

// Mock other dependencies used by handleConfirmation indirectly
jest.mock('../lib/calendar/parser', () => ({
  parseEventFromInput: jest.fn(),
}));
jest.mock('../lib/calendar/validator', () => ({
  validateParsedEvent: jest.fn(),
}));
jest.mock('../lib/calendar/conflict-detector', () => ({
  checkCalendarConflicts: jest.fn().mockResolvedValue({ has_conflicts: false, conflicts: [] }),
}));
jest.mock('../lib/calendar/previewer', () => ({
  generatePreview: jest.fn().mockReturnValue({ event_id: 'preview-id', text: 'Preview' }),
}));
jest.mock('../lib/calendar/contacts', () => ({
  lookupContactsByName: jest.fn().mockResolvedValue({ contacts: [], error: false }),
}));

import { handleConfirmation } from './telegram-calendar';
import { createCalendarEvent } from '../lib/calendar/creator';
import type { ValidatedEvent } from '../lib/calendar/types';

const mockCreate = createCalendarEvent as jest.MockedFunction<typeof createCalendarEvent>;

const validEvent: ValidatedEvent = {
  title: 'Reunião Teste',
  start_date: '2026-05-01',
  start_time: '14:00',
  end_time: '15:00',
  duration_minutes: 60,
  all_day: false,
  participants: [],
  description: null,
  location: null,
};

describe('handleConfirmation — contrato de retorno event_id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('1. retorna event_id após criação bem-sucedida', async () => {
    mockCreate.mockResolvedValueOnce({
      google_event_id: 'cal_abc123',
      event_link: 'https://cal.google.com/x',
    } as any);

    const response = await handleConfirmation('chat-1', 'pending-id', validEvent);

    expect(response.event_id).toBe('cal_abc123');
    expect(response.text).not.toContain('Event ID:');
    expect(response.text).toContain('✅ Evento criado!');
  });

  it('2. não retorna event_id quando criação falha', async () => {
    mockCreate.mockRejectedValueOnce(new Error('quota exceeded'));

    const response = await handleConfirmation('chat-2', 'pending-id', validEvent);

    expect(response.event_id).toBeUndefined();
    expect(response.text).toContain('❌ Erro');
  });

  it('3. retorna event_id diferente para cada evento criado', async () => {
    mockCreate.mockResolvedValueOnce({
      google_event_id: 'cal_xyz999',
      event_link: 'https://cal.google.com/y',
    } as any);

    const response = await handleConfirmation('chat-3', 'pending-id-2', validEvent);

    expect(response.event_id).toBe('cal_xyz999');
  });
});
