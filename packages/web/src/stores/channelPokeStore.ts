import { create } from 'zustand';

/**
 * Which instances offer channel pokes, per origin: the `supportsPoke` flag of
 * each instance's `ready` (websocket.md, "Channel pokes"). A poke is sent to
 * the instance hosting the space, so the author menu offers it only where
 * that instance said yes; a 1.10.0 or older instance sends no flag.
 */
export const useChannelPokeStore = create<{
  hosts: Record<string, boolean>;
  setHost: (origin: string, supported: boolean) => void;
  reset: () => void;
}>((set) => ({
  hosts: {},
  setHost: (origin, supported) => set(state => ({ hosts: { ...state.hosts, [origin]: supported } })),
  reset: () => set({ hosts: {} }),
}));
