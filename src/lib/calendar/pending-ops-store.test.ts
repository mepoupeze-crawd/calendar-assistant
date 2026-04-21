import { PendingOpsStore } from './pending-ops-store';

describe('PendingOpsStore', () => {
  it('stores and retrieves an update op', () => {
    const store = new PendingOpsStore(60000);
    store.set('op1', { type: 'update', google_event_id: 'e1', patch: { start: {} }, summary: 'Reunião' });
    const op = store.get('op1');
    expect(op).not.toBeNull();
    expect(op!.type).toBe('update');
    expect(op!.google_event_id).toBe('e1');
  });

  it('stores and retrieves a delete op', () => {
    const store = new PendingOpsStore(60000);
    store.set('op2', { type: 'delete', google_event_id: 'e2', summary: 'Standup' });
    const op = store.get('op2');
    expect(op).not.toBeNull();
    expect(op!.type).toBe('delete');
  });

  it('returns null after TTL expires', () => {
    jest.useFakeTimers();
    const store = new PendingOpsStore(1000);
    store.set('op3', { type: 'delete', google_event_id: 'e3', summary: 'Test' });
    jest.advanceTimersByTime(1500);
    expect(store.get('op3')).toBeNull();
    jest.useRealTimers();
  });

  it('delete removes the op', () => {
    const store = new PendingOpsStore(60000);
    store.set('op4', { type: 'delete', google_event_id: 'e4', summary: 'Test' });
    store.delete('op4');
    expect(store.get('op4')).toBeNull();
  });

  it('returns null for unknown opId', () => {
    const store = new PendingOpsStore(60000);
    expect(store.get('nonexistent')).toBeNull();
  });
});
