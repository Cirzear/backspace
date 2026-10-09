import type { WebSocket } from 'ws';
import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { connectionManager } from './handler.js';
import { getVoiceRoomElapsedSeconds, type SpaceRoomMeta } from './voiceRoomTypes.js';
import { getChannelSpaceId, hasPermission, computePermissions, PermissionBits } from '../utils/permissions.js';
import { canActOnMemberInSpace } from '../utils/roleHierarchy.js';
import { ERROR_MESSAGES } from '../utils/httpErrors.js';
import { syncNativeVoicePermissions } from './nativeVoiceSessions.js';
import { broadcastRoomLeave, leaveJoinedFederatedCall } from './dmCallEvents.js';

/**
 * Re-evaluate SPEAK permission for all participants in voice channels
 * belonging to the given space. On transition, updates the in-memory
 * permissionMutedUsers Set and broadcasts voice_permission_muted events.
 */
export function checkVoicePermissions(spaceId: string): void {
  for (const [roomId, room] of connectionManager.getAllRooms()) {
    if (room.roomType !== 'space') continue;
    const meta = room.metadata as SpaceRoomMeta;
    if (meta.spaceId !== spaceId) continue;

    for (const userId of room.participants) {
      const perms = computePermissions(userId, spaceId, roomId);
      // STREAM/CONNECT revocation must end native publishers even when SPEAK is unchanged.
      syncNativeVoicePermissions(userId);
      const canSpeak = (perms & PermissionBits.SPEAK) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
      const wasMuted = connectionManager.isPermissionMuted(spaceId, userId);
      const shouldMute = !canSpeak;

      if (shouldMute !== wasMuted) {
        connectionManager.setPermissionMuted(spaceId, userId, shouldMute);
        connectionManager.sendToSpace(spaceId, {
          type: 'voice_permission_muted',
          userId,
          spaceId,
          muted: shouldMute,
        });
      }
    }
  }
}

// ─── Voice Handlers (Unified Room API) ─────────────────────────────────────

/**
 * A refused join is terminal for the client, so it must be terminal on the
 * server too. When the refusal concerns the room the user is still holding —
 * the resume-after-reconnect case, where CONNECT was revoked or the channel
 * deleted mid-grace — leaving them parked there until the grace period expires
 * would keep them listed in a voice channel they have already been told they
 * are out of. A refusal aimed at any *other* channel leaves the live session
 * alone, which is what it has always done.
 */
function rejectVoiceJoin(userId: string, channelId: string): void {
  if (connectionManager.getUserRoom(userId)?.roomId === channelId) {
    handleVoiceLeave(userId);
  }
  connectionManager.sendToUser(userId, {
    type: 'voice_disconnected', userId, channelId, reason: 'rejected',
  });
}

