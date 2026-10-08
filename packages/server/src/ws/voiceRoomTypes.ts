import type { WebSocket } from 'ws';

export const VOICE_RECONNECT_GRACE_MS = 60_000;
export const MAX_PENDING_VOICE_RECONNECTS = 10_000;

export interface AuthenticatedSocket {
  ws: WebSocket;
  userId: string;
  username: string;
}

// ─── VoiceRoom Abstraction ─────────────────────────────────────────────────

export interface SpaceRoomMeta {
  type: 'space';
  spaceId: string;
}

export interface DmRoomMeta {
  type: 'dm';
  callerId: string;
  state: 'ringing' | 'active';
  /**
   * The call is in a group conversation (`isGroupConversation`). A group
   * member's end or decline removes only that member; in a 1-on-1 either
   * side ends the call (voice.md, "DM Call State Machine").
   */
  group: boolean;
  /** Members who declined while the call rang. Read only for group calls. */
  declinedUserIds: Set<string>;
  /**
   * Participants homed on a peer, added by a relayed accept: local row id to
   * the origin of the peer that relayed it. They are in `participants` like
   * any other member; this map lets a peer that goes away take them along.
   */
  remoteParticipants: Map<string, string>;
}

/** In-memory registry for federated calls on REMOTE instances. */
export interface FederatedCallEntry {
  dmChannelId: string | null;     // null for Path B (no local DM), late-bound when DM created mid-call
  federatedId: string;            // primary key — cross-instance stable
  callerId: string;               // local stub userId of the caller
  callerHomeUserId: string;
  federatedCallHost: string;      // peer origin of the host instance
  livekitUrl: string;
  tokens: Map<string, string>;    // homeUserId → LiveKit token
  ringedUserIds: string[];        // local userIds that received dm_call_incoming
  /**
   * Local users in the call through this instance (relayed accept to the
   * host). Each one's voice session is bound here, and a session lost past
   * its reconnect grace takes them out (`setFederatedCallLeaveHook`).
   */
  joinedUserIds: string[];
  /** A group conversation: a member's end or decline removes only that member. */
  group: boolean;
  state: 'ringing' | 'active';
  startedAt: number;
}

export interface PendingVoiceReconnect {
  timeout: NodeJS.Timeout;
  roomId: string | null;
  federatedId: string | null;
}

export interface VoiceRoom {
  roomId: string;
  roomType: 'space' | 'dm';
  participants: Set<string>;
  metadata: SpaceRoomMeta | DmRoomMeta;
  startedAt: number;
}

/** Whole occupied seconds for the wire protocol; never exposes a server clock timestamp. */
export function getVoiceRoomElapsedSeconds(room: VoiceRoom, now = Date.now()): number {
  return Math.max(0, Math.floor((now - room.startedAt) / 1_000));
}
