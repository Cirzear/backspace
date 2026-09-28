import { DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@backspace/shared/src/permissions.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb, getRawDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors';
import { hasPermission, PermissionBits } from '../utils/permissions.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { checkVoicePermissions } from '../ws/events.js';
import { connectionManager } from '../ws/handler.js';

export function spaceRoleRoutes(app: FastifyInstance): void {
  // POST /api/spaces/:id/roles - Create a new role
  app.post<{ Params: { id: string }; Body: { name: string; color?: string; permissions?: string } }>('/api/spaces/:id/roles', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, color, permissions } = request.body;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    // Validate permissions string is a valid bigint if provided
    let permStr: string;
    if (permissions !== undefined && permissions !== null) {
      try {
        BigInt(permissions);
        permStr = permissions;
      } catch {
        return sendError(reply, 400, 'permissions_invalid');
      }
    } else {
      // Default to @everyone baseline so new roles start functional
      permStr = permissionsToString(DEFAULT_EVERYONE_PERMISSIONS);
    }

    // Trim and validate name
    const roleName = (name || 'new role').trim() || 'new role';

    // Check for case-insensitive duplicate name within the space
    const rawDb = getRawDb();
    const duplicate = rawDb.prepare(
      'SELECT id FROM roles WHERE space_id = ? AND name COLLATE NOCASE = ?'
    ).get(id, roleName);
    if (duplicate) {
      return sendError(reply, 409, 'role_name_taken');
    }

    const roleId = generateSnowflake();
    db.insert(schema.roles).values({
      id: roleId,
      spaceId: id,
      name: roleName,
      color: color || '#b9bbbe',
      position: 0,
      permissions: permStr,
      createdAt: Date.now(),
    }).run();

    const role = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();

    // Broadcast updated state to all space members
    const memberRows = db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.spaceId, id)).all();
    for (const m of memberRows) {
      connectionManager.pushReadyPayload(m.userId);
    }
    checkVoicePermissions(id);

    return reply.code(201).send(role);
  });

  // PATCH /api/spaces/:id/roles/:roleId - Update a role
  app.patch<{ Params: { id: string; roleId: string }; Body: { name?: string; color?: string; position?: number; permissions?: string } }>('/api/spaces/:id/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, roleId } = request.params;
    const { name, color, position, permissions } = request.body;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
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
    if (position !== undefined) updates.position = position;

    if (permissions !== undefined) {
      try {
        BigInt(permissions);
        updates.permissions = permissions;
      } catch {
        return sendError(reply, 400, 'permissions_invalid');
      }
    }

    if (Object.keys(updates).length === 0) {
      return sendError(reply, 400, 'no_fields_to_update');
    }

    db.update(schema.roles).set(updates).where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, id))).run();
    const updated = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();

    // Broadcast updated state to all space members
    const memberRows = db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.spaceId, id)).all();
    for (const m of memberRows) {
      connectionManager.pushReadyPayload(m.userId);
    }
    checkVoicePermissions(id);

    return reply.code(200).send(updated);
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

    // Broadcast updated state to all space members
    const memberRows = db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.spaceId, id)).all();
    for (const m of memberRows) {
      connectionManager.pushReadyPayload(m.userId);
    }
    checkVoicePermissions(id);

    return reply.code(200).send({ success: true });
  });

  // POST /api/spaces/:id/members/:uid/roles - Add role to member
  app.post<{ Params: { id: string; uid: string }; Body: { roleId: string } }>('/api/spaces/:id/members/:uid/roles', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const { roleId } = request.body;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    db.insert(schema.memberRoles).values({
      spaceId: id,
      userId: uid,
      roleId,
    }).run();

    connectionManager.pushReadyPayload(uid);
    return reply.code(200).send({ success: true });
  });

  // DELETE /api/spaces/:id/members/:uid/roles/:roleId - Remove role from member
  app.delete<{ Params: { id: string; uid: string; roleId: string } }>('/api/spaces/:id/members/:uid/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid, roleId } = request.params;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    db.delete(schema.memberRoles).where(and(
      eq(schema.memberRoles.spaceId, id),
      eq(schema.memberRoles.userId, uid),
      eq(schema.memberRoles.roleId, roleId)
    )).run();

    connectionManager.pushReadyPayload(uid);
    return reply.code(200).send({ success: true });
  });
}
