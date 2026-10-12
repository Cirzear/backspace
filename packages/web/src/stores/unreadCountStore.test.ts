import { beforeEach, describe, expect, it } from 'vitest';
import { useUnreadCountStore } from './unreadCountStore';

describe('unread count snapshots', () => {
  beforeEach(() => useUnreadCountStore.getState().reset());

  it('replaces one origin on reconnect without touching another', () => {
    const store = useUnreadCountStore.getState();
    store.hydrate('', { a: 3, gone: 2 });
    store.hydrate('remote', { b: 5 });
    store.updateCounts('', { a: 0 });
    expect(useUnreadCountStore.getState().counts).toEqual({ '': { a: 0, gone: 2 }, remote: { b: 5 } });
    store.hydrate('', { a: 1 });
    expect(useUnreadCountStore.getState().counts).toEqual({ '': { a: 1 }, remote: { b: 5 } });
  });

  it('forgets an origin whose ready carries no counts', () => {
    const store = useUnreadCountStore.getState();
    store.hydrate('remote', { b: 5 });
    store.hydrate('remote', undefined);
    expect(useUnreadCountStore.getState().counts).toEqual({});
  });

  it('starts an origin from a follow-up when it has no snapshot yet', () => {
    useUnreadCountStore.getState().updateCounts('remote', { b: 1 });
    expect(useUnreadCountStore.getState().counts).toEqual({ remote: { b: 1 } });
  });
});
