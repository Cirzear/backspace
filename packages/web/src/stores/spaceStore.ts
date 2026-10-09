import { getHomeOrigin } from '../platform/instanceRuntime';
import type {
  Channel,
  CreateSpaceRequest,
  DmChannel,
  MemberWithUser,
  Space,
  UpdateChannelRequest,
  UpdateSpaceRequest,
  User,
} from '@backspace/shared';
import { create } from 'zustand';
import { api, HttpError } from '../api/client';
import { JoinRequestRequiredError } from '../utils/joinErrors';
import { resolveAssetUrl, normalizeUserAssets } from '../utils/assetUrls';
import {
  getApiForOrigin,
  resolveOriginFromHostname,
} from '../utils/crossStoreResolvers';
import { userKey, isIssuedByHome, withUserUpdate, type IdentityFields, type PresenceSubject } from '../utils/identity';
import { locateDmChannel } from '../utils/dmChannelLookup';
import { deriveMissingOneOnOneKeys, type PeerDmChannel } from '../utils/dmConversationKey';
import { applyDmPinMoves } from '../utils/dmOriginFailover';
import { sortDmChannels } from '../utils/dmSorting';
import { useAuthStore, getMyUserIdForOrigin, isMe } from './authStore';
import { useChatStore } from './chatStore';
import {
  putChannels,
  dropChannels,
  replaceSpaceChannels,
  channelIdsWhere,
  deriveChannelOriginMap,
  channelTablesOf,
  channelTableFields,
  byPosition,
  isOpenSpace,
  withCategoryOrigins,
  type SpaceChannelIndex,
} from './spaceChannels';
import {
  conversationCopyIndex,
  copyIdOnOrigin,
  copyOnOrigin,
  EMPTY_DM_CONVERSATIONS,
  mergeOriginListing,
  patchCopy,
  patchEveryCopy,
  pinnedDmChannels,
  pinnedOriginByChannelId,
  removeCopy,
  setOriginAvailable,
  upsertCopy,
  upsertUnplacedCopy,
  type DmConversations,
  type DmOperation,
  type DmPinContext,
} from './dmConversations';
import { createAddSpaceFromReadySlice } from './spaceAddSpaceFromReadySlice';
import { createSpaceLayoutSlice, pushLayoutToOrigin } from './spaceLayoutSlice';
import { createPopulateFromReadySlice } from './spacePopulateFromReadySlice';
import { createRemoveInstanceSpacesSlice } from './spaceRemoveInstanceSpacesSlice';
import type { SpaceState, TaggedSpace, UserViewEntry } from './spaceStoreTypes';
export type { TaggedSpace, UserViewEntry } from './spaceStoreTypes';
import {
  nextDetailRequestSeq,
  newestDetailRequests,
  inFlightRosterLogs,
  recordRosterChange,
  replayRosterChange,
  applyRosterChange,
  type RosterChange,
} from './spaceDetailLoaders';

// ─── Error types ─────────────────────────────────────────────────────────────

/** Thrown when joinByCode targets a remote origin the user is not connected to. */
export class NotConnectedError extends Error {
  constructor(public origin: string) {
    super(`Not connected to ${origin}`);
    this.name = 'NotConnectedError';
  }
}

/**
 * The origin a join or a join request is sent to: `''` for the page's own
 * instance (an explicit `getHomeOrigin()` included, as inviteParser
 * normalizes at the URL boundary), else the remote origin, which must hold a
 * connected session. Throws `NotConnectedError` when it does not, so the
 * caller can run the connect step and try again.
 */
export async function connectedJoinOrigin(origin?: string): Promise<string> {
  if (!origin) return '';
  if (typeof window !== 'undefined' && origin === getHomeOrigin()) return '';
  // Dynamic import: instanceStore imports this module.
  const { useInstanceStore } = await import('./instanceStore');
  const connected = useInstanceStore.getState().instances.some(
    (i) => i.origin === origin && i.status === 'connected',
  );
  if (!connected) throw new NotConnectedError(origin);
  return origin;
}

/**
 * The `JoinRequestRequiredError` for a join that `origin` refused with
 * `join_request_required`, or null for any other failure. The space id comes
 * from the refusal's `details.spaceId`; an instance up to 1.9.0 does not send
 * it, so the invite preview is asked instead, and when that fails too the
 * original refusal stands.
 */
async function joinRequestRequired(err: unknown, inviteCode: string, origin: string): Promise<JoinRequestRequiredError | null> {
  if (!(err instanceof HttpError) || err.code !== 'join_request_required') return null;
  const fromDetails = err.details?.spaceId;
  if (typeof fromDetails === 'string' && fromDetails.length > 0) {
    return new JoinRequestRequiredError(err, fromDetails, origin);
  }
  try {
    const preview = await (origin ? getApiForOrigin(origin) : api).spaces.invitePreview(inviteCode);
    return new JoinRequestRequiredError(err, preview.spaceId, origin);
  } catch {
    return null;
  }
}

