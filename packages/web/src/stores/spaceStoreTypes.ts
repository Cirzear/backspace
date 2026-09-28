import type { Channel, ChannelCategory, CreateSpaceRequest, DmChannel, MemberWithUser, Role, Space, SpaceFolder, SpaceLayoutItem, SpaceWithChannelsAndMembers, UpdateChannelRequest, UpdateSpaceRequest, User } from '@backspace/shared';

import type { TaggedSpace, UserViewEntry } from './spaceStore';

export interface SpaceState {
  spaces: TaggedSpace[];
  currentSpaceId: string | null;
  /**
   * Sticky memory of the most-recently-selected space. Updated on every
   * `setCurrentSpace(non-null)` and when `loadSpaceDetail` lands. Crucially, it
   * is NOT cleared by `setCurrentSpace(null)` (the @me / DMs navigation case)
   * so mobile callers can answer "which space should the Spaces tab return to
   * after a side trip through DMs?" — `currentSpaceId` is wiped on @me by
   * AppLayout's URL effect, which would otherwise force a fallback to
   * `spaces[0]`. Cleared only when the remembered space is actually removed
   * (deleteSpace / leaveSpace / removeSpaceFromState / removeInstanceSpaces /
   * reset). Ephemeral — not persisted, since URL drives initial state on
   * reload.
   */
  lastSelectedSpaceId: string | null;
  channels: Channel[];
  categories: ChannelCategory[];
  members: MemberWithUser[];
  roles: Role[];
  folders: SpaceFolder[];
  spaceLayout: SpaceLayoutItem[] | null;
  dmChannels: DmChannel[];
  channelToSpaceMap: Map<string, string>;
  channelLastMessageIds: Map<string, string>;
  spacePermissions: Map<string, string>; // spaceId → myPermissions decimal string
  channelPermissions: Map<string, string>; // channelId → myPermissions decimal string
  channelOriginMap: Map<string, string>; // channelId → instance origin ('' = home)
  voiceChannelIds: Set<string>; // channelIds that are voice channels (excluded from unread)
  categoryOriginMap: Map<string, string>; // categoryId → instance origin ('' = home)
  /** federatedId → (origin → localChannelId). Every DM from every origin's ready payload is recorded here regardless of dedup outcome, so failover can re-point to an alternate origin's local channel ID. */
  dmAlternatives: Map<string, Map<string, string>>;
  /**
   * canonicalUserKey → best-known view of that user. Populated from every wire
   * surface that delivers a User object (DM members, message authors, friends,
   * space members, profile updates). Pruned only on full instance removal
   * (`removeInstanceSpaces`) and `reset`, never on transient WS disconnect —
   * mirrors `dmAlternatives`' no-flapping invariant. Render sites read through
   * `getCanonicalUserView` / `useCanonicalUserView` to surface the home view
   * even when the carrying channel was deduped away.
   */
  userViews: Map<string, UserViewEntry>;
  loadingSpaceId: string | null; // non-null while loadSpaceDetail is fetching
  /**
   * Set of spaceIds whose `loadSpaceDetail` has completed at least once this
   * session. Distinct from `currentSpaceId` (which moves with selection) and
   * from `loadingSpaceId` (which only marks in-flight). Render sites use this
   * to differentiate "load not yet attempted" from "loaded with empty result"
   * — see `MobileSpacesScreen`'s mascot empty state, which must not appear
   * during the pre-skeleton load window.
   *
   * Lifecycle:
   *  - Added on successful `loadSpaceDetail` completion.
   *  - Cleared per-space when the space is removed (`deleteSpace`,
   *    `leaveSpace`, `removeSpace`, `removeInstanceSpaces`).
   *  - Wiped entirely on `reset` (logout).
   *
   * Not persisted (ephemeral).
   */
  loadedSpaceIds: Set<string>;
  _layoutUpdatedAt: number;
  setSpaces: (spaces: TaggedSpace[]) => void;
  setCurrentSpace: (spaceId: string | null) => void;
  setChannels: (channels: Channel[]) => void;
  setCategories: (categories: ChannelCategory[]) => void;
  setMembers: (members: MemberWithUser[]) => void;
  setRoles: (roles: Role[]) => void;
  setDmChannels: (channels: DmChannel[]) => void;
  addDmChannel: (channel: DmChannel, origin?: string) => void;
  /** Record that `origin` holds its own copy of the DM `federatedId` under `channelId` (see `dmAlternatives`). */
  recordDmAlternative: (federatedId: string, origin: string, channelId: string) => void;
  reloadDmsForOrigin: (origin: string) => Promise<void>;
  removeDmChannel: (id: string) => void;
  addDmMember: (dmChannelId: string, user: User) => void;
  removeDmMember: (dmChannelId: string, userId: string) => void;
  updateDmOwner: (
    dmChannelId: string,
    newOwnerId: string,
    newOwnerHomeUserId?: string,
    newOwnerHomeInstance?: string,
  ) => void;
  updateDmMetadata: (dmChannelId: string, patch: { name?: string | null; icon?: string | null }) => void;
  closeDm: (id: string) => Promise<void>;
  leaveDm: (id: string) => Promise<void>;
  loadSpaces: () => Promise<void>;
  loadSpaceDetail: (spaceId: string) => Promise<void>;
  createSpace: (data: CreateSpaceRequest) => Promise<Space>;
  updateSpace: (spaceId: string, data: UpdateSpaceRequest) => Promise<void>;
  deleteSpace: (spaceId: string) => Promise<void>;
  joinSpace: (spaceId: string, inviteCode: string) => Promise<void>;
  leaveSpace: (spaceId: string) => Promise<void>;
  joinByCode: (inviteCode: string, origin?: string) => Promise<Space>;
  generateInvite: (spaceId: string) => Promise<string>;
  createChannel: (spaceId: string, name: string, type: 'text' | 'voice', topic?: string, categoryId?: string) => Promise<Channel>;
  upsertChannel: (channel: Channel, spaceId: string, origin: string) => void;
  /** Updates a space channel on its own instance and applies the stored row,
   *  which the server may have normalized (see `normalizeChannelName`). */
  updateChannel: (channelId: string, data: UpdateChannelRequest) => Promise<Channel>;
  deleteChannel: (channelId: string) => Promise<void>;
  createCategory: (spaceId: string, name: string) => Promise<ChannelCategory>;
  /** Updates a category on its space's instance and applies the stored row. */
  updateCategory: (categoryId: string, data: { name?: string; position?: number }) => Promise<ChannelCategory>;
  deleteCategory: (categoryId: string) => Promise<void>;
  updateChannelLayout: (spaceId: string, data: { channels: Array<{ id: string; position: number; categoryId: string | null }>; categories: Array<{ id: string; position: number }> }) => Promise<void>;
  addSpace: (space: Space) => void;
  removeSpace: (spaceId: string) => void;
  updateMemberPresence: (userId: string, status: string) => void;
  updateUserEverywhere: (user: User) => void;
  addMember: (member: MemberWithUser) => void;
  removeMember: (userId: string) => void;
  setSpaceLayout: (layout: SpaceLayoutItem[] | null) => void;
  updateSpaceLayout: (items: SpaceLayoutItem[], folders: Record<string, { name: string | null; color: string | null; spaceIds: string[] }>) => Promise<void>;
  populateFromReady: (origin: string, spaces: SpaceWithChannelsAndMembers[], folders?: SpaceFolder[], dmChannels?: DmChannel[], spaceLayout?: SpaceLayoutItem[] | null, layoutUpdatedAt?: number) => void;
  /**
   * Upsert a User into the userViews cache under the preference rule:
   *   - if no entry: insert
   *   - if existing is home view and incoming is stub: ignore
   *   - if existing is stub and incoming is home view: overwrite (upgrade)
   *   - same tier (both home or both stub): freshness wins (incoming overwrites)
   * Origin is REQUIRED to derive the home/stub tier and to enable pruning by
   * delivering origin on instance removal.
   */
  upsertUserView: (user: User, deliveringOrigin: string) => void;
  addSpaceFromReady: (origin: string, space: SpaceWithChannelsAndMembers) => void;
  removeInstanceSpaces: (origin: string) => void;
  transferOwnership: (spaceId: string, newOwnerId: string) => Promise<void>;
  findExistingDmForUser: (targetUser: { id: string; homeUserId?: string | null }) => { dm: DmChannel; origin: string } | null;
  reset: () => void;
}

/**
 * Push the current layout to a specific origin whose layout was older.
 * Used when populateFromReady receives a stale layout from an instance.
 */
