import type { WebSocket } from 'ws';

/** One native capture session owns two SFU participants but never a second user. */
export interface NativeVoiceSession {
  userId: string;
  roomId: string;
  identity: string;
  voiceIdentity: string;
  ownerIdentity: string;
  /** Captures the exact server-side room object, not just a reusable channel id. */
  isCurrent: () => boolean;
  stop: () => Promise<void>;
  syncPermissions: () => Promise<void>;
}

const sessions = new Map<string, NativeVoiceSession>();
const companionSockets = new Map<WebSocket, NativeVoiceSession>();

export function getNativeVoiceSession(identity: string): NativeVoiceSession | undefined {
  return sessions.get(identity);
}

export function addNativeVoiceSession(session: NativeVoiceSession): void {
  sessions.set(session.identity, session);
}

export async function stopNativeVoiceSession(identity: string): Promise<void> {
  const session = sessions.get(identity);
  if (!session) return;
  // Invalidate first so late native binds and concurrent stop requests cannot revive it.
  sessions.delete(identity);
  for (const [ws, bound] of companionSockets) {
    if (bound !== session) continue;
    // Keep the binding until the socket's close callback: ConnectionManager must
    // recognize it as the last voice transport and start its usual reconnect grace.
    ws.close(1000, 'Native voice session ended');
  }
  await session.stop();
}

export async function stopNativeVoiceSessionsForUser(userId: string): Promise<void> {
  await Promise.all(Array.from(sessions.values())
    .filter(session => session.userId === userId)
    .map(session => stopNativeVoiceSession(session.identity)));
}

export function revokeNativeVoiceSessions(scope: { userId?: string; roomId?: string }): void {
  for (const session of sessions.values()) {
    if (scope.userId && session.userId !== scope.userId) continue;
    if (scope.roomId && session.roomId !== scope.roomId) continue;
    void stopNativeVoiceSession(session.identity).catch(error => {
      console.error('[native-voice] SFU participant cleanup failed', error);
    });
  }
}

export function syncNativeVoicePermissions(userId: string): void {
  for (const session of sessions.values()) {
    if (session.userId !== userId) continue;
    void session.syncPermissions().catch(error => {
      console.error('[native-voice] SFU permission update failed', error);
    });
  }
}

/** The native connection shares the existing voice session; it must not send voice_join. */
export function bindNativeVoiceSocket(options: { userId: string; identity: string; ws: WebSocket }): boolean {
  const session = sessions.get(options.identity);
  if (!session || session.userId !== options.userId || !session.isCurrent()) return false;
  companionSockets.set(options.ws, session);
  return true;
}

export function hasNativeVoiceSocket(userId: string): boolean {
  return Array.from(companionSockets).some(([ws, session]) =>
    session.userId === userId && sessions.get(session.identity) === session && ws.readyState === 1 && session.isCurrent());
}

export function removeNativeVoiceSocket(ws: WebSocket): boolean {
  const session = companionSockets.get(ws);
  if (!session) return false;
  companionSockets.delete(ws);
  // A dead background transport cannot keep a native publisher running unmoderated.
  void stopNativeVoiceSession(session.identity).catch(error => {
    console.error('[native-voice] Disconnected companion cleanup failed', error);
  });
  return true;
}