export function handleVoiceJoin(event: Record<string, unknown>, userId: string, ws: WebSocket): void {
  const channelId = event.channelId as string;

  if (!channelId || typeof channelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'channelId is required' });
    return;
  }

  const spaceId = getChannelSpaceId(channelId);
  if (!spaceId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Channel not found' });
    rejectVoiceJoin(userId, channelId);
    return;
  }

  if (!hasPermission(userId, spaceId, PermissionBits.CONNECT, channelId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing CONNECT permission' });
    rejectVoiceJoin(userId, channelId);
    return;
  }

  // ── Device switch guardrail ──
  // If this user already has a voice session on a different socket,
  // notify that socket to tear down its LiveKit connection.
  {
    const oldVoiceWs = connectionManager.getVoiceWs(userId);
    if (oldVoiceWs && oldVoiceWs !== ws) {
      const oldRoom = connectionManager.getUserRoom(userId);
      connectionManager.sendToWs(oldVoiceWs, {
        type: 'voice_disconnected',
        userId,
        channelId: oldRoom?.roomId ?? channelId,
        reason: 'displaced',
      });
    }
    connectionManager.setVoiceWs(userId, ws);
  }

  // If the user is already in this exact room (e.g. WS reconnect re-registration),
  // skip the leave+join broadcast to avoid visual flicker for other users.
  const currentRoom = connectionManager.getUserRoom(userId);
  if (currentRoom && currentRoom.roomId === channelId) {
    const status = connectionManager.getVoiceUserStatus(userId);
    if (status) {
      connectionManager.sendToRoom(channelId, {
        type: 'voice_status_update',
        userId,
        channelId,
        isMuted: status.isMuted,
        isDeafened: status.isDeafened,
        isCameraOn: status.isCameraOn,
        isScreenSharing: status.isScreenSharing,
      });
    }

    // Re-broadcast persistent restrictions (covers page reload while in voice)
    const db = getDb();
    const restrictions = db.select()
      .from(schema.voiceRestrictions)
      .where(and(
        eq(schema.voiceRestrictions.spaceId, spaceId),
        eq(schema.voiceRestrictions.userId, userId),
      ))
      .all();
    for (const r of restrictions) {
      if (r.restrictionType === 'mute') {
        connectionManager.setSpaceMuted(spaceId, userId, true);
        connectionManager.sendToUser(userId, {
          type: 'voice_space_muted',
          userId,
          channelId,
          spaceId,
          muted: true,
        });
      } else if (r.restrictionType === 'deafen') {
        connectionManager.setSpaceDeafened(spaceId, userId, true);
        connectionManager.sendToUser(userId, {
          type: 'voice_space_deafened',
          userId,
          channelId,
          spaceId,
          deafened: true,
        });
      }
    }

    // Re-check permission mute on re-registration
    {
      const perms = computePermissions(userId, spaceId, channelId);
      const canSpeak = (perms & PermissionBits.SPEAK) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
      const shouldPermMute = !canSpeak;
      connectionManager.setPermissionMuted(spaceId, userId, shouldPermMute);
      if (shouldPermMute) {
        connectionManager.sendToUser(userId, {
          type: 'voice_permission_muted',
          userId,
          spaceId,
          muted: true,
        });
      }
    }
    return;
  }

  // Leave current room (space OR DM)
  const left = connectionManager.leaveCurrentRoom(userId);
  if (left) {
    broadcastRoomLeave(left.roomId, left.room, userId);

    // Notify all of the user's tabs so the displaced tab tears down LiveKit
    connectionManager.sendToUser(userId, {
      type: 'voice_disconnected',
      userId,
      channelId: left.roomId,
      reason: 'displaced',
    });
  }
  if (connectionManager.getJoinedFederatedCall(userId)) {
    connectionManager.leaveFederatedCall(userId);
  }

  // Lazy-create space room
  connectionManager.createRoom(channelId, 'space', { type: 'space', spaceId });

  // Join room
  connectionManager.joinRoom(channelId, userId);

  // A call the user started that still rings ends, and the peers hear it
  // (the user started a call, then joined voice before anyone answered).
  // After the join, so ending it leaves the voice session bound to this
  // socket alone.
  connectionManager.endRingingCallsPlacedBy(userId);

  // Broadcast join
  const joinedRoom = connectionManager.getRoom(channelId);
  connectionManager.sendToRoom(channelId, {
    type: 'voice_state_update',
    channelId,
    userId,
    action: 'join',
    channelElapsedSeconds: joinedRoom ? getVoiceRoomElapsedSeconds(joinedRoom) : undefined,
  });

  // Also broadcast current voice status if it exists (persisted during moves)
  const status = connectionManager.getVoiceUserStatus(userId);
  if (status) {
    connectionManager.sendToRoom(channelId, {
      type: 'voice_status_update',
      userId,
      channelId,
      isMuted: status.isMuted,
      isDeafened: status.isDeafened,
      isCameraOn: status.isCameraOn,
      isScreenSharing: status.isScreenSharing,
    });
  }

  // Load persistent voice restrictions for this user in this space
  const db = getDb();
  const restrictions = db.select()
    .from(schema.voiceRestrictions)
    .where(and(
      eq(schema.voiceRestrictions.spaceId, spaceId),
      eq(schema.voiceRestrictions.userId, userId),
    ))
    .all();

  for (const r of restrictions) {
    if (r.restrictionType === 'mute') {
      connectionManager.setSpaceMuted(spaceId, userId, true);
      connectionManager.sendToSpace(spaceId, {
        type: 'voice_space_muted',
        userId,
        channelId,
        spaceId,
        muted: true,
      });
    } else if (r.restrictionType === 'deafen') {
      connectionManager.setSpaceDeafened(spaceId, userId, true);
      connectionManager.sendToSpace(spaceId, {
        type: 'voice_space_deafened',
        userId,
        channelId,
        spaceId,
        deafened: true,
      });
    }
  }

  // Check SPEAK permission and apply permission mute if needed
  {
    const perms = computePermissions(userId, spaceId, channelId);
    const canSpeak = (perms & PermissionBits.SPEAK) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
    if (!canSpeak) {
      connectionManager.setPermissionMuted(spaceId, userId, true);
      connectionManager.sendToSpace(spaceId, {
        type: 'voice_permission_muted',
        userId,
        spaceId,
        muted: true,
      });
    }
  }
}

