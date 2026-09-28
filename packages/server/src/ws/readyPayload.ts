import type { ActiveCallInfo, Activity, Channel, ChannelCategory, DmChannel, MemberWithUser, ReadState, Space, SpaceFolder, SpaceLayoutItem, SpaceWithChannelsAndMembers, User } from '@backspace/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { listNotificationSettings } from '../routes/notificationSettings.js';
import { computePermissions, PermissionBits, permissionsToString } from '../utils/permissions.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { channelUnreadCounts, dmUnreadCounts } from './channelUnreadCounts.js';

import { connectionManager } from './handler.js';
import { type DmRoomMeta } from './voiceRoomTypes.js';

// SQLite's SQLITE_MAX_VARIABLE_NUMBER default is 999.
// Chunk inArray() calls to stay safely under this limit.
const BATCH_CHUNK_SIZE = 500;

function batchInArray<TId, TResult>(ids: TId[], queryFn: (chunk: TId[]) => TResult[]): TResult[] {
  if (ids.length <= BATCH_CHUNK_SIZE) return queryFn(ids);
  const results: TResult[] = [];
  for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
    results.push(...queryFn(ids.slice(i, i + BATCH_CHUNK_SIZE)));
  }
  return results;
}


function buildReadySpaces(userId: string) {
  const db = getDb();
  // Get user's space memberships
  const memberships = db.select()
    .from(schema.spaceMembers)
    .where(eq(schema.spaceMembers.userId, userId))
    .all();

  const spaceIds = memberships.map(m => m.spaceId);

  const visibleChannelIdSet = new Set<string>();
  const spaces: SpaceWithChannelsAndMembers[] = [];

  if (spaceIds.length > 0) {
    const spaceRows = db.select()
      .from(schema.spaces)
      .where(inArray(schema.spaces.id, spaceIds))
      .all();

    // Batch: all channels for all spaces (1 query instead of N)
    const allChannels = batchInArray(
      spaceIds,
      ids => db.select().from(schema.channels).where(inArray(schema.channels.spaceId, ids)).all(),
    );
    const channelsBySpace = new Map<string, (typeof allChannels)>();
    for (const ch of allChannels) {
      let arr = channelsBySpace.get(ch.spaceId);
      if (!arr) { arr = []; channelsBySpace.set(ch.spaceId, arr); }
      arr.push(ch);
    }

    // Batch: determine which channels are private (VIEW_CHANNEL denied on @everyone)
    // @everyone role ID equals the space ID, so we query for overrides targeting role = spaceId
    const allEveroneOverrides = batchInArray(
      spaceIds,
      ids => db.select().from(schema.channelOverrides).where(
        and(
          eq(schema.channelOverrides.targetType, 'role'),
          inArray(schema.channelOverrides.targetId, ids),
        )
      ).all(),
    );
    const privateChannelIds = new Set<string>();
    for (const o of allEveroneOverrides) {
      const denyBits = BigInt(o.deny || '0');
      if ((denyBits & PermissionBits.VIEW_CHANNEL) !== 0n) {
        privateChannelIds.add(o.channelId);
      }
    }

    // Batch: all categories for all spaces (1 query instead of N)
    const allCategories = batchInArray(
      spaceIds,
      ids => db.select().from(schema.channelCategories).where(inArray(schema.channelCategories.spaceId, ids)).all(),
    );
    const categoriesBySpace = new Map<string, ChannelCategory[]>();
    for (const cat of allCategories) {
      let arr = categoriesBySpace.get(cat.spaceId);
      if (!arr) { arr = []; categoriesBySpace.set(cat.spaceId, arr); }
      arr.push({
        id: cat.id,
        spaceId: cat.spaceId,
        name: cat.name,
        position: cat.position ?? 0,
        createdAt: cat.createdAt,
      });
    }

    // Batch: last message ID per channel (1 query instead of N×C)
    const allChannelIds = allChannels.map(ch => ch.id);
    const lastMsgMap = new Map<string, string>();
    if (allChannelIds.length > 0) {
      const lastMsgRows = batchInArray(
        allChannelIds,
        ids => db.select({
          channelId: schema.messages.channelId,
          lastId: sql<string>`max(${schema.messages.id})`,
        }).from(schema.messages).where(and(inArray(schema.messages.channelId, ids), eq(schema.messages.type, 'user'))).groupBy(schema.messages.channelId).all(),
      );
      for (const row of lastMsgRows) {
        if (row.lastId) lastMsgMap.set(row.channelId, row.lastId);
      }
    }

    for (const spaceRow of spaceRows) {
      const channels = channelsBySpace.get(spaceRow.id) ?? [];

      const roles = db.select()
        .from(schema.roles)
        .where(eq(schema.roles.spaceId, spaceRow.id))
        .orderBy(schema.roles.position)
        .all();

      const memberRows = db.select()
        .from(schema.spaceMembers)
        .where(eq(schema.spaceMembers.spaceId, spaceRow.id))
        .all();

      const memberUserIds = memberRows.map(m => m.userId);
      const users = memberUserIds.length > 0
        ? batchInArray(memberUserIds, ids => db.select().from(schema.users).where(inArray(schema.users.id, ids)).all())
        : [];
      const userMap = new Map(users.map(u => [u.id, u]));

      const memberRoleRows = db.select()
        .from(schema.memberRoles)
        .where(eq(schema.memberRoles.spaceId, spaceRow.id))
        .all();

      const members: MemberWithUser[] = memberRows
        .map(m => {
          const u = userMap.get(m.userId);
          if (!u) return null;

          const assignedRoleIds = memberRoleRows
            .filter(mr => mr.userId === m.userId)
            .map(mr => mr.roleId);

          const memberRoles = roles
            .filter(r => assignedRoleIds.includes(r.id))
            .map(r => ({
              id: r.id,
              spaceId: r.spaceId,
              name: r.name,
              color: r.color ?? '#b9bbbe',
              position: r.position ?? 0,
              createdAt: r.createdAt,
            }));

          return {
            spaceId: m.spaceId,
            userId: m.userId,
            nickname: m.nickname,
            joinedAt: m.joinedAt,
            user: sanitizeUser(u),
            roles: memberRoles,
          };
        })
        .filter((m): m is MemberWithUser => m !== null);

      // Compute space-level permissions for this user
      const spacePerms = computePermissions(userId, spaceRow.id);

      // Filter channels by VIEW_CHANNEL and attach per-channel permissions
      const visibleChannels: Channel[] = [];
      for (const ch of channels) {
        const chPerms = computePermissions(userId, spaceRow.id, ch.id);
        const hasView = (chPerms & PermissionBits.VIEW_CHANNEL) !== 0n || (chPerms & PermissionBits.ADMINISTRATOR) !== 0n;
        if (hasView) {
          visibleChannelIdSet.add(ch.id);
          visibleChannels.push({
            id: ch.id,
            spaceId: ch.spaceId,
            name: ch.name,
            type: ch.type as Channel['type'],
            topic: ch.topic,
            position: ch.position ?? 0,
            categoryId: ch.categoryId ?? null,
            isPrivate: privateChannelIds.has(ch.id),
            createdAt: ch.createdAt,
            lastMessageId: lastMsgMap.get(ch.id) ?? null,
            myPermissions: permissionsToString(chPerms),
          });
        }
      }

      spaces.push({
        id: spaceRow.id,
        name: spaceRow.name,
        icon: spaceRow.icon,
        banner: spaceRow.banner ?? null,
        avatarColor: (spaceRow.avatarColor as Space['avatarColor']) ?? null,
        ownerId: spaceRow.ownerId,
        ownerTitle: spaceRow.ownerTitle,
        inviteCode: spaceRow.inviteCode,
        visibility: (spaceRow.visibility ?? 'private') as SpaceWithChannelsAndMembers['visibility'],
        directoryListed: spaceRow.directoryListed === 1,
        description: spaceRow.description ?? null,
        createdAt: spaceRow.createdAt,
        channels: visibleChannels,
        categories: categoriesBySpace.get(spaceRow.id) ?? [],
        members,
        roles: roles.map(r => ({
          id: r.id,
          spaceId: r.spaceId,
          name: r.name,
          color: r.color ?? '#b9bbbe',
          position: r.position ?? 0,
          permissions: r.permissions ?? undefined,
          isEveryone: r.id === spaceRow.id,
          createdAt: r.createdAt,
        })),
        myPermissions: permissionsToString(spacePerms),
      });
    }
  }

  // Store user's space IDs for broadcasting
  connectionManager.setUserSpaces(userId, spaceIds);

  return { spaces, visibleChannelIdSet };
}