// ─── DM conversations: the derived view ──────────────────────────────────────

export type DmView = Pick<SpaceState, 'dmConversations' | 'dmChannels' | 'dmAlternatives' | 'channelOriginMap' | 'channelLastMessageIds'>;

/**
 * The store fields derived from `conversations`. `previousRows` are the DM
 * rows `channelLastMessageIds` held entries for until now; those entries are
 * replaced, the space-channel entries are kept. `channelOriginMap` is derived
 * whole from the space-channel index and the conversations.
 */
export function deriveDmView(
  conversations: DmConversations,
  previousRows: readonly DmChannel[],
  spaceChannelIndex: SpaceChannelIndex,
  channelLastMessageIds: ReadonlyMap<string, string>,
): DmView {
  const lastMessageIds = new Map(channelLastMessageIds);
  for (const dm of previousRows) lastMessageIds.delete(dm.id);
  const rows = pinnedDmChannels(conversations);
  for (const dm of rows) {
    if (dm.lastMessage?.id) lastMessageIds.set(dm.id, dm.lastMessage.id);
  }
  const { unreadChannels, currentChannelId } = useChatStore.getState();
  return {
    dmConversations: conversations,
    dmChannels: sortDmChannels(rows, unreadChannels, currentChannelId),
    dmAlternatives: conversationCopyIndex(conversations),
    channelOriginMap: deriveChannelOriginMap(spaceChannelIndex, pinnedOriginByChannelId(conversations)),
    channelLastMessageIds: lastMessageIds,
  };
}


/** The pin rule's view of the session: the user's home is `getLayoutHomeOrigin()`. */
export function dmPinContext(): DmPinContext {
  return { home: getLayoutHomeOrigin() };
}

/**
 * Store the result of a DM operation, derive the view from it, and apply its
 * pin moves: the chat state and URL of a row follow it to its new channel id
 * (`applyDmPinMoves`), after which the list is re-sorted, since the moves
 * carried unread state to the new ids.
 */
export function commitDmOperation(op: DmOperation): void {
  if (op.next !== useSpaceStore.getState().dmConversations) {
    useSpaceStore.setState((state) =>
      deriveDmView(op.next, state.dmChannels, state.spaceChannelIndex, state.channelLastMessageIds),
    );
  }
  if (op.pinMoves.length === 0) return;
  applyDmPinMoves(op.pinMoves);
  useSpaceStore.getState().resortDmChannels();
}

// ─── Store implementation ───────────────────────────────────────────────────

