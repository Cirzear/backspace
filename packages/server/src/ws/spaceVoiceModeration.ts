import { syncNativeVoicePermissions } from './nativeVoiceSessions.js';

/** Manages space-level voice moderation states (mute, deafen, permission mute). */
export class SpaceVoiceModeration {
  private spaceMutedUsers: Set<string> = new Set();
  private spaceDeafenedUsers: Set<string> = new Set();
  private permissionMutedUsers: Set<string> = new Set();

  setSpaceMuted(spaceId: string, userId: string, muted: boolean): void {
    const key = `${spaceId}:${userId}`;
    if (muted) this.spaceMutedUsers.add(key);
    else this.spaceMutedUsers.delete(key);
    syncNativeVoicePermissions(userId);
  }

  isSpaceMuted(spaceId: string, userId: string): boolean {
    return this.spaceMutedUsers.has(`${spaceId}:${userId}`);
  }

  setSpaceDeafened(spaceId: string, userId: string, deafened: boolean): void {
    const key = `${spaceId}:${userId}`;
    if (deafened) this.spaceDeafenedUsers.add(key);
    else this.spaceDeafenedUsers.delete(key);
    syncNativeVoicePermissions(userId);
  }

  isSpaceDeafened(spaceId: string, userId: string): boolean {
    return this.spaceDeafenedUsers.has(`${spaceId}:${userId}`);
  }

  clearSpaceVoiceState(spaceId: string, userId: string): void {
    this.spaceMutedUsers.delete(`${spaceId}:${userId}`);
    this.spaceDeafenedUsers.delete(`${spaceId}:${userId}`);
    this.permissionMutedUsers.delete(`${spaceId}:${userId}`);
  }

  setPermissionMuted(spaceId: string, userId: string, muted: boolean): void {
    const key = `${spaceId}:${userId}`;
    if (muted) this.permissionMutedUsers.add(key);
    else this.permissionMutedUsers.delete(key);
    syncNativeVoicePermissions(userId);
  }

  isPermissionMuted(spaceId: string, userId: string): boolean {
    return this.permissionMutedUsers.has(`${spaceId}:${userId}`);
  }
}
