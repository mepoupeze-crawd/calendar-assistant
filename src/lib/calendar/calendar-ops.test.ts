// At top of test file — BEFORE imports
jest.mock('googleapis', () => {
  const mockEventsList = jest.fn().mockResolvedValue({
    data: {
      items: [
        {
          id: 'e1',
          summary: 'Reunião João',
          start: { dateTime: '2026-05-01T14:00:00-03:00' },
          end: { dateTime: '2026-05-01T15:00:00-03:00' },
          location: 'Sala 101',
          attendees: [{ email: 'joao@example.com', displayName: 'João' }],
        },
      ],
    },
  });
  const mockEventsPatch = jest.fn().mockResolvedValue({
    data: { id: 'e1', htmlLink: 'https://calendar.google.com/event?eid=e1' },
  });
  const mockEventsDelete = jest.fn().mockResolvedValue({});

  return {
    google: {
      calendar: jest.fn(() => ({
        events: {
          list: mockEventsList,
          patch: mockEventsPatch,
          delete: mockEventsDelete,
        },
      })),
    },
    _mockEventsList: mockEventsList,
    _mockEventsPatch: mockEventsPatch,
    _mockEventsDelete: mockEventsDelete,
  };
});

jest.mock('./google-auth', () => ({ getGoogleAuth: () => ({}) }));

import * as googleapis from 'googleapis';
import {
  listUpcomingEvents,
  searchEventsByQuery,
  updateEvent,
  deleteEvent,
} from './calendar-ops';

const mockEventsList = (googleapis as any)._mockEventsList as jest.Mock;
const mockEventsPatch = (googleapis as any)._mockEventsPatch as jest.Mock;
const mockEventsDelete = (googleapis as any)._mockEventsDelete as jest.Mock;

describe('calendar-ops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset to default mock
    mockEventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: 'e1',
            summary: 'Reunião João',
            start: { dateTime: '2026-05-01T14:00:00-03:00' },
            end: { dateTime: '2026-05-01T15:00:00-03:00' },
            location: 'Sala 101',
            attendees: [{ email: 'joao@example.com', displayName: 'João' }],
          },
        ],
      },
    });
    mockEventsPatch.mockResolvedValue({
      data: { id: 'e1', htmlLink: 'https://calendar.google.com/event?eid=e1' },
    });
    mockEventsDelete.mockResolvedValue({});
  });

  test('1. listUpcomingEvents returns mapped CalendarEventSummary array', async () => {
    const events = await listUpcomingEvents({ daysAhead: 7 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'e1',
      summary: 'Reunião João',
      start: '2026-05-01T14:00:00-03:00',
      end: '2026-05-01T15:00:00-03:00',
      location: 'Sala 101',
      attendees: [{ email: 'joao@example.com', displayName: 'João' }],
    });

    expect(mockEventsList).toHaveBeenCalledWith(
      expect.objectContaining({
        singleEvents: true,
        orderBy: 'startTime',
      })
    );
  });

  test('2. searchEventsByQuery passes query param and returns filtered items', async () => {
    const events = await searchEventsByQuery({ query: 'João', daysAhead: 14 });

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('e1');

    expect(mockEventsList).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'João',
        singleEvents: true,
        orderBy: 'startTime',
      })
    );
  });

  test('3. updateEvent calls events.patch and returns { google_event_id, event_link }', async () => {
    const result = await updateEvent('e1', { summary: 'Updated Meeting' });

    expect(result).toEqual({
      google_event_id: 'e1',
      event_link: 'https://calendar.google.com/event?eid=e1',
    });

    expect(mockEventsPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'e1',
        requestBody: { summary: 'Updated Meeting' },
      })
    );
  });

  test('4. deleteEvent calls events.delete with correct eventId', async () => {
    await deleteEvent('e1');

    expect(mockEventsDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'e1',
      })
    );
  });

  test('5. toSummary handles all-day events (start.date instead of start.dateTime)', async () => {
    mockEventsList.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: 'e2',
            summary: 'Feriado',
            start: { date: '2026-05-01' },
            end: { date: '2026-05-01' },
          },
        ],
      },
    });

    const events = await listUpcomingEvents({});

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'e2',
      summary: 'Feriado',
      start: '2026-05-01',
      end: '2026-05-01',
    });
  });
});
