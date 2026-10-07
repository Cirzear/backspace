import type { Channel, ChannelCategory } from '@backspace/shared';
import { pinnedOriginByChannelId, type DmConversations } from './dmConversations';

/**
 * The client's space-channel index: one entry per space channel the user can
 * see, on every connected instance, whether or not its space is open.
 *
 * Pure functions, no store imports. `spaceStore` holds the tables and derives
 * the lookup maps (`channelToSpaceMap`, `channelOriginMap`, `voiceChannelIds`)
 * from the index after every change, merged with the DM view
 * (`deriveChannelLookups`). Every operation returns new tables; nothing here
 * changes a map it was given, so a reader that selects a map sees every change.
 *
 * Space channel ids and DM channel ids never overlap (different tables on
 * every server), so the operations can share `lastMessageIds` with the DM
 * view: they only ever touch the ids of space channels.
 */

/** What the client knows about one space channel. */
export interface SpaceChannelEntry {
  /** The space that holds it. */
  readonly spaceId: string;
  /** The instance that issued its id ('' is home). */
  readonly origin: string;
  readonly type: Channel['type'];
}

export type SpaceChannelIndex = ReadonlyMap<string, SpaceChannelEntry>;

/** The per-channel facts the space-channel writers keep. Replaced together. */
export interface SpaceChannelTables {
  readonly index: SpaceChannelIndex;
  /** channelId → the user's permissions in it (decimal string). Space channels only. */
  readonly permissions: ReadonlyMap<string, string>;
  /** channelId → last message id as a listing reported it. DM entries belong to the DM view. */
  readonly lastMessageIds: ReadonlyMap<string, string>;
}

/**
 * Add or replace `channels` of `spaceId` on `origin`. A channel without
 * `myPermissions` or `lastMessageId` keeps the value the tables already hold:
 * events that omit a field do not know it, they do not clear it.
 */
export function putChannels(
  tables: SpaceChannelTables,
  spaceId: string,
  origin: string,
  channels: readonly Channel[],
): SpaceChannelTables {
  return putSpaceListings(tables, origin, [{ id: spaceId, channels }]);
}

/** `putChannels` for the channels of several spaces of one origin, in one copy of the tables. */
export function putSpaceListings(
  tables: SpaceChannelTables,
  origin: string,
  spaces: ReadonlyArray<{ readonly id: string; readonly channels: readonly Channel[] }>,
): SpaceChannelTables {
  if (spaces.every((space) => space.channels.length === 0)) return tables;
  const index = new Map(tables.index);
  const permissions = new Map(tables.permissions);
  const lastMessageIds = new Map(tables.lastMessageIds);
  for (const space of spaces) {
    for (const channel of space.channels) {
      index.set(channel.id, { spaceId: space.id, origin, type: channel.type });
      if (channel.myPermissions) permissions.set(channel.id, channel.myPermissions);
      // Voice channels have no text to read; unread tracking skips them.
      if (channel.type !== 'voice' && channel.lastMessageId) lastMessageIds.set(channel.id, channel.lastMessageId);
    }
  }
  return { index, permissions, lastMessageIds };
}

/** Forget `channelIds` in every table. Ids the index does not hold are ignored. */
export function dropChannels(tables: SpaceChannelTables, channelIds: Iterable<string>): SpaceChannelTables {
  const ids = [...channelIds].filter((id) => tables.index.has(id));
  if (ids.length === 0) return tables;
  const index = new Map(tables.index);
  const permissions = new Map(tables.permissions);
  const lastMessageIds = new Map(tables.lastMessageIds);
  for (const id of ids) {
    index.delete(id);
    permissions.delete(id);
    lastMessageIds.delete(id);
  }
  return { index, permissions, lastMessageIds };
}

/** The ids of the indexed channels `match` accepts. */
export function channelIdsWhere(
  index: SpaceChannelIndex,
  match: (entry: SpaceChannelEntry) => boolean,
): string[] {
  const ids: string[] = [];
  for (const [id, entry] of index) {
    if (match(entry)) ids.push(id);
  }
  return ids;
}

/** Whether `entry` belongs to the space `spaceId` as `origin` issued it. */
export function inSpace(entry: SpaceChannelEntry, spaceId: string, origin: string): boolean {
  return entry.spaceId === spaceId && entry.origin === origin;
}

/**
 * `channels` is the complete set of channels of `spaceId` on `origin` the user
 * can see (a listing, a space detail, a layout event): the space's entries
 * become exactly these. Returns the ids that left the set.
 */
