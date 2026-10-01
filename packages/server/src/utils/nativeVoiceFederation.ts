import { eq } from 'drizzle-orm';
import type { LiveKitScreenTokenRequest, LiveKitScreenTokenResponse } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { connectionManager } from '../ws/connectionManager.js';
import { addNativeVoiceSession, stopNativeVoiceSession, stopNativeVoiceSessionsForUser } from '../ws/nativeVoiceSessions.js';
import { isDmMember } from './permissions.js';
import { buildFederationHeaders, getOurOrigin } from './federationAuth.js';
import { federationFetch } from './federationFetch.js';
import { NativeVoiceError } from './nativeVoicePublisher.js';
import { getNativeOwnerUser } from '../routes/livekitScreenOwner.js';
import { relayActorOfUser } from '../routes/federation/identity.js';

async function requestHost(options: { origin: string; action: 'token' | 'stop'; body: unknown }): Promise<Response> {
  const peer = getDb().select().from(schema.federationPeers).where(eq(schema.federationPeers.origin, options.origin)).get();
  if (!peer || peer.status !== 'active') throw new NativeVoiceError(503, 'The call host is not an active peer');
  const body = JSON.stringify(options.body);
  const response = await federationFetch(peer.origin, `/api/federation/livekit/screen-${options.action}`, {
    method: 'POST', body,
    headers: buildFederationHeaders(body, peer.pendingHmacSecret ?? peer.hmacSecret, getOurOrigin()),
    signal: AbortSignal.timeout(10_000),
  }, 'approved');
  if (!response.ok) throw new NativeVoiceError(response.status, `Call host refused native screen ${options.action}`);
  return response;
}

function parseHostToken(value: unknown): LiveKitScreenTokenResponse {
  if (!value || typeof value !== 'object') throw new NativeVoiceError(502, 'Invalid call host token response');
  const fields = ['token', 'url', 'roomName', 'identity', 'ownerIdentity', 'voiceToken', 'voiceIdentity'];
  const response = value as Record<string, unknown>;
  if (fields.some(field => typeof response[field] !== 'string' || !response[field])) {
    throw new NativeVoiceError(502, 'Invalid call host token response');
  }
  return response as unknown as LiveKitScreenTokenResponse;
}

/** Returns undefined only when this instance hosts the call; no remote-to-local fallback. */
export async function requestFederatedNativePublisher(options: {
  request: LiveKitScreenTokenRequest; userId: string;
}): Promise<LiveKitScreenTokenResponse | undefined> {
  const { request, userId } = options;
  if (request.channelId) return undefined;
  const call = request.federatedCallId
    ? connectionManager.getFederatedCall(request.federatedCallId)
    : connectionManager.getFederatedCallByDmChannel(request.dmChannelId!);
  if (!call) return undefined;
  const user = getNativeOwnerUser(userId);
  const actor = relayActorOfUser(user);
  const isCurrent = () => connectionManager.getFederatedCall(call.federatedId) === call &&
    call.state === 'active' && call.ringedUserIds.includes(userId) &&
    (!call.dmChannelId || isDmMember(call.dmChannelId, userId));
  if (!actor || !isCurrent() || request.ownerIdentity.split(':')[0] !== actor.homeUserId || !call.tokens.has(actor.homeUserId)) {
    throw new NativeVoiceError(403, 'No active federated call for this user');
  }
  await stopNativeVoiceSessionsForUser(userId);
  const response = await requestHost({
    origin: call.federatedCallHost, action: 'token',
    body: { federatedCallId: call.federatedId, ownerIdentity: request.ownerIdentity, actor },
  });
  const result = parseHostToken(await response.json());
  if (result.ownerIdentity !== request.ownerIdentity || result.roomName !== call.federatedId) {
    throw new NativeVoiceError(502, 'Call host returned mismatched native participant');
  }
  const stop = async () => {
    await requestHost({ origin: call.federatedCallHost, action: 'stop', body: { identity: result.identity, actor } });
  };
  if (!isCurrent()) {
    await stop();
    throw new NativeVoiceError(403, 'Call ended during native token request');
  }
  addNativeVoiceSession({
    userId, roomId: call.federatedId, identity: result.identity, voiceIdentity: result.voiceIdentity,
    ownerIdentity: result.ownerIdentity, isCurrent, stop,
    syncPermissions: async () => { if (!isCurrent()) await stopNativeVoiceSession(result.identity); },
  });
  return result;
}
