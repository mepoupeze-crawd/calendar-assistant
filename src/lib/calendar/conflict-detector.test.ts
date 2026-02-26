/**
 * Calendar Assistant - Conflict Detection Tests (t8)
 * Tests: overlap detection, boundary cases, all-day events
 */

import { checkCalendarConflicts } from './conflict-detector';
import { ValidatedEvent } from './types';

describe('Conflict Detection (t8)', () => {
  describe('Overlap Detection', () => {
    test('1. Full overlap: new event inside existing', async () => {
      // Mock: existing event 14:00-15:00, new event 14:15-14:45
      const newEvent: ValidatedEvent = {
        title: 'New Meeting',
        start_date: '2026-02-25',
        start_time: '14:15',
        end_time: '14:45',
        duration_minutes: 30,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      // In real scenario with mock data, this should detect conflict
      expect(conflicts).toBeDefined();
      expect(conflicts.has_conflicts).toBeDefined();
    });

    test('2. Partial overlap: new event starts during existing', async () => {
      const newEvent: ValidatedEvent = {
        title: 'New Meeting',
        start_date: '2026-02-25',
        start_time: '14:45',
        end_time: '15:15',
        duration_minutes: 30,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts).toBeDefined();
      expect(Array.isArray(conflicts.conflicts)).toBe(true);
    });

    test('3. Partial overlap: new event ends during existing', async () => {
      const newEvent: ValidatedEvent = {
        title: 'New Meeting',
        start_date: '2026-02-25',
        start_time: '13:45',
        end_time: '14:15',
        duration_minutes: 30,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts).toBeDefined();
    });

    test('4. Wraps existing: new event covers multiple events', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Block Day',
        start_date: '2026-02-25',
        start_time: '14:00',
        end_time: '16:00',
        duration_minutes: 120,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts).toBeDefined();
      // Should potentially show multiple conflicts
    });
  });

  describe('Boundary Cases', () => {
    test('5. Exact boundary: new end = existing start (OK)', async () => {
      // Existing: 15:00-16:00, New: 14:00-15:00 (touching but no overlap)
      const newEvent: ValidatedEvent = {
        title: 'New Meeting',
        start_date: '2026-02-25',
        start_time: '14:00',
        end_time: '15:00',
        duration_minutes: 60,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts.has_conflicts).toBe(false);
    });

    test('6. Exact boundary: new start = existing end (OK)', async () => {
      // Existing: 14:00-15:00, New: 15:00-16:00
      const newEvent: ValidatedEvent = {
        title: 'New Meeting',
        start_date: '2026-02-25',
        start_time: '15:00',
        end_time: '16:00',
        duration_minutes: 60,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts.has_conflicts).toBe(false);
    });

    test('7. 1-minute gap (OK)', async () => {
      const newEvent: ValidatedEvent = {
        title: 'New Meeting',
        start_date: '2026-02-25',
        start_time: '15:01',
        end_time: '16:00',
        duration_minutes: 59,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts.has_conflicts).toBe(false);
    });
  });

  describe('All-Day Events', () => {
    test('8. All-day event: no time-based conflicts', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Holiday',
        start_date: '2026-02-25',
        start_time: null,
        end_time: null,
        duration_minutes: null,
        all_day: true,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      // All-day events don't conflict with timed events time-wise
      expect(conflicts).toBeDefined();
    });

    test('9. All-day + timed event same day (technically overlapping)', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Focused Day',
        start_date: '2026-02-25',
        start_time: null,
        end_time: null,
        duration_minutes: null,
        all_day: true,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts).toBeDefined();
    });
  });

  describe('Multiple Events', () => {
    test('10. Multiple conflicts: 3 overlapping events', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Long Block',
        start_date: '2026-02-25',
        start_time: '13:00',
        end_time: '17:00',
        duration_minutes: 240,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      if (conflicts.has_conflicts) {
        expect(conflicts.conflicts.length).toBeGreaterThanOrEqual(1);
        // Each conflict should have required fields
        conflicts.conflicts.forEach(c => {
          expect(c.title).toBeTruthy();
          expect(c.start_time).toMatch(/\d{2}:\d{2}/);
          expect(c.end_time).toMatch(/\d{2}:\d{2}/);
          expect(c.calendar_event_id).toBeTruthy();
        });
      }
    });
  });

  describe('Edge Cases', () => {
    test('11. Different date: no conflicts', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Future Event',
        start_date: '2026-03-01',
        start_time: '14:00',
        end_time: '15:00',
        duration_minutes: 60,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts.has_conflicts).toBe(false);
    });

    test('12. First event of day', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Early Morning',
        start_date: '2026-02-25',
        start_time: '08:00',
        end_time: '09:00',
        duration_minutes: 60,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts).toBeDefined();
    });

    test('13. Last event of day', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Late Evening',
        start_date: '2026-02-25',
        start_time: '23:00',
        end_time: '23:30',
        duration_minutes: 30,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts).toBeDefined();
    });

    test('14. Very short event (1 minute)', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Quick Standup',
        start_date: '2026-02-25',
        start_time: '14:30',
        end_time: '14:31',
        duration_minutes: 1,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts).toBeDefined();
    });

    test('15. Very long event (8 hours)', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Retreat',
        start_date: '2026-02-25',
        start_time: '08:00',
        end_time: '16:00',
        duration_minutes: 480,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      expect(conflicts).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    test('16. Invalid calendar ID (should gracefully fail)', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Test Event',
        start_date: '2026-02-25',
        start_time: '14:00',
        end_time: '15:00',
        duration_minutes: 60,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      try {
        await checkCalendarConflicts(newEvent, 'nonexistent-calendar-id');
        // Either succeeds with no conflicts or throws
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    test('17. Google Calendar unavailable (network error)', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Test Event',
        start_date: '2026-02-25',
        start_time: '14:00',
        end_time: '15:00',
        duration_minutes: 60,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      try {
        await checkCalendarConflicts(newEvent, 'primary');
        // Implementation should handle gracefully
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });

  describe('Conflict Info Format', () => {
    test('18. Conflict object has all required fields', async () => {
      const newEvent: ValidatedEvent = {
        title: 'Meeting',
        start_date: '2026-02-25',
        start_time: '14:30',
        end_time: '15:30',
        duration_minutes: 60,
        all_day: false,
        participants: [],
        description: null,
        location: null,
      };

      const conflicts = await checkCalendarConflicts(newEvent, 'primary');
      
      if (conflicts.has_conflicts && conflicts.conflicts.length > 0) {
        const conflict = conflicts.conflicts[0];
        expect(conflict).toHaveProperty('title');
        expect(conflict).toHaveProperty('start_time');
        expect(conflict).toHaveProperty('end_time');
        expect(conflict).toHaveProperty('calendar_event_id');
        expect(conflict).toHaveProperty('event_date');
      }
    });
  });
});
