import { dmCallOrigin, dmCallRoomKey } from '../utils/dmCall';
import { RoomEvent, type Room } from 'livekit-client';
import type { PluginListenerHandle } from '@capacitor/core';
import { createApiClient, type BackspaceApiClient } from '../api/client';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { getApiForOrigin, getTokenForOrigin } from '../utils/crossStoreResolvers';
import { getWebSocketUrl } from '../platform/instanceRuntime';
import { broadcastVoiceStatus } from '../utils/voice';
import { buildScreenShareOptions } from '../utils/screenShare';
import { suspendWebMicrophoneForNative } from '../hooks/useLiveKit';
import { describeNativeScreenShareError } from './nativeScreenShareErrors';
import { BackspaceScreenShare, type NativeAudioState } from './nativeScreenSharePlugin';
import type { NativeScreenRoomLocator, NativeScreenTokenResponse } from './nativeScreenShareTypes';

interface NativeSession {
  room: Room;
  client: BackspaceApiClient;
  tokenRequest: Promise<NativeScreenTokenResponse>;
  target: string;
  cancelled: boolean;
  started: boolean;
  listener?: PluginListenerHandle;
  unsubscribe?: () => void;
  stopPromise?: Promise<void>;
  audioState: NativeAudioState;
  audioUpdate: Promise<void>;
  shareAudio: boolean;
}
let session: NativeSession | null = null;

/** Call origin is the authenticated relay, not necessarily the LiveKit host. */
export function nativeScreenShareTarget(): { origin: string; locator: NativeScreenRoomLocator; key: string } {
  const state = useVoiceStore.getState();
  if (state.currentVoiceChannelId) {
    const channelId = state.currentVoiceChannelId;
    return { origin: getChannelOrigin(channelId), locator: { channelId }, key: `space:${channelId}` };
  }
  if (!state.activeDmCall) throw new Error('Screen sharing requires an active call');
  // Native helpers must use the active slot, never a newer incoming ring's credentials.
  const call = state.activeDmCall;
  const origin = dmCallOrigin(call);
  const locator: NativeScreenRoomLocator = call.federatedCallId
    ? { federatedCallId: call.federatedCallId }
    : { dmChannelId: dmCallRoomKey(call) };
  return { origin, locator, key: `dm:${dmCallRoomKey(call)}` };
}

export function nativeAudioState(): NativeAudioState {
  const state = useVoiceStore.getState();
  const channelId = state.currentVoiceChannelId;
  const origin = channelId ? getChannelOrigin(channelId) : '';
  const userId = channelId ? getMyUserIdForOrigin(origin) : undefined;
  const spaceId = channelId ? useSpaceStore.getState().channelToSpaceMap.get(channelId) : undefined;
  const key = spaceId && userId ? `${spaceId}:${userId}` : '';
  const deafened = state.isDeafened || state.spaceDeafenedUserIds.has(key);
  return {
    micMuted: state.isMuted || deafened || state.micPermissionDenied
      || state.spaceMutedUserIds.has(key) || state.permissionMutedUserIds.has(key),
    deafened,
  };
}

function reportNativeFailure(error: unknown): void {
  console.error('[NativeScreenShare]', error);
  useUIStore.getState().addToast(describeNativeScreenShareError(error), 'warning');
}

function stopInBackground(): void {
  void stopNativeScreenShare().catch(reportNativeFailure);
}

function currentTargetKey(): string | null {
  const state = useVoiceStore.getState();
  if (state.currentVoiceChannelId) return `space:${state.currentVoiceChannelId}`;
  return state.activeDmCall ? `dm:${state.activeDmCall.dmChannelId}` : null;
}

function markStarted(current: NativeSession): void {
  if (session !== current || current.cancelled || current.started) return;
  current.started = true;
  useVoiceStore.setState({
    isScreenSharing: true,
    screenShareAudio: current.shareAudio ? 'published' : 'unavailable',
  });
  broadcastVoiceStatus();
}

async function observeSession(current: NativeSession): Promise<void> {
  current.listener = await BackspaceScreenShare.addListener('screenShareState', (event) => {
    if (session !== current || current.cancelled) return;
    if (event.state === 'started') markStarted(current);
    if (event.state === 'stopped' || event.state === 'error') {
      if (event.state === 'error' && current.started) reportNativeFailure(event.error);
      stopInBackground();
    }
  });
  if (current.cancelled) {
    await current.listener.remove();
    return;
  }
  const authToken = useAuthStore.getState().token;
  const offAuth = useAuthStore.subscribe((state) => {
    if (state.token !== authToken) stopInBackground();
  });
  const offVoice = useVoiceStore.subscribe((state) => {
    if (current.cancelled) return;
    if (currentTargetKey() !== current.target || state.voiceConnectionStatus === 'disconnected') {
      stopInBackground();
      return;
    }
    const next = nativeAudioState();
    if (next.micMuted === current.audioState.micMuted && next.deafened === current.audioState.deafened) return;
    current.audioState = next;
    if (!current.started) return;
    // Keep rapid mute/deafen and moderator changes ordered across the native bridge.
    current.audioUpdate = current.audioUpdate.then(async () => {
      if (!current.cancelled) await BackspaceScreenShare.updateAudioState(next);
    }).catch((error: unknown) => { reportNativeFailure(error); stopInBackground(); });
  });
  current.room.on(RoomEvent.Disconnected, stopInBackground);
  current.unsubscribe = () => {
    offAuth();
    offVoice();
    current.room.off(RoomEvent.Disconnected, stopInBackground);
  };
}

