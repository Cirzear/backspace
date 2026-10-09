import type { ErrorCode, ErrorDetails } from '@backspace/shared/src/errors';
import type { JoinSpaceRequest, MemberWithUser } from '@backspace/shared';
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors';
import { hasPermission, isBanned, isMember, PermissionBits } from '../utils/permissions.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { getLocalInvitePreview } from '../utils/spaceInviteSnapshot.js';
import { connectionManager } from '../ws/handler.js';
import { rowToSpace } from './spaceSerialization.js';

interface InviteJoinRefusal {
  status: number;
  code: ErrorCode;
  details?: ErrorDetails;
}

/**
 * Why a valid invite code does not admit this user, or null when it does.
 * Shared by both join-by-code routes. Read against the space's visibility at
 * the time of the call, so a link follows the space when its visibility
 * changes.
 *
 * Banned and already-member answer as every join path does. A request space
 * never admits anyone by code: entry is `POST /api/spaces/:id/request-join`
 * and a manager's approval. A user with a request waiting is told so
 * (`409 join_request_pending`, the answer the request route gives); anyone
 * else gets `403 join_request_required` with the space's id, which is all a
 * client needs to send the request. Private and public spaces admit by code.
 */
function inviteJoinRefusal(space: typeof schema.spaces.$inferSelect, userId: string): InviteJoinRefusal | null {
  if (isBanned(space.id, userId)) {
    return { status: 403, code: 'user_banned' };
  }
  if (isMember(space.id, userId)) {
    return { status: 409, code: 'already_member' };
  }
  if (space.visibility === 'request') {
    const pending = getDb().select({ id: schema.joinRequests.id }).from(schema.joinRequests)
      .where(and(
        eq(schema.joinRequests.spaceId, space.id),
        eq(schema.joinRequests.userId, userId),
        eq(schema.joinRequests.status, 'pending'),
      ))
      .get();
    if (pending) {
      return { status: 409, code: 'join_request_pending' };
    }
    return { status: 403, code: 'join_request_required', details: { spaceId: space.id } };
  }
  return null;
}

/**
 * Add a member admitted by an invite code: the membership row, the user's
 * WebSocket subscription to the space, and `member_joined` to the space.
 */
function admitByInvite(spaceId: string, userId: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(schema.spaceMembers).values({
    spaceId,
    userId,
    joinedAt: now,
  }).run();

  // Register the user in connectionManager so they receive WS broadcasts for this space
  connectionManager.addUserSpace(userId, spaceId);

  // Broadcast member_joined to existing space members
  const joiningUser = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (joiningUser) {
    const memberPayload: MemberWithUser = {
      spaceId,
      userId,
      nickname: null,
      joinedAt: now,
      user: sanitizeUser(joiningUser),
      roles: [],
    };
    connectionManager.sendToSpace(spaceId, {
      type: 'member_joined',
      spaceId,
      member: memberPayload,
    });
  }
}

export function spaceInviteRoutes(app: FastifyInstance): void {
  // POST /api/spaces/:id/invite - Generate invite code (admin+)
  app.post<{ Params: { id: string } }>('/api/spaces/:id/invite', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (!hasPermission(request.userId, id, PermissionBits.CREATE_INVITE)) {
      // Owners and instance admins always pass hasPermission, so anyone who lands
      // here is either a non-member or a member without CREATE_INVITE. Give the
      // non-member a clearer "go join first" message instead of a permission error.
      if (!isMember(id, request.userId)) {
        return sendError(reply, 403, 'not_space_member');
      }
      return sendError(reply, 403, 'missing_permission', { permission: 'CREATE_INVITE' });
    }

    // Every space hands out its link, a request space included: the link
    // never admits anyone to a request space (see inviteJoinRefusal), it leads
    // to the join request flow.

    // Return existing invite code if one exists, otherwise generate a new one
    if (server.inviteCode) {
      return reply.code(200).send({ inviteCode: server.inviteCode });
    }

    const inviteCode = crypto.randomBytes(4).toString('hex');
    db.update(schema.spaces).set({ inviteCode }).where(eq(schema.spaces.id, id)).run();

    return reply.code(200).send({ inviteCode });
  });

  // POST /api/spaces/:id/join - Join server by invite code
  app.post<{ Params: { id: string }; Body: JoinSpaceRequest }>('/api/spaces/:id/join', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { inviteCode } = request.body;

    if (!inviteCode || typeof inviteCode !== 'string') {
      return sendError(reply, 400, 'invite_code_required');
    }

    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (server.inviteCode !== inviteCode) {
      return sendError(reply, 400, 'invite_not_found');
    }

    const refusal = inviteJoinRefusal(server, request.userId);
    if (refusal) {
      return sendError(reply, refusal.status, refusal.code, refusal.details);
    }

    admitByInvite(server.id, request.userId);
    return reply.code(200).send(rowToSpace(server));
  });

  // POST /api/spaces/join - Join server by invite code (no server ID needed)
  app.post<{ Body: JoinSpaceRequest }>('/api/spaces/join', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { inviteCode } = request.body;

    if (!inviteCode || typeof inviteCode !== 'string') {
      return sendError(reply, 400, 'invite_code_required');
    }

    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.inviteCode, inviteCode)).get();
    if (!server) {
      return sendError(reply, 404, 'invite_not_found');
    }

    const refusal = inviteJoinRefusal(server, request.userId);
    if (refusal) {
      return sendError(reply, refusal.status, refusal.code, refusal.details);
    }

    admitByInvite(server.id, request.userId);
    return reply.code(200).send(rowToSpace(server));
  });

  // GET /api/spaces/invite/:code/preview — Public invite preview (no auth)
  app.get<{ Params: { code: string } }>('/api/spaces/invite/:code/preview', async (request, reply) => {
    const { code } = request.params;
    const preview = getLocalInvitePreview(code);
    if (!preview) {
      return sendError(reply, 404, 'invite_not_found');
    }
    return reply.code(200).send(preview);
  });

  // ─── Ban Management ───────────────────────────────────────────────────────
}
