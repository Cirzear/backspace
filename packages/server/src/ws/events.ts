import { handleChannelPoke } from './channelPoke.js';
import type { WebSocket } from 'ws';
import { hasMassMention } from '@backspace/shared/src/mentions.js';
import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { connectionManager } from './connectionManager.js';
import { isMember, getChannelSpaceId, isDmMember, hasPermission, PermissionBits } from '../utils/permissions.js';
import { broadcastDmMessage, getDmMessageWithUser, isDmReplyTargetInChannel } from '../routes/dm.js';
import { fetchReplyToMessages, isReplyTargetInChannel } from '../routes/messages.js';
import { MAX_MESSAGE_LENGTH, isChosenUserStatus, type MessageWithUser, type Attachment } from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';
import { collectProfileBroadcastTargetIds } from '../utils/userDeletion.js';
import { applyChosenStatus } from './presence.js';
import { presenceUpdateFor, validateActivities } from './presenceEvent.js';
import { deleteAttachmentFiles } from '../utils/fileCleanup.js';
import { resolveEmbeds, embedRowToEmbed } from '../utils/embedResolver.js';
import { dmMessageMutationTarget, queueDmRelay, queueDmMessageDeleteRelay, sendTypingRelay, queueReadStateRelay } from '../utils/federationOutbox.js';
import { handleReactionAdd, handleReactionRemove } from './reactionEvents.js';
import { handleVoiceJoin, handleVoiceLeave, handleVoiceStatus, handleVoiceSpaceMute, handleVoiceSpaceDeafen, handleVoiceMove, handleVoiceDisconnect } from './voiceEvents.js';
import { handleDmCallStart, handleDmCallAccept, handleDmCallReject, handleDmCallEnd } from './dmCallEvents.js';

// Keep the established public entry points while implementations stay domain-scoped.
export { checkVoicePermissions } from './voiceEvents.js';
export {
  registerCallRelayHooks,
  handleDmCallAcceptForTest,
  handleDmCallRejectForTest,
  handleDmCallEndForTest,
  sendFederatedCallStartForTest,
} from './dmCallEvents.js';

function getMessageWithUser(messageId: string): MessageWithUser | null {
  const db = getDb();
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!message) return null;

  const user = db.select().from(schema.users).where(eq(schema.users.id, message.userId)).get();
  if (!user) return null;

  const attachmentRows = db.select()
    .from(schema.attachments)
    .where(eq(schema.attachments.messageId, messageId))
    .all();

  const attachments: Attachment[] = attachmentRows.map(a => ({
    id: a.id,
    messageId: a.messageId ?? messageId,
    filename: a.filename,
    originalName: a.originalName,
    mimetype: a.mimetype,
    size: a.size,
    thumbnailFilename: a.thumbnailFilename ?? null,
    width: a.width ?? null,
    height: a.height ?? null,
    duration: a.duration ?? null,
    playable: a.playable ?? null,
    createdAt: a.createdAt,
  }));

  const reactionRows = db.select()
    .from(schema.reactions)
    .where(eq(schema.reactions.messageId, messageId))
    .all();

  const reactions = reactionRows.map(r => ({
    id: r.id,
    messageId: r.messageId,
    userId: r.userId,
    emoji: r.emoji,
    createdAt: r.createdAt,
  }));

  const embedRows = db.select()
    .from(schema.embeds)
    .where(eq(schema.embeds.messageId, messageId))
    .all();

  // Reply targets are confined to the message's own channel. This is the same
  // helper the REST read paths use, so both stay on one rule.
  let replyTo: MessageWithUser | null = null;
  if (message.replyToId) {
    const replyToMap = fetchReplyToMessages(message.channelId, [message]);
    replyTo = replyToMap.get(message.replyToId) ?? null;
  }

  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.userId,
    replyToId: message.replyToId,
    content: message.content,
    editedAt: message.editedAt,
    createdAt: message.createdAt,
    user: sanitizeUser(user),
    attachments,
    embeds: embedRows.map(e => embedRowToEmbed(e)),
    reactions,
    replyTo,
  };
}

// Typing timeout tracking (capped to prevent unbounded growth)
const MAX_TYPING_ENTRIES = 10_000;
const typingTimeouts: Map<string, NodeJS.Timeout> = new Map();

