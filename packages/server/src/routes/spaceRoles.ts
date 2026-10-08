import {
  DEFAULT_EVERYONE_PERMISSIONS,
  permissionsToString,
  stringToPermissions,
  parsePermissionString,
  roleBitsChangeRefusal,
  rolePermissionsVersion,
  type HeldBitsRefusal,
  canActOnMember,
  canManageRoleAt,
} from '@backspace/shared/src/permissions.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb, getRawDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors';
import { computePermissions, hasPermission, isMember, isSpaceOwner, PermissionBits } from '../utils/permissions.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { canActOnMemberInSpace, canManageRoleInSpace, getHierarchyStanding } from '../utils/roleHierarchy.js';
import { moveRoleToPosition, normalizeRolePositions, positionNextTo } from '../db/rolePositions.js';
import { roleView, viewerReadsPermissionData } from '../utils/permissionDataView.js';
import { announceAccessChange, membersHoldingRole } from './spaceAccess.js';

type RoleChangeRefusal = {
  status: 400 | 403 | 404;
  code: 'missing_permission' | 'cannot_change_own_roles' | 'space_owner_only' | 'member_not_found' | 'role_not_in_space' | 'everyone_role_not_assignable' | 'role_hierarchy' | HeldBitsRefusal;
  details?: Record<string, string>;
};

/**
 * Held-bits rule for handing out a role (permissions.md, "Held-bits rule"):
 * giving a member a role gives them its bits, so the actor must hold every
 * one of them. Taking a role away is governed by the hierarchy alone.
 */
export function roleGrantRefusal(spaceId: string, actorId: string, rolePermissions: string | null): HeldBitsRefusal | null {
  return roleBitsChangeRefusal(computePermissions(actorId, spaceId), 0n, stringToPermissions(rolePermissions));
}

/**
 * The checks shared by the two single-role routes (add one role to a member,
 * take one away). They match what PATCH /members/:uid enforces for a whole
 * role set: MANAGE_ROLES, not one's own roles, not the owner's, a member of
 * this space, a role of this space other than @everyone, a member ranked
 * below the actor, a role below the actor's top role and, when adding, a
 * role whose bits the actor holds.
 */
function checkSingleRoleChange(
  spaceId: string,
  actorId: string,
  targetId: string,
  roleId: string,
  change: 'add' | 'remove',
): RoleChangeRefusal | null {
  const db = getDb();
  if (!hasPermission(actorId, spaceId, PermissionBits.MANAGE_ROLES)) {
    return { status: 403, code: 'missing_permission', details: { permission: 'MANAGE_ROLES' } };
  }
  if (targetId === actorId) return { status: 400, code: 'cannot_change_own_roles' };
  if (isSpaceOwner(spaceId, targetId)) return { status: 403, code: 'space_owner_only' };
  if (!isMember(spaceId, targetId)) return { status: 404, code: 'member_not_found' };
  const role = typeof roleId === 'string'
    ? db.select().from(schema.roles).where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, spaceId))).get()
    : undefined;
  if (!role) return { status: 400, code: 'role_not_in_space', details: { roleId: String(roleId) } };
  if (role.id === spaceId) return { status: 400, code: 'everyone_role_not_assignable' };
  const actor = getHierarchyStanding(spaceId, actorId);
  if (!canActOnMember(actor, getHierarchyStanding(spaceId, targetId)) || !canManageRoleAt(actor, role.position ?? 0)) {
    return { status: 403, code: 'role_hierarchy' };
  }
  if (change === 'add') {
    const refusal = roleGrantRefusal(spaceId, actorId, role.permissions);
    if (refusal) return { status: 403, code: refusal };
  }
  return null;
}

