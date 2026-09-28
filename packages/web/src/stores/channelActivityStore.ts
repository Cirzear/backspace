import type { ServerEvent } from '@backspace/shared';
import { create } from 'zustand';

export type PokeNotice = Extract<ServerEvent, { type: 'channel_poke' }> & {
  id: string;
  origin: string;
  createdAt: number;
};
// Pokes have no server history; bound the session-only timeline memory.
const MAX_SESSION_POKES = 200;

interface ChannelActivityState {
  pokes: PokeNotice[];
  addPoke: (origin: string, event: Extract<ServerEvent, { type: 'channel_poke' }>) => void;
  counts: Record<string, Record<string, number>>;
  pokeOrigins: Record<string, boolean>;
  hydrate: (origin: string, snapshot: { counts?: Record<string, number>; supportsPoke?: boolean }) => void;
  updateCounts: (origin: string, counts: Record<string, number>) => void;
  reset: () => void;
}
export const useChannelActivityStore = create<ChannelActivityState>(set => ({
  counts: {}, pokeOrigins: {}, pokes: [],
  addPoke: (origin, event) => set(s => ({ pokes: [...s.pokes, { ...event, origin, id: crypto.randomUUID(), createdAt: Date.now() }].slice(-MAX_SESSION_POKES) })),
  // Replace the origin snapshot on reconnect, including lost permissions/deleted channels.
  hydrate: (origin, snapshot) => set(s => ({
    counts: { ...s.counts, [origin]: snapshot.counts ?? {} },
    pokeOrigins: { ...s.pokeOrigins, [origin]: snapshot.supportsPoke === true },
  })),
  updateCounts: (origin, counts) => set(s => ({ counts: {
    ...s.counts, [origin]: { ...s.counts[origin], ...counts },
  } })),
  reset: () => set({ counts: {}, pokeOrigins: {}, pokes: [] }),
}));
