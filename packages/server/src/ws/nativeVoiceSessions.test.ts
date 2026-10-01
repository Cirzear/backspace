import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { connectionManager } from './connectionManager.js';
import { VOICE_RECONNECT_GRACE_MS } from './voiceRoomTypes.js';
import { handleNativeVoiceBind } from './nativeVoiceBinding.js';
import { addNativeVoiceSession, bindNativeVoiceSocket, getNativeVoiceSession, stopNativeVoiceSession, type NativeVoiceSession } from './nativeVoiceSessions.js';

const ids: string[] = [];
function socket(): WebSocket {
  return { readyState: 1, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
}
function sessionFor(userId: string, roomId: string): NativeVoiceSession {
  const session: NativeVoiceSession = {
    userId, roomId, identity: `screen:${userId}`, voiceIdentity: `native-voice:${userId}`, ownerIdentity: `${userId}:alice`,
    isCurrent: () => connectionManager.getUserRoom(userId)?.roomId === roomId,
    stop: vi.fn(async () => {}), syncPermissions: vi.fn(async () => {}),
  };
  ids.push(session.identity);
  addNativeVoiceSession(session);
  return session;
}
function join(userId: string, roomId: string) {
  const web = socket();
  const native = socket();
  connectionManager.createRoom(roomId, 'space', { type: 'space', spaceId: 'space' });
  connectionManager.joinRoom(roomId, userId);
  connectionManager.addConnection(userId, web);
  connectionManager.addConnection(userId, native);
  // Keep an ordinary connection so tests never run presence DB teardown.
  connectionManager.addConnection(userId, socket());
  connectionManager.setVoiceWs(userId, web);
  return { web, native, session: sessionFor(userId, roomId) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(ids.splice(0).map(id => stopNativeVoiceSession(id)));
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('native voice companion lifecycle', () => {
  it('binds only the authenticated owner and returns distinct enforcement flags', () => {
    const { web, native, session } = join('binding', 'binding-room');
    expect(bindNativeVoiceSocket({ userId: 'other', identity: session.identity, ws: native })).toBe(false);
    connectionManager.setSpaceMuted('space', 'binding', true);
    handleNativeVoiceBind({ identity: session.identity }, 'binding', native);
    expect(native.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'native_voice_bound', identity: session.identity, userId: 'binding',
      spaceMuted: true, permissionMuted: false, muted: true, deafened: false,
    }));
    expect(connectionManager.getVoiceWs('binding')).toBe(web);
    expect(web.send).not.toHaveBeenCalled();
    connectionManager.destroyRoom('binding-room');
  });
  it('keeps the same voice session when WebView is suspended without displacing its owner', () => {
    const { web, native, session } = join('keepalive', 'keepalive-room');
    expect(bindNativeVoiceSocket({ userId: 'keepalive', identity: session.identity, ws: native })).toBe(true);
    connectionManager.removeConnection(web);
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS * 2);
    expect(connectionManager.getUserRoom('keepalive')?.roomId).toBe('keepalive-room');
    expect(session.stop).not.toHaveBeenCalled();
    connectionManager.removeConnection(native);
    expect(session.stop).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);
    expect(connectionManager.getUserRoom('keepalive')).toBeNull();
  });
  it('an ordinary authenticated socket cannot keep the voice session alive', () => {
    const { web, session } = join('ordinary', 'ordinary-room');
    connectionManager.removeConnection(web);
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);
    expect(connectionManager.getUserRoom('ordinary')).toBeNull();
    expect(session.stop).toHaveBeenCalledOnce();
  });
  it('explicit leave and room destruction stop helpers and close the bound transport', () => {
    const { native, session } = join('leaving', 'leaving-room');
    bindNativeVoiceSocket({ userId: 'leaving', identity: session.identity, ws: native });
    connectionManager.leaveCurrentRoom('leaving');
    expect(getNativeVoiceSession(session.identity)).toBeUndefined();
    expect(native.close).toHaveBeenCalledWith(1000, 'Native voice session ended');
    expect(session.stop).toHaveBeenCalledOnce();
    const second = join('destroying', 'destroying-room');
    connectionManager.destroyRoom('destroying-room');
    expect(second.session.stop).toHaveBeenCalledOnce();
  });
  it('stopping native while Web is suspended still starts voice reconnect grace on socket close', async () => {
    const { web, native, session } = join('stop-suspended', 'stop-suspended-room');
    bindNativeVoiceSocket({ userId: 'stop-suspended', identity: session.identity, ws: native });
    connectionManager.removeConnection(web);
    await stopNativeVoiceSession(session.identity);
    connectionManager.removeConnection(native);
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);
    expect(connectionManager.getUserRoom('stop-suspended')).toBeNull();
  });
  it('server mute and deafen refresh the native SFU permissions', () => {
    const { session } = join('moderated', 'moderated-room');
    connectionManager.setSpaceMuted('space', 'moderated', true);
    connectionManager.setSpaceDeafened('space', 'moderated', true);
    connectionManager.setPermissionMuted('space', 'moderated', true);
    expect(session.syncPermissions).toHaveBeenCalledTimes(3);
    connectionManager.clearVoiceWs('moderated');
    expect(session.stop).toHaveBeenCalledOnce();
    connectionManager.destroyRoom('moderated-room');
  });
});
