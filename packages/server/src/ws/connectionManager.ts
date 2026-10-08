import { ownsChosenStatus, type Activity, type ChosenUserStatus, type ServerEvent } from '@backspace/shared';
import { eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { getDb, schema } from '../db/index.js';
import { statusOnConnect, type StatusSourceRow } from '../utils/presenceStatus.js';
import { collectProfileBroadcastTargetIds } from '../utils/userDeletion.js';
import { attachReplicaSessionHost, showReplicaStatusOnConnect, showReplicaStatusOnDisconnect } from './replicaPresence.js';
import { presenceUpdateFor } from './presenceEvent.js';
import { pushReadyPayloadToConnections } from './readyPayload.js';
import { buildSpaceVoiceState, type SpaceVoiceStateResult } from './spaceVoiceState.js';
import { getVoiceRoomElapsedSeconds, MAX_PENDING_VOICE_RECONNECTS, VOICE_RECONNECT_GRACE_MS, type DmRoomMeta, type FederatedCallEntry, type PendingVoiceReconnect, type SpaceRoomMeta, type VoiceRoom } from './voiceRoomTypes.js';
import { WsRateLimiter } from './wsRateLimiter.js';
import { hasNativeVoiceSocket, removeNativeVoiceSocket, revokeNativeVoiceSessions, syncNativeVoicePermissions } from './nativeVoiceSessions.js';
import { isGroupConversation } from '../utils/dmConversation.js';
import { normalizeOriginForCompare } from '../utils/federationAuth.js';
import { FederatedCallRegistry } from './federatedCallRegistry.js';
import { SpaceVoiceModeration } from './spaceVoiceModeration.js';
import { UserActivityTracker } from './userActivityTracker.js';
import { EventBroadcaster } from './eventBroadcaster.js';

class ConnectionManager {
  private connections: Map<string, Set<WebSocket>> = new Map();
  private userSpaces: Map<string, Set<string>> = new Map();
  private wsToUser: Map<WebSocket, string> = new Map();
  private voiceRooms: Map<string, VoiceRoom> = new Map();
  private userToRoom: Map<string, string> = new Map();
  private voiceUserStates: Map<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }> = new Map();
  private pendingOfflineTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private pendingVoiceReconnects: Map<string, PendingVoiceReconnect> = new Map();
  private ringingTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private ringTimeoutFanoutHook: ((dmChannelId: string, callerId: string) => Promise<void>) | null = null;
  private federatedCalls = new FederatedCallRegistry();
  private voiceModeration = new SpaceVoiceModeration();
  private voiceWs: Map<string, WebSocket> = new Map();
  private userRateLimiters: Map<string, WsRateLimiter> = new Map();

  // ─── Rich Presence & Activity ───────────────────────────────────────────
  private activityTracker = new UserActivityTracker();

  // ─── Broadcasting ─────────────────────────────────────────────────────────
  private broadcaster = new EventBroadcaster({
    getUserConnections: (uid) => this.getUserConnections(uid),
    getUserSpacesEntries: () => this.userSpaces.entries(),
    getFederatedCallRingedUsers: (fedId) => this.federatedCalls.getFederatedCall(fedId)?.ringedUserIds,
    getRoom: (rid) => this.getRoom(rid),
    getAllConnections: () => this.connections,
  });

  addConnection(userId: string, ws: WebSocket): void {
    if (!this.connections.has(userId)) this.connections.set(userId, new Set());
    this.connections.get(userId)!.add(ws);
    this.wsToUser.set(ws, userId);

    // If they were pending offline, cancel it!
    this.cancelDisconnect(userId);
  }

  removeConnection(ws: WebSocket): string | undefined {
    const userId = this.wsToUser.get(ws);
    if (!userId) return undefined;

    const wasNativeVoice = removeNativeVoiceSocket(ws);
    this.wsToUser.delete(ws);
    const userConnections = this.connections.get(userId);
    if (userConnections) {
      userConnections.delete(ws);

      // Only the socket that owns voice starts the voice grace period. Closing
      // another tab must not disturb the active voice session.
      if (this.voiceWs.get(userId) === ws) {
        this.voiceWs.delete(userId);
        this.scheduleVoiceDisconnect(userId);
      } else if (wasNativeVoice && !this.voiceWs.has(userId)) {
        this.scheduleVoiceDisconnect(userId);
      }

      if (userConnections.size === 0) {
        this.connections.delete(userId);
        // Presence and voice have independent grace periods.
        this.scheduleDisconnect(userId);
      }
    }
    return userId;
  }

  private scheduleDisconnect(userId: string) {
    if (this.pendingOfflineTimeouts.has(userId)) return;

    const timeout = setTimeout(() => {
      this.finalizeDisconnect(userId);
      this.pendingOfflineTimeouts.delete(userId);
    }, 5000); // 5 second grace period

    this.pendingOfflineTimeouts.set(userId, timeout);
  }

  private cancelDisconnect(userId: string) {
    const timeout = this.pendingOfflineTimeouts.get(userId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingOfflineTimeouts.delete(userId);
      console.log(`[ConnectionManager] Rescued session for user ${userId}`);
    }
  }

  private scheduleVoiceDisconnect(userId: string): void {
    this.cancelVoiceDisconnect(userId);
    if (hasNativeVoiceSocket(userId)) return;
    const roomId = this.userToRoom.get(userId)
      ?? Array.from(this.voiceRooms).find(([, room]) =>
        room.roomType === 'dm'
        && (room.metadata as DmRoomMeta).state === 'ringing'
        && (room.metadata as DmRoomMeta).callerId === userId,
      )?.[0]
      ?? null;
    // A session with no room here may hold a call hosted on a peer, joined
    // through this instance. Its loss is that member's only leave signal.
    const federatedId = roomId === null ? this.getJoinedFederatedCall(userId)?.federatedId ?? null : null;
    if (!roomId && !federatedId) return;

    if (this.pendingVoiceReconnects.size >= MAX_PENDING_VOICE_RECONNECTS) {
      const oldest = this.pendingVoiceReconnects.entries().next().value as
        | [string, PendingVoiceReconnect]
        | undefined;
      if (oldest) {
        clearTimeout(oldest[1].timeout);
        this.pendingVoiceReconnects.delete(oldest[0]);
        this.finalizeVoiceDisconnect(oldest[0], oldest[1].roomId, oldest[1].federatedId);
      }
    }

    const timeout = setTimeout(() => {
      const pending = this.pendingVoiceReconnects.get(userId);
      if (!pending || pending.timeout !== timeout) return;
      this.pendingVoiceReconnects.delete(userId);
      if (!this.voiceWs.has(userId) && !hasNativeVoiceSocket(userId)) {
        this.finalizeVoiceDisconnect(userId, pending.roomId, pending.federatedId);
      }
    }, VOICE_RECONNECT_GRACE_MS);
    this.pendingVoiceReconnects.set(userId, { timeout, roomId, federatedId });
  }

  private cancelVoiceDisconnect(userId: string): void {
    const pending = this.pendingVoiceReconnects.get(userId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingVoiceReconnects.delete(userId);
  }

  private finalizeVoiceDisconnect(
    userId: string,
    expectedRoomId: string | null = null,
    expectedFederatedId: string | null = null,
  ): void {
    if (this.voiceWs.has(userId) || hasNativeVoiceSocket(userId)) return;
    revokeNativeVoiceSessions({ userId });
    this.clearVoiceUserStatus(userId);

    // The session held a call hosted on a peer: the member leaves it as if
    // they had hung up, unless they already left it.
    if (expectedFederatedId !== null) {
      if (this.getJoinedFederatedCall(userId)?.federatedId === expectedFederatedId) {
        this.leaveFederatedCall(userId);
      }
      return;
    }

    const current = this.getUserRoom(userId);
    if (!expectedRoomId || current?.roomId === expectedRoomId) this.leaveCurrentRoomAnnounced(userId);

    for (const [roomId, room] of this.voiceRooms) {
      if (room.roomType !== 'dm') continue;
      const meta = room.metadata as DmRoomMeta;
      if (meta.state === 'ringing' && meta.callerId === userId
          && (!expectedRoomId || expectedRoomId === roomId)) {
        this.endDmRoom(roomId, 'dm_call_ended');
        this.fanOutCallEnd(roomId, userId);
      }
    }
  }

  /**
   * Take `userId` out of the room they are in, unless it is `keepRoomId`,
   * and tell whoever sees that room. A DM call they leave empty ends, and the
   * end is relayed to the peers in the name of its caller, who is homed here.
   * Returns the room left, if any.
   */
  leaveCurrentRoomAnnounced(userId: string, keepRoomId?: string): { roomId: string; room: VoiceRoom } | null {
    if (keepRoomId !== undefined && this.userToRoom.get(userId) === keepRoomId) return null;
    const left = this.leaveCurrentRoom(userId);
    if (!left) return null;
    if (left.room.roomType === 'space') {
      const meta = left.room.metadata as SpaceRoomMeta;
      this.sendToSpace(meta.spaceId, { type: 'voice_state_update', channelId: left.roomId, userId, action: 'leave' });
    } else if (this.afterDmCallLeave(left.roomId, userId) === 'ended') {
      this.fanOutCallEnd(left.roomId, (left.room.metadata as DmRoomMeta).callerId);
    }
    return left;
  }

  /**
   * Publish the status of a connection for `row` that just authenticated and
   * return it. A row that owns its status shows its chosen one
   * (`statusOnConnect`); a replicated row's status is written by
   * `showReplicaStatusOnConnect` (ws/replicaPresence.ts).
   */
  publishConnectStatus(row: StatusSourceRow & { id: string }): ChosenUserStatus {
    if (!ownsChosenStatus(row)) return showReplicaStatusOnConnect(row);
    const status = statusOnConnect(row);
    getDb().update(schema.users).set({ status }).where(eq(schema.users.id, row.id)).run();
    return status;
  }

  /** A session of the user is open here, or its disconnect grace period runs. */
  hasSessionHere(userId: string): boolean {
    return this.isUserOnline(userId) || this.pendingOfflineTimeouts.has(userId);
  }

  private finalizeDisconnect(userId: string) {
    // Double check they are still offline
    if (this.isUserOnline(userId)) return;

    // Native remote-call sessions have no userToRoom entry, but still require teardown.
    revokeNativeVoiceSessions({ userId });
    console.log(`[ConnectionManager] Finalizing disconnect for user ${userId}`);

    // A replicated row returns to its home's projection, or to 'offline' when
    // none is known (ws/replicaPresence.ts). The home owns its status, so
    // nothing is relayed, and relayed activities stay unless it is offline.
    const replica = showReplicaStatusOnDisconnect(userId);
    if (replica) {
      if (replica.status === 'offline') this.activityTracker.clearUser(userId);
      if (replica.changed) {
        const payload = presenceUpdateFor(userId, replica.status, replica.status === 'offline' ? [] : undefined);
        for (const uid of collectProfileBroadcastTargetIds(userId)) this.sendToUser(uid, payload);
      }
      this.forgetSessionState(userId);
      return;
    }

    const db = getDb();
    db.update(schema.users).set({ status: 'offline' }).where(eq(schema.users.id, userId)).run();

    // Clear activity state
    this.activityTracker.clearUser(userId);

    const offlinePayload = presenceUpdateFor(userId, 'offline', []);
    const offlineTargets = collectProfileBroadcastTargetIds(userId);
    for (const uid of offlineTargets) this.sendToUser(uid, offlinePayload);

    // S2S: project offline to all active peers (mirrors profile_update fanout).
    // Imported lazily to avoid circular import (federationPresence → db → ws/handler).
    void import('../utils/federationPresence.js').then(({ queuePresenceRelay }) => {
      try { queuePresenceRelay(userId, 'offline', []); } catch (e) { console.warn('[ws] queuePresenceRelay(offline) failed', e); }
    });

    this.forgetSessionState(userId);
  }

  private forgetSessionState(userId: string): void {
    this.userSpaces.delete(userId);
    this.userRateLimiters.delete(userId);
  }

  getUserConnections(userId: string): Set<WebSocket> {
    return this.connections.get(userId) ?? new Set();
  }

  isUserOnline(userId: string): boolean {
    const conns = this.connections.get(userId);
    return conns !== undefined && conns.size > 0;
  }

  getUserRateLimiter(userId: string): WsRateLimiter {
    let limiter = this.userRateLimiters.get(userId);
    if (!limiter) {
      limiter = new WsRateLimiter();
      this.userRateLimiters.set(userId, limiter);
    }
    return limiter;
  }

  // ─── Activity accessors ─────────────────────────────────────────────────

  setUserActivities(userId: string, activities: Activity[]): void {
    this.activityTracker.setUserActivities(userId, activities);
  }

  getUserActivities(userId: string): Activity[] {
    return this.activityTracker.getUserActivities(userId);
  }

  clearUserActivities(userId: string): void {
    this.activityTracker.clearUserActivities(userId);
  }

  setUserShowActivity(userId: string, show: boolean): void {
    this.activityTracker.setUserShowActivity(userId, show);
  }

  getUserShowActivity(userId: string): boolean {
    return this.activityTracker.getUserShowActivity(userId);
  }

  setUserStatus(userId: string, status: string): void {
    this.activityTracker.setUserStatus(userId, status);
  }

  getUserStatus(userId: string): string {
    return this.activityTracker.getUserStatus(userId);
  }

  checkActivityRateLimit(userId: string): boolean {
    return this.activityTracker.checkActivityRateLimit(userId);
  }

  setUserSpaces(userId: string, spaceIds: string[]): void {
    this.userSpaces.set(userId, new Set(spaceIds));
  }

  addUserSpace(userId: string, spaceId: string): void {
    if (!this.userSpaces.has(userId)) {
      this.userSpaces.set(userId, new Set());
    }
    this.userSpaces.get(userId)!.add(spaceId);
    this.pushSpaceVoiceState(userId, spaceId);
  }

  /**
   * Send `userId` the voice presence of `spaceId` they can see now, as one
   * `space_voice_state` (`buildSpaceVoiceState`, VIEW_CHANNEL-filtered).
   */
  pushSpaceVoiceState(userId: string, spaceId: string): void {
    if (this.getUserConnections(userId).size === 0) return;
    const snapshot = this.buildSpaceVoiceState(spaceId, userId);
    if (Object.keys(snapshot.voiceStates).length === 0
        && Object.keys(snapshot.spaceVoiceStates).length === 0) {
      return;
    }
    this.sendToUser(userId, {
      type: 'space_voice_state',
      spaceId,
      voiceStates: snapshot.voiceStates,
      voiceChannelElapsedSeconds: snapshot.voiceChannelElapsedSeconds,
      voiceUserStates: snapshot.voiceUserStates,
      spaceVoiceStates: snapshot.spaceVoiceStates,
    });
  }

  /**
   * After a change to the space's roles or to a member's roles, notify members
   * and push the updated space voice state to affected users.
   */
  announceSpaceAccessChange(spaceId: string, affectedUserIds: Iterable<string>): void {
    this.sendToSpace(spaceId, { type: 'space_access_changed', spaceId });
    for (const userId of new Set(affectedUserIds)) {
      if (this.getUserSpaces(userId).has(spaceId)) this.pushSpaceVoiceState(userId, spaceId);
    }
  }

  announceUserAccessChange(userId: string, spaceIds: Iterable<string>): void {
    if (this.getUserConnections(userId).size === 0) return;
    for (const spaceId of new Set(spaceIds)) {
      this.sendToUser(userId, { type: 'space_access_changed', spaceId });
      this.pushSpaceVoiceState(userId, spaceId);
    }
  }

  getUserSpaces(userId: string): Set<string> {
    return this.userSpaces.get(userId) ?? new Set();
  }

  /**
   * Build the current voice-presence snapshot for a single space, from the
   * perspective of `userId`:
   * - which voice channels the user can VIEW have participants, and who they are,
   * - each participant's per-user status (mute/deafen/camera/screenshare),
   * - space-level mute/deafen (persisted) + permission-mute (ephemeral)
   *   restrictions, keyed `spaceId:userId`.
   *
   * Voice presence is VIEW_CHANNEL-filtered per `computePermissions` exactly as
   * `buildReadyPayload` does — a user must never learn who is sitting in a voice
   * channel they cannot see.
   *
   * Single source of truth shared by `buildReadyPayload` (connect-time bootstrap,
   * looped across all of a user's spaces) and `addUserSpace` (mid-session join
   * push). Keep these two consumers in sync by changing only this method.
   */
  buildSpaceVoiceState(spaceId: string, userId: string): SpaceVoiceStateResult {
    return buildSpaceVoiceState(
      {
        getRoom: (id) => this.getRoom(id),
        getVoiceUserStatus: (uid) => this.getVoiceUserStatus(uid),
        getVoiceRooms: () => this.voiceRooms.entries(),
        isPermissionMuted: (sid, uid) => this.isPermissionMuted(sid, uid),
      },
      spaceId,
      userId,
    );
  }

  // ─── Unified VoiceRoom API ─────────────────────────────────────────────────

  /** Create a room. Returns false if room already exists. */
  createRoom(roomId: string, roomType: 'space' | 'dm', metadata: SpaceRoomMeta | DmRoomMeta): boolean {
    if (this.voiceRooms.has(roomId)) return false;
    this.voiceRooms.set(roomId, {
      roomId,
      roomType,
      participants: new Set(),
      metadata,
      startedAt: Date.now(),
    });
    return true;
  }

  /** Register a fan-out callback invoked when a ringing DM room hits its 60s timeout. */
  setRingTimeoutFanoutHook(fn: (dmChannelId: string, callerId: string) => Promise<void>): void {
    this.ringTimeoutFanoutHook = fn;
  }

  /**
   * Relay dm_call_end to remote peers for calls hosted here that end on the
   * host's own initiative (60s ring timeout, socket close while ringing,
   * voice reconnect grace expiring on the last participant, or account deletion).
   * Safe to call on purely local calls: sendFederatedCallEnd checks remote
   * member presence and no-ops when none exist.
   * `endedByUserId` is the host's own identity that took the action; a peer
   * refuses an end attributed to a user homed on another instance.
   */
  fanOutCallEnd(dmChannelId: string, endedByUserId: string): void {
    if (!this.ringTimeoutFanoutHook) return;
    this.ringTimeoutFanoutHook(dmChannelId, endedByUserId).catch(err =>
      console.error('[ws] call-end fan-out error:', err),
    );
  }

  /**
   * Register the callback that takes a local user out of the call hosted on
   * a peer they joined through this instance, and tells the host, when they
   * leave it without hanging up.
   */
  setFederatedCallLeaveHook(fn: (userId: string) => void): void {
    this.federatedCalls.setFederatedCallLeaveHook(fn);
  }

  /** `userId` left the call hosted on a peer they joined through here. */
  leaveFederatedCall(userId: string): void {
    this.federatedCalls.leaveFederatedCall(userId);
  }

  /** The call hosted on a peer that `userId` joined through this instance. */
  getJoinedFederatedCall(userId: string): FederatedCallEntry | undefined {
    return this.federatedCalls.getJoinedFederatedCall(userId);
  }

  /** Create a DM room in ringing state with 60s auto-cleanup. */
  createDmRoom(dmChannelId: string, callerId: string): boolean {
    const row = getDb().select({ ownerId: schema.dmChannels.ownerId, federatedId: schema.dmChannels.federatedId })
      .from(schema.dmChannels)
      .where(eq(schema.dmChannels.id, dmChannelId))
      .get();
    const created = this.createRoom(dmChannelId, 'dm', {
      type: 'dm',
      callerId,
      state: 'ringing',
      group: row ? isGroupConversation({ owner_id: row.ownerId, federated_id: row.federatedId }) : false,
      declinedUserIds: new Set(),
      remoteParticipants: new Map(),
    });
    if (!created) return false;

    // 60s ringing timeout: nobody but the caller joined, so the call ends.
    const timeout = setTimeout(() => {
      this.ringingTimeouts.delete(dmChannelId);
      const room = this.voiceRooms.get(dmChannelId);
      if (room && room.roomType === 'dm' && (room.metadata as DmRoomMeta).state === 'ringing') {
        const ringedCallerId = (room.metadata as DmRoomMeta).callerId;
        this.endDmRoom(dmChannelId, 'dm_call_ended');
        // Fan dm_call_end out to remote peers so stranded Path-A/B ringees exit the ring.
        // Without this, an accept-relay failure → Alice's 60s auto-clean leaves Bob's FederatedCallEntry lingering with no terminal event.
        this.fanOutCallEnd(dmChannelId, ringedCallerId);
      }
    }, 60_000);
    this.ringingTimeouts.set(dmChannelId, timeout);

    return true;
  }

  /**
   * End a DM call hosted here: unbind the voice sessions it holds, destroy the
   * room, tell the DM members that each participant left, then send `kind`
   * (`dm_call_ended`, or `dm_call_rejected` for a call every ringee declined).
   * Local only: the caller relays `dm_call_end` to the peers. Returns false
   * when there is no such room.
   */
  endDmRoom(dmChannelId: string, kind: 'dm_call_ended' | 'dm_call_rejected'): boolean {
    const room = this.voiceRooms.get(dmChannelId);
    if (!room || room.roomType !== 'dm') return false;
    const meta = room.metadata as DmRoomMeta;
    const participants = Array.from(room.participants);
    // The caller of a ringing call holds no seat but owns the voice binding,
    // unless they have since joined some other room.
    const callerRoom = this.userToRoom.get(meta.callerId);
    if (callerRoom === undefined || callerRoom === dmChannelId) this.clearVoiceWs(meta.callerId);
    for (const participantId of participants) {
      this.clearVoiceUserStatus(participantId);
      this.clearVoiceWs(participantId);
    }
    this.destroyRoom(dmChannelId);
    for (const participantId of participants) {
      this.sendToDmMembers(dmChannelId, {
        type: 'voice_state_update', channelId: dmChannelId, userId: participantId, action: 'leave',
      });
    }
    this.sendToDmMembers(dmChannelId, { type: kind, dmChannelId });
    return true;
  }

  /**
   * After `userId` left the DM call `dmChannelId` (already out of its
   * participants): tell the DM members, and end the call when it is active
   * and nobody is left in it. Returns 'ended' when the call ended, so the
   * caller relays the end to the peers.
   */
  afterDmCallLeave(dmChannelId: string, userId: string): 'left' | 'ended' {
    const room = this.voiceRooms.get(dmChannelId);
    if (room && room.roomType === 'dm') (room.metadata as DmRoomMeta).remoteParticipants.delete(userId);
    this.sendToDmMembers(dmChannelId, {
      type: 'voice_state_update', channelId: dmChannelId, userId, action: 'leave',
    });
    if (room && room.roomType === 'dm' && room.participants.size === 0
        && (room.metadata as DmRoomMeta).state === 'active') {
      this.endDmRoom(dmChannelId, 'dm_call_ended');
      return 'ended';
    }
    return 'left';
  }

  /**
   * A member hangs up or cancels a group call hosted here (`dm_call_end`,
   * local or relayed). The caller of a call nobody has joined yet ends it;
   * a participant leaves it, and the call ends with the last one out; anyone
   * else is not in the call and changes nothing.
   */
  leaveGroupDmCall(dmChannelId: string, userId: string): 'ignored' | 'left' | 'ended' {
    const room = this.voiceRooms.get(dmChannelId);
    if (!room || room.roomType !== 'dm') return 'ignored';
    const meta = room.metadata as DmRoomMeta;
    if (meta.state === 'ringing' && meta.callerId === userId) {
      this.endDmRoom(dmChannelId, 'dm_call_ended');
      return 'ended';
    }
    if (!room.participants.has(userId)) return 'ignored';
    this.leaveRoom(dmChannelId, userId);
    this.clearVoiceUserStatus(userId);
    this.clearVoiceWs(userId);
    return this.afterDmCallLeave(dmChannelId, userId);
  }

  /**
   * A member declines a group call hosted here (`dm_call_reject`, local or
   * relayed). The decliner stops ringing; the call goes on for everyone else.
   * When the call is still ringing and every member but the caller has
   * declined, nobody is left to answer and it ends as rejected. The caller
   * and participants cannot decline. Membership is the caller's to check.
   */
  declineGroupDmCall(dmChannelId: string, userId: string): 'ignored' | 'declined' | 'ended' {
    const room = this.voiceRooms.get(dmChannelId);
    if (!room || room.roomType !== 'dm') return 'ignored';
    const meta = room.metadata as DmRoomMeta;
    if (meta.callerId === userId || room.participants.has(userId)) return 'ignored';
    meta.declinedUserIds.add(userId);
    if (meta.state !== 'ringing') return 'declined';
    const ringees = getDb().select({ userId: schema.dmMembers.userId })
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
      .all()
      .filter(m => m.userId !== meta.callerId);
    if (ringees.some(m => !meta.declinedUserIds.has(m.userId))) return 'declined';
    this.endDmRoom(dmChannelId, 'dm_call_rejected');
    return 'ended';
  }

  /**
   * Take every participant that `peerOrigin` relayed into the DM call
   * `dmChannelId` (`remoteParticipants`) out of it, as when that peer can no
   * longer tell us they left. Returns how many left and whether the call
   * ended because nobody is left. Local only: the caller relays the end.
   */
  leavePeerParticipants(dmChannelId: string, peerOrigin: string): { removed: number; ended: boolean } {
    const peerKey = normalizeOriginForCompare(peerOrigin);
    const room = this.voiceRooms.get(dmChannelId);
    if (peerKey === null || !room || room.roomType !== 'dm') return { removed: 0, ended: false };
    const meta = room.metadata as DmRoomMeta;
    let removed = 0;
    for (const [userId, origin] of Array.from(meta.remoteParticipants)) {
      if (normalizeOriginForCompare(origin) !== peerKey) continue;
      this.leaveRoom(dmChannelId, userId);
      removed += 1;
      if (this.afterDmCallLeave(dmChannelId, userId) === 'ended') return { removed, ended: true };
    }
    return { removed, ended: false };
  }

  /**
   * A peer stopped being active: the participants it relayed into calls
   * hosted here can no longer tell us they left, so they leave now. A call
   * left empty ends, and the end is relayed to the remaining peers in the
   * caller's name. Returns how many participants were removed.
   */
  dropRemoteCallParticipants(peerOrigin: string): number {
    let removed = 0;
    for (const [roomId, room] of Array.from(this.voiceRooms)) {
      if (room.roomType !== 'dm') continue;
      const callerId = (room.metadata as DmRoomMeta).callerId;
      const result = this.leavePeerParticipants(roomId, peerOrigin);
      removed += result.removed;
      if (result.ended) this.fanOutCallEnd(roomId, callerId);
    }
    return removed;
  }

  /** Transition a DM room from ringing → active. Returns false if not found or not ringing. */
  activateDmRoom(dmChannelId: string): boolean {
    const room = this.voiceRooms.get(dmChannelId);
    if (!room || room.roomType !== 'dm') return false;
    const meta = room.metadata as DmRoomMeta;
    if (meta.state !== 'ringing') return false;
    meta.state = 'active';

    // Clear ringing timeout
    const timeout = this.ringingTimeouts.get(dmChannelId);
    if (timeout) {
      clearTimeout(timeout);
      this.ringingTimeouts.delete(dmChannelId);
    }
    return true;
  }

  /** Register a federated call received via S2S. Adds 60s ringing timeout. */
  createFederatedCall(entry: FederatedCallEntry): void {
    this.federatedCalls.createFederatedCall(
      entry,
      (uid, event) => this.sendToUser(uid, event),
      (fedId) => revokeNativeVoiceSessions({ roomId: fedId }),
    );
  }

  /** Get a federated call entry by federatedId (primary lookup). */
  getFederatedCall(federatedId: string): FederatedCallEntry | undefined {
    return this.federatedCalls.getFederatedCall(federatedId);
  }

  /** Get a federated call entry by local dmChannelId (convenience reverse lookup). */
  getFederatedCallByDmChannel(dmChannelId: string): FederatedCallEntry | undefined {
    return this.federatedCalls.getFederatedCallByDmChannel(dmChannelId);
  }

  /** Transition a federated call from ringing → active. */
  activateFederatedCall(federatedId: string): boolean {
    return this.federatedCalls.activateFederatedCall(federatedId);
  }

  /** Remove a federated call entry and clear its timeout. */
  clearFederatedCall(federatedId: string): void {
    revokeNativeVoiceSessions({ roomId: federatedId });
    this.federatedCalls.clearFederatedCall(
      federatedId,
      (userId) => this.clearVoiceWs(userId),
      this.userToRoom,
    );
  }

  /**
   * Evict all FederatedCallEntry objects whose federatedCallHost matches the given peer origin.
   * Emits dm_call_undeliverable { phase: 'host_unreachable', terminal: true } to each entry's
   * ringedUserIds, then clears the entry (and its 60s ring timer if still armed).
   *
   * Idempotent: re-invocation with an already-evicted host returns 0.
   * Called from onPeerDeactivated (signal 1) and the 30s sentinel (signal 2 / backstop).
   */
  evictFederatedCallsForHost(
    peerOrigin: string,
    ctx: {
      reason: 'peer_transient_failure' | 'peer_rejected';
      peerLabel?: string;
    },
  ): number {
    return this.federatedCalls.evictFederatedCallsForHost(
      peerOrigin,
      ctx,
      (uid, event) => this.sendToUser(uid, event),
      (userId) => this.clearVoiceWs(userId),
      this.userToRoom,
      (fedId) => revokeNativeVoiceSessions({ roomId: fedId }),
    );
  }

  /** Late-bind a dmChannelId onto a Path B FederatedCallEntry. */
  lateBindFederatedCall(federatedId: string, dmChannelId: string): void {
    this.federatedCalls.lateBindFederatedCall(federatedId, dmChannelId);
  }

  /** Expose federated calls for ready payload assembly. */
  getAllFederatedCalls(): Map<string, FederatedCallEntry> {
    return this.federatedCalls.getAllFederatedCalls();
  }

  /** Add a user to a room. Enforces one-room-per-user invariant. Returns the room or null if room doesn't exist. */
  joinRoom(roomId: string, userId: string): VoiceRoom | null {
    const room = this.voiceRooms.get(roomId);
    if (!room) return null;

    // Enforce one-room-per-user invariant: silently remove from old room
    const currentRoomId = this.userToRoom.get(userId);
    if (currentRoomId && currentRoomId !== roomId) {
      revokeNativeVoiceSessions({ userId });
      const oldRoom = this.voiceRooms.get(currentRoomId);
      if (oldRoom) {
        oldRoom.participants.delete(userId);
        if (oldRoom.participants.size === 0 && oldRoom.roomType === 'space') {
          this.voiceRooms.delete(currentRoomId);
        }
      }
    }

    room.participants.add(userId);
    this.userToRoom.set(userId, roomId);
    return room;
  }

  /** Remove a user from a specific room. Returns the room or null if not found. */
  leaveRoom(roomId: string, userId: string): VoiceRoom | null {
    const room = this.voiceRooms.get(roomId);
    if (!room || !room.participants.has(userId)) return null;

    revokeNativeVoiceSessions({ userId, roomId });
    room.participants.delete(userId);
    this.userToRoom.delete(userId);

    if (room.roomType === 'space') {
      const meta = room.metadata as SpaceRoomMeta;
      this.clearSpaceVoiceState(meta.spaceId, userId);
    }

    // Auto-cleanup empty space rooms (they're lazy-created)
    if (room.participants.size === 0 && room.roomType === 'space') {
      this.voiceRooms.delete(roomId);
    }

    return room;
  }

  /** Leave whatever room the user is in. Returns { roomId, room } or null. */
  leaveCurrentRoom(userId: string): { roomId: string; room: VoiceRoom } | null {
    const roomId = this.userToRoom.get(userId);
    if (!roomId) return null;

    const room = this.leaveRoom(roomId, userId);
    if (!room) return null;

    return { roomId, room };
  }

  /** Destroy a room entirely. Returns displaced userIds. */
  destroyRoom(roomId: string): string[] {
    const room = this.voiceRooms.get(roomId);
    if (!room) return [];

    revokeNativeVoiceSessions({ roomId });
    const displaced: string[] = [];
    for (const userId of room.participants) {
      this.userToRoom.delete(userId);
      this.cancelVoiceDisconnect(userId);
      displaced.push(userId);
    }

    if (room.roomType === 'dm') {
      this.cancelVoiceDisconnect((room.metadata as DmRoomMeta).callerId);
    }

    this.voiceRooms.delete(roomId);

    // Clear ringing timeout if any
    const timeout = this.ringingTimeouts.get(roomId);
    if (timeout) {
      clearTimeout(timeout);
      this.ringingTimeouts.delete(roomId);
    }

    return displaced;
  }

  /** Get a room by ID. */
  getRoom(roomId: string): VoiceRoom | undefined {
    return this.voiceRooms.get(roomId);
  }

  /** Get participants in a room. */
  getRoomParticipants(roomId: string): Set<string> {
    return this.voiceRooms.get(roomId)?.participants ?? new Set();
  }

  /** Get the room a user is currently in. Returns { roomId, room } or null. */
  getUserRoom(userId: string): { roomId: string; room: VoiceRoom } | null {
    const roomId = this.userToRoom.get(userId);
    if (!roomId) return null;
    const room = this.voiceRooms.get(roomId);
    if (!room) return null;
    return { roomId, room };
  }

  /** Read-only access to all rooms. */
  getAllRooms(): Map<string, VoiceRoom> {
    return this.voiceRooms;
  }

  // ─── Voice User Status (unchanged) ────────────────────────────────────────

  setVoiceUserStatus(userId: string, isMuted: boolean, isDeafened: boolean, isCameraOn: boolean, isScreenSharing: boolean): void {
    this.voiceUserStates.set(userId, { isMuted, isDeafened, isCameraOn, isScreenSharing });
  }

  getVoiceUserStatus(userId: string): { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean } | undefined {
    return this.voiceUserStates.get(userId);
  }

  clearVoiceUserStatus(userId: string): void {
    this.voiceUserStates.delete(userId);
  }

  // ─── Voice WebSocket Binding ───────────────────────────────────────────────

  /** Store which ws owns the voice session for this user. */
  setVoiceWs(userId: string, ws: WebSocket): void {
    const previous = this.voiceWs.get(userId);
    if (previous && previous !== ws) revokeNativeVoiceSessions({ userId });
    this.cancelVoiceDisconnect(userId);
    this.voiceWs.set(userId, ws);
  }

  /** Get the voice-owning ws for this user. */
  getVoiceWs(userId: string): WebSocket | undefined {
    return this.voiceWs.get(userId);
  }

  /** Clear the voice ws binding for this user. */
  clearVoiceWs(userId: string): void {
    revokeNativeVoiceSessions({ userId });
    this.cancelVoiceDisconnect(userId);
    this.voiceWs.delete(userId);
  }

  setSpaceMuted(spaceId: string, userId: string, muted: boolean): void {
    this.voiceModeration.setSpaceMuted(spaceId, userId, muted);
  }

  isSpaceMuted(spaceId: string, userId: string): boolean {
    return this.voiceModeration.isSpaceMuted(spaceId, userId);
  }

  setSpaceDeafened(spaceId: string, userId: string, deafened: boolean): void {
    this.voiceModeration.setSpaceDeafened(spaceId, userId, deafened);
  }

  isSpaceDeafened(spaceId: string, userId: string): boolean {
    return this.voiceModeration.isSpaceDeafened(spaceId, userId);
  }

  clearSpaceVoiceState(spaceId: string, userId: string): void {
    this.voiceModeration.clearSpaceVoiceState(spaceId, userId);
  }

  setPermissionMuted(spaceId: string, userId: string, muted: boolean): void {
    this.voiceModeration.setPermissionMuted(spaceId, userId, muted);
  }

  isPermissionMuted(spaceId: string, userId: string): boolean {
    return this.voiceModeration.isPermissionMuted(spaceId, userId);
  }

  getAllVoiceUserStates(): Map<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }> {
    return this.voiceUserStates;
  }

  // ─── Broadcasting ─────────────────────────────────────────────────────────

  /** Send to a specific user (all their connections). */
  sendToUser(userId: string, event: ServerEvent): void {
    this.broadcaster.sendToUser(userId, event);
  }

  /** Send to all members of a space. */
  sendToSpace(spaceId: string, event: ServerEvent, excludeUserId?: string): void {
    this.broadcaster.sendToSpace(spaceId, event, excludeUserId);
  }

  /** Send to space members who have VIEW_CHANNEL on the given channel. */
  sendToChannel(spaceId: string, channelId: string, event: ServerEvent, excludeUserId?: string): void {
    this.broadcaster.sendToChannel(spaceId, channelId, event, excludeUserId);
  }

  /** Expose userSpaces iterator for pre-delete viewer collection. */
  getUserSpaceEntries(): IterableIterator<[string, Set<string>]> {
    return this.userSpaces.entries();
  }

  /** Send to all DM channel members (queries dm_members table). */
  sendToDmMembers(dmChannelId: string, event: ServerEvent, excludeUserId?: string): void {
    this.broadcaster.sendToDmMembers(dmChannelId, event, excludeUserId);
  }

  /**
   * Send event to users who were ringed for a federated call.
   * ALWAYS uses ringedUserIds, never sendToDmMembers.
   */
  sendToFederatedCallUsers(federatedId: string, event: ServerEvent, excludeUserId?: string): void {
    this.broadcaster.sendToFederatedCallUsers(federatedId, event, excludeUserId);
  }

  /** Send to a room — routes to sendToSpace (space rooms) or sendToDmMembers (DM rooms). */
  sendToRoom(roomId: string, event: ServerEvent, excludeUserId?: string): void {
    this.broadcaster.sendToRoom(roomId, event, excludeUserId);
  }

  /** Send to all connections of all online users. */
  sendToAll(event: ServerEvent, excludeUserId?: string): void {
    this.broadcaster.sendToAll(event, excludeUserId);
  }

  /** Send to a specific WebSocket instance (not all of a user's connections). */
  sendToWs(ws: WebSocket, event: ServerEvent): void {
    this.broadcaster.sendToWs(ws, event);
  }

  /** Force-disconnect all WebSocket connections for a user (e.g. account deletion). */
  forceDisconnectUser(userId: string): void {
    // Cancel any pending offline timeout
    const timeout = this.pendingOfflineTimeouts.get(userId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingOfflineTimeouts.delete(userId);
    }

    // Leave the voice room they are in. This is a leave like any other: a
    // DM call it empties ends, and the end reaches the peers. A call hosted
    // on a peer that they joined through here is left as if they hung up.
    this.clearVoiceUserStatus(userId);
    this.clearVoiceWs(userId);
    this.leaveCurrentRoomAnnounced(userId);
    if (this.getJoinedFederatedCall(userId)) this.leaveFederatedCall(userId);

    // End any ringing DM rooms where this user is the caller
    for (const [roomId, room] of this.voiceRooms) {
      if (room.roomType === 'dm') {
        const meta = room.metadata as DmRoomMeta;
        if (meta.state === 'ringing' && meta.callerId === userId) {
          this.endDmRoom(roomId, 'dm_call_ended');
          this.fanOutCallEnd(roomId, userId);
        }
      }
    }

    // Clear activity state
    this.activityTracker.clearUser(userId);

    // Close all WebSocket connections
    const connections = this.connections.get(userId);
    if (connections) {
      for (const ws of connections) {
        this.wsToUser.delete(ws);
        try { ws.close(4001, 'Account deleted'); } catch { /* ignore */ }
      }
      this.connections.delete(userId);
    }

    // Clean up user spaces
    this.userSpaces.delete(userId);
  }

  getAllOnlineUserIds(): string[] { return Array.from(this.connections.keys()); }
  getAllConnections(): Map<string, Set<WebSocket>> { return this.connections; }
  sendToAdmins(event: ServerEvent): void { this.broadcaster.sendToAdmins(event); }
  pushReadyPayload(userId: string): void {
    pushReadyPayloadToConnections(userId, this.getUserConnections(userId));
  }
}

export const connectionManager = new ConnectionManager();
attachReplicaSessionHost(connectionManager);
