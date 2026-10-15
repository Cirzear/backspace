import { create } from 'zustand';

/**
 * Exact unread message counts, per origin and then per channel or DM id, as
 * the instance at that origin counted them (websocket.md, "Unread counts").
 * The instance stops counting at 100, which reads "100 or more"; the badges
 * show anything above 99 as "99+".
 *
 * An origin is absent when its instance sends no counts (a release before
 * they existed): its badges stay hidden and its unread dots work as before.
 * Within a present origin, a missing id means the instance has not counted
 * that channel yet (it was created or became visible after `ready`).
 */
interface UnreadCountState {
  counts: Record<string, Record<string, number>>;
  /** Replace an origin's counts with its `ready` snapshot, or drop them when the snapshot has none. */
  hydrate: (origin: string, counts: Record<string, number> | undefined) => void;
  /** Apply a `channel_unread_count` from `origin`. */
  updateCounts: (origin: string, counts: Record<string, number>) => void;
  reset: () => void;
}

export const useUnreadCountStore = create<UnreadCountState>(set => ({
  counts: {},
  hydrate: (origin, counts) => set(s => {
    const next = { ...s.counts };
    if (counts) next[origin] = counts;
    else delete next[origin];
    return { counts: next };
  }),
  updateCounts: (origin, counts) => set(s => ({
    counts: { ...s.counts, [origin]: { ...s.counts[origin], ...counts } },
  })),
  reset: () => set({ counts: {} }),
}));