export function handleVoiceLeave(userId: string): void {
  // A call hosted on a peer, joined through this instance, is voice the user
  // holds here too: the client leaves it this way when it joins voice on
  // another instance, which tells this one nothing else.
  leaveJoinedFederatedCall(userId);
  connectionManager.clearVoiceWs(userId);
  const left = connectionManager.leaveCurrentRoom(userId);
  if (left) {
    broadcastRoomLeave(left.roomId, left.room, userId);
  }
  connectionManager.clearVoiceUserStatus(userId);
}

export function handleVoiceStatus(event: Record<string, unknown>, userId: string, ws: WebSocket): void {
  const isMuted = event.isMuted === true;
  const isDeafened = event.isDeafened === true;
  const isCameraOn = event.isCameraOn === true;
  const isScreenSharing = event.isScreenSharing === true;

  // BUG FIX: uses unified getUserRoom() instead of server-only getUserVoiceChannel()
  // This now works for both server channels AND DM calls.
  const userRoom = connectionManager.getUserRoom(userId);
  if (!userRoom) {
    if (connectionManager.getJoinedFederatedCall(userId)) connectionManager.setVoiceWs(userId, ws);
    return;
  }
  // Space sessions must resume through voice_join so an ordinary tab cannot
  // keep a stale session alive merely by sending status. DM calls have no
  // voice_join event, so voice_status is their explicit resume signal.
  if (userRoom.room.roomType === 'dm') connectionManager.setVoiceWs(userId, ws);

  let isSpaceMuted = false;
  let isSpaceDeafened = false;
  let isPermMuted = false;
  if (userRoom.room.roomType === 'space') {
    const meta = userRoom.room.metadata as SpaceRoomMeta;
    isSpaceMuted = connectionManager.isSpaceMuted(meta.spaceId, userId);
    isSpaceDeafened = connectionManager.isSpaceDeafened(meta.spaceId, userId);
    isPermMuted = connectionManager.isPermissionMuted(meta.spaceId, userId);
  }

  // Server-side enforcement: prevent clients from bypassing server mute/deafen/permission mute
  const effectiveMuted = (isSpaceMuted || isPermMuted) ? true : isMuted;
  const effectiveDeafened = isSpaceDeafened ? true : isDeafened;

  connectionManager.setVoiceUserStatus(userId, effectiveMuted, effectiveDeafened, isCameraOn, isScreenSharing);

  // sendToRoom routes to sendToSpace for space rooms, sendToDmMembers for DM rooms
  connectionManager.sendToRoom(userRoom.roomId, {
    type: 'voice_status_update',
    userId,
    channelId: userRoom.roomId,
    isMuted: effectiveMuted,
    isDeafened: effectiveDeafened,
    isCameraOn,
    isScreenSharing,
  });
}

// ─── Voice Moderation Handlers ──────────────────────────────────────────────

/**
 * Voice moderation of another member follows the role hierarchy, like kick and
 * ban (permissions.md, "Role hierarchy"). Sends the refusal and returns true
 * when `actorId` does not outrank `targetId`; acting on oneself is not
 * moderation and is left to each handler's own rules.
 */
function refusedByRoleHierarchy(spaceId: string, actorId: string, targetId: string): boolean {
  if (actorId === targetId) return false;
  if (canActOnMemberInSpace(spaceId, actorId, targetId)) return false;
  connectionManager.sendToUser(actorId, { type: 'error', message: ERROR_MESSAGES.role_hierarchy, code: 'role_hierarchy' });
  return true;
}

