import type { ServerEvent } from '@backspace/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { hasPermission, PermissionBits } from '../utils/permissions.js';

/** Exact unread message counts, never channel counts. Own messages do not alert. */
export function channelUnreadCounts(userId: string, channelIds: string[]): Record<string, number> {
  if (!channelIds.length) return {};
  const db = getDb();
  const channels = db.select().from(schema.channels).where(inArray(schema.channels.id, channelIds)).all()
    .filter(ch => hasPermission(userId, ch.spaceId, PermissionBits.VIEW_CHANNEL, ch.id)
      && hasPermission(userId, ch.spaceId, PermissionBits.READ_MESSAGE_HISTORY, ch.id));
  const counts: Record<string, number> = {};
  for (const channel of channels) {
    const read = db.select().from(schema.readStates).where(and(
      eq(schema.readStates.userId, userId), eq(schema.readStates.channelId, channel.id),
    )).get();
    // IDs are decimal snowflakes stored as TEXT: compare numerically, not lexically.
    const result = db.select({ count: sql<number>`count(*)` }).from(schema.messages).where(and(
      eq(schema.messages.channelId, channel.id), ne(schema.messages.userId, userId),
      sql`cast(${schema.messages.id} as integer) > cast(${read?.lastReadMessageId ?? '0'} as integer)`,
    )).get();
    counts[channel.id] = result!.count;
  }
  return counts;
}

/** Publish snapshots on the same ordered socket as mutations, with no client polling/rate-limit load. */
export function unreadCountEvent(userId: string, event: ServerEvent): ServerEvent | null {
  let channelId: string;
  switch (event.type) {
    case 'message_created': channelId = event.message.channelId; break;
    case 'message_deleted':
    case 'channel_ack':
    case 'mark_unread': channelId = event.channelId; break;
    case 'channel_created':
    case 'channel_updated': channelId = event.channel.id; break;
    case 'channel_deleted': return { type: 'channel_unread_count', counts: { [event.channelId]: 0 } };
    default: return null;
  }
  return { type: 'channel_unread_count', counts: { [channelId]: 0, ...channelUnreadCounts(userId, [channelId]) } };
}
