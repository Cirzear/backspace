import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { connectionManager } from './connectionManager.js';
import { isMember, getChannelSpaceId, isDmMember, isDeadOneOnOne, hasPermission, PermissionBits } from '../utils/permissions.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { appendMutationLog, dmMessageFederationRef, queueOutboxEvent, getGroupDmTargetOrigins } from '../utils/federationOutbox.js';
import { getOurOrigin } from '../utils/federationAuth.js';

// ─── Reaction Handlers ─────────────────────────────────────────────────────

export function handleReactionAdd(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;
  const emoji = event.emoji as string;

  if (!messageId || !emoji) return;

  const db = getDb();

  // Try space message first
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (message) {
    const spaceId = getChannelSpaceId(message.channelId);
    if (!spaceId || !isMember(spaceId, userId)) return;

    if (!hasPermission(userId, spaceId, PermissionBits.ADD_REACTIONS, message.channelId)) {
      connectionManager.sendToUser(userId, { type: 'error', message: 'Missing ADD_REACTIONS permission' });
      return;
    }

    const reactionId = generateSnowflake();
    const now = Date.now();
    const result = db.insert(schema.reactions).values({
      id: reactionId,
      messageId,
      userId,
      emoji,
      createdAt: now,
    }).onConflictDoNothing({
      target: [schema.reactions.messageId, schema.reactions.userId, schema.reactions.emoji],
    }).run();
    // Only this identity conflict is a no-op; unrelated storage failures must surface.
    if (result.changes === 0) return;

    // Include user object so remote clients can use isSelf() for identity resolution
    const reactionUser = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    const userObj = reactionUser ? sanitizeUser(reactionUser) : undefined;

    connectionManager.sendToChannel(spaceId, message.channelId, {
      type: 'reaction_added',
      messageId,
      reaction: { id: reactionId, messageId, userId, emoji, createdAt: now, user: userObj },
    });
    return;
  }

  // Fall through to DM message. A federated account reacts here like anyone
  // else: it is a member of the DM on this instance, and the relay carries its
  // home identity back to its home instance.
  const dmMsg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, messageId)).get();
  if (!dmMsg || !isDmMember(dmMsg.dmChannelId, userId)) return;
  // Read-only enforcement: a dead 1-on-1 thread (partner tombstoned) accepts no
  // reaction mutations — the relay would fan out to all peers via undefined origins.
  if (isDeadOneOnOne(dmMsg.dmChannelId, userId)) return;

  const reactionId = generateSnowflake();
  const now = Date.now();
  const result = db.insert(schema.dmReactions).values({
    id: reactionId,
    dmMessageId: messageId,
    userId,
    emoji,
    createdAt: now,
  }).onConflictDoNothing({
    target: [schema.dmReactions.dmMessageId, schema.dmReactions.userId, schema.dmReactions.emoji],
  }).run();
  // Duplicate adds must not broadcast or create a second federation mutation/outbox event.
  if (result.changes === 0) return;

  // Include user object so remote clients can use isSelf() for identity resolution
  const reactionUser = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const userObj = reactionUser ? sanitizeUser(reactionUser) : undefined;

  connectionManager.sendToDmMembers(dmMsg.dmChannelId, {
    type: 'reaction_added',
    messageId,
    reaction: { id: reactionId, messageId, userId, emoji, createdAt: now, user: userObj },
  });

  // Federation: log reaction mutation and queue for relay. The relay names
  // the message in shared coordinates; `messageId` is only local here.
  const target = dmMessageFederationRef(dmMsg);
  appendMutationLog(messageId, dmMsg.dmChannelId, 'reaction_add', JSON.stringify({
    userId,
    homeUserId: reactionUser?.homeUserId || userId,
    homeInstance: reactionUser?.homeInstance || getOurOrigin(),
    emoji,
    createdAt: now,
  }));
  const reactionAddTargetOrigins = getGroupDmTargetOrigins(dmMsg.dmChannelId);
  queueOutboxEvent(reactionId, dmMsg.dmChannelId, 'reaction_add', JSON.stringify({
    reaction: {
      messageId: target.messageId,
      messageHomeInstance: target.messageHomeInstance,
      userId,
      homeUserId: reactionUser?.homeUserId || userId,
      homeInstance: reactionUser?.homeInstance || getOurOrigin(),
      emoji,
      createdAt: now,
    },
  }), reactionAddTargetOrigins);
}

export function handleReactionRemove(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;
  const emoji = event.emoji as string;

  if (!messageId || !emoji) return;

  const db = getDb();

  // Try space message first
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (message) {
    const spaceId = getChannelSpaceId(message.channelId);
    if (!spaceId || !isMember(spaceId, userId)) return;

    const result = db.delete(schema.reactions)
      .where(and(
        eq(schema.reactions.messageId, messageId),
        eq(schema.reactions.userId, userId),
        eq(schema.reactions.emoji, emoji)
      ))
      .run();

    if (result.changes > 0) {
      connectionManager.sendToChannel(spaceId, message.channelId, {
        type: 'reaction_removed',
        messageId,
        userId,
        emoji,
      });
    }
    return;
  }

  // Fall through to DM message. A federated account reacts here like anyone
  // else: it is a member of the DM on this instance, and the relay carries its
  // home identity back to its home instance.
  const dmMsg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, messageId)).get();
  if (!dmMsg || !isDmMember(dmMsg.dmChannelId, userId)) return;
  // Read-only enforcement: a dead 1-on-1 thread (partner tombstoned) accepts no
  // reaction mutations — the relay would fan out to all peers via undefined origins.
  if (isDeadOneOnOne(dmMsg.dmChannelId, userId)) return;

  const result = db.delete(schema.dmReactions)
    .where(and(
      eq(schema.dmReactions.dmMessageId, messageId),
      eq(schema.dmReactions.userId, userId),
      eq(schema.dmReactions.emoji, emoji)
    ))
    .run();

  if (result.changes > 0) {
    connectionManager.sendToDmMembers(dmMsg.dmChannelId, {
      type: 'reaction_removed',
      messageId,
      userId,
      emoji,
    });

    // Federation: log reaction removal and queue for relay
    const removingUser = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    const target = dmMessageFederationRef(dmMsg);
    appendMutationLog(messageId, dmMsg.dmChannelId, 'reaction_remove', JSON.stringify({
      userId,
      homeUserId: removingUser?.homeUserId || userId,
      homeInstance: removingUser?.homeInstance || getOurOrigin(),
      emoji,
    }));
    const reactionRemoveTargetOrigins = getGroupDmTargetOrigins(dmMsg.dmChannelId);
    queueOutboxEvent(
      `${messageId}:${userId}:${emoji}`,
      dmMsg.dmChannelId,
      'reaction_remove',
      JSON.stringify({
        reaction: {
          messageId: target.messageId,
          messageHomeInstance: target.messageHomeInstance,
          userId,
          homeUserId: removingUser?.homeUserId || userId,
          homeInstance: removingUser?.homeInstance || getOurOrigin(),
          emoji,
        },
      }),
      reactionRemoveTargetOrigins,
    );
  }
}