export function handleClientEvent(
  event: Record<string, unknown>,
  userId: string,
  username: string,
  ws: WebSocket,
  isFederated: boolean,
): void {
  const type = event.type as string;

  switch (type) {
    case 'message_create':
      handleMessageCreate(event, userId);
      break;
    case 'message_edit':
      handleMessageEdit(event, userId);
      break;
    case 'message_delete':
      handleMessageDelete(event, userId);
      break;
    case 'channel_poke':
      handleChannelPoke({ event, userId, ws });
      break;
    case 'typing_start':
      handleTypingStart(event, userId, username);
      break;
    case 'presence_update':
      handlePresenceUpdate(event, userId);
      break;
    case 'voice_join':
      handleVoiceJoin(event, userId, ws);
      break;
    case 'voice_leave':
      handleVoiceLeave(userId);
      break;
    case 'dm_message_create':
      handleDmMessageCreate(event, userId);
      break;
    case 'dm_typing_start':
      handleDmTypingStart(event, userId, username);
      break;
    case 'dm_message_edit':
      handleDmMessageEdit(event, userId);
      break;
    case 'dm_message_delete':
      handleDmMessageDelete(event, userId);
      break;
    case 'reaction_add':
      handleReactionAdd(event, userId);
      break;
    case 'reaction_remove':
      handleReactionRemove(event, userId);
      break;
    case 'channel_ack':
      handleChannelAck(event, userId, isFederated);
      break;
    case 'mark_unread':
      handleMarkUnread(event, userId, isFederated);
      break;
    case 'dm_call_start':
      handleDmCallStart(event, userId, username, ws);
      break;
    case 'dm_call_accept':
      handleDmCallAccept(event, userId, ws).catch(err =>
        console.error('[ws] handleDmCallAccept error:', err),
      );
      break;
    case 'dm_call_reject':
      handleDmCallReject(event, userId).catch(err =>
        console.error('[ws] handleDmCallReject error:', err),
      );
      break;
    case 'dm_call_end':
      handleDmCallEnd(event, userId).catch(err =>
        console.error('[ws] handleDmCallEnd error:', err),
      );
      break;
    case 'voice_status':
      handleVoiceStatus(event, userId, ws);
      break;
    case 'voice_space_mute':
      handleVoiceSpaceMute(event, userId);
      break;
    case 'voice_space_deafen':
      handleVoiceSpaceDeafen(event, userId);
      break;
    case 'voice_move':
      handleVoiceMove(event, userId);
      break;
    case 'voice_disconnect':
      handleVoiceDisconnect(event, userId);
      break;
    case 'activity_update':
      handleActivityUpdate(event, userId);
      break;
    default:
      connectionManager.sendToUser(userId, {
        type: 'error',
        message: `Unknown event type: ${type}`,
      });
  }
}

