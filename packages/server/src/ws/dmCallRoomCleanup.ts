import type { connectionManager } from './connectionManager.js';
import type { DmRoomMeta } from './voiceRoomTypes.js';
import { normalizeOriginForCompare } from '../utils/federationAuth.js';

/** Only room operations are needed; connection and native-session ownership stay with the manager. */
type CallRoomHost = Pick<typeof connectionManager,
  'getAllRooms' | 'endDmRoom' | 'fanOutCallEnd' | 'leaveRoom' | 'afterDmCallLeave' | 'leavePeerParticipants'>;

/**
 * End every DM call hosted here that `userId` placed and that still rings,
 * except `exceptRoomId`: the user started another call or joined voice, and
 * holds one call at a time. Each end goes to the DM members and is relayed
 * to the peers in the caller's name, so members ringing on other instances
 * stop ringing too.
 */
export function endRingingCallsPlacedBy(manager: CallRoomHost, userId: string, exceptRoomId?: string): void {
  for (const [roomId, room] of Array.from(manager.getAllRooms())) {
    if (room.roomType !== 'dm' || roomId === exceptRoomId) continue;
    const meta = room.metadata as DmRoomMeta;
    if (meta.state !== 'ringing' || meta.callerId !== userId) continue;
    manager.endDmRoom(roomId, 'dm_call_ended');
    manager.fanOutCallEnd(roomId, userId);
  }
}

/**
 * Take every participant that `peerOrigin` relayed into the DM call
 * `dmChannelId` (`remoteParticipants`) out of it, as when that peer can no
 * longer tell us they left. Returns how many left and whether the call
 * ended because nobody is left. Local only: the caller relays the end.
 */
export function leavePeerParticipants(manager: CallRoomHost, dmChannelId: string, peerOrigin: string): { removed: number; ended: boolean } {
  const peerKey = normalizeOriginForCompare(peerOrigin);
  const room = manager.getAllRooms().get(dmChannelId);
  if (peerKey === null || !room || room.roomType !== 'dm') return { removed: 0, ended: false };
  const meta = room.metadata as DmRoomMeta;
  let removed = 0;
  for (const [userId, origin] of Array.from(meta.remoteParticipants)) {
    if (normalizeOriginForCompare(origin) !== peerKey) continue;
    manager.leaveRoom(dmChannelId, userId);
    removed += 1;
    if (manager.afterDmCallLeave(dmChannelId, userId) === 'ended') return { removed, ended: true };
  }
  return { removed, ended: false };
}

/**
 * A peer stopped being active: the participants it relayed into calls
 * hosted here can no longer tell us they left, so they leave now. A call
 * left empty ends, and the end is relayed to the remaining peers in the
 * caller's name. Returns how many participants were removed.
 */
export function dropRemoteCallParticipants(manager: CallRoomHost, peerOrigin: string): number {
  let removed = 0;
  for (const [roomId, room] of Array.from(manager.getAllRooms())) {
    if (room.roomType !== 'dm') continue;
    const callerId = (room.metadata as DmRoomMeta).callerId;
    const result = manager.leavePeerParticipants(roomId, peerOrigin);
    removed += result.removed;
    if (result.ended) manager.fanOutCallEnd(roomId, callerId);
  }
  return removed;
}
