import { eq } from 'drizzle-orm';
import type { LiveKitScreenTokenRequest } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { connectionManager } from '../ws/connectionManager.js';
import { hasPermission, isDmMember, PermissionBits } from '../utils/permissions.js';
import { NativeVoiceError, type NativePublisherOwner } from '../utils/nativeVoicePublisher.js';
import { relayActorOfUser, sameRelayActor } from './federation/identity.js';

export function validateScreenTokenRequest(body: unknown): LiveKitScreenTokenRequest {
  if (!body || typeof body !== 'object') throw new NativeVoiceError(400, 'Invalid screen token request');
  const value = body as Record<string, unknown>;
  const locators = ['channelId', 'dmChannelId', 'federatedCallId'];
  const present = locators.filter(key => value[key] !== undefined);
  if (present.length !== 1 || typeof value[present[0]!] !== 'string' || !value[present[0]!] ||
      typeof value.ownerIdentity !== 'string' || value.ownerIdentity.length > 512 ||
      !value.ownerIdentity.includes(':') || value.ownerIdentity.startsWith('screen:') || value.ownerIdentity.startsWith('native-voice:')) {
    throw new NativeVoiceError(400, 'Invalid screen token request');
  }
  return value as unknown as LiveKitScreenTokenRequest;
}

export function getNativeOwnerUser(userId: string) {
  const user = getDb().select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user || user.isDeleted) throw new NativeVoiceError(403, 'User is unavailable');
  return user;
}

export function resolveHostedNativeOwner(options: {
  request: LiveKitScreenTokenRequest;
  userId: string;
  /** S2S requests are authenticated to a canonical home pair before reaching this function. */
  federated: boolean;
}): NativePublisherOwner {
  const { request, userId, federated } = options;
  const user = getNativeOwnerUser(userId);
  const actor = relayActorOfUser(user);
  const identityId = federated ? actor?.homeUserId : userId;
  if (!identityId || request.ownerIdentity.split(':')[0] !== identityId) {
    throw new NativeVoiceError(403, 'The requested owner does not match the authenticated user');
  }
  if (request.channelId) return resolveSpaceOwner({ request, userId });
  const db = getDb();
  const channel = request.dmChannelId
    ? db.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, request.dmChannelId)).get()
    : db.select().from(schema.dmChannels).where(eq(schema.dmChannels.federatedId, request.federatedCallId!)).get();
  if (!channel || !isDmMember(channel.id, userId)) throw new NativeVoiceError(403, 'Not a member of this DM call');
  if (federated) assertUnambiguousFederatedOwner(channel.id, user);
  const room = connectionManager.getRoom(channel.id);
  if (!room || room.roomType !== 'dm' || room.metadata.type !== 'dm' || room.metadata.state !== 'active') {
    throw new NativeVoiceError(403, 'No active DM call');
  }
  // Remote callers are not inserted into the host's local WS participant set.
  const isCurrent = () => connectionManager.getRoom(channel.id) === room && isDmMember(channel.id, userId) &&
    (federated || connectionManager.getUserRoom(userId)?.room === room);
  if (!isCurrent()) throw new NativeVoiceError(403, 'User has not joined this call');
  return {
    userId, roomId: channel.id, roomName: channel.federatedId ?? `dm-${channel.id}`,
    ownerIdentity: request.ownerIdentity, isCurrent,
    permissions: () => ({ canStream: isCurrent(), canSpeak: true, canSubscribe: true }),
  };
}

function assertUnambiguousFederatedOwner(channelId: string, user: ReturnType<typeof getNativeOwnerUser>): void {
  const actor = relayActorOfUser(user)!;
  const members = getDb().select({ user: schema.users }).from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, channelId)).all();
  // Existing main-call identities omit the home instance. Refuse an ambiguous legacy
  // identity instead of letting one home's helper aggregate under another home's user.
  const collision = members.some(member => {
    const other = relayActorOfUser(member.user);
    return other && other.homeUserId === actor.homeUserId && !sameRelayActor(actor, other);
  });
  if (collision) throw new NativeVoiceError(403, 'The legacy call identity is ambiguous across home instances');
}

function resolveSpaceOwner(options: { request: LiveKitScreenTokenRequest; userId: string }): NativePublisherOwner {
  const { request, userId } = options;
  const room = connectionManager.getUserRoom(userId);
  if (!room || room.roomId !== request.channelId || room.room.metadata.type !== 'space') {
    throw new NativeVoiceError(403, 'User has not joined this voice channel');
  }
  const spaceId = room.room.metadata.spaceId;
  const isCurrent = () => connectionManager.getUserRoom(userId)?.room === room.room;
  return {
    userId, roomId: room.roomId, roomName: room.roomId, ownerIdentity: request.ownerIdentity, isCurrent,
    permissions: () => ({
      canStream: hasPermission(userId, spaceId, PermissionBits.CONNECT, room.roomId) &&
        hasPermission(userId, spaceId, PermissionBits.STREAM, room.roomId),
      canSpeak: hasPermission(userId, spaceId, PermissionBits.SPEAK, room.roomId) &&
        !connectionManager.isSpaceMuted(spaceId, userId) && !connectionManager.isPermissionMuted(spaceId, userId),
      canSubscribe: !connectionManager.isSpaceDeafened(spaceId, userId),
    }),
  };
}