export const useSpaceStore = create<SpaceState>((set, get, apiStore) => ({
  spaces: [],
  currentSpaceId: null,
  lastSelectedSpaceId: null,
  channels: [],
  categories: [],
  members: [],
  roles: [],
  folders: [],
  spaceLayout: null,
  dmConversations: EMPTY_DM_CONVERSATIONS,
  dmChannels: [],
  spaceChannelIndex: new Map(),
  channelToSpaceMap: new Map(),
  channelLastMessageIds: new Map(),
  spacePermissions: new Map(),
  channelPermissions: new Map(),
  channelOriginMap: new Map(),
  voiceChannelIds: new Set(),
  categoryOriginMap: new Map(),
  dmAlternatives: new Map(),
  userViews: new Map(),
  loadingSpaceId: null,
  loadedSpaceIds: new Set(),
  _layoutUpdatedAt: 0,

  reset: () => {
    set({
      spaces: [],
      currentSpaceId: null,
      lastSelectedSpaceId: null,
      channels: [],
      categories: [],
      members: [],
      roles: [],
      folders: [],
      spaceLayout: null,
      dmConversations: EMPTY_DM_CONVERSATIONS,
      dmChannels: [],
      spaceChannelIndex: new Map(),
      channelToSpaceMap: new Map(),
      channelLastMessageIds: new Map(),
      spacePermissions: new Map(),
      channelPermissions: new Map(),
      channelOriginMap: new Map(),
      voiceChannelIds: new Set(),
      categoryOriginMap: new Map(),
      dmAlternatives: new Map(),
      userViews: new Map(),
      loadingSpaceId: null,
      loadedSpaceIds: new Set(),
      _layoutUpdatedAt: 0,
    });
  },

  setSpaces: (spaces) => set({ spaces }),
  setCurrentSpace: (spaceId) =>
    set((state) => ({
      currentSpaceId: spaceId,
      lastSelectedSpaceId: spaceId !== null ? spaceId : state.lastSelectedSpaceId,
    })),
  setChannels: (channels) => set({ channels }),
  setCategories: (categories) => set({ categories }),
  setMembers: (members) => set({ members }),
  setRoles: (roles) => set({ roles }),

  // DM Actions
  upsertDmCopy: (origin, channel, keySource) => {
    const op = upsertCopy(get().dmConversations, origin, channel, keySource, dmPinContext());
    commitDmOperation(op);
    return op.pinnedChannelId;
  },

  placeUnplacedDmMessage: (origin, message) => {
    commitDmOperation(upsertUnplacedCopy(get().dmConversations, origin, message, dmPinContext()));
  },

  patchDmCopy: (channelId, patch) => {
    commitDmOperation(patchCopy(get().dmConversations, channelId, patch));
  },

  resortDmChannels: (currentChannelId) => set((state) => {
    if (state.dmChannels.length === 0) return state;
    const chat = useChatStore.getState();
    const current = currentChannelId !== undefined ? currentChannelId : chat.currentChannelId;
    return { dmChannels: sortDmChannels(state.dmChannels, chat.unreadChannels, current) };
  }),

  setDmOriginAvailable: (origin, available) => {
    commitDmOperation(setOriginAvailable(get().dmConversations, origin, available, dmPinContext()));
  },

  reloadDmsForOrigin: async (origin: string) => {
    const client = getApiForOrigin(origin);
    const listed: PeerDmChannel[] = await client.dm.list();
    const derivedKeys = await deriveMissingOneOnOneKeys(listed);

    if (origin !== '') {
      for (const dm of listed) {
        for (const member of dm.members) {
          normalizeUserAssets(member, origin);
        }
      }
    }

    const { upsertUserView } = get();
    for (const dm of listed) {
      for (const member of dm.members) {
        upsertUserView(member, origin);
      }
    }

    commitDmOperation(mergeOriginListing(get().dmConversations, origin, listed, derivedKeys, dmPinContext()));
  },

  upsertUserView: (user, deliveringOrigin) => set((state) => {
    const key = userKey(user, deliveringOrigin);
    const incomingIsHome = isIssuedByHome(user, deliveringOrigin);
    const existing = state.userViews.get(key);

    if (existing && existing.isHome && !incomingIsHome) return state;

    const next = new Map(state.userViews);
    next.set(key, {
      user,
      deliveredBy: deliveringOrigin,
      isHome: incomingIsHome,
      updatedAt: Date.now(),
    });
    return { userViews: next };
  }),

  removeDmChannel: (id) => {
    commitDmOperation(removeCopy(get().dmConversations, id, dmPinContext()));
    useChatStore.getState().removeChannelStates(new Set([id]));
  },

  addDmMember: (dmChannelId, user) => {
    commitDmOperation(patchCopy(get().dmConversations, dmChannelId, (dm) =>
      dm.members.some(m => m.id === user.id) ? dm : { ...dm, members: [...dm.members, user] },
    ));
  },

  removeDmMember: (dmChannelId, userId) => {
    commitDmOperation(patchCopy(get().dmConversations, dmChannelId, (dm) =>
      ({ ...dm, members: dm.members.filter(m => m.id !== userId) }),
    ));
  },

  updateDmOwner: (dmChannelId, newOwnerId, newOwnerHomeUserId, newOwnerHomeInstance) => {
    commitDmOperation(patchCopy(get().dmConversations, dmChannelId, (dm) => {
      const next = { ...dm, ownerId: newOwnerId };
      if (newOwnerHomeUserId !== undefined) next.ownerHomeUserId = newOwnerHomeUserId;
      if (newOwnerHomeInstance !== undefined) next.ownerHomeInstance = newOwnerHomeInstance;
      return next;
    }));
  },

  updateDmMetadata: (dmChannelId, patch) => {
    commitDmOperation(patchCopy(get().dmConversations, dmChannelId, (dm) => {
      const next = { ...dm };
      if ('name' in patch) next.name = patch.name ?? null;
      if ('icon' in patch) next.icon = patch.icon ?? null;
      return next;
    }));
  },

  closeDm: async (id) => {
    const origin = get().channelOriginMap.get(id) || '';
    const targetApi = getApiForOrigin(origin);
    await targetApi.dm.close(id);
    commitDmOperation(removeCopy(get().dmConversations, id, dmPinContext()));
  },

  leaveDm: async (id) => {
    const origin = get().channelOriginMap.get(id) || '';
    const targetApi = getApiForOrigin(origin);
    await targetApi.dm.leave(id);
    commitDmOperation(removeCopy(get().dmConversations, id, dmPinContext()));
  },

  setDmChannels: (channels) => set({ dmChannels: channels }),
  addDmChannel: (channel, origin = '') => {
    get().upsertDmCopy(origin, channel, 'stated');
  },

  // Space Actions
  loadSpaces: async () => {
    try {
      const spaces = await api.spaces.list();
      set({
        spaces: spaces.map(s => ({ ...s, _instanceOrigin: '' })) as TaggedSpace[],
      });
    } catch {
      // Silently fail - will be populated from WS ready
    }
  },

  loadSpaceDetail: (spaceId: string, options?: { quiet?: boolean }) => {
    const quiet = options?.quiet === true;
    const seq = nextDetailRequestSeq();
    // Whether a load of this space started after this one.
    const overtaken = (): boolean => newestDetailRequests.get(spaceId)?.seq !== seq;
    const newestResult = (): Promise<Channel[] | null> =>
      newestDetailRequests.get(spaceId)?.result ?? Promise.resolve(null);
    // Ends the loading state of this space's open, whichever load started it.
    const endLoading = (state: SpaceState): string | null =>
      state.loadingSpaceId === spaceId ? null : state.loadingSpaceId;

    const result = (async (): Promise<Channel[] | null> => {
      // Joins and leaves that arrive during the fetch, replayed onto its roster.
      const rosterChanges: RosterChange[] = [];
      try {
        // Resolve the correct API client based on the server's instance origin
        const space = get().spaces.find(s => s.id === spaceId);
        if (!space) return null; // Not populated yet — remote WS ready will trigger reload
        if (!quiet) set({ loadingSpaceId: spaceId });
        const origin = space._instanceOrigin ?? '';
        const client = getApiForOrigin(origin);

        const logs = inFlightRosterLogs.get(spaceId) ?? new Set<RosterChange[]>();
        logs.add(rosterChanges);
        inFlightRosterLogs.set(spaceId, logs);

        const detail = await client.spaces.get(spaceId);
        if (overtaken()) return newestResult();
        // Normalize remote asset URLs (avatars, server icon)
        if (origin) {
          if (detail.icon) detail.icon = resolveAssetUrl(detail.icon, origin) ?? detail.icon;
          for (const member of detail.members) {
            normalizeUserAssets(member.user, origin);
          }
        }
        // Upsert every member into the userViews cache (home or remote).
        // Assets are already normalized above for the remote case.
        for (const member of detail.members) {
          get().upsertUserView(member.user, origin);
        }

        // The detail lists every channel of the space the user can see: the
        // space's index entries become exactly these, whether or not it is
        // open. `channels`, `categories`, `members` and `roles` belong to the
        // open space. Every caller opens the space before loading it, so a
        // space that is not open when its detail lands was left (or never
        // opened, for a refresh): it only gets its index and permission
        // entries.
        let dropped: string[] = [];
        set((state) => {
          const replaced = replaceSpaceChannels(channelTablesOf(state), spaceId, origin, detail.channels);
          dropped = replaced.dropped;
          const spacePermissions = new Map(state.spacePermissions);
          if (detail.myPermissions) spacePermissions.set(spaceId, detail.myPermissions);
          const categories = detail.categories ?? [];
          const fields = {
            ...channelTableFields(state, replaced.tables),
            categoryOriginMap: withCategoryOrigins(state.categoryOriginMap, categories, origin),
            spacePermissions,
            loadingSpaceId: endLoading(state),
          };
          if (state.currentSpaceId !== spaceId) return fields;
          const loadedSpaceIds = new Set(state.loadedSpaceIds);
          loadedSpaceIds.add(spaceId);
          return {
            ...fields,
            lastSelectedSpaceId: spaceId,
            channels: byPosition(detail.channels),
            categories: byPosition(categories),
            members: rosterChanges.reduce(replayRosterChange, detail.members),
            roles: detail.roles.sort((a, b) => b.position - a.position),
            loadedSpaceIds,
          };
        });
        if (dropped.length > 0) useChatStore.getState().removeChannelStates(new Set(dropped));
        return detail.channels;
      } catch {
        if (overtaken()) return newestResult();
        set((state) => ({ loadingSpaceId: endLoading(state) }));
        return null;
      } finally {
        const logs = inFlightRosterLogs.get(spaceId);
        logs?.delete(rosterChanges);
        if (logs?.size === 0) inFlightRosterLogs.delete(spaceId);
      }
    })();
    newestDetailRequests.set(spaceId, { seq, result });
    return result;
  },

  createSpace: async (data: CreateSpaceRequest) => {
    const space = await api.spaces.create(data);
    const tagged: TaggedSpace = { ...space, _instanceOrigin: '' };
    set((state) => ({ spaces: [...state.spaces, tagged] }));
    return space;
  },

  updateSpace: async (spaceId: string, data: UpdateSpaceRequest) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const updated = await client.spaces.update(spaceId, data);
    if (origin && updated.icon) {
      updated.icon = resolveAssetUrl(updated.icon, origin) ?? updated.icon;
    }
    if (origin && updated.banner) {
      updated.banner = resolveAssetUrl(updated.banner, origin) ?? updated.banner;
    }
    set((state) => ({
      spaces: state.spaces.map(s => s.id === spaceId ? { ...s, ...updated } : s),
    }));
  },

  deleteSpace: async (spaceId: string) => {
    await api.spaces.delete(spaceId);
    set((state) => {
      const loadedSpaceIds = new Set(state.loadedSpaceIds);
      loadedSpaceIds.delete(spaceId);
      return {
        spaces: state.spaces.filter(s => s.id !== spaceId),
        currentSpaceId: state.currentSpaceId === spaceId ? null : state.currentSpaceId,
        lastSelectedSpaceId:
          state.lastSelectedSpaceId === spaceId ? null : state.lastSelectedSpaceId,
        loadedSpaceIds,
      };
    });
  },

  leaveSpace: async (spaceId: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = (space as TaggedSpace)?._instanceOrigin ?? '';
    const targetApi = getApiForOrigin(origin);
    const userId = getMyUserIdForOrigin(origin);
    if (!userId) return;
    await targetApi.spaces.removeMember(spaceId, userId);
    set((state) => {
      const loadedSpaceIds = new Set(state.loadedSpaceIds);
      loadedSpaceIds.delete(spaceId);
      return {
        spaces: state.spaces.filter(s => s.id !== spaceId),
        currentSpaceId: state.currentSpaceId === spaceId ? null : state.currentSpaceId,
        lastSelectedSpaceId:
          state.lastSelectedSpaceId === spaceId ? null : state.lastSelectedSpaceId,
        loadedSpaceIds,
      };
    });
  },

  joinSpace: async (spaceId: string, inviteCode: string) => {
    const space = await api.spaces.join(spaceId, { inviteCode });
    set((state) => {
      if (state.spaces.find(s => s.id === space.id)) return state;
      return { spaces: [...state.spaces, { ...space, _instanceOrigin: '' } as TaggedSpace] };
    });
  },

  joinByCode: async (inviteCode: string, origin?: string) => {
    const target = await connectedJoinOrigin(origin);
    let space: Space;
    try {
      space = await (target ? getApiForOrigin(target) : api).spaces.joinByCode(inviteCode);
    } catch (err) {
      throw (await joinRequestRequired(err, inviteCode, target)) ?? err;
    }
    if (target) {
      if (space.icon) space.icon = resolveAssetUrl(space.icon, target) ?? space.icon;
      if (space.banner) space.banner = resolveAssetUrl(space.banner, target) ?? space.banner;
    }
    set((state) => {
      if (state.spaces.find(s => s.id === space.id && s._instanceOrigin === target)) return state;
      return { spaces: [...state.spaces, { ...space, _instanceOrigin: target } as TaggedSpace] };
    });
    return space;
  },

  generateInvite: async (spaceId: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const result = await client.spaces.invite(spaceId);
    return result.inviteCode;
  },

  // Channel & Category Actions
  createChannel: async (spaceId: string, name: string, type: 'text' | 'voice', topic?: string, categoryId?: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const channel = await client.channels.create(spaceId, { name, type, topic, categoryId });
    get().upsertChannel(channel, spaceId, origin);
    return channel;
  },

  upsertChannel: (channel: Channel, spaceId: string, origin: string) => {
    set((state) => {
      const fields = channelTableFields(state, putChannels(channelTablesOf(state), spaceId, origin, [channel]));
      // `channels` holds only the open space's list.
      if (!isOpenSpace(state, spaceId, origin)) return fields;
      const exists = state.channels.some(c => c.id === channel.id);
      const channels = byPosition(exists
        ? state.channels.map(c => (c.id === channel.id ? channel : c))
        : [...state.channels, channel]);
      return { ...fields, channels };
    });
  },

  removeChannel: (channelId: string) => {
    set((state) => {
      const channels = state.channels.some(c => c.id === channelId)
        ? state.channels.filter(c => c.id !== channelId)
        : state.channels;
      return { ...channelTableFields(state, dropChannels(channelTablesOf(state), [channelId])), channels };
    });
    useChatStore.getState().removeChannelStates(new Set([channelId]));
  },

  applyChannelLayout: (spaceId, origin, channels, categories) => {
    let dropped: string[] = [];
    set((state) => {
      const replaced = replaceSpaceChannels(channelTablesOf(state), spaceId, origin, channels);
      dropped = replaced.dropped;
      const fields = {
        ...channelTableFields(state, replaced.tables),
        categoryOriginMap: withCategoryOrigins(state.categoryOriginMap, categories, origin),
      };
      if (!isOpenSpace(state, spaceId, origin)) return fields;
      return { ...fields, channels: byPosition(channels), categories: byPosition(categories) };
    });
    if (dropped.length > 0) useChatStore.getState().removeChannelStates(new Set(dropped));
  },

  upsertCategory: (category, origin) => {
    set((state) => {
      const categoryOriginMap = withCategoryOrigins(state.categoryOriginMap, [category], origin);
      if (!isOpenSpace(state, category.spaceId, origin)) return { categoryOriginMap };
      const exists = state.categories.some(c => c.id === category.id);
      const categories = byPosition(exists
        ? state.categories.map(c => (c.id === category.id ? category : c))
        : [...state.categories, category]);
      return { categoryOriginMap, categories };
    });
  },

  removeCategory: (categoryId, spaceId, origin) => {
    set((state) => {
      const categoryOriginMap = new Map(state.categoryOriginMap);
      categoryOriginMap.delete(categoryId);
      if (!isOpenSpace(state, spaceId, origin)) return { categoryOriginMap };
      return {
        categoryOriginMap,
        categories: state.categories.filter(c => c.id !== categoryId),
        // The server uncategorized them too.
        channels: state.channels.map(ch => (ch.categoryId === categoryId ? { ...ch, categoryId: null } : ch)),
      };
    });
  },

  updateChannel: async (channelId: string, data: UpdateChannelRequest) => {
    const origin = get().channelOriginMap.get(channelId) ?? '';
    const channel = await getApiForOrigin(origin).channels.update(channelId, data);
    get().upsertChannel(channel, channel.spaceId, origin);
    return channel;
  },

  deleteChannel: async (channelId: string) => {
    const origin = get().channelOriginMap.get(channelId) ?? '';
    const channelApi = getApiForOrigin(origin);
    await channelApi.channels.delete(channelId);
    // The channel_deleted WS event does the same; removing is idempotent.
    get().removeChannel(channelId);
  },

  createCategory: async (spaceId: string, name: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const category = await client.categories.create(spaceId, name);
    // The category_created WS event carries the same row; applying the
    // response too means the caller sees it without waiting.
    get().upsertCategory(category, origin);
    return category;
  },

  updateCategory: async (categoryId: string, data: { name?: string; position?: number }) => {
    const known = get().categories.find(c => c.id === categoryId);
    const space = known ? get().spaces.find(s => s.id === known.spaceId) : undefined;
    const origin = space?._instanceOrigin ?? get().categoryOriginMap.get(categoryId) ?? '';
    const category = await getApiForOrigin(origin).categories.update(categoryId, data);
    // The category_updated WS event carries the same row; applying the
    // response too means the caller sees the stored value without waiting.
    get().upsertCategory(category, origin);
    return category;
  },

  deleteCategory: async (categoryId: string) => {
    const cat = get().categories.find(c => c.id === categoryId);
    if (!cat) return;
    const space = get().spaces.find(s => s.id === cat.spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    await client.categories.delete(categoryId);
  },

  updateChannelLayout: async (spaceId: string, data: { channels: Array<{ id: string; position: number; categoryId: string | null }>; categories: Array<{ id: string; position: number }> }) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = space?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    await client.channels.updateLayout(spaceId, data);
  },

  addSpace: (space: Space) => {
    set((state) => {
      if (state.spaces.find(s => s.id === space.id)) return state;
      return { spaces: [...state.spaces, { ...space, _instanceOrigin: '' } as TaggedSpace] };
    });
  },

  removeSpace: (spaceId: string) => {
    // Collect channel IDs before set() so we can clean up chatStore after
    const channelIdsToRemove = new Set(channelIdsWhere(get().spaceChannelIndex, (e) => e.spaceId === spaceId));

    set((state) => {
      const spacePermissions = new Map(state.spacePermissions);
      spacePermissions.delete(spaceId);

      const loadedSpaceIds = new Set(state.loadedSpaceIds);
      loadedSpaceIds.delete(spaceId);

      return {
        ...channelTableFields(state, dropChannels(channelTablesOf(state), channelIdsToRemove)),
        spaces: state.spaces.filter(s => s.id !== spaceId),
        currentSpaceId: state.currentSpaceId === spaceId ? null : state.currentSpaceId,
        lastSelectedSpaceId:
          state.lastSelectedSpaceId === spaceId ? null : state.lastSelectedSpaceId,
        spacePermissions,
        loadedSpaceIds,
      };
    });

    if (channelIdsToRemove.size > 0) {
      useChatStore.getState().removeChannelStates(channelIdsToRemove);
    }
  },

  updateMemberPresence: (subject: PresenceSubject, origin: string, status: string) => {
    const key = userKey(subject, origin);
    set((state) => {
      const typedStatus = status as 'online' | 'idle' | 'dnd' | 'offline';
      // Mirror the status into the userViews cache so any component reading via
      // useCanonicalUserView (e.g. the FriendItem avatar dot) re-renders with
      // fresh status, not just spaceStore.members which only feeds space UIs.
      // The cache is keyed by the same `userKey`.
      const entry = state.userViews.get(key);
      let changedViews: Map<string, UserViewEntry> | null = null;
      if (entry) {
        changedViews = new Map(state.userViews);
        changedViews.set(key, { ...entry, user: { ...entry.user, status: typedStatus } });
      }
      const nextUserViews = changedViews ?? state.userViews;

      const spaceOrigins = new Map<string, string>();
      const spaceOriginOf = (spaceId: string): string => {
        let spaceOrigin = spaceOrigins.get(spaceId);
        if (spaceOrigin === undefined) {
          spaceOrigin = state.spaces.find(s => s.id === spaceId)?._instanceOrigin ?? '';
          spaceOrigins.set(spaceId, spaceOrigin);
        }
        return spaceOrigin;
      };

      return {
        members: state.members.map(m =>
          userKey(m.user, spaceOriginOf(m.spaceId)) === key ? { ...m, user: { ...m.user, status: typedStatus } } : m
        ),
        userViews: nextUserViews,
      };
    });
  },

  updateUserEverywhere: (user: User, origin: string) => {
    set((state) => {
      // A roster row is issued by its space's origin.
      const spaceOrigins = new Map(state.spaces.map(s => [s.id, s._instanceOrigin ?? '']));
      let changed = false;
      const members = state.members.map(m => {
        const updated = withUserUpdate(m.user, spaceOrigins.get(m.spaceId) ?? '', user, origin);
        if (updated === m.user) return m;
        changed = true;
        return { ...m, user: updated };
      });
      return changed ? { members } : state;
    });
    commitDmOperation(patchEveryCopy(get().dmConversations, (dm, dmOrigin) => {
      let changed = false;
      const members = dm.members.map(m => {
        const updated = withUserUpdate(m, dmOrigin, user, origin);
        if (updated !== m) changed = true;
        return updated;
      });
      return changed ? { ...dm, members } : dm;
    }));
  },

  addMember: (spaceId: string, member: MemberWithUser) => {
    const change: RosterChange = { kind: 'join', member };
    recordRosterChange(spaceId, change);
    set((state) => ({ members: applyRosterChange(state.members, change) }));
  },

  removeMember: (spaceId: string, userId: string) => {
    const change: RosterChange = { kind: 'leave', userId };
    recordRosterChange(spaceId, change);
    set((state) => ({ members: applyRosterChange(state.members, change) }));
  },

  transferOwnership: async (spaceId: string, newOwnerId: string) => {
    const space = get().spaces.find(s => s.id === spaceId);
    const origin = (space as TaggedSpace)?._instanceOrigin ?? '';
    const client = getApiForOrigin(origin);
    const updated = await client.spaces.transferOwnership(spaceId, newOwnerId);
    if (origin && updated.icon) {
      updated.icon = resolveAssetUrl(updated.icon, origin) ?? updated.icon;
    }
    if (origin && updated.banner) {
      updated.banner = resolveAssetUrl(updated.banner, origin) ?? updated.banner;
    }
    set((state) => ({
      spaces: state.spaces.map(s =>
        s.id === spaceId ? { ...s, ...updated, _instanceOrigin: origin } as TaggedSpace : s
      ),
    }));
  },

  findExistingDmForUser: (target: IdentityFields, targetOrigin: string) => {
    const { dmChannels, channelOriginMap } = get();
    const targetKey = userKey(target, targetOrigin);

    for (const dm of dmChannels) {
      if (dm.members.length !== 2) continue;
      const origin = channelOriginMap.get(dm.id) || '';
      const other = dm.members.find(m => !isMe(m, origin));
      if (other && userKey(other, origin) === targetKey) return { dm, origin };
    }
    return null;
  },

  // Slices
  ...createPopulateFromReadySlice(set, get, apiStore),
  ...createAddSpaceFromReadySlice(set, get, apiStore),
  ...createRemoveInstanceSpacesSlice(set, get, apiStore),
  ...createSpaceLayoutSlice(set, get, apiStore),
}));

