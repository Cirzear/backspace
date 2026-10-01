import { randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import type { LiveKitScreenTokenResponse, NativeParticipantMetadata } from '@backspace/shared';
import { config } from '../config.js';
import { addNativeVoiceSession, stopNativeVoiceSession, stopNativeVoiceSessionsForUser } from '../ws/nativeVoiceSessions.js';

const NATIVE_TOKEN_TTL = '60s';

export interface NativePublishPermissions {
  canStream: boolean;
  canSpeak: boolean;
  canSubscribe: boolean;
}

export interface NativePublisherOwner {
  userId: string;
  roomId: string;
  roomName: string;
  ownerIdentity: string;
  isCurrent: () => boolean;
  permissions: () => NativePublishPermissions;
}

export class NativeVoiceError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function roomService(): RoomServiceClient {
  const { url, apiKey, apiSecret } = config.livekit;
  if (!url || !apiKey || !apiSecret) throw new NativeVoiceError(503, 'Voice/video is not configured');
  const httpUrl = new URL(url);
  // The same configured endpoint serves WSS signaling and HTTPS management RPC.
  // Map WebSocket schemes only; an HTTPS URL must never be downgraded.
  if (httpUrl.protocol === 'wss:') httpUrl.protocol = 'https:';
  if (httpUrl.protocol === 'ws:') httpUrl.protocol = 'http:';
  return new RoomServiceClient(httpUrl.toString().replace(/\/$/, ''), apiKey, apiSecret);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'not_found';
}

async function removeParticipant(client: RoomServiceClient, roomName: string, identity: string): Promise<void> {
  try {
    await client.removeParticipant(roomName, identity);
  } catch (error) {
    // Stopping before native connect and stopping after disconnect are both legitimate.
    if (!isNotFound(error)) throw error;
  }
}

function permissionGrant(kind: NativeParticipantMetadata['purpose'], permissions: NativePublishPermissions) {
  const screen = kind === 'screen-share';
  return {
    canPublish: screen || permissions.canSpeak,
    canPublishSources: screen
      ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
      : permissions.canSpeak ? [TrackSource.MICROPHONE] : [],
    canSubscribe: !screen && permissions.canSubscribe,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  };
}

async function signParticipant(options: {
  owner: NativePublisherOwner;
  identity: string;
  purpose: NativeParticipantMetadata['purpose'];
}): Promise<string> {
  const metadata: NativeParticipantMetadata = { purpose: options.purpose, ownerIdentity: options.owner.ownerIdentity };
  const token = new AccessToken(config.livekit.apiKey!, config.livekit.apiSecret!, {
    identity: options.identity,
    ttl: NATIVE_TOKEN_TTL,
    metadata: JSON.stringify(metadata),
  });
  token.addGrant({ room: options.owner.roomName, roomJoin: true, ...permissionGrant(options.purpose, options.owner.permissions()) });
  return token.toJwt();
}

const pendingOwners = new Set<string>();

/** A separate ADM per participant keeps mic and playback capture in distinct source tracks. */
export async function createNativePublisher(owner: NativePublisherOwner): Promise<LiveKitScreenTokenResponse> {
  if (pendingOwners.has(owner.userId)) throw new NativeVoiceError(409, 'Native capture is already starting');
  pendingOwners.add(owner.userId);
  try {
    return await issueNativePublisher(owner);
  } finally {
    pendingOwners.delete(owner.userId);
  }
}

async function issueNativePublisher(owner: NativePublisherOwner): Promise<LiveKitScreenTokenResponse> {
  const client = roomService();
  if (!owner.isCurrent() || !owner.permissions().canStream) throw new NativeVoiceError(403, 'No active authorized voice session');
  // A membership or a relayed ringing token alone does not prove the owner joined this room.
  try {
    await client.getParticipant(owner.roomName, owner.ownerIdentity);
  } catch (error) {
    if (isNotFound(error)) throw new NativeVoiceError(403, 'The owner is not connected to this voice room');
    throw error;
  }
  await stopNativeVoiceSessionsForUser(owner.userId);
  if (!owner.isCurrent() || !owner.permissions().canStream) throw new NativeVoiceError(403, 'Voice session ended during token issuance');
  const identity = `screen:${randomUUID()}`;
  const voiceIdentity = `native-voice:${randomUUID()}`;
  const [token, voiceToken] = await Promise.all([
    signParticipant({ owner, identity, purpose: 'screen-share' }),
    signParticipant({ owner, identity: voiceIdentity, purpose: 'native-voice' }),
  ]);
  if (!owner.isCurrent() || !owner.permissions().canStream) throw new NativeVoiceError(403, 'Voice session ended during token issuance');
  addNativeVoiceSession({
    ...owner,
    identity,
    voiceIdentity,
    stop: async () => {
      await Promise.all([
        removeParticipant(client, owner.roomName, identity),
        removeParticipant(client, owner.roomName, voiceIdentity),
      ]);
    },
    syncPermissions: async () => {
      const permissions = owner.permissions();
      if (!owner.isCurrent() || !permissions.canStream) {
        await stopNativeVoiceSession(identity);
        return;
      }
      try {
        await client.updateParticipant(owner.roomName, voiceIdentity, {
          permission: permissionGrant('native-voice', permissions),
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  });
  return { token, voiceToken, url: config.livekit.url!, roomName: owner.roomName, identity, voiceIdentity, ownerIdentity: owner.ownerIdentity };
}
