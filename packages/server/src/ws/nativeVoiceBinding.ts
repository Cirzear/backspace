import type { WebSocket } from 'ws';
import { connectionManager } from './connectionManager.js';
import { bindNativeVoiceSocket } from './nativeVoiceSessions.js';

/** This is a companion binding, not a device switch: the Web owner must remain connected. */
export function handleNativeVoiceBind(event: Record<string, unknown>, userId: string, ws: WebSocket): void {
  if (typeof event.identity !== 'string' || !bindNativeVoiceSocket({ userId, identity: event.identity, ws })) {
    ws.send(JSON.stringify({ type: 'error', code: 'forbidden', message: 'No authorized native voice session' }));
    return;
  }
  const room = connectionManager.getUserRoom(userId);
  const spaceId = room?.room.metadata.type === 'space' ? room.room.metadata.spaceId : null;
  const spaceMuted = spaceId ? connectionManager.isSpaceMuted(spaceId, userId) : false;
  const permissionMuted = spaceId ? connectionManager.isPermissionMuted(spaceId, userId) : false;
  const deafened = spaceId ? connectionManager.isSpaceDeafened(spaceId, userId) : false;
  ws.send(JSON.stringify({
    type: 'native_voice_bound', identity: event.identity, userId,
    spaceMuted, permissionMuted, muted: spaceMuted || permissionMuted, deafened,
  }));
}