export { pushLayoutToOrigin };

/**
 * What the client knows a channel id to be. `unknown` until a listing or an
 * event names it: before the `ready` of the instance that holds it, or after
 * it was deleted or hidden. Space channel ids and DM channel ids never
 * overlap, so the answer comes from the data alone, never from the URL.
 */
export type ChannelKind = 'space' | 'dm' | 'unknown';

function channelKindIn(
  state: Pick<SpaceState, 'spaceChannelIndex' | 'dmChannels' | 'dmAlternatives'>,
  channelId: string,
): ChannelKind {
  if (state.spaceChannelIndex.has(channelId)) return 'space';
  // A DM is a listed row or another instance's copy of one (ADR 0002).
  if (locateDmChannel(state.dmChannels, state.dmAlternatives, channelId)) return 'dm';
  return 'unknown';
}

/** `ChannelKind` of `channelId` now. For event-time code; render reads `useIsDmChannel`. */
export function getChannelKind(channelId: string): ChannelKind {
  return channelKindIn(useSpaceStore.getState(), channelId);
}

/** Whether `channelId` is a known DM now. An unknown channel is not one. */
export function isDmChannel(channelId: string): boolean {
  return getChannelKind(channelId) === 'dm';
}

/**
 * Reactive `isDmChannel` for render: true for a DM, false for a space
 * channel, undefined while the channel is unknown (see `ChannelKind`). Each
 * caller decides what unknown means for it.
 */