export function handleVoiceSpaceMute(event: Record<string, unknown>, userId: string): void {
  const targetUserId = event.userId as string;
  const muted = event.muted === true;

  if (!targetUserId || typeof targetUserId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'userId is required' });
    return;
  }

  // Find the target user's current room
  const targetRoom = connectionManager.getUserRoom(targetUserId);
  if (!targetRoom || targetRoom.room.roomType !== 'space') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target user is not in a voice channel' });
    return;
  }

  const meta = targetRoom.room.metadata as SpaceRoomMeta;
  if (!hasPermission(userId, meta.spaceId, PermissionBits.MUTE_MEMBERS, targetRoom.roomId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing MUTE_MEMBERS permission' });
    return;
  }

  // Cannot space-mute yourself
  if (targetUserId === userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Cannot space-mute yourself' });
    return;
  }

  if (refusedByRoleHierarchy(meta.spaceId, userId, targetUserId)) return;

  connectionManager.setSpaceMuted(meta.spaceId, targetUserId, muted);

  // Persist to DB
  const db = getDb();
  if (muted) {
    db.insert(schema.voiceRestrictions).values({
      spaceId: meta.spaceId,
      userId: targetUserId,
      restrictionType: 'mute',
      moderatorId: userId,
      createdAt: Date.now(),
    }).onConflictDoNothing().run();
  } else {
    db.delete(schema.voiceRestrictions).where(
      and(
        eq(schema.voiceRestrictions.spaceId, meta.spaceId),
        eq(schema.voiceRestrictions.userId, targetUserId),
        eq(schema.voiceRestrictions.restrictionType, 'mute'),
      )
    ).run();
  }

  // Broadcast to all space members
  connectionManager.sendToSpace(meta.spaceId, {
    type: 'voice_space_muted',
    userId: targetUserId,
    channelId: targetRoom.roomId,
    spaceId: meta.spaceId,
    muted,
  });
}

export function handleVoiceSpaceDeafen(event: Record<string, unknown>, userId: string): void {
  const targetUserId = event.userId as string;
  const deafened = event.deafened === true;

  if (!targetUserId || typeof targetUserId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'userId is required' });
    return;
  }

  const targetRoom = connectionManager.getUserRoom(targetUserId);
  if (!targetRoom || targetRoom.room.roomType !== 'space') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target user is not in a voice channel' });
    return;
  }

  const meta = targetRoom.room.metadata as SpaceRoomMeta;
  if (!hasPermission(userId, meta.spaceId, PermissionBits.DEAFEN_MEMBERS, targetRoom.roomId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing DEAFEN_MEMBERS permission' });
    return;
  }

  if (targetUserId === userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Cannot space-deafen yourself' });
    return;
  }

  if (refusedByRoleHierarchy(meta.spaceId, userId, targetUserId)) return;

  connectionManager.setSpaceDeafened(meta.spaceId, targetUserId, deafened);

  // Persist to DB
  const db = getDb();
  if (deafened) {
    db.insert(schema.voiceRestrictions).values({
      spaceId: meta.spaceId,
      userId: targetUserId,
      restrictionType: 'deafen',
      moderatorId: userId,
      createdAt: Date.now(),
    }).onConflictDoNothing().run();
  } else {
    db.delete(schema.voiceRestrictions).where(
      and(
        eq(schema.voiceRestrictions.spaceId, meta.spaceId),
        eq(schema.voiceRestrictions.userId, targetUserId),
        eq(schema.voiceRestrictions.restrictionType, 'deafen'),
      )
    ).run();
  }

  connectionManager.sendToSpace(meta.spaceId, {
    type: 'voice_space_deafened',
    userId: targetUserId,
    channelId: targetRoom.roomId,
    spaceId: meta.spaceId,
    deafened,
  });
}