function handleMessageCreate(event: Record<string, unknown>, userId: string): void {
  const channelId = event.channelId as string;
  const content = event.content as string;
  const replyToId = event.replyToId as string | undefined;

  if (!channelId || typeof channelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'channelId is required' });
    return;
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'content is required' });
    return;
  }

  if (content.length > MAX_MESSAGE_LENGTH) {
    connectionManager.sendToUser(userId, { type: 'error', message: `Message content must be ${MAX_MESSAGE_LENGTH} characters or less` });
    return;
  }

  const spaceId = getChannelSpaceId(channelId);
  if (!spaceId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Channel not found' });
    return;
  }

  if (!hasPermission(userId, spaceId, PermissionBits.SEND_MESSAGES, channelId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing SEND_MESSAGES permission' });
    return;
  }

  if (hasMassMention(content) && !hasPermission(userId, spaceId, PermissionBits.MENTION_EVERYONE, channelId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing MENTION_EVERYONE permission' });
    return;
  }

  // A reply may only target a message in the channel it is posted into.
  if (replyToId && !isReplyTargetInChannel(channelId, replyToId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Invalid reply target' });
    return;
  }

  const db = getDb();
  const messageId = generateSnowflake();
  const now = Date.now();

  db.insert(schema.messages).values({
    id: messageId,
    channelId,
    userId,
    replyToId: replyToId || null,
    content: content.trim(),
    createdAt: now,
  }).run();

  const messageWithUser = getMessageWithUser(messageId);
  if (messageWithUser) {
    // Broadcast to members with VIEW_CHANNEL on this channel
    connectionManager.sendToChannel(spaceId, channelId, {
      type: 'message_created',
      message: messageWithUser,
    });

    // Resolve embeds asynchronously
    setImmediate(() => {
      resolveEmbeds(messageId, content.trim(), channelId, false, spaceId).catch(() => {});
    });
  }
}

function handleMessageEdit(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;
  const content = event.content as string;

  if (!messageId || typeof messageId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'messageId is required' });
    return;
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'content is required' });
    return;
  }

  if (content.length > MAX_MESSAGE_LENGTH) {
    connectionManager.sendToUser(userId, { type: 'error', message: `Message content must be ${MAX_MESSAGE_LENGTH} characters or less` });
    return;
  }

  const db = getDb();
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!message) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Message not found' });
    return;
  }

  if (message.userId !== userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You can only edit your own messages' });
    return;
  }

  // The transport and edit path must enforce the same permission as REST creation.
  const mentionSpaceId = getChannelSpaceId(message.channelId);
  if (hasMassMention(content) && (!mentionSpaceId || !hasPermission(userId, mentionSpaceId, PermissionBits.MENTION_EVERYONE, message.channelId))) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing MENTION_EVERYONE permission' });
    return;
  }

  const now = Date.now();
  db.update(schema.messages)
    .set({ content: content.trim(), editedAt: now })
    .where(eq(schema.messages.id, messageId))
    .run();

  const spaceId = getChannelSpaceId(message.channelId);
  if (!spaceId) return;

  // Delete old embeds synchronously so the broadcast reflects the edit
  db.delete(schema.embeds).where(eq(schema.embeds.messageId, messageId)).run();

  const updatedMessage = getMessageWithUser(messageId);
  if (updatedMessage) {
    connectionManager.sendToChannel(spaceId, message.channelId, {
      type: 'message_updated',
      message: updatedMessage,
    });

    // Resolve new embeds asynchronously (old ones already deleted above)
    setImmediate(() => {
      resolveEmbeds(messageId, content.trim(), message.channelId, false, spaceId).catch(() => {});
    });
  }
}

function handleMessageDelete(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;

  if (!messageId || typeof messageId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'messageId is required' });
    return;
  }

  const db = getDb();
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!message) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Message not found' });
    return;
  }

  const spaceId = getChannelSpaceId(message.channelId);
  if (!spaceId) return;

  // Allow author or MANAGE_MESSAGES permission holder to delete
  const isAuthor = message.userId === userId;
  const canManageMessages = hasPermission(userId, spaceId, PermissionBits.MANAGE_MESSAGES, message.channelId);

  if (!isAuthor && !canManageMessages) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You cannot delete this message' });
    return;
  }

  // Collect attachment filenames before deletion
  const attachmentRows = db.select({ filename: schema.attachments.filename })
    .from(schema.attachments).where(eq(schema.attachments.messageId, messageId)).all();

  // Delete attachments + message atomically, file cleanup outside transaction
  db.transaction((tx) => {
    tx.delete(schema.attachments).where(eq(schema.attachments.messageId, messageId)).run();
    tx.delete(schema.messages).where(eq(schema.messages.id, messageId)).run();
  });

  // Clean up files from disk (outside transaction — file I/O)
  deleteAttachmentFiles(attachmentRows);

  connectionManager.sendToChannel(spaceId, message.channelId, {
    type: 'message_deleted',
    messageId,
    channelId: message.channelId,
  });
}

function handleTypingStart(event: Record<string, unknown>, userId: string, username: string): void {
  const channelId = event.channelId as string;

  if (!channelId || typeof channelId !== 'string') return;

  const spaceId = getChannelSpaceId(channelId);
  if (!spaceId) return;

  if (!hasPermission(userId, spaceId, PermissionBits.SEND_MESSAGES, channelId)) return;

  // Clear previous typing timeout for this user+channel
  const key = `${userId}:${channelId}`;
  const existing = typingTimeouts.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  // Broadcast typing event to channel viewers (exclude sender)
  connectionManager.sendToChannel(spaceId, channelId, {
    type: 'typing',
    channelId,
    userId,
    username,
  }, userId);

  // Safety cap: skip if Map is at max capacity (auto-expiry handles normal cleanup)
  if (!existing && typingTimeouts.size >= MAX_TYPING_ENTRIES) return;

  // Auto-expire typing after 5 seconds
  const timeout = setTimeout(() => {
    typingTimeouts.delete(key);
  }, 5000);
  typingTimeouts.set(key, timeout);
}