export function replaceSpaceChannels(
  tables: SpaceChannelTables,
  spaceId: string,
  origin: string,
  channels: readonly Channel[],
): { tables: SpaceChannelTables; dropped: string[] } {
  const listed = new Set(channels.map((c) => c.id));
  const dropped = channelIdsWhere(tables.index, (e) => inSpace(e, spaceId, origin)).filter((id) => !listed.has(id));
  return { tables: putChannels(dropChannels(tables, dropped), spaceId, origin, channels), dropped };
}

/** The lookup maps readers use, derived from the index and the DM view's pinned origins. */
export interface ChannelLookups {
  readonly channelToSpaceMap: ReadonlyMap<string, string>;
  readonly channelOriginMap: ReadonlyMap<string, string>;
  readonly voiceChannelIds: ReadonlySet<string>;
}

/**
 * Derive the lookup maps. `dmOrigins` is the DM view's channel id → pinned
 * origin (`pinnedOriginByChannelId`), the only source of DM entries.
 */
export function deriveChannelLookups(
  index: SpaceChannelIndex,
  dmOrigins: ReadonlyMap<string, string>,
): ChannelLookups {
  const channelToSpaceMap = new Map<string, string>();
  const voiceChannelIds = new Set<string>();
  for (const [id, entry] of index) {
    channelToSpaceMap.set(id, entry.spaceId);
    if (entry.type === 'voice') voiceChannelIds.add(id);
  }
  return { channelToSpaceMap, channelOriginMap: deriveChannelOriginMap(index, dmOrigins), voiceChannelIds };
}

/** `channelOriginMap` alone: what a DM operation changes. */
export function deriveChannelOriginMap(
  index: SpaceChannelIndex,
  dmOrigins: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const origins = new Map<string, string>();
  for (const [id, entry] of index) origins.set(id, entry.origin);
  for (const [id, origin] of dmOrigins) origins.set(id, origin);
  return origins;
}

/** `categoryOriginMap` with `categories` recorded under `origin`. */
export function withCategoryOrigins(
  categoryOriginMap: ReadonlyMap<string, string>,
  categories: readonly ChannelCategory[],
  origin: string,
): ReadonlyMap<string, string> {
  if (categories.length === 0) return categoryOriginMap;
  const next = new Map(categoryOriginMap);
  for (const category of categories) next.set(category.id, origin);
  return next;
}

export function channelTablesOf(state: {
  readonly spaceChannelIndex: SpaceChannelIndex;
  readonly channelPermissions: ReadonlyMap<string, string>;
  readonly channelLastMessageIds: ReadonlyMap<string, string>;
}): SpaceChannelTables {
  return { index: state.spaceChannelIndex, permissions: state.channelPermissions, lastMessageIds: state.channelLastMessageIds };
}

export function channelTableFields(
  state: {
    readonly spaceChannelIndex: SpaceChannelIndex;
    readonly channelPermissions: ReadonlyMap<string, string>;
    readonly channelLastMessageIds: ReadonlyMap<string, string>;
    readonly dmConversations: DmConversations;
  },
  tables: SpaceChannelTables,
  dmConversations: DmConversations = state.dmConversations,
): {
  spaceChannelIndex?: SpaceChannelIndex;
  channelPermissions?: ReadonlyMap<string, string>;
  channelLastMessageIds?: ReadonlyMap<string, string>;
  channelToSpaceMap?: ReadonlyMap<string, string>;
  channelOriginMap?: ReadonlyMap<string, string>;
  voiceChannelIds?: ReadonlySet<string>;
} {
  if (
    tables.index === state.spaceChannelIndex
    && tables.permissions === state.channelPermissions
    && tables.lastMessageIds === state.channelLastMessageIds
  ) {
    return {};
  }
  return {
    spaceChannelIndex: tables.index,
    channelPermissions: tables.permissions,
    channelLastMessageIds: tables.lastMessageIds,
    ...deriveChannelLookups(tables.index, pinnedOriginByChannelId(dmConversations)),
  };
}

export function byPosition<T extends { position: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position);
}

export function isOpenSpace(
  state: { readonly currentSpaceId: string | null; readonly spaces: ReadonlyArray<{ readonly id: string; readonly _instanceOrigin: string }> },
  spaceId: string,
  origin: string,
): boolean {
  if (state.currentSpaceId !== spaceId) return false;
  return (state.spaces.find((s) => s.id === spaceId)?._instanceOrigin ?? '') === origin;
}