function buildReadyDmChannels(userId: string, isFederated: boolean) {
  const db = getDb();
  // Get DM channels
  const dmMemberships = db.select()
    .from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.userId, userId),
      eq(schema.dmMembers.closed, 0),
    ))
    .all();

  const dmChannelIds = dmMemberships.map(dm => dm.dmChannelId);
  const dmChannels: DmChannel[] = [];

  if (dmChannelIds.length > 0) {
    // Batch: all DM channels (1 query, exclude soft-deleted)
    const allDmChannelRows = batchInArray(
      dmChannelIds,
      ids => db.select().from(schema.dmChannels).where(and(inArray(schema.dmChannels.id, ids), isNull(schema.dmChannels.deletedAt))).all(),
    );
    const dmChannelMap = new Map(allDmChannelRows.map(c => [c.id, c]));

    // Batch: all DM members across all channels (1 query)
    const allDmMemberRows = batchInArray(
      dmChannelIds,
      ids => db.select().from(schema.dmMembers).where(inArray(schema.dmMembers.dmChannelId, ids)).all(),
    );

    // Batch: all unique users from DM members (1 query)
    const allDmUserIds = [...new Set(allDmMemberRows.map(m => m.userId))];
    const allDmUsers = allDmUserIds.length > 0
      ? batchInArray(allDmUserIds, ids => db.select().from(schema.users).where(inArray(schema.users.id, ids)).all())
      : [];
    const dmUserMap = new Map(allDmUsers.map(u => [u.id, u]));

    // Batch: last message per DM channel.
    // Two-step approach (same as GET /api/dm): get MAX(created_at) per channel,
    // then fetch the actual message rows matching those timestamps.
    const dmMaxTimestamps = batchInArray(
      dmChannelIds,
      ids => db.select({
        dmChannelId: schema.dmMessages.dmChannelId,
        maxCreatedAt: sql<number>`MAX(${schema.dmMessages.createdAt})`.as('max_created_at'),
      }).from(schema.dmMessages).where(inArray(schema.dmMessages.dmChannelId, ids)).groupBy(schema.dmMessages.dmChannelId).all(),
    );
    const dmLastMsgMap = new Map<string, typeof schema.dmMessages.$inferSelect>();
    if (dmMaxTimestamps.length > 0) {
      const conditions = dmMaxTimestamps.map(t =>
        and(eq(schema.dmMessages.dmChannelId, t.dmChannelId), eq(schema.dmMessages.createdAt, t.maxCreatedAt!))
      );
      const dmLastMessages = db.select().from(schema.dmMessages).where(or(...conditions)).all();
      for (const m of dmLastMessages) {
        if (!dmLastMsgMap.has(m.dmChannelId)) {
          dmLastMsgMap.set(m.dmChannelId, m);
        }
      }
    }
    const dmLastMsgIds = [...dmLastMsgMap.values()].map(m => m.id);

    // Batch: attachments for last messages (1 query)
    const dmLastMsgAttachments = dmLastMsgIds.length > 0
      ? batchInArray(dmLastMsgIds, ids =>
          db.select({
            dmMessageId: schema.attachments.dmMessageId,
            type: schema.attachments.mimetype,
            filename: schema.attachments.originalName,
          }).from(schema.attachments).where(inArray(schema.attachments.dmMessageId, ids)).all()
        )
      : [];
    const dmLastMsgAttachmentMap = new Map<string, Array<{ type: string; filename: string }>>();
    for (const a of dmLastMsgAttachments) {
      if (!a.dmMessageId) continue;
      const arr = dmLastMsgAttachmentMap.get(a.dmMessageId) ?? [];
      arr.push({ type: a.type, filename: a.filename });
      dmLastMsgAttachmentMap.set(a.dmMessageId, arr);
    }

    // Assemble DM channels with zero additional queries
    for (const dm of dmMemberships) {
      const dmChannel = dmChannelMap.get(dm.dmChannelId);
      if (!dmChannel) continue;

      const memberRows = allDmMemberRows.filter(m => m.dmChannelId === dm.dmChannelId);
      const members = memberRows
        .map(m => dmUserMap.get(m.userId))
        .filter((u): u is NonNullable<typeof u> => u != null)
        .map(u => sanitizeUser(u));

      const last = dmLastMsgMap.get(dm.dmChannelId) ?? null;

      dmChannels.push({
        id: dmChannel.id,
        federatedId: dmChannel.federatedId ?? null,
        ownerId: dmChannel.ownerId ?? null,
        ownerHomeUserId: dmChannel.ownerHomeUserId ?? null,
        ownerHomeInstance: dmChannel.ownerHomeInstance ?? null,
        createdAt: dmChannel.createdAt,
        name: dmChannel.name ?? null,
        icon: dmChannel.icon ?? null,
        metadataUpdatedAt: dmChannel.metadataUpdatedAt ?? 0,
        members,
        lastMessage: last ? {
          id: last.id,
          dmChannelId: last.dmChannelId,
          userId: last.userId,
          content: last.content,
          createdAt: last.createdAt,
          type: last.type === 'system' ? 'system' : 'user',
          attachments: dmLastMsgAttachmentMap.get(last.id) ?? [],
        } : null,
      });
    }

  }

  // Seed read states for federated users' DM channels that have no existing read state.
  // This handles the bootstrap: DMs existed before cross-instance access was enabled,
  // so the remote instance has no read state history. Mark as read (latest message).
  // Going forward, the S2S read_state_update relay keeps things in sync.
  if (isFederated && dmChannels.length > 0) {
    const dmIds = dmChannels.map(dm => dm.id);
    const existingDmReadStates = batchInArray(
      dmIds,
      ids => db.select({ channelId: schema.readStates.channelId })
        .from(schema.readStates)
        .where(and(eq(schema.readStates.userId, userId), inArray(schema.readStates.channelId, ids)))
        .all(),
    );
    const hasReadState = new Set(existingDmReadStates.map(rs => rs.channelId));
    const now = Date.now();
    for (const dm of dmChannels) {
      if (!hasReadState.has(dm.id) && dm.lastMessage) {
        db.insert(schema.readStates).values({
          userId,
          channelId: dm.id,
          lastReadMessageId: dm.lastMessage.id,
          updatedAt: now,
        }).run();
      }
    }
  }

  return { dmChannels, dmMemberships };
}