function handlePresenceUpdate(event: Record<string, unknown>, userId: string): void {
  if (!isChosenUserStatus(event.status)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Status must be "online", "idle", or "dnd"' });
    return;
  }
  applyChosenStatus(userId, event.status);
}

function handleActivityUpdate(event: Record<string, unknown>, userId: string): void {
  if (!connectionManager.getUserShowActivity(userId)) return;
  if (!connectionManager.checkActivityRateLimit(userId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Activity update rate limited' });
    return;
  }

  const activities = validateActivities(event.activities);
  if (!activities) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Invalid activity payload' });
    return;
  }

  connectionManager.setUserActivities(userId, activities);
  const status = connectionManager.getUserStatus(userId);

  const payload = presenceUpdateFor(userId, status, activities);
  const targets = collectProfileBroadcastTargetIds(userId);
  for (const uid of targets) connectionManager.sendToUser(uid, payload);
  connectionManager.sendToUser(userId, payload);

  // S2S: project to all active peers (activities + current status).
  void import('../utils/federationPresence.js').then(({ queuePresenceRelay }) => {
    try { queuePresenceRelay(userId, status as 'online' | 'idle' | 'dnd' | 'offline', activities); } catch (e) { console.warn('[ws] queuePresenceRelay(activity) failed', e); }
  });
}

// ─── DM Message Handlers ───────────────────────────────────────────────────

function handleDmMessageCreate(event: Record<string, unknown>, userId: string): void {
  const dmChannelId = event.dmChannelId as string;
  const content = event.content as string | undefined;
  const attachmentIds = event.attachments as string[] | undefined;
  const replyToId = event.replyToId as string | undefined;

  if (!dmChannelId || typeof dmChannelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'dmChannelId is required' });
    return;
  }

  const hasContent = content && typeof content === 'string' && content.trim().length > 0;
  const hasAttachments = attachmentIds && Array.isArray(attachmentIds) && attachmentIds.length > 0;

  if (!hasContent && !hasAttachments) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Message must have content or attachments' });
    return;
  }

  if (hasContent && content!.length > MAX_MESSAGE_LENGTH) {
    connectionManager.sendToUser(userId, { type: 'error', message: `Message content must be ${MAX_MESSAGE_LENGTH} characters or less` });
    return;
  }

  if (!isDmMember(dmChannelId, userId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Not a member of this DM channel' });
    return;
  }

  // A reply may only target a message in the channel it is posted into.
  if (replyToId && !isDmReplyTargetInChannel(dmChannelId, replyToId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Invalid reply target' });
    return;
  }

  const db = getDb();

  // Verify attachment ownership before linking
  if (hasAttachments) {
    for (const attId of attachmentIds) {
      const att = db.select().from(schema.attachments).where(eq(schema.attachments.id, attId)).get();
      if (!att || att.messageId || att.dmMessageId) {
        connectionManager.sendToUser(userId, { type: 'error', message: 'Invalid or already-used attachment' });
        return;
      }
      if (att.uploaderId && att.uploaderId !== userId) {
        connectionManager.sendToUser(userId, { type: 'error', message: 'You do not own this attachment' });
        return;
      }
    }
  }

  const messageId = generateSnowflake();
  const now = Date.now();

  db.insert(schema.dmMessages).values({
    id: messageId,
    dmChannelId,
    userId,
    replyToId: replyToId || null,
    content: hasContent ? content.trim() : null,
    createdAt: now,
  }).run();

  // Link attachments to this DM message
  if (hasAttachments) {
    for (const attId of attachmentIds) {
      db.update(schema.attachments)
        .set({ dmMessageId: messageId })
        .where(eq(schema.attachments.id, attId))
        .run();
    }
  }

  const dmMessage = getDmMessageWithUser(messageId);
  if (!dmMessage) return;

  // Broadcast to all DM members (including those who closed the channel)
  broadcastDmMessage(dmChannelId, dmMessage);

  // Federation: queue for relay
  queueDmRelay(dmMessage, dmChannelId, 'create');

  // Clear any pending typing timeout for this user+channel
  const typingKey = `dm:${userId}:${dmChannelId}`;
  const existingTimeout = typingTimeouts.get(typingKey);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
    typingTimeouts.delete(typingKey);
  }

  // Resolve embeds asynchronously
  setImmediate(() => {
    resolveEmbeds(messageId, hasContent ? content!.trim() : null, dmChannelId, true, null).catch(() => {});
  });
}