export function handleVoiceMove(event: Record<string, unknown>, userId: string): void {
  const targetUserId = event.userId as string;
  const targetChannelId = event.targetChannelId as string;

  if (!targetUserId || typeof targetUserId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'userId is required' });
    return;
  }
  if (!targetChannelId || typeof targetChannelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'targetChannelId is required' });
    return;
  }

  // Find the target user's current room
  const currentRoom = connectionManager.getUserRoom(targetUserId);
  if (!currentRoom || currentRoom.room.roomType !== 'space') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target user is not in a voice channel' });
    return;
  }

  const meta = currentRoom.room.metadata as SpaceRoomMeta;
  if (!hasPermission(userId, meta.spaceId, PermissionBits.MOVE_MEMBERS, currentRoom.roomId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing MOVE_MEMBERS permission' });
    return;
  }

  if (refusedByRoleHierarchy(meta.spaceId, userId, targetUserId)) return;

  // Verify target channel exists and is a voice/video channel in the same space
  const db = getDb();
  const targetChannel = db.select().from(schema.channels).where(eq(schema.channels.id, targetChannelId)).get();
  if (!targetChannel || targetChannel.spaceId !== meta.spaceId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target channel not found in this space' });
    return;
  }
  if (targetChannel.type !== 'voice') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target channel is not a voice channel' });
    return;
  }
  if (targetChannelId === currentRoom.roomId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'User is already in that channel' });
    return;
  }

  const oldChannelId = currentRoom.roomId;

  // Leave current room
  connectionManager.leaveRoom(oldChannelId, targetUserId);

  // Broadcast leave from old channel
  connectionManager.sendToSpace(meta.spaceId, {
    type: 'voice_state_update',
    channelId: oldChannelId,
    userId: targetUserId,
    action: 'leave',
  });

  // Lazy-create target room and join
  connectionManager.createRoom(targetChannelId, 'space', { type: 'space', spaceId: meta.spaceId });
  connectionManager.joinRoom(targetChannelId, targetUserId);

  // Read the room after the join: an empty voice channel has no room at all
  // (leaveRoom tears space rooms down when the last participant leaves), so
  // looking it up any earlier reports no duration for the channel this move
  // just occupied.
  const targetRoom = connectionManager.getRoom(targetChannelId);

  // Broadcast join to new channel
  connectionManager.sendToSpace(meta.spaceId, {
    type: 'voice_state_update',
    channelId: targetChannelId,
    userId: targetUserId,
    action: 'join',
    channelElapsedSeconds: targetRoom ? getVoiceRoomElapsedSeconds(targetRoom) : undefined,
  });

  // Notify the moved user so they reconnect to LiveKit
  connectionManager.sendToUser(targetUserId, {
    type: 'voice_moved',
    userId: targetUserId,
    oldChannelId,
    newChannelId: targetChannelId,
  });

  // Preserve voice user status during move
  const status = connectionManager.getVoiceUserStatus(targetUserId);
  if (status) {
    connectionManager.sendToRoom(targetChannelId, {
      type: 'voice_status_update',
      userId: targetUserId,
      channelId: targetChannelId,
      isMuted: status.isMuted,
      isDeafened: status.isDeafened,
      isCameraOn: status.isCameraOn,
      isScreenSharing: status.isScreenSharing,
    });
  }
}

export function handleVoiceDisconnect(event: Record<string, unknown>, userId: string): void {
  const targetUserId = event.userId as string;

  if (!targetUserId || typeof targetUserId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'userId is required' });
    return;
  }

  if (targetUserId === userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Cannot disconnect yourself' });
    return;
  }

  // Find the target user's current room
  const currentRoom = connectionManager.getUserRoom(targetUserId);
  if (!currentRoom || currentRoom.room.roomType !== 'space') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target user is not in a voice channel' });
    return;
  }

  const meta = currentRoom.room.metadata as SpaceRoomMeta;
  if (!hasPermission(userId, meta.spaceId, PermissionBits.DISCONNECT_MEMBERS, currentRoom.roomId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing DISCONNECT_MEMBERS permission' });
    return;
  }

  if (refusedByRoleHierarchy(meta.spaceId, userId, targetUserId)) return;

  const channelId = currentRoom.roomId;

  // Remove from voice room
  connectionManager.leaveRoom(channelId, targetUserId);
  connectionManager.clearVoiceWs(targetUserId);

  // Clear ephemeral voice status (mute/camera/etc)
  connectionManager.clearVoiceUserStatus(targetUserId);

  // Broadcast leave to all space members
  connectionManager.sendToSpace(meta.spaceId, {
    type: 'voice_state_update',
    channelId,
    userId: targetUserId,
    action: 'leave',
  });

  // Notify the disconnected user so they clean up client-side
  connectionManager.sendToUser(targetUserId, {
    type: 'voice_disconnected',
    userId: targetUserId,
    channelId,
  });
}