/** No staged browser capture: Android's consent owns the capture transaction. */
export async function startNativeScreenShare(room: Room): Promise<void> {
  if (session) throw new Error('Native screen sharing is already active');
  const target = nativeScreenShareTarget();
  const wsToken = getTokenForOrigin(target.origin);
  if (!wsToken) throw new Error('Missing authenticated session for the call origin');
  // Freeze this origin's credential only for teardown. Logout clears store tokens
  // synchronously; cleanup must still revoke the helpers created by this session.
  const client = createApiClient(target.origin, () => wsToken);
  const current: NativeSession = {
    room, client, target: target.key, cancelled: false, started: false,
    tokenRequest: getApiForOrigin(target.origin).livekit.screenToken({ ...target.locator, ownerIdentity: room.localParticipant.identity }),
    audioState: nativeAudioState(), audioUpdate: Promise.resolve(),
    shareAudio: useVoiceStore.getState().screenShareConfig.shareAudio,
  };
  session = current;
  try {
    const [, credentials] = await Promise.all([observeSession(current), current.tokenRequest]);
    if (current.cancelled || currentTargetKey() !== current.target) throw new Error('Native screen sharing was cancelled');
    if (credentials.ownerIdentity !== room.localParticipant.identity) throw new Error('Screen token owner mismatch');
    useVoiceStore.setState({ nativeVoiceActive: true });
    // React effects are not a synchronization boundary: await the actual Web
    // unpublish/capture release before Android attempts to acquire the mic.
    await suspendWebMicrophoneForNative(room);
    if (current.cancelled) throw new Error('Native screen sharing was cancelled');
    const config = useVoiceStore.getState().screenShareConfig;
    const options = buildScreenShareOptions(config);
    current.shareAudio = config.shareAudio;
    const result = await BackspaceScreenShare.start({
      url: credentials.url, token: credentials.token, voiceToken: credentials.voiceToken,
      identity: credentials.identity, wsUrl: getWebSocketUrl(target.origin), wsToken,
      ...options.capture, bitrate: options.publish.videoEncoding.maxBitrate,
      shareAudio: config.shareAudio, ...nativeAudioState(),
    });
    if (result.state !== 'started' || current.cancelled) throw new Error('Native screen sharing did not start');
    markStarted(current);
    // A moderator/mute event may have arrived while Android's consent was open.
    await BackspaceScreenShare.updateAudioState(nativeAudioState());
  } catch (error) {
    // A cancelled start may settle after the user begins another share. Only
    // tear down the transaction that failed, never the newer native session.
    try {
      if (session === current) await stopNativeScreenShare();
      else await current.stopPromise;
    } catch (cleanupError) {
      reportNativeFailure(cleanupError);
    }
    throw error;
  }
}

export function hasNativeScreenShare(): boolean { return session !== null; }

/** Every terminal path converges here, including OS stop, leave and logout. */
export function stopNativeScreenShare(): Promise<void> {
  const current = session;
  if (!current) return Promise.resolve();
  if (current.stopPromise) return current.stopPromise;
  current.cancelled = true;
  current.unsubscribe?.();
  // Defer until stopPromise is assigned: the native stop event can be immediate.
  current.stopPromise = Promise.resolve().then(async () => {
    const stopped = BackspaceScreenShare.stop();
    const revoked = current.tokenRequest.then(
      (token) => current.client.livekit.screenStop(token.identity),
      // Token issuance failed: there are no helper identities to revoke. The
      // start transaction owns and reports that original HTTP failure.
      () => undefined,
    );
    const [nativeResult, serverResult] = await Promise.allSettled([stopped, revoked]);
    if (nativeResult.status === 'rejected') {
      current.stopPromise = undefined;
      throw nativeResult.reason;
    }
    if (nativeResult.value.state !== 'stopped') {
      current.stopPromise = undefined;
      throw new Error('Android capture has not stopped');
    }
    if (session === current) session = null;
    useVoiceStore.setState({ nativeVoiceActive: false, isScreenSharing: false, screenShareAudio: null });
    broadcastVoiceStatus();
    await current.listener?.remove();
    if (serverResult.status === 'rejected') throw serverResult.reason;
  });
  return current.stopPromise;
}