export function useIsDmChannel(channelId: string): boolean | undefined {
  const kind = useSpaceStore((s) => channelKindIn(s, channelId));
  return kind === 'unknown' ? undefined : kind === 'dm';
}

/**
 * Returns the instance origin for a given channel ID.
 * '' = home instance, 'https://...' = remote instance.
 */
export function getChannelOrigin(channelId: string): string {
  return useSpaceStore.getState().channelOriginMap.get(channelId) ?? '';
}

/**
 * The owner's home instance of a group DM as the channel records it
 * (`ownerHomeInstance`, an origin or host), or '' when none is recorded.
 * `utils/groupDmOwnerActions.ts` sends owner-only requests there.
 *
 * Distinct from getChannelOrigin: that function returns the channel's
 * pinned serving origin (where the client's WS connection mirrors the
 * channel), which can differ from the owner's home instance after a
 * manual transfer.
 */
export function getOwnerInstanceForDm(channelId: string): string {
  const dm = useSpaceStore.getState().dmChannels.find(d => d.id === channelId);
  return dm?.ownerHomeInstance ?? '';
}

/**
 * Resolves a raw DM channel ID to its primary `dmChannels` entry ID.
 */
export function resolveDmChannelId(rawId: string): string | null {
  const { dmChannels, dmAlternatives } = useSpaceStore.getState();
  return locateDmChannel(dmChannels, dmAlternatives, rawId)?.dm.id ?? null;
}

