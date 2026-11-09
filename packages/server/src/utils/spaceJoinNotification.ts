import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from './snowflake.js';
import { buildMessageWithUser } from '../routes/messages.js';
import { channelSystemContent } from '@backspace/shared/src/channelSystemEvents.js';
import { connectionManager } from '../ws/handler.js';
import { dmSystemName } from './dmSystemMessages.js';

/**
 * Sends a system welcome message to the space's configured system channel
 * when a user joins the space.
 *
 * If no system channel is configured, or the channel is missing/non-text,
 * this is a no-op.
 */
export function sendSpaceJoinNotification(
  spaceId: string,
  joiningUser: typeof schema.users.$inferSelect,
): void {
  const db = getDb();
  const space = db.select({
    id: schema.spaces.id,
    systemChannelId: schema.spaces.systemChannelId,
    welcomeMessage: schema.spaces.welcomeMessage,
  }).from(schema.spaces).where(eq(schema.spaces.id, spaceId)).get();

  if (!space?.systemChannelId) {
    return;
  }

  // Ensure systemChannel belongs to this space and is a text channel
  const channel = db.select({ id: schema.channels.id })
    .from(schema.channels)
    .where(and(
      eq(schema.channels.id, space.systemChannelId),
      eq(schema.channels.spaceId, spaceId),
      eq(schema.channels.type, 'text'),
    )).get();

  if (!channel) {
    return;
  }

  const displayName = dmSystemName(joiningUser);
  const now = Date.now();
  const messageId = generateSnowflake();

  const content = channelSystemContent({
    event: 'member_join',
    userId: joiningUser.id,
    displayName,
    customMessage: space.welcomeMessage ?? null,
  });

  const row = db.insert(schema.messages).values({
    id: messageId,
    channelId: channel.id,
    userId: joiningUser.id,
    type: 'system',
    content,
    createdAt: now,
  }).returning().get();

  const messageWithUser = buildMessageWithUser(row, joiningUser, []);

  connectionManager.sendToChannel(spaceId, channel.id, {
    type: 'message_created',
    message: messageWithUser,
  });
}
