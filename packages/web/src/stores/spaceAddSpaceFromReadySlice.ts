import type { SpaceWithChannelsAndMembers } from '@backspace/shared';
import type { StateCreator } from 'zustand';
import { resolveAssetUrl } from '../utils/assetUrls';
import { useChatStore } from './chatStore';
import {
  channelTableFields,
  channelTablesOf,
  replaceSpaceChannels,
  withCategoryOrigins,
} from './spaceChannels';
import type { TaggedSpace } from './spaceStore';
import type { SpaceState } from './spaceStoreTypes';

export const createAddSpaceFromReadySlice: StateCreator<
  SpaceState,
  [],
  [],
  Pick<SpaceState, 'addSpaceFromReady'>
> = (set, _get) => ({
  addSpaceFromReady: (origin: string, space: SpaceWithChannelsAndMembers) => {
    // Normalize remote asset URLs before creating the tagged object
    if (origin) {
      if (space.icon) space.icon = resolveAssetUrl(space.icon, origin) ?? space.icon;
      if (space.banner) space.banner = resolveAssetUrl(space.banner, origin) ?? space.banner;
    }

    const tagged: TaggedSpace = {
      id: space.id,
      name: space.name,
      icon: space.icon,
      banner: space.banner ?? null,
      avatarColor: space.avatarColor ?? null,
      ownerId: space.ownerId,
      ownerTitle: space.ownerTitle,
      inviteCode: space.inviteCode,
      visibility: space.visibility,
      directoryListed: space.directoryListed ?? false,
      description: space.description,
      createdAt: space.createdAt,
      _instanceOrigin: origin,
    };

    let dropped: string[] = [];
    set((state) => {
      const replaced = replaceSpaceChannels(channelTablesOf(state), space.id, origin, space.channels);
      dropped = replaced.dropped;
      const spacePermissions = new Map(state.spacePermissions);
      if (space.myPermissions) spacePermissions.set(space.id, space.myPermissions);
      return {
        ...channelTableFields(state, replaced.tables),
        spaces: [...state.spaces.filter((s) => s.id !== space.id), tagged],
        spacePermissions,
        categoryOriginMap: withCategoryOrigins(state.categoryOriginMap, space.categories ?? [], origin),
      };
    });
    if (dropped.length > 0) useChatStore.getState().removeChannelStates(new Set(dropped));
  },
});