export function buildReadyPayload(userId: string): {
  user: User;
  spaces: SpaceWithChannelsAndMembers[];
  dmChannels: DmChannel[];
  folders: SpaceFolder[];
  spaceLayout: SpaceLayoutItem[] | null;
  layoutUpdatedAt: number | null;
  voiceStates: Record<string, string[]>;
  voiceChannelElapsedSeconds: Record<string, number>;
  voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>;
  spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }>;
  notificationSettings: import("@backspace/shared").NotificationSetting[];
  unreadCounts: Record<string, number>;
  supportsPoke: boolean;
  readStates: ReadState[];
  activeCalls: ActiveCallInfo[];
  userActivities: Record<string, Activity[]>;
  rejectedPeerOrigins: string[];
  awaitingApprovalPeerOrigins: string[];
  activePeerOrigins: string[];
  pendingApprovalCount: number;
} {
  const db = getDb();

  // Get user
  const userRow = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!userRow) {
    throw new Error('User not found');
  }
  const user = sanitizeUser(userRow, true);
  const isFederated = !!userRow.homeInstance;

  // Cache showActivity and status for Rich Presence
  connectionManager.setUserShowActivity(userId, userRow.showActivity !== 0);
  connectionManager.setUserStatus(userId, (userRow.status ?? 'offline') as string);

  const { spaces, visibleChannelIdSet } = buildReadySpaces(userId);

  const { dmChannels, dmMemberships } = buildReadyDmChannels(userId, isFederated);
  // Include DM channel IDs in the visible set for read state filtering
  for (const dm of dmChannels) {
    visibleChannelIdSet.add(dm.id);
  }

  // Get Space Folders
  const folderRows = db.select()
    .from(schema.spaceFolders)
    .where(eq(schema.spaceFolders.userId, userId))
    .orderBy(schema.spaceFolders.position)
    .all();

  const folders: SpaceFolder[] = [];
  for (const folder of folderRows) {
    const folderSpaceIds = db.select()
      .from(schema.spaceFolderMembers)
      .where(eq(schema.spaceFolderMembers.folderId, folder.id))
      .orderBy(schema.spaceFolderMembers.position)
      .all()
      .map(m => m.spaceId);

    folders.push({
      id: folder.id,
      userId: folder.userId,
      name: folder.name,
      color: folder.color,
      position: folder.position ?? 0,
      spaceIds: folderSpaceIds,
    });
  }

  // Get user space layout
  const layoutRow = db.select().from(schema.userSpaceLayout)
    .where(eq(schema.userSpaceLayout.userId, userId)).get();
  const spaceLayout: SpaceLayoutItem[] | null = layoutRow ? JSON.parse(layoutRow.layout) : null;
  const layoutUpdatedAt: number | null = layoutRow?.updatedAt ?? null;

  // Build voice states — who is currently in voice channels, plus space mute/
  // deafen and permission-mute, across all the user's spaces. Delegates to the
  // shared per-space helper (also used for the mid-session join push in
  // ConnectionManager.addUserSpace) so the two code paths can never diverge.
  // The helper applies the same VIEW_CHANNEL filtering used when building the
  // `spaces` array above.
  const voiceStates: Record<string, string[]> = {};
  const voiceChannelElapsedSeconds: Record<string, number> = {};
  const spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }> = {};
  for (const space of spaces) {
    const snap = connectionManager.buildSpaceVoiceState(space.id, userId);
    Object.assign(voiceStates, snap.voiceStates);
    Object.assign(voiceChannelElapsedSeconds, snap.voiceChannelElapsedSeconds);
    Object.assign(spaceVoiceStates, snap.spaceVoiceStates);
  }

  // Build active calls from user's DM memberships
  const activeCalls: ActiveCallInfo[] = [];
  for (const dm of dmMemberships) {
    const room = connectionManager.getRoom(dm.dmChannelId);
    if (room && room.roomType === 'dm') {
      const dmMeta = room.metadata as DmRoomMeta;
      activeCalls.push({
        dmChannelId: dm.dmChannelId,
        callerId: dmMeta.callerId,
        participants: Array.from(room.participants),
        startedAt: room.startedAt,
        state: dmMeta.state,
      });
      // Inject DM call participants into voiceStates so frontend's generic handler works
      if (room.participants.size > 0) {
        voiceStates[dm.dmChannelId] = Array.from(room.participants);
      }
    }
  }

  // Resolve this user's homeUserId for token lookup
  const readyUser = db.select({ homeUserId: schema.users.homeUserId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  const myHomeUserId = readyUser?.homeUserId || userId;

  // Also include federated calls (this instance is NOT the host)
  for (const [_fedId, fedCall] of connectionManager.getAllFederatedCalls()) {
    const isParticipant = fedCall.ringedUserIds.includes(userId);
    const isDmMember = fedCall.dmChannelId && dmMemberships.some(dm => dm.dmChannelId === fedCall.dmChannelId);
    if (isParticipant || isDmMember) {
      activeCalls.push({
        dmChannelId: fedCall.dmChannelId,
        federatedCallId: fedCall.federatedId,
        callerId: fedCall.callerId,
        participants: [],
        startedAt: fedCall.startedAt,
        state: fedCall.state,
        federatedCallHost: fedCall.federatedCallHost,
        livekitUrl: fedCall.livekitUrl,
        livekitToken: fedCall.tokens.get(myHomeUserId),
      });
    }
  }

  // Build voice user states — includes both space and DM participants now
  const voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }> = {};
  for (const chId of Object.keys(voiceStates)) {
    const usersInChannel = voiceStates[chId];
    if (usersInChannel) {
      for (const uid of usersInChannel) {
        const status = connectionManager.getVoiceUserStatus(uid);
        if (status) {
          voiceUserStates[uid] = status;
        }
      }
    }
  }

  // Fetch read states for unread tracking
  const readStateRows = db.select()
    .from(schema.readStates)
    .where(eq(schema.readStates.userId, userId))
    .all();

  const readStates: ReadState[] = readStateRows
    .filter(rs => !isFederated || visibleChannelIdSet.has(rs.channelId))
    .map(rs => ({
      channelId: rs.channelId,
      lastReadMessageId: rs.lastReadMessageId,
    }));

  // Build user activities snapshot for all visible users
  // Auto-inject customStatus as a 'custom' activity for users with no ephemeral activities
  const userActivities: Record<string, Activity[]> = {};
  const seenUserIds = new Set<string>();

  function collectUserActivities(uid: string, customStatus: string | null) {
    if (seenUserIds.has(uid)) return;
    seenUserIds.add(uid);
    let acts = connectionManager.getUserActivities(uid);
    if (acts.length === 0 && customStatus) {
      acts = [{ type: 'custom', name: customStatus }];
    }
    if (acts.length > 0) {
      userActivities[uid] = acts;
    }
  }

  for (const space of spaces) {
    for (const member of space.members) {
      collectUserActivities(member.userId, member.user?.customStatus ?? null);
    }
  }
  for (const dm of dmChannels) {
    for (const member of dm.members) {
      collectUserActivities(member.id, member.customStatus ?? null);
    }
  }

  // Rejected peer origins for unreachable member indicators
  const rejectedPeers = db
    .select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'rejected'))
    .all();
  const rejectedPeerOrigins = rejectedPeers.map(p => p.origin);

  // Awaiting-approval peer origins for softer unreachable indicators
  const awaitingApprovalPeers = db
    .select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'awaiting_approval'))
    .all();
  const awaitingApprovalPeerOrigins = awaitingApprovalPeers.map(p => p.origin);

  // Active peer origins — client uses this allowlist to gate DM events from remote instances
  const activePeers = db
    .select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'active'))
    .all();
  const activePeerOrigins = activePeers.map(p => p.origin);

  // Pending approval count for admin notification
  let pendingApprovalCount = 0;
  if (userRow?.isAdmin === 1) {
    const countResult = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.peerApprovalRequests)
      .get();
    pendingApprovalCount = countResult?.count ?? 0;
  }

  return { user, spaces, dmChannels, folders, spaceLayout, layoutUpdatedAt, voiceStates, voiceChannelElapsedSeconds, voiceUserStates, spaceVoiceStates, supportsPoke: true, unreadCounts: { ...channelUnreadCounts(userId, spaces.flatMap(space => space.channels.map(channel => channel.id))), ...dmUnreadCounts(userId, dmChannels.map(dm => dm.id)) }, readStates, notificationSettings: listNotificationSettings(userId), activeCalls, userActivities, rejectedPeerOrigins, awaitingApprovalPeerOrigins, activePeerOrigins, pendingApprovalCount };
}