function handleDmTypingStart(event: Record<string, unknown>, userId: string, username: string): void {
  const dmChannelId = event.dmChannelId as string;

  if (!dmChannelId || typeof dmChannelId !== 'string') return;

  if (!isDmMember(dmChannelId, userId)) return;

  const key = `dm:${userId}:${dmChannelId}`;
  const existing = typingTimeouts.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  // Send to all other DM members
  const db = getDb();
  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  for (const member of dmMembers) {
    if (member.userId !== userId) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_typing',
        dmChannelId,
        userId,
        username,
      });
    }
  }

  // Relay typing indicator to remote peers (fire-and-forget)
  sendTypingRelay(dmChannelId, 'dm_typing_start', userId);

  const timeout = setTimeout(() => {
    typingTimeouts.delete(key);
  }, 5000);
  typingTimeouts.set(key, timeout);
}

function handleDmMessageEdit(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;
  const content = event.content as string;

  if (!messageId || typeof messageId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'messageId is required' });
    return;
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'content is required' });
    return;
  }

  if (content.length > MAX_MESSAGE_LENGTH) {
    connectionManager.sendToUser(userId, { type: 'error', message: `Message content must be ${MAX_MESSAGE_LENGTH} characters or less` });
    return;
  }

  const db = getDb();
  const msg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, messageId)).get();
  if (!msg) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Message not found' });
    return;
  }

  if (msg.userId !== userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You can only edit your own messages' });
    return;
  }

  const now = Date.now();
  db.update(schema.dmMessages)
    .set({ content: content.trim(), editedAt: now })
    .where(eq(schema.dmMessages.id, messageId))
    .run();

  // Delete old embeds synchronously so the broadcast reflects the edit
  db.delete(schema.embeds).where(eq(schema.embeds.dmMessageId, messageId)).run();

  const updated = getDmMessageWithUser(messageId);
  if (!updated) return;

  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, msg.dmChannelId))
    .all();

  for (const member of dmMembers) {
    connectionManager.sendToUser(member.userId, {
      type: 'dm_message_updated',
      message: updated,
    });
  }

  // Federation: queue for relay
  queueDmRelay(updated, msg.dmChannelId, 'update');

  // Resolve new embeds asynchronously (old ones already deleted above)
  setImmediate(() => {
    resolveEmbeds(messageId, content.trim(), msg.dmChannelId, true, null).catch(() => {});
  });
}

function handleDmMessageDelete(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;

  if (!messageId || typeof messageId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'messageId is required' });
    return;
  }

  const db = getDb();
  const msg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, messageId)).get();
  if (!msg) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Message not found' });
    return;
  }

  if (msg.userId !== userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You can only delete your own messages' });
    return;
  }

  // The relay names the message by its shared coordinates, read from the row
  // before it is gone.
  const relayTarget = dmMessageMutationTarget(msg, userId);

  // Collect attachment filenames before deletion
  const dmAttachmentRows = db.select({ filename: schema.attachments.filename })
    .from(schema.attachments).where(eq(schema.attachments.dmMessageId, messageId)).all();

  // Delete attachments, reactions, and message atomically
  db.transaction((tx) => {
    tx.delete(schema.attachments)
      .where(eq(schema.attachments.dmMessageId, messageId))
      .run();
    tx.delete(schema.dmReactions)
      .where(eq(schema.dmReactions.dmMessageId, messageId))
      .run();
    tx.delete(schema.dmMessages)
      .where(eq(schema.dmMessages.id, messageId))
      .run();
  });

  // Clean up files from disk
  deleteAttachmentFiles(dmAttachmentRows);

  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, msg.dmChannelId))
    .all();

  for (const member of dmMembers) {
    connectionManager.sendToUser(member.userId, {
      type: 'dm_message_deleted',
      messageId,
      dmChannelId: msg.dmChannelId,
    });
  }

  // Federation: log mutation and queue for relay
  queueDmMessageDeleteRelay(messageId, msg.dmChannelId, relayTarget);
}