export function spaceRoleRoutes(app: FastifyInstance): void {
  // POST /api/spaces/:id/roles - Create a role
  app.post<{ Params: { id: string }; Body: { name: string; color?: string; permissions?: string } }>('/api/spaces/:id/roles', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, color, permissions } = request.body;
    const db = getDb();
    const rawDb = getRawDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    const roleName = name?.trim();
    if (!roleName) {
      return sendError(reply, 400, 'role_name_required');
    }

    // Check for case-insensitive duplicate name within the space
    const duplicate = rawDb.prepare(
      'SELECT id FROM roles WHERE space_id = ? AND name COLLATE NOCASE = ?'
    ).get(id, roleName);
    if (duplicate) {
      return sendError(reply, 409, 'role_name_taken');
    }

    const actorPerms = computePermissions(request.userId, id);
    let permStr: string;
    if (permissions !== undefined && permissions !== null) {
      const requested = parsePermissionString(permissions);
      if (requested === null) {
        return sendError(reply, 400, 'permissions_invalid');
      }
      const refusal = roleBitsChangeRefusal(actorPerms, 0n, requested);
      if (refusal) {
        return sendError(reply, 403, refusal);
      }
      permStr = permissionsToString(requested);
    } else {
      // Default to the @everyone baseline so new roles start functional,
      // limited to the bits the creator holds.
      permStr = permissionsToString(DEFAULT_EVERYONE_PERMISSIONS & actorPerms);
    }

    // A new role starts at the bottom, just above @everyone, so the actor
    // must be able to manage a role there.
    if (!canManageRoleInSpace(id, request.userId, 1)) {
      return sendError(reply, 403, 'role_hierarchy');
    }

    const roleId = generateSnowflake();
    db.insert(schema.roles).values({
      id: roleId,
      spaceId: id,
      name: roleName,
      color: color || '#b9bbbe',
      // Position 0 ties with nothing but @everyone's slot; the normalisation
      // below places the newest role last, at 1, and moves the others up.
      position: 0,
      permissions: permStr,
      createdAt: Date.now(),
    }).run();
    normalizeRolePositions(rawDb, id);

    const role = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();
    if (!role) {
      return sendError(reply, 500, 'internal_error');
    }

    // A new role has no holders yet, so nobody's own access changed.
    announceAccessChange(id, []);

    return reply.code(201).send(roleView(role, viewerReadsPermissionData(computePermissions(request.userId, id))));
  });

  // PATCH /api/spaces/:id/roles/:roleId - Update a role
  app.patch<{ Params: { id: string; roleId: string }; Body: { name?: string; color?: string; position?: number; above?: unknown; below?: unknown; permissions?: string; permissionsVersion?: unknown } }>('/api/spaces/:id/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, roleId } = request.params;
    const { name, color, permissions, above, below, permissionsVersion } = request.body;
    let position = request.body.position;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    const role = db.select().from(schema.roles)
      .where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, id)))
      .get();
    if (!role) {
      return sendError(reply, 404, 'role_not_in_space', { roleId });
    }

    // Only roles below the actor's top role can be edited or moved, and only
    // to a position that is still below it.
    const actorStanding = getHierarchyStanding(id, request.userId);
    if (!canManageRoleAt(actorStanding, role.position ?? 0)) {
      return sendError(reply, 403, 'role_hierarchy');
    }
    // A move by anchor (`above` or `below` another role) lands the role next
    // to that role in the order as it is now, so it does what the mover's list
    // showed even when that list is out of date; the request's `position`,
    // which clients send too for servers that do not read the anchor, is
    // ignored then (permissions.md, "Setting the order").
    if (above !== undefined || below !== undefined) {
      const side = above !== undefined ? 'above' : 'below';
      const anchorId = above ?? below;
      if (roleId === id || (above !== undefined && below !== undefined) || typeof anchorId !== 'string') {
        return sendError(reply, 400, 'validation_failed');
      }
      const anchor = db.select({ id: schema.roles.id }).from(schema.roles)
        .where(and(eq(schema.roles.id, anchorId), eq(schema.roles.spaceId, id)))
        .get();
      if (!anchor) {
        return sendError(reply, 400, 'role_not_in_space', { roleId: anchorId });
      }
      const placed = positionNextTo(getRawDb(), id, roleId, anchorId, side);
      if (placed === null) {
        return sendError(reply, 400, 'validation_failed');
      }
      position = placed;
    }
    if (position !== undefined) {
      // @everyone is always at 0, and positions count from 1.
      if (roleId === id || !Number.isInteger(position) || position < 1) {
        return sendError(reply, 400, 'validation_failed');
      }
      if (!canManageRoleAt(actorStanding, position)) {
        return sendError(reply, 403, 'role_hierarchy');
      }
    }

    const updates: Partial<typeof schema.roles.$inferInsert> = {};
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        return sendError(reply, 400, 'role_name_required');
      }
      // Check for case-insensitive duplicate name within the space
      const rawDb = getRawDb();
      const duplicate = rawDb.prepare(
        'SELECT id FROM roles WHERE space_id = ? AND name COLLATE NOCASE = ? AND id != ?'
      ).get(id, trimmed, roleId);
      if (duplicate) {
        return sendError(reply, 409, 'role_name_taken');
      }
      updates.name = trimmed;
    }
    if (color !== undefined) updates.color = color;

    if (permissions !== undefined) {
      const requested = parsePermissionString(permissions);
      if (requested === null) {
        return sendError(reply, 400, 'permissions_invalid');
      }
      // Concurrent edits (permissions.md): a value saved from an outdated copy
      // of the role is refused. Without `permissionsVersion` (a client from
      // before the check) the write is not compared, as before.
      if (permissionsVersion !== undefined) {
        if (typeof permissionsVersion !== 'string' || permissionsVersion.length === 0) {
          return sendError(reply, 400, 'validation_failed');
        }
        if (rolePermissionsVersion(role.permissions) !== permissionsVersion) {
          return sendError(reply, 409, 'role_permissions_conflict');
        }
      }
      // Held-bits rule: only bits the actor holds may be switched, on or off.
      const refusal = roleBitsChangeRefusal(
        computePermissions(request.userId, id),
        stringToPermissions(role.permissions),
        requested,
      );
      if (refusal) {
        return sendError(reply, 403, refusal);
      }
      updates.permissions = permissionsToString(requested);
    }

    if (Object.keys(updates).length === 0 && position === undefined) {
      return sendError(reply, 400, 'no_fields_to_update');
    }

    if (Object.keys(updates).length > 0) {
      db.update(schema.roles).set(updates).where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, id))).run();
    }
    // A move renumbers the other roles too, so positions stay distinct.
    if (position !== undefined) {
      moveRoleToPosition(getRawDb(), id, roleId, position);
    }
    const updated = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();
    if (!updated) {
      return sendError(reply, 404, 'role_not_in_space', { roleId });
    }

    announceAccessChange(id, membersHoldingRole(id, roleId));

    // The actor may have just switched off their own MANAGE_ROLES (a role
    // below their top role can carry it), so the answer is shaped for what
    // they hold now.
    return reply.code(200).send(roleView(updated, viewerReadsPermissionData(computePermissions(request.userId, id))));
  });

  // DELETE /api/spaces/:id/roles/:roleId - Delete a role
  app.delete<{ Params: { id: string; roleId: string } }>('/api/spaces/:id/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, roleId } = request.params;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    // Cannot delete @everyone role
    if (roleId === id) {
      return sendError(reply, 400, 'everyone_role_not_deletable');
    }

    // The overrides below are keyed by role id alone, so the role has to be
    // proven to belong to this space before its id is used to delete them.
    const role = db.select().from(schema.roles)
      .where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, id)))
      .get();
    if (!role) {
      return sendError(reply, 404, 'role_not_in_space', { roleId });
    }

    if (!canManageRoleInSpace(id, request.userId, role.position ?? 0)) {
      return sendError(reply, 403, 'role_hierarchy');
    }

    // Held-bits rule: deleting a role switches its bits off for everyone who
    // holds it, including members ranked above the actor.
    const deleteRefusal = roleBitsChangeRefusal(computePermissions(request.userId, id), stringToPermissions(role.permissions), 0n);
    if (deleteRefusal) {
      return sendError(reply, 403, deleteRefusal);
    }

    // Its holders, read before the delete takes their member_roles rows with it.
    const holders = membersHoldingRole(id, roleId);

    // Overrides name their target without a foreign key, so they would
    // outlive the role: invisible in the editor and impossible to remove.
    db.transaction((tx) => {
      tx.delete(schema.channelOverrides).where(
        and(eq(schema.channelOverrides.targetType, 'role'), eq(schema.channelOverrides.targetId, roleId))
      ).run();
      tx.delete(schema.categoryOverrides).where(
        and(eq(schema.categoryOverrides.targetType, 'role'), eq(schema.categoryOverrides.targetId, roleId))
      ).run();
      tx.delete(schema.roles).where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, id))).run();
    });
    normalizeRolePositions(getRawDb(), id);

    announceAccessChange(id, holders);

    return reply.code(200).send({ success: true });
  });

  // POST /api/spaces/:id/members/:uid/roles - Add role to member
  app.post<{ Params: { id: string; uid: string }; Body: { roleId: string } }>('/api/spaces/:id/members/:uid/roles', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const { roleId } = request.body;
    const db = getDb();

    const refusal = checkSingleRoleChange(id, request.userId, uid, roleId, 'add');
    if (refusal) return sendError(reply, refusal.status, refusal.code, refusal.details);

    db.insert(schema.memberRoles).values({
      spaceId: id,
      userId: uid,
      roleId,
    }).onConflictDoNothing().run();

    announceAccessChange(id, [uid]);

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/spaces/:id/members/:uid/roles/:roleId - Remove role from member
  app.delete<{ Params: { id: string; uid: string; roleId: string } }>('/api/spaces/:id/members/:uid/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid, roleId } = request.params;
    const db = getDb();

    const refusal = checkSingleRoleChange(id, request.userId, uid, roleId, 'remove');
    if (refusal) return sendError(reply, refusal.status, refusal.code, refusal.details);

    db.delete(schema.memberRoles).where(and(
      eq(schema.memberRoles.spaceId, id),
      eq(schema.memberRoles.userId, uid),
      eq(schema.memberRoles.roleId, roleId)
    )).run();

    announceAccessChange(id, [uid]);

    return reply.code(200).send({ success: true });
  });
}
