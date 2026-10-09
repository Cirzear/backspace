import { callRelayActor, fanOutCallEvent, relayCallEvent, userRelayIdentity, type CallRelayEventType } from '../utils/callFanout.js';
import type { RelayActor } from '../routes/federation/identity.js';
import type { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { connectionManager } from './handler.js';
import type { DmRoomMeta, FederatedCallEntry, SpaceRoomMeta, VoiceRoom } from './voiceRoomTypes.js';
import { isDmMember } from '../utils/permissions.js';
import { reopenForClosedMembers } from '../routes/dm.js';
import { type ServerEvent, type DmCallUndeliverableFailure, type DmCallUndeliverableReason } from '@backspace/shared';
import type { ErrorCode } from '@backspace/shared/src/errors';
import type { CallRelayResult, CallFanoutFailure } from '../utils/federationOutbox.js';
import { mapCallReasonToEventReason } from '../utils/federationOutbox.js';
import { sendCallRelay } from '../utils/federationOutbox.js';
import { canonicalizeHomeInstance, getOurOrigin, normalizeOriginForCompare } from '../utils/federationAuth.js';
import { generateFederatedCallToken } from '../routes/livekit.js';
import { config } from '../config.js';
import { ERROR_MESSAGES } from '../utils/httpErrors.js';

// ─── DM Call Handlers (Unified Room API) ───────────────────────────────────

/** Helper: broadcast a voice leave and end a DM call its last participant left. */
export function broadcastRoomLeave(roomId: string, room: VoiceRoom, userId: string): void {
  if (room.roomType === 'space') {
    const meta = room.metadata as SpaceRoomMeta;
    connectionManager.sendToSpace(meta.spaceId, {
      type: 'voice_state_update',
      channelId: roomId,
      userId,
      action: 'leave',
    });
  } else if (connectionManager.afterDmCallLeave(roomId, userId) === 'ended') {
    sendFederatedCallEnd(roomId, [userId, (room.metadata as DmRoomMeta).callerId]).catch(err =>
      console.error('[federation] sendFederatedCallEnd (last participant left) error:', err),
    );
  }
}

/**
 * Refuse a `dm_call_start` or `dm_call_accept` on the socket that sent it.
 * Only that socket set a calling or joined state, and another session of the
 * same user may be the one in a call in this DM, so the refusal is not sent
 * to the user's other sessions. `dmChannelId` tells the client which call
 * state to drop.
 */
function refuseDmCall(ws: WebSocket, code: ErrorCode, dmChannelId?: string): void {
  connectionManager.sendToWs(ws, { type: 'error', message: ERROR_MESSAGES[code], code, dmChannelId });
}

/**
 * `userId` joins the call hosted here for `dmChannelId`. The first join turns
 * a ringing call active and seats its caller; any later one is a late join,
 * which every call allows (voice.md, "DM Call State Machine").
 */
async function joinHostedDmCall(dmChannelId: string, userId: string, ws: WebSocket): Promise<void> {
  const room = connectionManager.getRoom(dmChannelId);
  if (!room || room.roomType !== 'dm') return;
  const meta = room.metadata as DmRoomMeta;

  if (meta.state === 'ringing') {
    connectionManager.activateDmRoom(dmChannelId);
    const callerLeft = connectionManager.leaveCurrentRoom(meta.callerId);
    if (callerLeft) broadcastRoomLeave(callerLeft.roomId, callerLeft.room, meta.callerId);
    connectionManager.joinRoom(dmChannelId, meta.callerId);
    connectionManager.sendToDmMembers(dmChannelId, {
      type: 'voice_state_update',
      channelId: dmChannelId,
      userId: meta.callerId,
      action: 'join',
    });
  }

  // Leave the room the user is in, unless it is this call: a session taking
  // the call over from another session of the same user must not empty, and
  // so end, the call it is joining.
  if (connectionManager.getUserRoom(userId)?.roomId !== dmChannelId) {
    const acceptorLeft = connectionManager.leaveCurrentRoom(userId);
    if (acceptorLeft) broadcastRoomLeave(acceptorLeft.roomId, acceptorLeft.room, userId);
  }
  leaveJoinedFederatedCall(userId);
  meta.declinedUserIds.delete(userId);
  connectionManager.joinRoom(dmChannelId, userId);
  connectionManager.setVoiceWs(userId, ws);
  // Look up federatedId for the broadcast so all clients (including remote) can match
  const fedIdRow = getDb().select({ federatedId: schema.dmChannels.federatedId })
    .from(schema.dmChannels).where(eq(schema.dmChannels.id, dmChannelId)).get();
  // Who answered, so only their own other sessions stop ringing: in a group
  // call the other members are still free to answer.
  const answeredBy = userRelayIdentity(userId, getDb());
  connectionManager.sendToDmMembers(dmChannelId, {
    type: 'dm_call_accepted',
    dmChannelId,
    federatedCallId: fedIdRow?.federatedId ?? undefined,
    ...(answeredBy ? { answeredBy } : {}),
  } as ServerEvent);
  connectionManager.sendToDmMembers(dmChannelId, {
    type: 'voice_state_update',
    channelId: dmChannelId,
    userId,
    action: 'join',
  });
  const acceptFanoutFailures = await sendFederatedCallAccept(dmChannelId, [userId, meta.callerId], answeredBy);
  emitFanoutUndeliverable(
    userId,
    dmChannelId,
    fedIdRow?.federatedId ?? null,
    'accept',
    acceptFanoutFailures,
  );
}

/**
 * Relay a member's accept, decline or hang-up of a call hosted on a peer to
 * its host, in that member's name. A group call (`FederatedCallEntry.group`)
 * carries `perMember`: this instance applies the group rules and keeps the
 * call for its other members, and it tells the host when this member leaves
 * (voice.md, "Group calls across instances").
 */
function relayToCallHost(
  fedCall: FederatedCallEntry,
  userId: string,
  eventType: CallRelayEventType,
  answeredBy: RelayActor | null = null,
): Promise<CallRelayResult> {
  return relayCallEvent(fedCall.federatedCallHost, eventType, fedCall.federatedId, [userId], { perMember: fedCall.group, answeredBy });
}

/**
 * `userId` leaves the call hosted on a peer that they joined through this
 * instance, without a hang-up of their own: their voice session was lost
 * past its reconnect grace, they joined other voice or another call, or their
 * account is going. In a group call this is their hang-up: they leave the
 * entry, and the host hears it (`perMember`) and ends the call with its last
 * participant. Any other entry keeps the rules a host up to 1.8.0 applies,
 * where an end from one member ends the call for everyone: the member only
 * leaves the entry here, and nothing is relayed.
 */
export function leaveJoinedFederatedCall(userId: string): void {
  const fedCall = connectionManager.getJoinedFederatedCall(userId);
  if (!fedCall) return;
  connectionManager.leaveFederatedCallEntry(fedCall.federatedId, userId);
  if (!fedCall.group) return;
  fedCall.ringedUserIds = fedCall.ringedUserIds.filter(id => id !== userId);
  const host = fedCall.federatedCallHost;
  relayToCallHost(fedCall, userId, 'dm_call_end')
    .then(result => {
      if (!result.ok) console.error('[federation] dm_call_end relay (member left) to %s failed (%s): %s', host, result.reason, result.error);
    })
    .catch(err => console.error('[federation] dm_call_end relay (member left) threw:', err));
}

/**
 * Whether the call hosted on a peer for a DM is still live, so a start in
 * that DM must be refused. It is while it rings (the host's end or the 60 s
 * ring timeout ends that), and while a member here is in it. The starter's
 * own place in it counts only while another of their sessions holds it: the
 * socket that starts a call holds none (the client starts one only then),
 * and a place no voice session holds any more is gone, so they leave it
 * first. Anything else is a record the host's end never replaced (a host up
 * to 1.8.0 ends some calls without telling its peers, and a relay can be
 * lost). Nobody here is in that call, so it does not block the DM.
 */
function federatedCallStillLive(fedCall: FederatedCallEntry, userId: string, ws: WebSocket): boolean {
  if (fedCall.joinedUserIds.includes(userId)) {
    const session = connectionManager.getVoiceWs(userId);
    if (session === undefined || session === ws) leaveJoinedFederatedCall(userId);
  }
  return fedCall.state === 'ringing' || fedCall.joinedUserIds.length > 0;
}

export async function handleDmCallStart(event: Record<string, unknown>, userId: string, username: string, ws: WebSocket): Promise<void> {
  const dmChannelId = event.dmChannelId;
  if (!dmChannelId || typeof dmChannelId !== 'string') {
    refuseDmCall(ws, 'validation_failed');
    return;
  }

  if (!isDmMember(dmChannelId, userId)) {
    refuseDmCall(ws, 'not_dm_member', dmChannelId);
    return;
  }

  // The DM already has a call hosted here. A member who is not in it joins
  // it, as if they had accepted the ring; one who is already in it (as a
  // participant, or as the caller of a call still ringing) has nothing to
  // start.
  const existing = connectionManager.getRoom(dmChannelId);
  if (existing && existing.roomType === 'dm') {
    const meta = existing.metadata as DmRoomMeta;
    if (existing.participants.has(userId) || (meta.state === 'ringing' && meta.callerId === userId)) {
      refuseDmCall(ws, 'dm_call_in_progress', dmChannelId);
      return;
    }
    await joinHostedDmCall(dmChannelId, userId, ws);
    return;
  }

  // The DM has a call hosted on another instance. While that call is live a
  // second call here would split the conversation across two rooms, and the
  // host minted its room tokens when the call started, so there is nothing
  // to join it with: the start is refused. A record of a call that is no
  // longer live must not block the DM, so it is dropped and the start goes
  // on (`federatedCallStillLive`).
  const fedCall = connectionManager.getFederatedCallByDmChannel(dmChannelId);
  if (fedCall) {
    if (federatedCallStillLive(fedCall, userId, ws)) {
      refuseDmCall(ws, 'dm_call_in_progress', dmChannelId);
      return;
    }
    connectionManager.clearFederatedCall(fedCall.federatedId);
  }

  // Leave current room if in one, and any call hosted on a peer
  const left = connectionManager.leaveCurrentRoom(userId);
  if (left) {
    broadcastRoomLeave(left.roomId, left.room, userId);
  }
  leaveJoinedFederatedCall(userId);
  connectionManager.clearVoiceUserStatus(userId);

  // A call this user still rings elsewhere ends: one call at a time. Its
  // end reaches the peers too, whose members are still ringing.
  connectionManager.endRingingCallsPlacedBy(userId, dmChannelId);

  // Create DM room in ringing state. No room exists for this DM (checked
  // above), so this only fails on a concurrent start.
  const created = connectionManager.createDmRoom(dmChannelId, userId);
  if (!created) {
    refuseDmCall(ws, 'dm_call_in_progress', dmChannelId);
    return;
  }

  // Bind voice session to this socket so removeConnection can clean up
  // if the caller closes the tab while the call is ringing
  connectionManager.setVoiceWs(userId, ws);

  // A member who has the conversation closed (a new 1-on-1's recipient before
  // its first message, #360) gets it back first, so the call has a
  // conversation to open in and survives a reconnect.
  reopenForClosedMembers(dmChannelId);

  // Ring other members
  connectionManager.sendToDmMembers(dmChannelId, {
    type: 'dm_call_incoming',
    dmChannelId,
    callerId: userId,
    callerName: username,
  }, userId);

  // Federation: notify remote instances (fire-and-forget)
  sendFederatedCallStart(dmChannelId, userId, username)
    .catch(err => console.error('[federation] sendFederatedCallStart error:', err));
}

export async function handleDmCallAccept(event: Record<string, unknown>, userId: string, ws: WebSocket): Promise<void> {
  let dmChannelId = (event.dmChannelId as string) || null;
  const federatedCallId = (event.federatedCallId as string) || null;
  if (!dmChannelId && !federatedCallId) {
    refuseDmCall(ws, 'validation_failed');
    return;
  }

  // Resolve federatedCallId → dmChannelId when only federatedCallId is provided.
  // This happens when a remote instance accepts via callOrigin and the DM doesn't
  // exist there (Path B), but the HOST has the VoiceRoom keyed by dmChannelId.
  if (!dmChannelId && federatedCallId) {
    const db = getDb();
    const ch = db.select({ id: schema.dmChannels.id })
      .from(schema.dmChannels)
      .where(eq(schema.dmChannels.federatedId, federatedCallId))
      .get();
    if (ch) {
      dmChannelId = ch.id;
    }
  }

  // Path 1: Local room (we're the host) — only possible with dmChannelId
  if (dmChannelId) {
    if (!isDmMember(dmChannelId, userId)) {
      refuseDmCall(ws, 'not_dm_member', (event.dmChannelId as string) || federatedCallId || undefined);
      return;
    }

    const room = connectionManager.getRoom(dmChannelId);
    if (room && room.roomType === 'dm') {
      await joinHostedDmCall(dmChannelId, userId, ws);
      return;
    }
  }

  // Path 2: Federated call (we're a remote instance)
  const fedCall = federatedCallId
    ? connectionManager.getFederatedCall(federatedCallId)
    : dmChannelId
      ? connectionManager.getFederatedCallByDmChannel(dmChannelId)
      : undefined;

  if (fedCall) {
    // The member is in one call at a time: whatever voice they hold here, or
    // another call hosted on a peer, they leave first.
    connectionManager.leaveCurrentRoomAnnounced(userId);
    const otherCall = connectionManager.getJoinedFederatedCall(userId);
    if (otherCall && otherCall.federatedId !== fedCall.federatedId) connectionManager.leaveFederatedCall(userId);

    // Optimistic transition so the acceptor's client flips to active immediately.
    // Rolled back below if the relay to host fails.
    connectionManager.activateFederatedCall(fedCall.federatedId);
    if (!fedCall.joinedUserIds.includes(userId)) fedCall.joinedUserIds.push(userId);
    // Voice binding tied to the socket accepting the call: in a group call
    // the only leave the host hears of when the tab closes or the network
    // goes.
    connectionManager.setVoiceWs(userId, ws);
    const db = getDb();
    const answeredBy = userRelayIdentity(userId, db);
    connectionManager.sendToFederatedCallUsers(fedCall.federatedId, {
      type: 'dm_call_accepted',
      dmChannelId: fedCall.dmChannelId,
      federatedCallId: fedCall.federatedId,
      ...(answeredBy ? { answeredBy } : {}),
    } as ServerEvent);

    const result = await relayToCallHost(fedCall, userId, 'dm_call_accept', answeredBy);

    if (!result.ok) {
      console.error('[federation] dm_call_accept relay to %s failed (%s): %s', fedCall.federatedCallHost, result.reason, result.error);
      const failure = buildFailureFromResult(result, fedCall.federatedCallHost, db);
      // Clear first so a concurrent end-handler sees a cleared entry (idempotent).
      connectionManager.clearFederatedCall(fedCall.federatedId);
      // Terminal targets ONLY the acceptor — other ringed users (group DM) didn't
      // accept and should stay in their ring state; their own dm_call_end / timeout
      // paths govern their teardown.
      connectionManager.sendToUser(userId, {
        type: 'dm_call_undeliverable',
        dmChannelId: fedCall.dmChannelId,
        federatedCallId: fedCall.federatedId,
        terminal: true,
        phase: 'accept',
        failures: [failure],
      });
    }
    return;
  }

  // The call ended before this accept arrived. The client already joined it
  // on its side, so it is told which call to drop, by the id it sent.
  refuseDmCall(ws, 'dm_call_not_found', (event.dmChannelId as string) || federatedCallId || undefined);
}

export async function handleDmCallReject(event: Record<string, unknown>, userId: string): Promise<void> {
  let dmChannelId = (event.dmChannelId as string) || null;
  const federatedCallId = (event.federatedCallId as string) || null;

  if (!dmChannelId && !federatedCallId) return;

  // Resolve federatedCallId → dmChannelId for host VoiceRoom lookup
  if (!dmChannelId && federatedCallId) {
    const db = getDb();
    const ch = db.select({ id: schema.dmChannels.id })
      .from(schema.dmChannels)
      .where(eq(schema.dmChannels.federatedId, federatedCallId))
      .get();
    if (ch) dmChannelId = ch.id;
  }

  // Path 1: Local room (we're the host)
  if (dmChannelId) {
    if (!isDmMember(dmChannelId, userId)) return;

    const room = connectionManager.getRoom(dmChannelId);
    if (room && room.roomType === 'dm') {
      const meta = room.metadata as DmRoomMeta;
      if (meta.group) {
        // A group decline stops only the decliner's ring (all their
        // sessions). The call ends only when nobody is left to answer it.
        const outcome = connectionManager.declineGroupDmCall(dmChannelId, userId);
        if (outcome === 'declined') {
          connectionManager.sendToUser(userId, { type: 'dm_call_rejected', dmChannelId });
        }
        if (outcome !== 'ended') return;
      } else {
        connectionManager.endDmRoom(dmChannelId, 'dm_call_rejected');
      }
      const fedIdRejectRow = getDb().select({ federatedId: schema.dmChannels.federatedId })
        .from(schema.dmChannels).where(eq(schema.dmChannels.id, dmChannelId)).get();
      const rejectFanoutFailures = await sendFederatedCallEnd(dmChannelId, [userId, meta.callerId]);
      emitFanoutUndeliverable(
        userId,
        dmChannelId,
        fedIdRejectRow?.federatedId ?? null,
        'reject',
        rejectFanoutFailures,
      );
      return;
    }
  }

  // Path 2: Federated call
  const fedCall = federatedCallId
    ? connectionManager.getFederatedCall(federatedCallId)
    : dmChannelId
      ? connectionManager.getFederatedCallByDmChannel(dmChannelId)
      : undefined;

  if (fedCall) {
    const host = fedCall.federatedCallHost;
    const fedId = fedCall.federatedId;
    const dmId = fedCall.dmChannelId;
    if (fedCall.group) {
      // A member in the call cannot decline it. Anyone else stops ringing
      // on all their sessions; the call goes on for the others here, and
      // the host decides whether anyone is left to answer.
      if (fedCall.joinedUserIds.includes(userId)) return;
      fedCall.ringedUserIds = fedCall.ringedUserIds.filter(id => id !== userId);
      connectionManager.sendToUser(userId, {
        type: 'dm_call_rejected',
        dmChannelId: dmId,
        federatedCallId: fedId,
      } as ServerEvent);
    } else {
      // Optimistic local clear: the user means to reject.
      connectionManager.sendToFederatedCallUsers(fedId, {
        type: 'dm_call_rejected',
        dmChannelId: dmId,
        federatedCallId: fedId,
      } as ServerEvent, userId);
      connectionManager.clearFederatedCall(fedId);
    }

    const db = getDb();
    const result = await relayToCallHost(fedCall, userId, 'dm_call_reject');

    if (!result.ok) {
      console.error('[federation] dm_call_reject relay to %s failed (%s): %s', host, result.reason, result.error);
      const failure = buildFailureFromResult(result, host, db);
      connectionManager.sendToUser(userId, {
        type: 'dm_call_undeliverable',
        dmChannelId: dmId,
        federatedCallId: fedId,
        terminal: false,
        phase: 'reject',
        failures: [failure],
      });
    }
  }
}

export async function handleDmCallEnd(event: Record<string, unknown>, userId: string): Promise<void> {
  let dmChannelId = (event.dmChannelId as string) || null;
  const federatedCallId = (event.federatedCallId as string) || null;

  if (!dmChannelId && !federatedCallId) return;

  // Resolve federatedCallId → dmChannelId for host VoiceRoom lookup
  if (!dmChannelId && federatedCallId) {
    const db = getDb();
    const ch = db.select({ id: schema.dmChannels.id })
      .from(schema.dmChannels)
      .where(eq(schema.dmChannels.federatedId, federatedCallId))
      .get();
    if (ch) dmChannelId = ch.id;
  }

  // Path 1: Local room (we're the host)
  if (dmChannelId) {
    if (!isDmMember(dmChannelId, userId)) return;

    const room = connectionManager.getRoom(dmChannelId);
    if (room && room.roomType === 'dm') {
      const meta = room.metadata as DmRoomMeta;
      if (meta.group) {
        // Hanging up or cancelling takes only the sender out of a group
        // call; it ends with the last one out. A member who is not in the
        // call changes nothing.
        if (connectionManager.leaveGroupDmCall(dmChannelId, userId) !== 'ended') return;
      } else {
        connectionManager.endDmRoom(dmChannelId, 'dm_call_ended');
      }
      const fedIdEndRow = getDb().select({ federatedId: schema.dmChannels.federatedId })
        .from(schema.dmChannels).where(eq(schema.dmChannels.id, dmChannelId)).get();
      const endFanoutFailures = await sendFederatedCallEnd(dmChannelId, [userId, meta.callerId]);
      emitFanoutUndeliverable(
        userId,
        dmChannelId,
        fedIdEndRow?.federatedId ?? null,
        'end',
        endFanoutFailures,
      );
      return;
    }
  }

  // Path 2: Federated call
  const fedCall = federatedCallId
    ? connectionManager.getFederatedCall(federatedCallId)
    : dmChannelId
      ? connectionManager.getFederatedCallByDmChannel(dmChannelId)
      : undefined;

  if (fedCall) {
    const host = fedCall.federatedCallHost;
    const fedId = fedCall.federatedId;
    const dmId = fedCall.dmChannelId;
    if (fedCall.group) {
      // Only a member in the call can leave it, and the others here stay
      // in. The host ends the call when its last participant is gone and
      // tells us with a dm_call_end of its own.
      if (!fedCall.joinedUserIds.includes(userId)) return;
      fedCall.ringedUserIds = fedCall.ringedUserIds.filter(id => id !== userId);
      if (!connectionManager.getUserRoom(userId)) connectionManager.clearVoiceWs(userId);
      connectionManager.leaveFederatedCallEntry(fedId, userId);
    } else {
      // Exclude the user who ended the call: they already disconnected client-side.
      connectionManager.sendToFederatedCallUsers(fedId, {
        type: 'dm_call_ended',
        dmChannelId: dmId,
        federatedCallId: fedId,
      } as ServerEvent, userId);
      connectionManager.clearFederatedCall(fedId);
    }

    const db = getDb();
    const result = await relayToCallHost(fedCall, userId, 'dm_call_end');

    if (!result.ok) {
      console.error('[federation] dm_call_end relay to %s failed (%s): %s', host, result.reason, result.error);
      const failure = buildFailureFromResult(result, host, db);
      connectionManager.sendToUser(userId, {
        type: 'dm_call_undeliverable',
        dmChannelId: dmId,
        federatedCallId: fedId,
        terminal: false,
        phase: 'end',
        failures: [failure],
      });
    }
  }
}

/**
 * Send S2S dm_call_start to all remote instances with DM members.
 * Fire-and-forget per relay, but aggregates per-peer results to surface
 * undeliverable calls via `dm_call_undeliverable` to the caller.
 */
async function sendFederatedCallStart(
  dmChannelId: string,
  callerId: string,
  callerName: string,
): Promise<void> {
  const db = getDb();
  const ourOrigin = getOurOrigin();

  // The conversation key names the call on every instance. Call start reads
  // it and never computes or mints one (ADR 0002): every 1-on-1 is keyed at
  // insert, and a group without a key has no copy on any peer, so a row
  // without one is not announced.
  const channel = db.select({ federatedId: schema.dmChannels.federatedId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();

  if (!channel?.federatedId) return;
  const federatedId = channel.federatedId;

  // Get all DM members with their user records
  const members = db.select({
    userId: schema.dmMembers.userId,
    homeUserId: schema.users.homeUserId,
    homeInstance: schema.users.homeInstance,
    username: schema.users.username,
    displayName: schema.users.displayName,
  })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  // Classify members relative to this instance. `homeInstance` is stored in two
  // shapes (bare host and full URL), so every comparison goes through
  // normalizeOriginForCompare; the peer-facing origin is canonicalized. The
  // caller is never rung, so a caller homed elsewhere (a federated account
  // here) is not a recipient: their home gets no token for them.
  const ourOriginKey = normalizeOriginForCompare(ourOrigin);
  const remoteMembers = members.filter(m => {
    if (m.userId === callerId) return false;
    const key = normalizeOriginForCompare(m.homeInstance);
    return key !== null && key !== ourOriginKey;
  });

  // A call with no member homed elsewhere has no federated recipient. Relaying
  // it anyway would hand every peered instance the call's existence, its
  // participant roster and room credentials for a conversation none of them
  // hosts a party to.
  if (remoteMembers.length === 0) return;

  const localNonCallerMembers = members.filter(m => {
    if (m.userId === callerId) return false;
    return (normalizeOriginForCompare(m.homeInstance) ?? ourOriginKey) === ourOriginKey;
  });
  const hasConnectedLocalRingee = localNonCallerMembers.some(m =>
    connectionManager.isUserOnline(m.userId),
  );

  // ─── LiveKit pre-flight ────────────────────────────────────────────────────
  // Reached only with at least one remote member, so a missing key is fatal here.
  if (!config.livekit.apiKey || !config.livekit.apiSecret) {
    console.warn('[federation] Cannot start federated call: LiveKit not configured');
    emitUndeliverableAndMaybeDestroy({
      callerId,
      dmChannelId,
      federatedId,
      terminal: !hasConnectedLocalRingee,
      failures: [{ reason: 'livekit_unavailable' }],
    });
    return;
  }

  // Use the configured LiveKit URL (wss://domain/livekit from .env).
  // Previously this was `https://${config.domain}/livekit` which fails because
  // the LiveKit SDK requires a wss:// WebSocket URL, not https://.
  const livekitUrl = config.livekit.url ?? `wss://${config.domain}/livekit`;

  // Build participants array (all member identities for Path B)
  const participants = members.map(m => ({
    homeUserId: m.homeUserId || m.userId,
    homeInstance: m.homeInstance || ourOrigin,
    displayName: m.displayName || m.username,
  }));

  // A group call follows the group rules here, and the peers holding its
  // entry are told so (`perMember`, voice.md "Group calls across instances").
  const room = connectionManager.getRoom(dmChannelId);
  const perMember = room?.roomType === 'dm' && (room.metadata as DmRoomMeta).group;

  // Group remote members by the instance that homes them. Each bucket is the
  // exact set of identities its peer is entitled to act for.
  const targetedPeers = new Map<string, typeof members>();
  for (const m of remoteMembers) {
    const origin = canonicalizeHomeInstance(m.homeInstance);
    if (!origin) continue;
    const bucket = targetedPeers.get(origin) ?? [];
    bucket.push(m);
    targetedPeers.set(origin, bucket);
  }

  /**
   * Build the `dm_call_start` payload for one recipient peer.
   *
   * A LiveKit token is a bearer credential: it grants `roomJoin` + `canPublish`
   * on the call room to whoever holds it, under the identity it was minted for.
   * So a peer is only ever handed tokens for the members it actually homes —
   * never the caller's (both inbound paths skip the caller), never a local
   * member's, never another peer's. Keying the map per recipient also removes
   * the cross-instance `homeUserId` ambiguity of a single shared map.
   *
   * `participants` is the non-secret roster and stays complete: the recipient
   * needs it for Path B identity matching when the DM has no local row yet.
   */
  const buildRelayEvent = async (recipients: typeof members, caller: RelayActor) => {
    // `tokens` (by home user id) is for receivers that predate `memberTokens`,
    // which names each holder with its home instance (FederationCallPayload).
    const tokens: Record<string, string> = {};
    const memberTokens: Array<{ homeUserId: string; homeInstance: string; token: string }> = [];
    for (const m of recipients) {
      const homeUserId = m.homeUserId || m.userId;
      const name = m.displayName || m.username;
      const token = await generateFederatedCallToken(federatedId, homeUserId, name);
      tokens[homeUserId] = token;
      const homeInstance = canonicalizeHomeInstance(m.homeInstance);
      if (homeInstance) memberTokens.push({ homeUserId, homeInstance, token });
    }
    return {
      eventType: 'dm_call_start' as const,
      messageId: generateSnowflake(),
      encryptionVersion: 0 as const,
      timestamp: Date.now(),
      federatedId,
      call: {
        livekitUrl,
        tokens,
        memberTokens,
        caller: {
          homeUserId: caller.homeUserId,
          homeInstance: caller.homeInstance,
          displayName: callerName,
        },
        participants,
        ...(perMember ? { perMember: true } : {}),
      },
    };
  };

  // Peer labels for the undeliverable surface.
  const peerRows = db.select({
    origin: schema.federationPeers.origin,
    instanceName: schema.federationPeers.instanceName,
  })
    .from(schema.federationPeers)
    .all();

  const peerLabelByOrigin = new Map<string, string>();
  for (const row of peerRows) {
    if (row.instanceName) peerLabelByOrigin.set(row.origin, row.instanceName);
  }

  // ─── Targeted relay: fan out in parallel, await results ────────────────────
  // Each peer's result has FOUR possible classifications:
  //   no name the peer accepts for the caller  → identity_not_accepted, not sent
  //   ok=true, messageId NOT in undeliverable → delivered
  //   ok=true, messageId IN undeliverable     → new: no_recipient failure (#18)
  //   ok=false                                → existing failure reasons
  const targetedResults = await Promise.all(
    Array.from(targetedPeers.entries()).map(async ([peerOrigin, recipients]) => {
      // The caller is named as every call relay names its actor
      // (`callRelayActor`): by their own identity, which a peer accepts from
      // here only when they are homed here or on that peer. A federated
      // account here whose home is a third instance cannot be named to this
      // peer at all, so its members cannot be rung through this instance.
      const caller = callRelayActor(peerOrigin, [callerId], db);
      if (!caller) {
        console.warn('[federation] dm_call_start to %s not sent: the peer accepts no name for the caller from this instance', peerOrigin);
        return {
          origin: peerOrigin,
          ok: false as const,
          reason: 'identity_not_accepted' as const satisfies DmCallUndeliverableReason,
          error: 'caller not accepted by the peer',
        };
      }
      const relayEvent = await buildRelayEvent(recipients, caller);
      const result = await sendCallRelay(peerOrigin, [relayEvent]);
      if (result.ok) {
        if (result.undeliverable.includes(relayEvent.messageId)) {
          console.warn(`[federation] dm_call_start to ${peerOrigin}: remote had no recipient`);
          return {
            origin: peerOrigin,
            ok: false as const,
            reason: 'no_recipient' as const satisfies DmCallUndeliverableReason,
            error: 'remote reported no_recipient',
          };
        }
        return { origin: peerOrigin, ok: true as const };
      }
      const reason = mapCallReasonToEventReason(result.reason);
      console.error(`[federation] dm_call_start to ${peerOrigin} failed (${result.reason}): ${result.error}`);
      return { origin: peerOrigin, ok: false as const, reason, error: result.error };
    }),
  );

  // ─── Aggregate failures → dm_call_undeliverable ───────────────────────────
  const failedTargeted = targetedResults.filter(
    (r): r is Extract<typeof r, { ok: false }> => !r.ok,
  );
  if (failedTargeted.length === 0) return;

  const anyTargetedSuccess = targetedResults.some(r => r.ok);
  const plausibleRecipientRemains = anyTargetedSuccess || hasConnectedLocalRingee;

  const failures: DmCallUndeliverableFailure[] = failedTargeted.map(r => {
    const affectedUserIds = (targetedPeers.get(r.origin) ?? []).map(m => m.userId);
    return {
      reason: r.reason,
      peerOrigin: r.origin,
      peerLabel: peerLabelByOrigin.get(r.origin),
      affectedUserIds,
    };
  });

  emitUndeliverableAndMaybeDestroy({
    callerId,
    dmChannelId,
    federatedId,
    terminal: !plausibleRecipientRemains,
    failures,
  });
}

/** Build a DmCallUndeliverableFailure from a failed CallRelayResult, enriching with peer label. */
function buildFailureFromResult(
  result: Extract<CallRelayResult, { ok: false }>,
  peerOrigin: string,
  db: ReturnType<typeof getDb>,
): DmCallUndeliverableFailure {
  const label = db.select({ instanceName: schema.federationPeers.instanceName })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, peerOrigin))
    .get()?.instanceName;
  return {
    reason: mapCallReasonToEventReason(result.reason),
    peerOrigin,
    peerLabel: label ?? undefined,
  };
}


/**
 * Emit dm_call_undeliverable to the caller. If terminal, also destroy the
 * local ring room (which clears the ringing timer and voice WS binding)
 * and broadcast dm_call_ended to non-caller DM members, mirroring the
 * 60s auto-timeout's cleanup semantics (handler.ts:414-424) so any
 * ringing client (e.g., a Connection WS from another instance) exits
 * the ring state instead of hanging.
 *
 * Guard: if the caller already cancelled mid-race, the room is already
 * gone — do NOT emit a phantom "could not reach" toast.
 */
function emitUndeliverableAndMaybeDestroy(args: {
  callerId: string;
  dmChannelId: string;
  federatedId: string;
  terminal: boolean;
  failures: DmCallUndeliverableFailure[];
}): void {
  const { callerId, dmChannelId, federatedId, terminal, failures } = args;

  // Caller may have cancelled mid-race. If the room is gone, move on silently.
  const room = connectionManager.getRoom(dmChannelId);
  if (!room) return;

  if (terminal) {
    connectionManager.clearVoiceWs(callerId);
    connectionManager.destroyRoom(dmChannelId);
    connectionManager.sendToDmMembers(dmChannelId, {
      type: 'dm_call_ended',
      dmChannelId,
    }, callerId);
  }

  connectionManager.sendToUser(callerId, {
    type: 'dm_call_undeliverable',
    dmChannelId,
    federatedCallId: federatedId,
    terminal,
    phase: 'start',
    failures,
  });
}

/**
 * Emit a non-terminal dm_call_undeliverable to the local user whose Path-1 action
 * (accept / reject / end) had one or more fan-out failures reach peers.
 * No-op when there were no failures or no federatedId to reference.
 */
function emitFanoutUndeliverable(
  userId: string, dmChannelId: string | null, federatedId: string | null | undefined,
  phase: 'accept' | 'reject' | 'end', fanoutFailures: CallFanoutFailure[],
): void {
  if (fanoutFailures.length === 0 || !federatedId) return;
  const failures: DmCallUndeliverableFailure[] = fanoutFailures.map(f => ({
    reason: f.reason, peerOrigin: f.origin, peerLabel: f.peerLabel,
  }));
  connectionManager.sendToUser(userId, {
    type: 'dm_call_undeliverable', dmChannelId, federatedCallId: federatedId,
    terminal: false, phase, failures,
  });
}

/**
 * Relay a join of the call hosted here for `dmChannelId` to every peer with a
 * member in it. `actorUserIds` are the local users the accept may be named
 * after, in order: the member who joined, then the caller (`callRelayActor`).
 * `answeredBy` is the member who joined, whoever the accept is named after.
 */
function sendFederatedCallAccept(
  dmChannelId: string,
  actorUserIds: readonly string[],
  answeredBy: RelayActor | null,
): Promise<CallFanoutFailure[]> {
  return fanOutCallEvent(dmChannelId, 'dm_call_accept', actorUserIds, undefined, { answeredBy });
}

/**
 * Relay the end of the call hosted here for `dmChannelId` to every peer with
 * a member in it. `actorUserIds` are the local users the end may be named
 * after, in order: the user whose action ended it, then the caller
 * (`callRelayActor`).
 */
function sendFederatedCallEnd(dmChannelId: string, actorUserIds: readonly string[]): Promise<CallFanoutFailure[]> {
  return fanOutCallEvent(dmChannelId, 'dm_call_end', actorUserIds, undefined);
}

/**
 * Register the ring-timeout fan-out so a host-side 60s auto-clean notifies remote peers.
 * Called from server startup; split from module-load to keep test isolation clean
 * (tests that exercise ring timeouts can register their own stub via
 * `connectionManager.setRingTimeoutFanoutHook`).
 */
export function registerCallRelayHooks(): void {
  connectionManager.setRingTimeoutFanoutHook(async (dmChannelId, callerId) => {
    const failures = await sendFederatedCallEnd(dmChannelId, [callerId]);
    if (failures.length > 0) {
      console.warn('[federation] Ring-timeout fan-out had failures:', failures);
    }
  });
  connectionManager.setFederatedCallLeaveHook(leaveJoinedFederatedCall);
}

// ─── Test-only exports ──────────────────────────────────────────────────────
/** Direct export for unit tests — do not use in production code paths. */
export const handleDmCallStartForTest = handleDmCallStart;
export const handleDmCallAcceptForTest = handleDmCallAccept;
export const handleDmCallRejectForTest = handleDmCallReject;
export const handleDmCallEndForTest = handleDmCallEnd;
export const sendFederatedCallStartForTest = sendFederatedCallStart;