/**
 * The channel id `origin` holds for the DM conversation of `channelId`, or
 * null when that instance holds no copy of it.
 */
export function dmCopyIdOnOrigin(channelId: string, origin: string): string | null {
  return copyIdOnOrigin(useSpaceStore.getState().dmConversations, channelId, origin);
}

/**
 * The copy `origin` holds of the DM conversation of `channelId` (its id and
 * its members as that instance knows them), or null when it holds none.
 */
export function dmCopyOnOrigin(channelId: string, origin: string): DmChannel | null {
  return copyOnOrigin(useSpaceStore.getState().dmConversations, channelId, origin);
}

// The resolver/setter pairs live in `utils/crossStoreResolvers.ts` — a
// neutral module with no store imports — to break a TDZ cycle: instanceStore registers these at top-level load, but
// a spaceStore-rooted import chain leaves spaceStore mid-load when that code
// runs. Re-exported here for backward compatibility with existing import
// sites. See the header comment in crossStoreResolvers.ts for details.
export {
  setApiForOriginResolver,
  getApiForOrigin,
  setOriginFromHostnameResolver,
  setTokenForOriginResolver,
  getTokenForOrigin,
} from '../utils/crossStoreResolvers';

/**
 * Returns the origin that is authoritative for this user's space layout.
 * '' = browsing instance (native users, or true home not yet connected).
 * 'https://...' = connected remote that is the user's true home.
 */
export function getLayoutHomeOrigin(): string {
  const user = useAuthStore.getState().user;
  if (!user?.homeInstance) return '';
  return resolveOriginFromHostname(user.homeInstance);
}

/** The signed-in user's row id on an instance; defined with the record it reads (`authStore.myRowIds`). */
export { getMyUserIdForOrigin };

export function setMyUserIdForOrigin(origin: string, userId: string): void {
  useAuthStore.getState().recordMyRow(origin, userId);
}
