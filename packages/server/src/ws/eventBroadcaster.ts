import type { ServerEvent } from '@backspace/shared';
import type { WebSocket } from 'ws';
import { unreadCountEvent } from './channelUnreadCounts.js';
import { computePermissions, PermissionBits } from '../utils/permissions.js';
import { getDb, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import type { VoiceRoom, SpaceRoomMeta } from './voiceRoomTypes.js';

export interface BroadcasterContext {
  getUserConnections: (userId: string) => Set<WebSocket>;
  getUserSpacesEntries: () => IterableIterator<[string, Set<string>]>;
  getFederatedCallRingedUsers: (federatedId: string) => string[] | undefined;
  getRoom: (roomId: string) => VoiceRoom | undefined;
  getAllConnections: () => Map<string, Set<WebSocket>>;
}

/** Broadcasts WebSocket events to users, spaces, channels, and rooms. */
export class EventBroadcaster {
  constructor(private ctx: BroadcasterContext) {}

  /** Send to a specific user (all their connections). */
  sendToUser(userId: string, event: ServerEvent): void {
    const connections = this.ctx.getUserConnections(userId);
    const message = JSON.stringify(event);
    const unread = connections.size ? unreadCountEvent(userId, event) : null;
    const unreadMessage = unread ? JSON.stringify(unread) : null;
    for (const ws of connections) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(message);
        if (unreadMessage) ws.send(unreadMessage);
      }
    }
  }

  /** Send to all members of a space. */
  sendToSpace(spaceId: string, event: ServerEvent, excludeUserId?: string): void {
    for (const [userId, spaceIds] of this.ctx.getUserSpacesEntries()) {
      if (spaceIds.has(spaceId) && userId !== excludeUserId) {
        this.sendToUser(userId, event);
      }
    }
  }

  /** Send to space members who have VIEW_CHANNEL on the given channel. */
  sendToChannel(spaceId: string, channelId: string, event: ServerEvent, excludeUserId?: string): void {
    for (const [userId, spaceIds] of this.ctx.getUserSpacesEntries()) {
      if (spaceIds.has(spaceId) && userId !== excludeUserId) {
        const perms = computePermissions(userId, spaceId, channelId);
        if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
          this.sendToUser(userId, event);
        }
      }
    }
  }

  /** Send to all DM channel members (queries dm_members table). */
  sendToDmMembers(dmChannelId: string, event: ServerEvent, excludeUserId?: string): void {
    const db = getDb();
    const dmMembers = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
      .all();

    for (const member of dmMembers) {
      if (member.userId !== excludeUserId) {
        this.sendToUser(member.userId, event);
      }
    }
  }

  /**
   * Send event to users who were ringed for a federated call.
   * ALWAYS uses ringedUserIds, never sendToDmMembers.
   */
  sendToFederatedCallUsers(federatedId: string, event: ServerEvent, excludeUserId?: string): void {
    const ringedUserIds = this.ctx.getFederatedCallRingedUsers(federatedId);
    if (!ringedUserIds) return;
    for (const uid of ringedUserIds) {
      if (uid !== excludeUserId) {
        this.sendToUser(uid, event);
      }
    }
  }

  /** Send to a room — routes to sendToSpace (space rooms) or sendToDmMembers (DM rooms). */
  sendToRoom(roomId: string, event: ServerEvent, excludeUserId?: string): void {
    const room = this.ctx.getRoom(roomId);
    if (!room) return;

    if (room.roomType === 'space') {
      const meta = room.metadata as SpaceRoomMeta;
      this.sendToSpace(meta.spaceId, event, excludeUserId);
    } else {
      this.sendToDmMembers(roomId, event, excludeUserId);
    }
  }

  /** Send to all connections of all online users. */
  sendToAll(event: ServerEvent, excludeUserId?: string): void {
    const message = JSON.stringify(event);
    for (const [userId, connections] of this.ctx.getAllConnections()) {
      if (userId !== excludeUserId) {
        for (const ws of connections) {
          if (ws.readyState === 1) {
            ws.send(message);
          }
        }
      }
    }
  }

  /** Send to a specific WebSocket instance (not all of a user's connections). */
  sendToWs(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify(event));
    }
  }

  /** Send an event to all connected admin users. */
  sendToAdmins(event: ServerEvent): void {
    const db = getDb();
    for (const userId of this.ctx.getAllConnections().keys()) {
      const user = db.select({ isAdmin: schema.users.isAdmin })
        .from(schema.users).where(eq(schema.users.id, userId)).get();
      if (user?.isAdmin === 1) {
        this.sendToUser(userId, event);
      }
    }
  }
}
