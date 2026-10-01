import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomEvent, type Room } from 'livekit-client';

const mock = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), updateAudioState: vi.fn(), addListener: vi.fn(), remove: vi.fn(),
  screenToken: vi.fn(), screenStop: vi.fn(), createClient: vi.fn(), token: vi.fn(), suspend: vi.fn(),
  broadcast: vi.fn(), toast: vi.fn(),
  event: null as null | ((event: { state: string; error?: string }) => void),
}));
vi.mock('./nativeScreenSharePlugin', () => ({ BackspaceScreenShare: mock }));
vi.mock('../api/client', () => ({ createApiClient: mock.createClient, HttpError: class HttpError extends Error {} }));
vi.mock('../hooks/useLiveKit', () => ({ suspendWebMicrophoneForNative: mock.suspend }));
vi.mock('../utils/crossStoreResolvers', () => ({
  getTokenForOrigin: mock.token,
  getApiForOrigin: () => ({ livekit: { screenToken: mock.screenToken } }),
}));
vi.mock('../utils/voice', () => ({ broadcastVoiceStatus: mock.broadcast }));
vi.mock('../platform/instanceRuntime', () => ({ getWebSocketUrl: (origin: string) => `${origin.replace('https:', 'wss:')}/ws` }));
vi.mock('../utils/screenShare', () => ({ buildScreenShareOptions: () => ({
  capture: { width: 1280, height: 720, frameRate: 30 }, publish: { videoEncoding: { maxBitrate: 4_000_000 } },
}) }));
vi.mock('../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast: mock.toast }) } }));
vi.mock('../stores/spaceStore', () => ({
  getChannelOrigin: (id: string) => id === 'remote-channel' ? 'https://remote.test' : '',
  getMyUserIdForOrigin: () => 'remote-local-id',
  useSpaceStore: { getState: () => ({ channelToSpaceMap: new Map([['remote-channel', 'space']]) }) },
}));
vi.mock('../stores/authStore', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ token: 'home-jwt' })) };
});
vi.mock('../stores/voiceStore', async () => {
  const { create } = await import('zustand');
  return { useVoiceStore: create(() => ({
    currentVoiceChannelId: 'remote-channel', activeDmCall: null, callOrigin: null, federatedCallId: null,
    voiceConnectionStatus: 'connected', nativeVoiceActive: false, isScreenSharing: false, screenShareAudio: null,
    isMuted: false, isDeafened: false, micPermissionDenied: false,
    spaceMutedUserIds: new Set(), spaceDeafenedUserIds: new Set(), permissionMutedUserIds: new Set(),
    screenShareConfig: { shareAudio: true },
  })) };
});

import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { hasNativeScreenShare, nativeAudioState, nativeScreenShareTarget, startNativeScreenShare, stopNativeScreenShare } from './nativeScreenShare';

const credentials = {
  token: 'screen-jwt', voiceToken: 'voice-jwt', identity: 'screen:random', voiceIdentity: 'voice:random',
  ownerIdentity: 'origin-specific-id:alice', roomName: 'room', url: 'wss://media.test',
};
function room() {
  return { localParticipant: { identity: credentials.ownerIdentity }, on: vi.fn(), off: vi.fn() } as unknown as Room;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  if (hasNativeScreenShare()) await stopNativeScreenShare();
  vi.clearAllMocks();
  mock.start.mockResolvedValue({ state: 'started' });
  mock.stop.mockResolvedValue({ state: 'stopped' });
  mock.updateAudioState.mockResolvedValue(undefined);
  mock.suspend.mockResolvedValue(undefined);
  mock.screenToken.mockResolvedValue(credentials);
  mock.screenStop.mockResolvedValue(undefined);
  mock.createClient.mockReturnValue({ livekit: { screenToken: mock.screenToken, screenStop: mock.screenStop } });
  mock.token.mockReturnValue('origin-jwt');
  mock.addListener.mockImplementation(async (_name, callback) => {
    mock.event = callback;
    return { remove: mock.remove };
  });
  useVoiceStore.setState({
    currentVoiceChannelId: 'remote-channel', activeDmCall: null, callOrigin: null, federatedCallId: null,
    voiceConnectionStatus: 'connected', nativeVoiceActive: false, isScreenSharing: false,
    isMuted: false, isDeafened: false, micPermissionDenied: false,
    spaceMutedUserIds: new Set(), spaceDeafenedUserIds: new Set(), permissionMutedUserIds: new Set(),
  });
  useAuthStore.setState({ token: 'home-jwt' });
});

