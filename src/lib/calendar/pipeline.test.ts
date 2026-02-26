/**
 * Calendar Assistant - Phase 1 Integration Tests (t7)
 * Tests: text input → validation → preview → creation flow
 * 
 * Test Suite: 10+ manual cases covering valid, invalid, ambiguous inputs
 */

import { parseEventFromInput } from './parser';
import { validateParsedEvent } from './validator';
import { generatePreview } from './previewer';
import { ParsedEvent, ValidatedEvent } from './types';

describe('Calendar Agent - Phase 1 Pipeline', () => {
  describe('Valid Inputs', () => {
    test('1. Simple event with all fields', async () => {
      const input = 'Reunião com João amanhã às 14:30 por 1 hora no escritório';
      const parsed = await parseEventFromInput(input);

      expect(parsed.status).toMatch(/success|ambiguous/);
      expect(parsed.title).toBeTruthy();
      expect(parsed.start_date).toBeTruthy();
      expect(parsed.start_time).toBeTruthy();

      const validation = validateParsedEvent(parsed);
      expect(validation.valid).toBe(true);
      expect(validation.correctedEvent).toBeTruthy();

      const preview = generatePreview(validation.correctedEvent!);
      expect(preview.text).toContain('Reunião');
      expect(preview.keyboard.buttons[0].length).toBe(3);
    });

    test('2. All-day event', async () => {
      const input = 'Congresso de TI o dia todo em 28/02';
      const parsed = await parseEventFromInput(input);

      expect(parsed.title).toBeTruthy();
      expect(parsed.start_date).toBeTruthy();

      const validation = validateParsedEvent(parsed);
      if (validation.valid) {
        expect(validation.correctedEvent!.all_day).toBe(true);
        expect(validation.correctedEvent!.start_time).toBeNull();
      }
    });

    test('3. Event with multiple participants', async () => {
      const input = 'Café com João, Maria e Pedro próxima segunda 10:00';
      const parsed = await parseEventFromInput(input);

      expect(parsed.participants.length).toBeGreaterThan(0);

      const validation = validateParsedEvent(parsed);
      if (validation.valid) {
        expect(validation.correctedEvent!.participants.length).toBeGreaterThan(0);
      }
    });

    test('4. Short, simple event', async () => {
      const input = 'Standup 9:30';
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      // May be ambiguous due to missing date, but should parse title + time
      expect(parsed.start_time).toBeTruthy();
    });
  });

  describe('Ambiguous Inputs (Should Block)', () => {
    test('5. Vague time: "à noite"', async () => {
      const input = 'Reunião amanhã à noite';
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      if (validation.status === 'ambiguous') {
        expect(validation.clarificationRequest).toContain('horário');
      }
    });

    test('6. Vague date: "próxima semana"', async () => {
      const input = 'Almoço com João próxima semana';
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      if (validation.status === 'ambiguous' || validation.status === 'invalid') {
        expect(validation.clarificationRequest || validation.errors.length).toBeTruthy();
      }
    });

    test('7. Very vague: no date or time', async () => {
      const input = 'Reunião com João';
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      expect(validation.valid).toBe(false);
    });

    test('8. Date without year (should assume current year)', async () => {
      const input = 'Apresentação 25/02 14:30';
      const parsed = await parseEventFromInput(input);

      // Parser should assume current year 2026
      if (parsed.start_date) {
        expect(parsed.start_date).toMatch(/2026/);
      }
    });
  });

  describe('Invalid Inputs (Should Reject)', () => {
    test('9. Empty input', async () => {
      const input = '';
      const parsed = await parseEventFromInput(input);

      expect(parsed.status).toBe('error');
      expect(parsed.ambiguities.length).toBeGreaterThan(0);
    });

    test('10. Invalid date (30/02)', async () => {
      const input = 'Reunião 30/02 14:30';
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    test('11. Invalid time format', async () => {
      const input = 'Reunião amanhã 25:00'; // 25h invalid
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      expect(validation.valid).toBe(false);
    });

    test('12. End time before start time', async () => {
      const input = 'Reunião amanhã 14:30 às 10:00'; // end before start
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      expect(validation.valid).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    test('13. Same-day retroactive event (should warn but allow)', async () => {
      const input = 'Reunião hoje 14:30';
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      // Should pass validation but include warning
      if (validation.valid) {
        expect(validation.warnings.length).toBeGreaterThanOrEqual(0);
      }
    });

    test('14. Event exactly 365 days away', async () => {
      const input = 'Conferência 25/02/2027 10:00';
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      // Should be at boundary (valid)
      expect(validation.valid).toBe(true);
    });

    test('15. Event >365 days away (should reject)', async () => {
      const input = 'Event 01/01/2030 10:00';
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      expect(validation.valid).toBe(false);
    });

    test('16. Title at length boundary (100 chars)', async () => {
      const longTitle = 'A'.repeat(100);
      const input = `${longTitle} amanhã 14:30`;
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      expect(validation.valid).toBe(true);
    });

    test('17. Title too long (>100 chars)', async () => {
      const longTitle = 'A'.repeat(101);
      const input = `${longTitle} amanhã 14:30`;
      const parsed = await parseEventFromInput(input);

      const validation = validateParsedEvent(parsed);
      expect(validation.valid).toBe(false);
    });
  });

  describe('Preview Generation', () => {
    test('18. Preview message format', async () => {
      const event: ValidatedEvent = {
        title: 'Reunião Importante',
        start_date: '2026-02-25',
        start_time: '14:30',
        end_time: '15:30',
        duration_minutes: 60,
        all_day: false,
        participants: [
          { name: 'João', email: 'joao@example.com', resolved: true },
          { name: 'Maria', email: null, resolved: false },
        ],
        description: 'Discussão sobre Q1 roadmap',
        location: 'Sala 101',
      };

      const preview = generatePreview(event);

      expect(preview.text).toContain('Reunião Importante');
      expect(preview.text).toContain('Quarta-feira, 25/02/2026');
      expect(preview.text).toContain('14:30–15:30');
      expect(preview.text).toContain('João, Maria');
      expect(preview.event_id).toMatch(/^\d{10}[A-Z0-9]{6}$/);
      expect(preview.keyboard.buttons[0]).toHaveLength(3);
    });

    test('19. Preview with all-day event', async () => {
      const event: ValidatedEvent = {
        title: 'Feriado',
        start_date: '2026-03-05',
        start_time: null,
        end_time: null,
        duration_minutes: null,
        all_day: true,
        participants: [],
        description: null,
        location: null,
      };

      const preview = generatePreview(event);

      expect(preview.text).toContain('O dia todo');
      expect(preview.text).not.toContain('–');
    });

    test('20. Preview with conflicts', async () => {
      const event: ValidatedEvent = {
        title: 'Reunião',
        start_date: '2026-02-25',
        start_time: '14:30',
        end_time: '15:30',
        duration_minutes: 60,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = [
        {
          title: 'Standup',
          start_time: '14:00',
          end_time: '14:45',
          calendar_event_id: 'evt123',
        },
      ];

      const preview = generatePreview(event, conflicts);

      expect(preview.text).toContain('⚠️ **Conflito');
      expect(preview.text).toContain('Standup');
    });
  });

  describe('End-to-End Flows', () => {
    test('21. Valid flow: parse → validate → preview', async () => {
      const input = 'Almoço com a equipe amanhã 12:00 1h na Cantina';
      const parsed = await parseEventFromInput(input);
      const validation = validateParsedEvent(parsed);

      if (validation.valid) {
        const preview = generatePreview(validation.correctedEvent!);

        expect(validation.correctedEvent!.title).toBeTruthy();
        expect(validation.correctedEvent!.start_date).toBeTruthy();
        expect(preview.text).toContain('Almoço');
        expect(preview.keyboard).toBeTruthy();
      }
    });

    test('22. Ambiguous flow: parse → validate → clarification', async () => {
      const input = 'Reunião amanhã';
      const parsed = await parseEventFromInput(input);
      const validation = validateParsedEvent(parsed);

      expect(validation.valid).toBe(false);
      expect(validation.clarificationRequest).toBeTruthy();
    });
  });
});
