import type { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { connectionManager } from './connectionManager.js';
import type { DmRoomMeta } from './voiceRoomTypes.js';
import { isDmMember } from '../utils/permissions.js';
import { reopenForClosedMembers } from '../routes/dm.js';
import { type ServerEvent, type DmCallUndeliverableFailure, type DmCallUndeliverableReason } from '@backspace/shared';
import type { CallRelayResult, CallFanoutFailure } from '../utils/federationOutbox.js';
import { mapCallReasonToEventReason } from '../utils/federationOutbox.js';
import { sendCallRelay } from '../utils/federationOutbox.js';
import { canonicalizeHomeInstance, getOurOrigin, normalizeOriginForCompare } from '../utils/federationAuth.js';
import { generateFederatedCallToken } from '../routes/livekit.js';
import { config } from '../config.js';
import { broadcastRoomLeave } from './voiceEvents.js';

// ─── DM Call Handlers (Unified Room API) ───────────────────────────────────

export function handleDmCallStart(event: Record<string, unknown>, userId: string, username: string, ws: WebSocket): void {
  const dmChannelId = event.dmChannelId as string;
  if (!dmChannelId || typeof dmChannelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'dmChannelId is required' });
    return;
  }

  if (!isDmMember(dmChannelId, userId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You are not a member of this DM channel' });
    return;
  }

  // Leave current room if in one
  const left = connectionManager.leaveCurrentRoom(userId);
  if (left) {
    broadcastRoomLeave(left.roomId, left.room, userId);
  }
  connectionManager.clearVoiceUserStatus(userId);

  // Cancel any other ringing rooms started by this user
  for (const [roomId, room] of connectionManager.getAllRooms()) {
    if (room.roomType === 'dm' && roomId !== dmChannelId) {
      const meta = room.metadata as DmRoomMeta;
      if (meta.state === 'ringing' && meta.callerId === userId) {
        connectionManager.destroyRoom(roomId);
        connectionManager.sendToDmMembers(roomId, {
          type: 'dm_call_ended',
          dmChannelId: roomId,
        });
      }
    }
  }

  // Create DM room in ringing state (fails if already active)
  const created = connectionManager.createDmRoom(dmChannelId, userId);
  if (!created) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'A call is already active in this DM channel' });
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
    connectionManager.sendToUser(userId, { type: 'error', message: 'dmChannelId or federatedCallId is required' });
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
      connectionManager.sendToUser(userId, { type: 'error', message: 'You are not a member of this DM channel' });
      return;
    }

    const room = connectionManager.getRoom(dmChannelId);
    if (room && room.roomType === 'dm') {
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

      const acceptorLeft = connectionManager.leaveCurrentRoom(userId);
      if (acceptorLeft) broadcastRoomLeave(acceptorLeft.roomId, acceptorLeft.room, userId);
      connectionManager.joinRoom(dmChannelId, userId);
      connectionManager.setVoiceWs(userId, ws);
      // Look up federatedId for the broadcast so all clients (including remote) can match
      const fedIdRow = getDb().select({ federatedId: schema.dmChannels.federatedId })
        .from(schema.dmChannels).where(eq(schema.dmChannels.id, dmChannelId)).get();
      connectionManager.sendToDmMembers(dmChannelId, {
        type: 'dm_call_accepted',
        dmChannelId,
        federatedCallId: fedIdRow?.federatedId ?? undefined,
      } as ServerEvent);
      connectionManager.sendToDmMembers(dmChannelId, {
        type: 'voice_state_update',
        channelId: dmChannelId,
        userId,
        action: 'join',
      });
      const acceptFanoutFailures = await sendFederatedCallAccept(dmChannelId, userId);
      emitFanoutUndeliverable(
        userId,
        dmChannelId,
        fedIdRow?.federatedId ?? null,
        'accept',
        acceptFanoutFailures,
      );
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
    // Optimistic transition so the acceptor's client flips to active immediately.
    // Rolled back below if the relay to host fails.
    connectionManager.activateFederatedCall(fedCall.federatedId);
    connectionManager.sendToFederatedCallUsers(fedCall.federatedId, {
      type: 'dm_call_accepted',
      dmChannelId: fedCall.dmChannelId,
      federatedCallId: fedCall.federatedId,
    } as ServerEvent);

    const db = getDb();
    const user = db.select({ homeUserId: schema.users.homeUserId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    const homeUserId = user?.homeUserId || userId;

    const result = await sendCallRelay(fedCall.federatedCallHost, [{
      eventType: 'dm_call_accept',
      messageId: generateSnowflake(),
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId: fedCall.federatedId,
      call: {
        acceptor: { homeUserId, homeInstance: getOurOrigin() },
      },
    }]);

    if (!result.ok) {
      console.error(`[federation] dm_call_accept relay to ${fedCall.federatedCallHost} failed (${result.reason}): ${result.error}`);
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

  connectionManager.sendToUser(userId, { type: 'error', message: 'No active call in this DM channel' });
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
    if (room) {
      const meta = room.metadata as DmRoomMeta;
      connectionManager.clearVoiceWs(meta.callerId);
      connectionManager.destroyRoom(dmChannelId);
      connectionManager.sendToDmMembers(dmChannelId, { type: 'dm_call_rejected', dmChannelId });
      const fedIdRejectRow = getDb().select({ federatedId: schema.dmChannels.federatedId })
        .from(schema.dmChannels).where(eq(schema.dmChannels.id, dmChannelId)).get();
      const rejectFanoutFailures = await sendFederatedCallEnd(dmChannelId, userId);
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
    // Optimistic local clear — user intent is to reject.
    connectionManager.sendToFederatedCallUsers(fedCall.federatedId, {
      type: 'dm_call_rejected',
      dmChannelId: fedCall.dmChannelId,
      federatedCallId: fedCall.federatedId,
    } as ServerEvent, userId);
    const host = fedCall.federatedCallHost;
    const fedId = fedCall.federatedId;
    const dmId = fedCall.dmChannelId;
    connectionManager.clearFederatedCall(fedId);

    const db = getDb();
    const user = db.select({ homeUserId: schema.users.homeUserId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    const homeUserId = user?.homeUserId || userId;

    const result = await sendCallRelay(host, [{
      eventType: 'dm_call_reject',
      messageId: generateSnowflake(),
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId: fedId,
      call: {
        rejector: { homeUserId, homeInstance: getOurOrigin() },
      },
    }]);

    if (!result.ok) {
      console.error(`[federation] dm_call_reject relay to ${host} failed (${result.reason}): ${result.error}`);
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
    if (room) {
      const meta = room.metadata as DmRoomMeta;
      connectionManager.clearVoiceWs(meta.callerId);
      for (const participantId of room.participants) {
        connectionManager.clearVoiceUserStatus(participantId);
        connectionManager.clearVoiceWs(participantId);
      }
      const fedIdEndRow = getDb().select({ federatedId: schema.dmChannels.federatedId })
        .from(schema.dmChannels).where(eq(schema.dmChannels.id, dmChannelId)).get();
      connectionManager.destroyRoom(dmChannelId);
      connectionManager.sendToDmMembers(dmChannelId, { type: 'dm_call_ended', dmChannelId });
      const endFanoutFailures = await sendFederatedCallEnd(dmChannelId, userId);
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
    // Exclude the user who ended the call — they already disconnected client-side.
    connectionManager.sendToFederatedCallUsers(fedCall.federatedId, {
      type: 'dm_call_ended',
      dmChannelId: fedCall.dmChannelId,
      federatedCallId: fedCall.federatedId,
    } as ServerEvent, userId);
    const host = fedCall.federatedCallHost;
    const fedId = fedCall.federatedId;
    const dmId = fedCall.dmChannelId;
    connectionManager.clearFederatedCall(fedId);

    const db = getDb();
    const user = db.select({ homeUserId: schema.users.homeUserId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    const homeUserId = user?.homeUserId || userId;

    const result = await sendCallRelay(host, [{
      eventType: 'dm_call_end',
      messageId: generateSnowflake(),
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId: fedId,
      call: {
        endedBy: { homeUserId, homeInstance: getOurOrigin() },
      },
    }]);

    if (!result.ok) {
      console.error(`[federation] dm_call_end relay to ${host} failed (${result.reason}): ${result.error}`);
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
  // normalizeOriginForCompare; the peer-facing origin is canonicalized.
  const ourOriginKey = normalizeOriginForCompare(ourOrigin);
  const remoteMembers = members.filter(m => {
    const key = normalizeOriginForCompare(m.homeInstance);
    return key !== null && key !== ourOriginKey;
  });

  // A purely local call has no federated recipient. Relaying it anyway would
  // hand every peered instance the call's existence, its participant roster and
  // room credentials for a conversation none of them hosts a party to.
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

  const callerHomeUserId = members.find(m => m.userId === callerId)?.homeUserId || callerId;

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
  const buildRelayEvent = async (recipients: typeof members) => {
    const tokens: Record<string, string> = {};
    for (const m of recipients) {
      const homeUserId = m.homeUserId || m.userId;
      const name = m.displayName || m.username;
      tokens[homeUserId] = await generateFederatedCallToken(federatedId, homeUserId, name);
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
        caller: {
          homeUserId: callerHomeUserId,
          homeInstance: ourOrigin,
          displayName: callerName,
        },
        participants,
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
  // Each peer's result has THREE possible classifications:
  //   ok=true, messageId NOT in undeliverable → delivered
  //   ok=true, messageId IN undeliverable     → new: no_recipient failure (#18)
  //   ok=false                                → existing failure reasons
  const targetedResults = await Promise.all(
    Array.from(targetedPeers.entries()).map(async ([peerOrigin, recipients]) => {
      const relayEvent = await buildRelayEvent(recipients);
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
  userId: string,
  dmChannelId: string | null,
  federatedId: string | null | undefined,
  phase: 'accept' | 'reject' | 'end',
  fanoutFailures: CallFanoutFailure[],
): void {
  if (fanoutFailures.length === 0 || !federatedId) return;
  const failures: DmCallUndeliverableFailure[] = fanoutFailures.map(f => ({
    reason: f.reason,
    peerOrigin: f.origin,
    peerLabel: f.peerLabel,
  }));
  connectionManager.sendToUser(userId, {
    type: 'dm_call_undeliverable',
    dmChannelId,
    federatedCallId: federatedId,
    terminal: false,
    phase,
    failures,
  });
}

async function sendFederatedCallAccept(
  dmChannelId: string,
  acceptorUserId: string,
): Promise<CallFanoutFailure[]> {
  const db = getDb();
  const channel = db.select({ federatedId: schema.dmChannels.federatedId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();
  if (!channel?.federatedId) return [];

  const members = db.select({ homeInstance: schema.users.homeInstance })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  const ourOrigin = getOurOrigin();
  const targets = new Set<string>();
  for (const m of members) {
    if (m.homeInstance) {
      const normalized = m.homeInstance.startsWith('http') ? m.homeInstance : `https://${m.homeInstance}`;
      if (normalized !== ourOrigin) targets.add(normalized);
    }
  }
  if (targets.size === 0) return [];

  const user = db.select({ homeUserId: schema.users.homeUserId })
    .from(schema.users)
    .where(eq(schema.users.id, acceptorUserId))
    .get();
  const homeUserId = user?.homeUserId || acceptorUserId;

  const event = {
    eventType: 'dm_call_accept' as const,
    messageId: generateSnowflake(),
    encryptionVersion: 0 as const,
    timestamp: Date.now(),
    federatedId: channel.federatedId,
    call: {
      acceptor: { homeUserId, homeInstance: ourOrigin },
    },
  };

  const labelByOrigin = new Map<string, string | null>();
  for (const r of db.select({ origin: schema.federationPeers.origin, instanceName: schema.federationPeers.instanceName })
    .from(schema.federationPeers)
    .all()) {
    labelByOrigin.set(r.origin, r.instanceName ?? null);
  }

  const results = await Promise.all(
    Array.from(targets).map(async origin => ({ origin, result: await sendCallRelay(origin, [event]) })),
  );

  const failures: CallFanoutFailure[] = [];
  for (const { origin, result } of results) {
    if (!result.ok) {
      console.error(`[federation] dm_call_accept fanout to ${origin} failed (${result.reason}): ${result.error}`);
      failures.push({
        origin,
        peerLabel: labelByOrigin.get(origin) ?? undefined,
        reason: mapCallReasonToEventReason(result.reason),
      });
    }
  }
  return failures;
}

async function sendFederatedCallEnd(
  dmChannelId: string,
  endedByUserId: string,
): Promise<CallFanoutFailure[]> {
  const db = getDb();
  const channel = db.select({ federatedId: schema.dmChannels.federatedId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();
  if (!channel?.federatedId) return [];

  const members = db.select({ homeInstance: schema.users.homeInstance })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  const ourOrigin = getOurOrigin();
  const targets = new Set<string>();
  for (const m of members) {
    if (m.homeInstance) {
      const normalized = m.homeInstance.startsWith('http') ? m.homeInstance : `https://${m.homeInstance}`;
      if (normalized !== ourOrigin) targets.add(normalized);
    }
  }
  if (targets.size === 0) return [];

  const endUser = db.select({ homeUserId: schema.users.homeUserId })
    .from(schema.users)
    .where(eq(schema.users.id, endedByUserId))
    .get();
  const resolvedHomeUserId = endUser?.homeUserId || endedByUserId;

  const event = {
    eventType: 'dm_call_end' as const,
    messageId: generateSnowflake(),
    encryptionVersion: 0 as const,
    timestamp: Date.now(),
    federatedId: channel.federatedId,
    call: {
      endedBy: { homeUserId: resolvedHomeUserId, homeInstance: ourOrigin },
    },
  };

  const labelByOrigin = new Map<string, string | null>();
  for (const r of db.select({ origin: schema.federationPeers.origin, instanceName: schema.federationPeers.instanceName })
    .from(schema.federationPeers)
    .all()) {
    labelByOrigin.set(r.origin, r.instanceName ?? null);
  }

  const results = await Promise.all(
    Array.from(targets).map(async origin => ({ origin, result: await sendCallRelay(origin, [event]) })),
  );

  const failures: CallFanoutFailure[] = [];
  for (const { origin, result } of results) {
    if (!result.ok) {
      console.error(`[federation] dm_call_end fanout to ${origin} failed (${result.reason}): ${result.error}`);
      failures.push({
        origin,
        peerLabel: labelByOrigin.get(origin) ?? undefined,
        reason: mapCallReasonToEventReason(result.reason),
      });
    }
  }
  return failures;
}

/**
 * Register the ring-timeout fan-out so a host-side 60s auto-clean notifies remote peers.
 * Called from server startup; split from module-load to keep test isolation clean
 * (tests that exercise ring timeouts can register their own stub via
 * `connectionManager.setRingTimeoutFanoutHook`).
 */
export function registerCallRelayHooks(): void {
  connectionManager.setRingTimeoutFanoutHook(async (dmChannelId, callerId) => {
    const failures = await sendFederatedCallEnd(dmChannelId, callerId);
    if (failures.length > 0) {
      console.warn('[federation] Ring-timeout fan-out had failures:', failures);
    }
  });
}

// ─── Test-only exports ──────────────────────────────────────────────────────
/** Direct export for unit tests — do not use in production code paths. */
export const handleDmCallAcceptForTest = handleDmCallAccept;
export const handleDmCallRejectForTest = handleDmCallReject;
export const handleDmCallEndForTest = handleDmCallEnd;
export const sendFederatedCallStartForTest = sendFederatedCallStart;