describe('Android native screen sharing transaction', () => {
  it('awaits Web microphone release and uses the room identity and origin-scoped token', async () => {
    const release = deferred<void>();
    mock.suspend.mockReturnValueOnce(release.promise);
    const started = startNativeScreenShare(room());
    await vi.waitFor(() => expect(mock.suspend).toHaveBeenCalled());
    expect(useVoiceStore.getState().nativeVoiceActive).toBe(true);
    expect(mock.start).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    release.resolve();
    await started;
    expect(mock.screenToken).toHaveBeenCalledWith({ channelId: 'remote-channel', ownerIdentity: credentials.ownerIdentity });
    expect(mock.start).toHaveBeenCalledWith(expect.objectContaining({
      token: 'screen-jwt', voiceToken: 'voice-jwt', wsToken: 'origin-jwt', wsUrl: 'wss://remote.test/ws',
      identity: 'screen:random', shareAudio: true, width: 1280, height: 720, frameRate: 30, bitrate: 4_000_000,
    }));
    expect(useVoiceStore.getState().isScreenSharing).toBe(true);
    expect(mock.broadcast).toHaveBeenCalled();
    await stopNativeScreenShare();
    expect(mock.screenStop).toHaveBeenCalledWith('screen:random');
    expect(useVoiceStore.getState().nativeVoiceActive).toBe(false);
  });

  it('routes incoming federated DMs through callOrigin with only federatedCallId', () => {
    useVoiceStore.setState({ currentVoiceChannelId: null, activeDmCall: { dmChannelId: 'local-dm' }, callOrigin: 'https://relay.test', federatedCallId: 'federated-call' });
    expect(nativeScreenShareTarget()).toEqual({ origin: 'https://relay.test', locator: { federatedCallId: 'federated-call' }, key: 'dm:local-dm' });
  });

  it('never reports cancelled system consent as success and releases both helpers', async () => {
    const cancelled = Object.assign(new Error('Cancelled'), { code: 'SCREEN_SHARE_CANCELLED' });
    mock.start.mockRejectedValueOnce(cancelled);
    await expect(startNativeScreenShare(room())).rejects.toBe(cancelled);
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    expect(useVoiceStore.getState().nativeVoiceActive).toBe(false);
    expect(mock.stop).toHaveBeenCalledOnce();
    expect(mock.screenStop).toHaveBeenCalledWith(credentials.identity);
  });

  it('cancels an in-flight token request without ever starting capture', async () => {
    const pending = deferred<typeof credentials>();
    mock.screenToken.mockReturnValueOnce(pending.promise);
    const started = startNativeScreenShare(room());
    const outcome = expect(started).rejects.toThrow('cancelled');
    const stopped = stopNativeScreenShare();
    pending.resolve(credentials);
    await Promise.all([outcome, stopped]);
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.screenStop).toHaveBeenCalledWith(credentials.identity);
  });

  it('stops on OS stop, restores Web ownership, and removes event listeners', async () => {
    await startNativeScreenShare(room());
    mock.event?.({ state: 'stopped' });
    await vi.waitFor(() => expect(hasNativeScreenShare()).toBe(false));
    expect(useVoiceStore.getState().nativeVoiceActive).toBe(false);
    expect(mock.remove).toHaveBeenCalledOnce();
  });

  it('keeps the issuing credential for cleanup after logout', async () => {
    await startNativeScreenShare(room());
    const getToken = mock.createClient.mock.calls[0][1] as () => string;
    useAuthStore.setState({ token: null });
    await vi.waitFor(() => expect(hasNativeScreenShare()).toBe(false));
    expect(getToken()).toBe('origin-jwt');
    expect(mock.screenStop).toHaveBeenCalledWith(credentials.identity);
  });

  it('stops when leaving or changing the call', async () => {
    await startNativeScreenShare(room());
    useVoiceStore.setState({ currentVoiceChannelId: null });
    await vi.waitFor(() => expect(hasNativeScreenShare()).toBe(false));
    expect(mock.stop).toHaveBeenCalledOnce();
  });

  it('stops on a terminal room disconnection', async () => {
    const activeRoom = room();
    await startNativeScreenShare(activeRoom);
    const listener = vi.mocked(activeRoom.on).mock.calls.find(([name]) => name === RoomEvent.Disconnected)?.[1];
    listener?.();
    await vi.waitFor(() => expect(hasNativeScreenShare()).toBe(false));
  });

  it('preserves token issuance failure without starting or revoking nonexistent helpers', async () => {
    const failure = new Error('Server has no screen-token route');
    mock.screenToken.mockRejectedValueOnce(failure);
    await expect(startNativeScreenShare(room())).rejects.toBe(failure);
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.screenStop).not.toHaveBeenCalled();
    expect(hasNativeScreenShare()).toBe(false);
  });

  it('does not let an old cancelled start stop a newer session', async () => {
    const oldStart = deferred<{ state: 'started' }>();
    mock.start.mockReturnValueOnce(oldStart.promise);
    const first = startNativeScreenShare(room());
    const firstRejected = expect(first).rejects.toThrow('did not start');
    await vi.waitFor(() => expect(mock.start).toHaveBeenCalledOnce());
    await stopNativeScreenShare();
    await startNativeScreenShare(room());
    oldStart.resolve({ state: 'started' });
    await firstRejected;
    expect(hasNativeScreenShare()).toBe(true);
    expect(useVoiceStore.getState().isScreenSharing).toBe(true);
    expect(mock.stop).toHaveBeenCalledOnce();
    await stopNativeScreenShare();
  });

  it('holds Web microphone ownership until native stop is confirmed', async () => {
    await startNativeScreenShare(room());
    const stopped = deferred<{ state: 'stopped' }>();
    mock.stop.mockReturnValueOnce(stopped.promise);
    const stopping = stopNativeScreenShare();
    await vi.waitFor(() => expect(mock.stop).toHaveBeenCalledOnce());
    expect(useVoiceStore.getState().nativeVoiceActive).toBe(true);
    stopped.resolve({ state: 'stopped' });
    await stopping;
    expect(useVoiceStore.getState().nativeVoiceActive).toBe(false);
  });

  it('propagates mute/deafen changes and origin-specific moderator restrictions', async () => {
    await startNativeScreenShare(room());
    useVoiceStore.setState({ spaceMutedUserIds: new Set(['space:remote-local-id']) });
    await vi.waitFor(() => expect(mock.updateAudioState).toHaveBeenLastCalledWith({ micMuted: true, deafened: false }));
    useVoiceStore.setState({ isDeafened: true });
    await vi.waitFor(() => expect(mock.updateAudioState).toHaveBeenLastCalledWith({ micMuted: true, deafened: true }));
    expect(nativeAudioState()).toEqual({ micMuted: true, deafened: true });
    await stopNativeScreenShare();
  });
});
