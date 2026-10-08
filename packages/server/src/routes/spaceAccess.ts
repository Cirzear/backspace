import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { checkVoicePermissions } from '../ws/events.js';
import { connectionManager } from '../ws/handler.js';

/**
 * After a change to the space's roles, to a member's roles or to its owner
 * (the owner holds every permission): every connected member is told with
 * `space_access_changed` (docs/systems/websocket.md) and refetches the
 * space's detail, which carries their permissions, the channels they can
 * see, the roles and the member list. `affectedUserIds` are the
 * members whose own permissions may have changed; each is also sent the voice
 * state they can see now (`announceSpaceAccessChange`). Voice permissions are
 * re-checked here too, since a role can carry SPEAK or STREAM.
 */
export function announceAccessChange(spaceId: string, affectedUserIds: readonly string[]): void {
  connectionManager.announceSpaceAccessChange(spaceId, affectedUserIds);
  checkVoicePermissions(spaceId);
}

/** The members whose permissions a change to `roleId` reaches: its holders, or everyone for @everyone. */
export function membersHoldingRole(spaceId: string, roleId: string): string[] {
  const db = getDb();
  if (roleId === spaceId) {
    return db.select({ userId: schema.spaceMembers.userId }).from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.spaceId, spaceId)).all().map((m) => m.userId);
  }
  return db.select({ userId: schema.memberRoles.userId }).from(schema.memberRoles)
    .where(eq(schema.memberRoles.roleId, roleId)).all().map((m) => m.userId);
}
