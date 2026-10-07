import type { StateCreator } from 'zustand';
import { useChatStore } from './chatStore';
import { dropOrigin } from './dmConversations';
import {
  channelIdsWhere,
  channelTableFields,
  channelTablesOf,
  dropChannels,
} from './spaceChannels';
import { commitDmOperation, dmPinContext } from './spaceStore';
import type { SpaceState, UserViewEntry } from './spaceStoreTypes';

export const createRemoveInstanceSpacesSlice: StateCreator<
  SpaceState,
  [],
  [],
  Pick<SpaceState, 'removeInstanceSpaces'>
> = (set, get) => ({
  removeInstanceSpaces: (origin: string) => {
    // Collect channel IDs before set() for chatStore cleanup
    const currentState = get();
    const channelIdsToRemove = new Set<string>();
    for (const [channelId, chOrigin] of currentState.channelOriginMap) {
      if (chOrigin === origin) channelIdsToRemove.add(channelId);
    }

    set((state) => {
      const remainingSpaces = state.spaces.filter((s) => s._instanceOrigin !== origin);

      const spacePermissions = new Map(state.spacePermissions);
      for (const s of state.spaces) {
        if (s._instanceOrigin === origin) {
          spacePermissions.delete(s.id);
        }
      }
      const categoryOriginMap = new Map<string, string>();
      for (const [categoryId, categoryOrigin] of state.categoryOriginMap) {
        if (categoryOrigin !== origin) categoryOriginMap.set(categoryId, categoryOrigin);
      }
      const spaceChannelIds = channelIdsWhere(state.spaceChannelIndex, (e) => e.origin === origin);

      // Prune userViews: drop entries delivered by this origin. Symmetrical
      // with the DM copies — full removal evicts; transient disconnect leaves
      // the last-known view in place. If the surviving cache no longer holds
      // a home view for some user, render falls back to whatever the carrying
      // payload supplies (no crash; just degrades to stub view).
      const userViews = new Map<string, UserViewEntry>();
      for (const [key, entry] of state.userViews) {
        if (entry.deliveredBy !== origin) userViews.set(key, entry);
      }

      // Drop loadedSpaceIds entries for spaces removed by this instance teardown
      const removedSpaceIds = new Set(
        state.spaces.filter((s) => s._instanceOrigin === origin).map((s) => s.id)
      );
      const loadedSpaceIds = new Set<string>();
      for (const id of state.loadedSpaceIds) {
        if (!removedSpaceIds.has(id)) loadedSpaceIds.add(id);
      }

      return {
        ...channelTableFields(state, dropChannels(channelTablesOf(state), spaceChannelIds)),
        spaces: remainingSpaces,
        spacePermissions,
        categoryOriginMap,
        userViews,
        currentSpaceId: remainingSpaces.find((s) => s.id === state.currentSpaceId)
          ? state.currentSpaceId
          : null,
        lastSelectedSpaceId: remainingSpaces.find((s) => s.id === state.lastSelectedSpaceId)
          ? state.lastSelectedSpaceId
          : null,
        loadedSpaceIds,
      };
    });

    // This origin's DM copies go. A row pinned to one of them moves to
    // another copy of its conversation, and its chat state moves with it,
    // before the states of the removed ids are cleaned up below.
    commitDmOperation(dropOrigin(get().dmConversations, origin, dmPinContext()));

    // Clean up orphaned unread/read states and cached messages in chatStore
    if (channelIdsToRemove.size > 0) {
      useChatStore.getState().removeChannelStates(channelIdsToRemove);
    }
  },
});