// ─── Read State Handler ────────────────────────────────────────────────────

function handleChannelAck(event: Record<string, unknown>, userId: string, isFederated: boolean): void {
  const channelId = event.channelId as string;
  const messageId = event.messageId as string;
  if (!channelId || !messageId) return;
  // Validate messageId is a valid snowflake (numeric string) — reject temp/garbage IDs
  if (!/^\d+$/.test(messageId)) return;

  // Validate channel membership — reject acks for channels the user doesn't belong to
  const spaceId = getChannelSpaceId(channelId);
  if (spaceId) {
    if (!isMember(spaceId, userId)) return;
  } else {
    if (!isDmMember(channelId, userId)) return;
  }

  const db = getDb();

  const existing = db.select()
    .from(schema.readStates)
    .where(and(
      eq(schema.readStates.userId, userId),
      eq(schema.readStates.channelId, channelId),
    ))
    .get();

  const now = Date.now();

  if (existing) {
    // Only update if the new messageId is newer (larger snowflake)
    if (BigInt(messageId) > BigInt(existing.lastReadMessageId)) {
      db.update(schema.readStates)
        .set({ lastReadMessageId: messageId, updatedAt: now })
        .where(and(
          eq(schema.readStates.userId, userId),
          eq(schema.readStates.channelId, channelId),
        ))
        .run();
    }
  } else {
    db.insert(schema.readStates).values({
      userId,
      channelId,
      lastReadMessageId: messageId,
      updatedAt: now,
    }).run();
  }

  // Echo ack back to all of this user's connections (multi-tab sync)
  connectionManager.sendToUser(userId, {
    type: 'channel_ack',
    channelId,
    messageId,
  });

  // Relay read state to federated peers for cross-instance sync
  queueReadStateRelay(channelId, messageId, userId);
}

function handleMarkUnread(event: Record<string, unknown>, userId: string, isFederated: boolean): void {
  const channelId = event.channelId as string;
  const messageId = event.messageId as string;
  if (!channelId || !messageId) return;
  if (!/^\d+$/.test(messageId)) return;

  // Validate channel membership
  const spaceId = getChannelSpaceId(channelId);
  if (spaceId) {
    if (!isMember(spaceId, userId)) return;
  } else {
    if (!isDmMember(channelId, userId)) return;
  }

  const db = getDb();
  const now = Date.now();

  if (messageId === '0') {
    // '0' sentinel: delete the read state entirely → channel appears fully unread
    db.delete(schema.readStates)
      .where(and(
        eq(schema.readStates.userId, userId),
        eq(schema.readStates.channelId, channelId),
      ))
      .run();
  } else {
    // Set read state to the specified message (allows backward writes)
    const existing = db.select()
      .from(schema.readStates)
      .where(and(
        eq(schema.readStates.userId, userId),
        eq(schema.readStates.channelId, channelId),
      ))
      .get();

    if (existing) {
      db.update(schema.readStates)
        .set({ lastReadMessageId: messageId, updatedAt: now })
        .where(and(
          eq(schema.readStates.userId, userId),
          eq(schema.readStates.channelId, channelId),
        ))
        .run();
    } else {
      db.insert(schema.readStates).values({
        userId,
        channelId,
        lastReadMessageId: messageId,
        updatedAt: now,
      }).run();
    }
  }

  // Broadcast to all of this user's connections (multi-tab sync)
  connectionManager.sendToUser(userId, {
    type: 'mark_unread',
    channelId,
    messageId,
  });

  // Relay mark-unread to federated peers for cross-instance sync
  // (skip the '0' sentinel — it deletes the read state and can't be mapped to a message)
  if (messageId !== '0') {
    queueReadStateRelay(channelId, messageId, userId);
  }
}
