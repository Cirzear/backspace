import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { computePermissions, PermissionBits } from '../utils/permissions.js';
import { getVoiceRoomElapsedSeconds, type SpaceRoomMeta, type VoiceRoom } from './voiceRoomTypes.js';

export interface SpaceVoiceStateSource {
  getRoom(roomId: string): VoiceRoom | undefined;
  getVoiceUserStatus(userId: string): { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean } | undefined;
  getVoiceRooms(): Iterable<[string, VoiceRoom]>;
  isPermissionMuted(spaceId: string, userId: string): boolean;
}

export interface SpaceVoiceStateResult {
  voiceStates: Record<string, string[]>;
  voiceChannelElapsedSeconds: Record<string, number>;
  voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>;
  spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }>;
}

export function buildSpaceVoiceState(
  source: SpaceVoiceStateSource,
  spaceId: string,
  userId: string,
): SpaceVoiceStateResult {
  const db = getDb();
  const voiceStates: Record<string, string[]> = {};
  const voiceChannelElapsedSeconds: Record<string, number> = {};
  const voiceUserStates: Record<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }> = {};
  const spaceVoiceStates: Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted: boolean }> = {};

  // Who is currently in each of this space's voice channels the user can VIEW.
  const voiceChannels = db.select({ id: schema.channels.id })
    .from(schema.channels)
    .where(and(eq(schema.channels.spaceId, spaceId), eq(schema.channels.type, 'voice')))
    .all();
  for (const ch of voiceChannels) {
    const chPerms = computePermissions(userId, spaceId, ch.id);
    const hasView = (chPerms & PermissionBits.VIEW_CHANNEL) !== 0n || (chPerms & PermissionBits.ADMINISTRATOR) !== 0n;
    if (!hasView) continue;
    const room = source.getRoom(ch.id);
    if (room && room.participants.size > 0) {
      const ids = Array.from(room.participants);
      voiceStates[ch.id] = ids;
      voiceChannelElapsedSeconds[ch.id] = getVoiceRoomElapsedSeconds(room);
      for (const uid of ids) {
        const status = source.getVoiceUserStatus(uid);
        if (status) voiceUserStates[uid] = status;
      }
    }
  }

  // Space mute/deafen — persisted, authoritative (survives reconnect).
  const restrictions = db.select()
    .from(schema.voiceRestrictions)
    .where(eq(schema.voiceRestrictions.spaceId, spaceId))
    .all();
  for (const r of restrictions) {
    const key = `${r.spaceId}:${r.userId}`;
    const existing = spaceVoiceStates[key] ?? { spaceMuted: false, spaceDeafened: false, permissionMuted: false };
    if (r.restrictionType === 'mute') existing.spaceMuted = true;
    if (r.restrictionType === 'deafen') existing.spaceDeafened = true;
    spaceVoiceStates[key] = existing;
  }

  // Permission-mute — ephemeral, derived from in-memory state for every participant.
  for (const [, room] of source.getVoiceRooms()) {
    if (room.roomType !== 'space') continue;
    const meta = room.metadata as SpaceRoomMeta;
    if (meta.spaceId !== spaceId) continue;
    for (const participantId of room.participants) {
      if (source.isPermissionMuted(spaceId, participantId)) {
        const key = `${spaceId}:${participantId}`;
        const existing = spaceVoiceStates[key] ?? { spaceMuted: false, spaceDeafened: false, permissionMuted: false };
        existing.permissionMuted = true;
        spaceVoiceStates[key] = existing;
      }
    }
  }

  return { voiceStates, voiceChannelElapsedSeconds, voiceUserStates, spaceVoiceStates };
}
