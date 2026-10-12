import type { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { generateSnowflake } from '../utils/snowflake.js';
import { buildMessageWithUser } from '../routes/messages.js';
import { dmSystemName } from '../utils/dmSystemMessages.js';
import { channelSystemContent } from '@backspace/shared/src/channelSystemEvents.js';
import { getDb, schema } from '../db/index.js';
import { getChannelSpaceId, getMember, hasPermission, PermissionBits } from '../utils/permissions.js';
import { connectionManager } from './handler.js';
import { errorText } from '../utils/httpErrors.js';
import { createFixedWindowLimit } from '../utils/fixedWindowLimit.js';
import type { ErrorCode, ErrorDetails } from '@backspace/shared/src/errors';

/**
 * Refuse a poke with a coded `error` on the socket that sent it, as
 * `refuseDmMessage` does: the client shows the code's text in the user's
 * language, and the user's other sessions did not ask, so they are not told.
 */
function refusePoke(ws: WebSocket, code: ErrorCode, details?: ErrorDetails): void {
  connectionManager.sendToWs(ws, details
    ? { type: 'error', message: errorText(code, details), code, details }
    : { type: 'error', message: errorText(code), code });
}

/**
 * How often one member may poke: 5 pokes per minute, counted per actor (the
 * row id on this instance, so each federated account counts on its own),
 * across every channel and target. A poke is a stored row that every viewer of
 * the channel receives and that plays a cue on its target, so it is held well
 * below the per-user limit on every WebSocket event (30 at once, 2 a second).
 */
export const CHANNEL_POKE_RATE_LIMIT = { max: 5, windowMs: 60_000 } as const;

const pokeLimit = createFixedWindowLimit(CHANNEL_POKE_RATE_LIMIT);

/** Tests only: forget every actor's window. */
export function _resetChannelPokeLimit(): void {
  pokeLimit.reset();
}

/**
 * `channel_poke`: the actor pokes a member in a space channel. The instance
 * hosting the space checks the request, stores a system message and sends
 * it to everyone who can see the channel in one `channel_poke` event, after
 * the row is stored. The client adds the row to the timeline without an alert
 * and plays the poke cue for those viewing the channel (websocket.md,
 * "Channel pokes").
 */
export function handleChannelPoke({ event, userId, ws }: {
  event: Record<string, unknown>; userId: string; ws: WebSocket;
}): void {
  const { channelId, targetUserId } = event;
  if (typeof channelId !== 'string' || typeof targetUserId !== 'string') {
    refusePoke(ws, 'validation_failed'); return;
  }
  // A channel the actor cannot see answers as one that does not exist.
  const spaceId = getChannelSpaceId(channelId);
  if (!spaceId || !hasPermission(userId, spaceId, PermissionBits.VIEW_CHANNEL, channelId)) {
    refusePoke(ws, 'channel_not_found'); return;
  }
  if (!hasPermission(userId, spaceId, PermissionBits.SEND_MESSAGES, channelId)) {
    refusePoke(ws, 'missing_permission', { permission: 'SEND_MESSAGES' }); return;
  }
  const db = getDb();
  const actor = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const target = db.select().from(schema.users).where(eq(schema.users.id, targetUserId)).get();
  // The target is a member of the space: an instance admin who never joined
  // holds every permission there but is not someone to poke.
  const targetMember = getMember(spaceId, targetUserId);
  if (!actor || !target || !targetMember) { refusePoke(ws, 'member_not_found'); return; }
  if (!hasPermission(targetUserId, spaceId, PermissionBits.VIEW_CHANNEL, channelId)) {
    refusePoke(ws, 'poke_target_no_access'); return;
  }
  // Counted only once a poke would be stored, so a refused one costs nothing.
  if (!pokeLimit.consume(userId)) {
    refusePoke(ws, 'rate_limited'); return;
  }
  // The target's name in this space when the poke happened: the snapshot a
  // client shows once the target has left (channelSystemEvents.ts).
  const targetDisplayName = targetMember.nickname || dmSystemName(target);
  const row = db.insert(schema.messages).values({
    id: generateSnowflake(), channelId, userId, type: 'system',
    content: channelSystemContent({ event: 'channel_poke', targetUserId, targetDisplayName }),
    createdAt: Date.now(),
  }).returning().get();
  // One event carries the stored row. It is not a message_created: a client
  // from before pokes ignores an event type it does not know, where it would
  // treat a message_created as a new message (an unread dot, a message sound,
  // a notification showing the JSON content). It reads the row from history
  // later as a system message it does not know. No unread count follows it,
  // since a poke does not count as unread.
  connectionManager.sendToChannel(spaceId, channelId, {
    type: 'channel_poke',
    message: buildMessageWithUser(row, actor, []),
  });
}
