import type { DmChannel, SpaceFolder, SpaceLayoutItem, SpaceWithChannelsAndMembers } from '@backspace/shared';
import { normalizeUserAssets } from '../utils/assetUrls';
import { sortDmChannels } from '../utils/dmSorting';
import { useChatStore } from './chatStore';

import type { StateCreator } from 'zustand';
import { type TaggedSpace, pushLayoutToOrigin } from './spaceStore';
import type { SpaceState } from './spaceStoreTypes';

export const createPopulateFromReadySlice: StateCreator<SpaceState, [], [], Pick<SpaceState, 'populateFromReady'>> = (set, get) => ({
  populateFromReady: (origin: string, spaces: SpaceWithChannelsAndMembers[], folders?: SpaceFolder[], dmChannels?: DmChannel[], spaceLayout?: SpaceLayoutItem[] | null, layoutUpdatedAt?: number) => {
    const isHome = !origin;

    // Tag all incoming servers with their instance origin
    const taggedSpaces: TaggedSpace[] = spaces.map(s => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      banner: s.banner ?? null,
      avatarColor: s.avatarColor ?? null,
      ownerId: s.ownerId,
      ownerTitle: s.ownerTitle,
      inviteCode: s.inviteCode,
      visibility: s.visibility ?? 'private' as const,
      directoryListed: s.directoryListed ?? false,
      description: s.description ?? null,
      createdAt: s.createdAt,
      _instanceOrigin: origin,
    }));

    // Merge by origin: keep servers from other origins, replace all from this origin
    const existingFromOtherOrigins = get().spaces.filter(s => s._instanceOrigin !== origin);
    const mergedSpaces = [...existingFromOtherOrigins, ...taggedSpaces];

    // Build/merge maps for incoming channels
    const channelToSpaceMap = new Map(get().channelToSpaceMap);
    const channelLastMessageIds = new Map(get().channelLastMessageIds);
    const spacePermissions = new Map(get().spacePermissions);
    const channelPermissions = new Map(get().channelPermissions);
    const channelOriginMap = new Map(get().channelOriginMap);
    const voiceChannelIds = new Set(get().voiceChannelIds);
    const categoryOriginMap = new Map(get().categoryOriginMap);
    const dmAlternatives = new Map<string, Map<string, string>>();
    for (const [fid, byOrigin] of get().dmAlternatives) {
      dmAlternatives.set(fid, new Map(byOrigin));
    }

    // If home, clear home-origin entries first to avoid stale data
    if (isHome) {
      for (const [key, val] of get().channelOriginMap) {
        if (val === origin) {
          channelToSpaceMap.delete(key);
          channelLastMessageIds.delete(key);
          channelPermissions.delete(key);
          channelOriginMap.delete(key);
          voiceChannelIds.delete(key);
        }
      }
      // Also clear server permissions for this origin
      for (const s of get().spaces) {
        if (s._instanceOrigin === origin) {
          spacePermissions.delete(s.id);
        }
      }
    } else {
      // Remote: clear entries that belonged to this origin
      for (const [key, val] of get().channelOriginMap) {
        if (val === origin) {
          channelToSpaceMap.delete(key);
          channelLastMessageIds.delete(key);
          channelPermissions.delete(key);
          channelOriginMap.delete(key);
          voiceChannelIds.delete(key);
        }
      }
      for (const s of get().spaces) {
        if (s._instanceOrigin === origin) {
          spacePermissions.delete(s.id);
        }
      }
    }

    // Populate maps from incoming servers
    for (const srv of spaces) {
      if (srv.myPermissions) {
        spacePermissions.set(srv.id, srv.myPermissions);
      }
      for (const ch of srv.channels) {
        channelToSpaceMap.set(ch.id, srv.id);
        channelOriginMap.set(ch.id, origin);
        if (ch.type === 'voice') {
          voiceChannelIds.add(ch.id);
        } else if (ch.lastMessageId) {
          channelLastMessageIds.set(ch.id, ch.lastMessageId);
        }
        if (ch.myPermissions) {
          channelPermissions.set(ch.id, ch.myPermissions);
        }
      }
      if (srv.categories) {
        for (const cat of srv.categories) {
          categoryOriginMap.set(cat.id, origin);
        }
      }
      // Upsert every space member into the userViews cache. Assets for remote
      // origins were normalized by the ready handler in useWebSocket before
      // populateFromReady was called, so the user objects are already clean here.
      if (srv.members) {
        const { upsertUserView } = get();
        for (const member of srv.members) {
          upsertUserView(member.user, origin);
        }
      }
    }

    // Accept DMs from all origins. Each instance serves its own DM data.
    const incomingDms = dmChannels ?? [];

    // Normalize asset URLs for remote-origin DMs
    if (origin !== '') {
      for (const dm of incomingDms) {
        for (const member of dm.members) {
          normalizeUserAssets(member, origin);
        }
      }
    }

    // Upsert every DM member from every origin into the userViews cache.
    // This runs unconditionally (home + remote) and BEFORE the dedup pass so
    // members of DMs that are about to be discarded still land in the cache.
    // Assets are already normalized above for the remote case.
    {
      const { upsertUserView } = get();
      for (const dm of incomingDms) {
        for (const member of dm.members) {
          upsertUserView(member, origin);
        }
      }
    }

    // Build a set of existing federatedIds for dedup (only from OTHER origins —
    // DMs from the reconnecting origin will be replaced, not deduplicated)
    const existingFederatedIds = new Map<string, string>(); // federatedId → dmChannelId
    for (const dm of get().dmChannels) {
      if (dm.federatedId) {
        const dmOrigin = get().channelOriginMap.get(dm.id);
        if (dmOrigin !== origin) {
          existingFederatedIds.set(dm.federatedId, dm.id);
        }
      }
    }

    // Filter incoming DMs: skip duplicates (same federatedId already loaded from another origin)
    const filteredDms: typeof incomingDms = [];
    for (const dm of incomingDms) {
      if (dm.federatedId && existingFederatedIds.has(dm.federatedId)) {
        // Duplicate cross-instance DM — keep the existing copy
        continue;
      }
      filteredDms.push(dm);
      if (dm.federatedId) {
        existingFederatedIds.set(dm.federatedId, dm.id);
      }
    }

    for (const dm of filteredDms) {
      channelOriginMap.set(dm.id, origin);
      if (dm.lastMessage?.id) {
        channelLastMessageIds.set(dm.id, dm.lastMessage.id);
      }
    }

    // Record every DM's (origin → localChannelId) for failover lookup,
    // regardless of whether the dedup pass kept this copy in dmChannels.
    for (const dm of incomingDms) {
      if (!dm.federatedId) continue;
      let byOrigin = dmAlternatives.get(dm.federatedId);
      if (!byOrigin) {
        byOrigin = new Map();
        dmAlternatives.set(dm.federatedId, byOrigin);
      }
      byOrigin.set(origin, dm.id);
    }

    // Merge: remove DMs belonging to this origin from existing state, then append incoming
    const existingDmsFromOtherOrigins = get().dmChannels.filter(dm => {
      const dmOrigin = get().channelOriginMap.get(dm.id);
      return dmOrigin !== origin;
    });
    const mergedDms = [...existingDmsFromOtherOrigins, ...filteredDms];

    // Sort DMs using unread-first ordering. On initial load, unreadChannels may
    // still be empty (read states are processed after populateFromReady); the
    // safety-net re-sort in setReadStates handles that case.
    const { unreadChannels, currentChannelId } = useChatStore.getState();
    const sortedDms = sortDmChannels(mergedDms, unreadChannels, currentChannelId);

    const update: Partial<SpaceState> = {
      spaces: mergedSpaces,
      dmChannels: sortedDms,
      channelToSpaceMap,
      channelLastMessageIds,
      spacePermissions,
      channelPermissions,
      channelOriginMap,
      voiceChannelIds,
      categoryOriginMap,
      dmAlternatives,
    };

    // LWW layout merge: accept incoming layout only if its timestamp is >= ours
    const incomingTs = layoutUpdatedAt ?? 0;
    const currentTs = get()._layoutUpdatedAt;
    if (incomingTs >= currentTs) {
      // Incoming is same age or newer — accept
      update.folders = folders || [];
      if (spaceLayout !== undefined) {
        update.spaceLayout = spaceLayout ?? null;
      }
      (update as any)._layoutUpdatedAt = incomingTs;
    } else {
      // Our layout is newer — push back to this instance
      pushLayoutToOrigin(origin, get().spaceLayout, get().folders, currentTs);
    }

    set(update as any);
  },

});
