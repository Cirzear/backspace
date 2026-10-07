import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  Participant,
  AudioPresets,
  RemoteParticipant,
  RemoteTrackPublication,
  RemoteAudioTrack,
  ConnectionState,
  ConnectionQuality,
  LocalAudioTrack,
  LocalTrackPublication,
  DisconnectReason,
  TrackEvent,
} from 'livekit-client';
import { getApiForOrigin, getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { refreshStreamHostLimits, useStreamHostLimits } from '../utils/streamHostLimits';
import { wsSend } from './useWebSocket';
import { useVoiceStore, type VoiceConnectionQuality } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import { broadcastVoiceStatus, clearSpaceVoiceForDmCall } from '../utils/voice';
import { consumeIntentionalCameraOff, markIntentionalCameraOff } from '../utils/voiceActions';
import { AudioManager } from '../audio/AudioManager';
import { SpeakingDetector } from '../audio/SpeakingDetector';
import {
  CAMERA_OVERDRIVE,
  buildScreenShareOptions,
  applyOverdrive,
  scheduleScreenShareOverdrive,
  republishScreenShare,
  getRequestedPublishedScreenShareCodec,
  handleScreenShareUnpublished,
  handleScreenShareAudioUnpublished,
  settleScreenShareAfterReconnect,
  resolveNativeOverdrive,
  syncScreenShareAudio,
} from '../utils/screenShare';
import { isStreamRepublish, parseStreamWatch, streamWatchKey } from '../utils/streamWatchProtocol';
import { StreamRepublishTracker } from '../utils/streamRepublish';
import { getMediaStreamTrack } from '../utils/livekitInternals';
import { deactivate as deactivateHwOverdrive } from '../utils/hwOverdrive';
import {
  collectParticipants, getNativeHelper, getParticipantOwnerIdentity, parseIdentity,
  resolveParticipantUserId, speakingParticipants, syncRemoteSubscriptions,
} from './liveKitParticipants';
import { republishMicrophone, suspendWebMicrophoneForNative } from './liveKitMicrophone';
export { deriveGridTiles, parseIdentity } from './liveKitParticipants';
export type { ParticipantInfo, UserTile, StreamTile, GridTile } from './liveKitParticipants';
export { suspendWebMicrophoneForNative } from './liveKitMicrophone';

let _activeRoom: Room | null = null;
/**
 * The republish state of each room's remote sharers. Keyed by the room so a
 * handler, a timer or `updateParticipants` always reaches the tracker of the
 * room it belongs to, never the one that happens to be current.
 */
const _republishTrackers = new WeakMap<Room, StreamRepublishTracker>();
/**
 * Serialises screen-share / camera track updates.
 *
 * `republishScreenShare` clears the published-codec marker before it awaits the
 * swap. A second effect run landing inside that window reads no codec, decides
 * nothing changed, and skips the republish — so toggling the codec pill twice
 * quickly leaves what is actually published disagreeing with the UI until some
 * later config change happens to correct it. Chaining the runs keeps every read
 * of that marker outside the window where it is being rewritten.
 */
let _activeTrackUpdate: Promise<void> = Promise.resolve();

function toVoiceConnectionQuality(quality: ConnectionQuality): VoiceConnectionQuality {
  switch (quality) {
    case ConnectionQuality.Excellent: return 'excellent';
    case ConnectionQuality.Good: return 'good';
    case ConnectionQuality.Poor: return 'poor';
    case ConnectionQuality.Lost: return 'lost';
    case ConnectionQuality.Unknown: return 'unknown';
    default: return 'unknown';
  }
}

export function getActiveRoom(): Room | null {
  return _activeRoom;
}

export function setStreamSubscription(room: Room | null, targetIdentity: string, subscribed: boolean) {
  if (!room) return;
  const rp = room.remoteParticipants.get(targetIdentity);
  if (!rp) return;
  rp.trackPublications.forEach((pub) => {
    if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
      (pub as RemoteTrackPublication).setSubscribed(subscribed);
    }
  });
}

export function setCameraSubscription(room: Room | null, targetIdentity: string, subscribed: boolean) {
  if (!room) return;
  const rp = room.remoteParticipants.get(targetIdentity);
  if (!rp) return;
  rp.trackPublications.forEach((pub) => {
    if (pub.source === Track.Source.Camera) {
      (pub as RemoteTrackPublication).setSubscribed(subscribed);
    }
  });
}

/** A remote screen share ended: drop the watch and the per-stream audio settings. */
function endRemoteStream(identity: string): void {
  const userId = resolveParticipantUserId(identity);
  const state = useVoiceStore.getState();
  state.unwatchStream(userId);
  state.clearStreamVolume(userId);
  state.clearStreamMute(userId);
}

let _connectGeneration = 0;

/** Null-safe Room.disconnect() wrapper — lets the SDK tear down its own internals cleanly. */
function destroyRoom(room: Room | null): Promise<void> | void {
  if (!room) return;
  return room.disconnect();
}

export function useLiveKit() {
  const [room, setRoom] = useState<Room | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [connectedChannelId, setConnectedChannelId] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const connectedChannelRef = useRef<string | null>(null);
  const switchCameraGenRef = useRef(0);
  
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const screenShareConfig = useVoiceStore((s) => s.screenShareConfig);
  // The host's limits shape the effective config, so a document that arrives
  // after the share started must reach the running encoder too.
  const { limits: streamHostLimits } = useStreamHostLimits();
  const voiceUserStates = useVoiceStore((s) => s.voiceUserStates);
  const spaceMutedUserIds = useVoiceStore((s) => s.spaceMutedUserIds);
  const spaceDeafenedUserIds = useVoiceStore((s) => s.spaceDeafenedUserIds);
  const permissionMutedUserIds = useVoiceStore((s) => s.permissionMutedUserIds);
  const inputVolume = useVoiceStore((s) => s.inputVolume);
  const inputDeviceId = useVoiceStore((s) => s.inputDeviceId);
  const cameraDeviceId = useVoiceStore((s) => s.cameraDeviceId);
  const micPermissionDenied = useVoiceStore((s) => s.micPermissionDenied);
  const nativeVoiceActive = useVoiceStore((s) => s.nativeVoiceActive);
  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const noiseSuppression = useVoiceStore((s) => s.noiseSuppression);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const rnnoiseEnabled = useVoiceStore((s) => s.rnnoiseEnabled);

  const lastMicGenRef = useRef(0);
  const nativeSpeakingRef = useRef(false);

  const updateParticipants = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;
    const republish = _republishTrackers.get(r);
    // The local share's lifecycle, owned by utils/screenShare: true from a
    // successful publish until the share stops, and so across a republish.
    const localShareLive = useVoiceStore.getState().isScreenSharing;

    const participants = collectParticipants(r, republishRef.current);
    useVoiceStore.getState().setParticipants(participants);
    const nativeSpeaking = participants.some(p => p.isLocal && (useVoiceStore.getState().nativeVoiceActive
      || (p.voicePublisherIdentity && p.voicePublisherIdentity !== p.identity)));
    if (nativeSpeaking !== nativeSpeakingRef.current) {
      // SpeakingDetector normally keeps the local analyser outside its remote map.
      // Reset when the same owner switches sides so a native analyser cannot survive restoration.
      SpeakingDetector.getInstance().clear();
      nativeSpeakingRef.current = nativeSpeaking;
    }
    SpeakingDetector.getInstance().syncTracks(speakingParticipants(participants));
  }, []);

  const handleDataReceived = useCallback((
    payload: Uint8Array,
    participant: RemoteParticipant | undefined,
    republish?: StreamRepublishTracker,
  ) => {
    // Helpers cannot impersonate owner control messages; the Web owner retains data control.
    if (participant && getNativeHelper(participant)) return;
    // Try the stream_watch protocol first (typed parser; returns null on non-matches).
    if (participant) {
      const sw = parseStreamWatch(payload);
      if (sw) {
        // Both sides of the watcher set are LiveKit identities: the sharer's
        // (the one string every client in the room shares, where its user id
        // is per instance) and the viewer's, so ParticipantDisconnected can
        // evict cleanly. An older viewer's ping is placed through the
        // participant it names by user id, or dropped when none matches.
        const sharerIdentity = streamWatchKey(sw, useVoiceStore.getState().participants);
        if (sharerIdentity) {
          useVoiceStore.getState().recordStreamWatch(sharerIdentity, participant.identity, sw.watching);
        }
        return;
      }
      if (isStreamRepublish(payload)) {
        // The sender's next screen-share unpublish is a codec swap, not the end.
        republish.announce(participant.identity);
        return;
      }
    }
    try {
      const text = new TextDecoder().decode(payload);
      const msg = JSON.parse(text);
      if (msg.type === 'deafen' && participant) {
        const { userId } = parseIdentity(participant.identity);
        useVoiceStore.getState().setUserDeafened(userId, msg.deafened === true);
        updateParticipants();
      }
    } catch { }
  }, [updateParticipants]);

  // Handle Input Device & Mute Logic via AudioManager
  // Mute uses setMicrophoneEnabled(false) to keep the track published (silence frames)
  // instead of unpublishTrack() which tears down the WebRTC transport.
  // This preserves the Web Audio pipeline for future AudioWorklet nodes (e.g. RNNoise).
  useEffect(() => {
    const r = roomRef.current;
    if (!r || !isConnected) return;

    let cancelled = false;
    const isCurrentRoom = () => !cancelled && roomRef.current === r && !useVoiceStore.getState().nativeVoiceActive;

    // Compute effective mute/deafen: user intent || server enforcement
    const vs = useVoiceStore.getState();
    const cvId = vs.currentVoiceChannelId;
    const effOrigin = cvId ? getChannelOrigin(cvId) : '';
    const effMyId = cvId ? getMyUserIdForOrigin(effOrigin) : undefined;
    const effSpaceId = cvId ? useSpaceStore.getState().channelToSpaceMap.get(cvId) : null;
    const effKey = (effSpaceId && effMyId) ? `${effSpaceId}:${effMyId}` : '';
    const effectiveMuted = isMuted || spaceMutedUserIds.has(effKey) || permissionMutedUserIds.has(effKey);
    const effectiveDeafened = isDeafened || spaceDeafenedUserIds.has(effKey);

    const syncMic = async () => {
      try {
        if (cancelled || roomRef.current !== r) return;
        if (useVoiceStore.getState().nativeVoiceActive) {
          await suspendWebMicrophoneForNative(r);
          return;
        }
        const audioManager = AudioManager.getInstance();

        // Sync voice processing settings to AudioManager
        audioManager.setVoiceProcessing({ echoCancellation, noiseSuppression, autoGainControl });
        await audioManager.setRnnoiseEnabled(rnnoiseEnabled);
        if (!isCurrentRoom()) return;

        const micPub = r.localParticipant.getTrackPublications()
          .find(p => p.source === Track.Source.Microphone);

        // Mic permission denied — user joined as a listener. Tear down any
        // stale publication (defensive: should not exist on first join, but
        // covers the edge where permission was revoked mid-call) and skip
        // the publish branch entirely. Re-attempt is gated behind the
        // `requestMicPermission` user-gesture path which clears the flag
        // and triggers this effect to re-run via its dep.
        if (micPermissionDenied) {
          if (micPub?.track) {
            await r.localParticipant.unpublishTrack(micPub.track as LocalAudioTrack).catch(() => {});
          }
          return;
        }

        // If effectively muted or deafened, mute the track in-place (keep it published)
        if (effectiveMuted || effectiveDeafened) {
          if (micPub?.track && !micPub.isMuted) {
            await r.localParticipant.setMicrophoneEnabled(false);
          }
          return;
        }

        // Not muted — ensure the AudioManager pipeline is on the right device
        // and at the right volume, then republish if the published track is
        // stale or missing.
        try {
          await audioManager.setInputDevice(inputDeviceId);
        } catch (err: any) {
          if (!isCurrentRoom()) return;
          // Late denial (e.g. iOS standalone PWA where the pre-arm in
          // `joinVoiceChannel` ran inside the gesture but the prompt is
          // delivered out-of-band; the user denies after `room.connect()`
          // has already succeeded). Promote to the listener-mode flag so
          // we don't loop forever trying to re-acquire.
          if (err?.name === 'NotAllowedError') {
            useVoiceStore.getState().setMicPermissionDenied(true);
            useUIStore.getState().addToast(
              'Microphone access denied. You joined as a listener — tap "Allow microphone" to grant access.',
              'warning',
            );
            return;
          }
          throw err;
        }
        if (!isCurrentRoom()) return;
        audioManager.setInputVolume(inputVolume);
        await republishMicrophone(r, lastMicGenRef, isCurrentRoom);
      } catch (err) {
        console.error('[LiveKit] Failed to sync mic state:', err);
      }
    };

    syncMic();

    // Re-sync when AudioManager resumes
    const unsubscribeResume = AudioManager.getInstance().onResumed(() => {
      syncMic();
    });

    return () => {
      cancelled = true;
      unsubscribeResume();
    };
  }, [isMuted, isDeafened, spaceMutedUserIds, spaceDeafenedUserIds, permissionMutedUserIds, inputDeviceId, inputVolume, isConnected, echoCancellation, noiseSuppression, autoGainControl, rnnoiseEnabled, micPermissionDenied, nativeVoiceActive]);

  // Subscribe to upstream-input-track-end events from AudioManager whenever a
  // room is connected. The published mic track is a clone of a WebAudio
  // destination node and never ends on hardware loss; only the upstream
  // getUserMedia track does. AudioManager owns that signal — we react to it.
  useEffect(() => {
    if (!isConnected || nativeVoiceActive) return;
    const am = AudioManager.getInstance();
    const subscriberRoom = roomRef.current;
    const isCurrentInput = () => roomRef.current === subscriberRoom && !useVoiceStore.getState().nativeVoiceActive;

    const unsubscribe = am.onInputTrackEnded(async () => {
      // Room was replaced or torn down between event emission and handler run.
      if (!isCurrentInput() || !subscriberRoom) return;

      const deviceId = useVoiceStore.getState().inputDeviceId;
      let copy = 'Microphone could not be restored';

      try {
        // Probe is intentionally constraint-free — we want to know whether the
        // device is reachable, not whether full voice constraints succeed. Adding
        // constraints here would create probe-vs-acquire skew (probe might fail
        // for a constraint that AudioManager would have negotiated around).
        const probe = await navigator.mediaDevices.getUserMedia({
          audio: deviceId === 'default' ? true : { deviceId: { exact: deviceId } },
        });
        probe.getTracks().forEach(t => t.stop());

        // Probe succeeded — device is back. Re-acquire and force a republish.
        if (!isCurrentInput()) return;
        try {
          await am.setInputDevice(deviceId);
          if (!isCurrentInput()) return;
          await republishMicrophone(subscriberRoom, lastMicGenRef, isCurrentInput);
          return;
        } catch {
          // copy already holds 'Microphone could not be restored'
        }
      } catch (err: any) {
        if (err?.name === 'NotAllowedError') {
          copy = 'Microphone permission was revoked';
        } else if (err?.name === 'NotFoundError') {
          if (deviceId !== 'default') {
            // The configured device disappeared. Fall back to default — the
            // store update triggers syncMic via its dep array, which calls
            // republishMicrophone with the freshly acquired default stream.
            useVoiceStore.getState().setInputDevice('default');
            copy = 'Microphone disconnected — switched to system default';
          } else {
            copy = 'Microphone disconnected';
          }
        } else {
          copy = 'Microphone could not be restored';
        }
      }

      if (!isCurrentInput()) return;
      useUIStore.getState().addToast(copy, 'warning');
    });

    return () => { unsubscribe(); };
  }, [isConnected, nativeVoiceActive]);

  // Hot-swap the camera source when cameraDeviceId changes mid-call.
  // Compares against the published track's actual deviceId (getSettings().deviceId)
  // rather than a memoised previous store value, so the null → explicit-same-device
  // transition is a correct no-op.
  useEffect(() => {
    const r = roomRef.current;
    if (!r || !isConnected || !isCameraOn) return;

    const camPub = r.localParticipant.getTrackPublications()
      .find(p => p.source === Track.Source.Camera);
    if (!camPub?.track) return;

    const currentDeviceId = camPub.track.mediaStreamTrack?.getSettings().deviceId;
    const target = cameraDeviceId;

    if (target === null) return;            // "Auto" never force-switches a live publication
    if (currentDeviceId === target) return; // already on target

    const myGen = ++switchCameraGenRef.current;

    // Race semantics: if the effect re-fires while this IIFE is in flight
    // (rapid dropdown changes), the newer firing will increment the gen.
    // This IIFE's catch then no-ops its store rollback — the newer attempt
    // owns the canonical store state.
    (async () => {
      const prev = currentDeviceId ?? null;
      try {
        await r.switchActiveDevice('videoinput', target);
      } catch (err) {
        console.error('[LiveKit] Camera hot-swap failed:', err);
        // A newer device-switch attempt has superseded ours. Don't write stale
        // rollback state; let the newer attempt's outcome stand.
        if (myGen !== switchCameraGenRef.current) {
          useUIStore.getState().addToast('Could not switch camera', 'warning');
          return;
        }
        const stillLive = camPub.track?.mediaStreamTrack?.readyState === 'live';
        if (stillLive && prev) {
          useVoiceStore.getState().setCameraDeviceId(prev);
        } else if (stillLive) {
          useVoiceStore.getState().setCameraDeviceId(null);
        } else {
          // Track is dead — disable the camera entirely. Mark the flag now to
          // suppress the already-queued `ended` event on the dead track.
          markIntentionalCameraOff();
          // Re-mark immediately before the disable: LiveKit may synthesize a
          // second `ended` event during teardown, and the flag is consumed once.
          // markIntentionalCameraOff is idempotent.
          markIntentionalCameraOff();
          await r.localParticipant.setCameraEnabled(false).catch(() => {});
          useVoiceStore.setState({ isCameraOn: false });
          broadcastVoiceStatus();
        }
        useUIStore.getState().addToast('Could not switch camera', 'warning');
      }
    })();
  }, [cameraDeviceId, isCameraOn, isConnected]);

  const connect = useCallback(async (channelId: string, isDm?: boolean) => {
    const storedId = isDm ? `dm-${channelId}` : channelId;
    if (connectedChannelRef.current === storedId && roomRef.current?.state === ConnectionState.Connected) return;

    // Entering a DM call: drop any space voice channel we're still "in" on the
    // client. Done synchronously (before any await) so the sidebar updates
    // immediately. See clearSpaceVoiceForDmCall for why currentVoiceChannelId
    // must be cleared here — otherwise the DM call's participants render against
    // the old space channel and we appear to still be sitting in it.
    if (isDm) clearSpaceVoiceForDmCall();

    // Register voice state with the WS server after LiveKit connects (not for DM calls)
    const registerWithServer = () => {
      if (isDm) return;
      const origin = getChannelOrigin(channelId);
      wsSend({ type: 'voice_join', channelId }, origin);
      broadcastVoiceStatus(origin);
    };
    const gen = ++_connectGeneration;

    // Ensure AudioContext is created and resumed before tracks arrive
    await AudioManager.getInstance().resumeContext();
    if (gen !== _connectGeneration) return;

    // 1. Reset state immediately to reflect "Loading/Switching" in UI
    SpeakingDetector.getInstance().clear();
    setRoom(null);
    useVoiceStore.getState().setParticipants([]);
    useVoiceStore.getState().setSpeakingParticipants(new Set());
    // Camera and screen share belong to the room being left: nothing of either
    // is published in the next one until the user starts it there.
    useVoiceStore.setState({ isCameraOn: false, isScreenSharing: false });
    setIsConnected(false);
    setIsConnecting(true);
    setConnectionState(ConnectionState.Connecting);
    useVoiceStore.getState().setVoiceConnectionStatus('connecting');
    setConnectionError(null);
    setConnectedChannelId(null); // Clear this so AppLayout knows we are transitioning

    useVoiceStore.getState().setConnectionError(null);
    useVoiceStore.getState().setIsLiveKitConnected(false);
    useVoiceStore.getState().setConnectionQuality('unknown');

    // 2. Strictly disconnect previous room (Local Ref OR Global Ref)
    // This handles cases where AppLayout might have remounted, losing roomRef but leaving _activeRoom alive.
    const roomToDisconnect = roomRef.current || _activeRoom;
    
    if (roomToDisconnect) {
      // A channel switch retains pre-armed capture. Ignore the old room's
      // terminal events before starting asynchronous SDK teardown.
      roomRef.current = null;
      _activeRoom = null;
      _republishTrackers.get(roomToDisconnect)?.clear();
      try {
        console.log('[LiveKit] Destroying previous room:', roomToDisconnect.name);
        await destroyRoom(roomToDisconnect);
      } catch (err) {
        console.warn('Error disconnecting from previous room:', err);
      }
    }
    if (gen !== _connectGeneration) return;
    
    try {
      let token: string;
      let url: string;
      // The instance that issues the token hosts the LiveKit room, so its
      // streaming limits are the ones a screen share here obeys. Null when the
      // token was relayed from a host this client has no session with.
      let hostOrigin: string | null;

      // For federated calls, use the stored token from S2S relay
      const { federatedCallToken, federatedCallUrl, clearFederatedCallData } = useVoiceStore.getState();
      if (isDm && federatedCallToken && federatedCallUrl) {
        token = federatedCallToken;
        url = federatedCallUrl;
        hostOrigin = null;
        clearFederatedCallData();
      } else {
        hostOrigin = getChannelOrigin(channelId);
        const client = getApiForOrigin(hostOrigin);
        const resp = isDm ? await client.livekit.dmToken(channelId) : await client.livekit.token(channelId);
        token = resp.token;
        url = resp.url;
      }
      if (gen !== _connectGeneration) return;
      useVoiceStore.setState({ livekitHostOrigin: hostOrigin });
      // Refreshed per join; home's document arrives with every home `ready`.
      if (hostOrigin) void refreshStreamHostLimits(hostOrigin);
      const newRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
        publishDefaults: {
          videoCodec: 'h264',
          simulcast: true,
          audioPreset: AudioPresets.musicHighQualityStereo,
          dtx: false,
        },
      });
      roomRef.current = newRoom;
      // This room's own tracker. Its handlers use it directly, and act only
      // while the room is current: a replaced room's late events belong to
      // nothing the user still sees.
      const republish = new StreamRepublishTracker((identity) => {
        // The announced republish never produced a new track: the share ended.
        if (roomRef.current !== newRoom) return;
        endRemoteStream(identity);
        updateParticipants();
      });
      _republishTrackers.set(newRoom, republish);
      let initialConnectPending = true;

      const isCurrent = () => roomRef.current === newRoom;
      const guardedUpdate = () => { if (isCurrent()) updateParticipants(); };
      const syncSubscriptions = () => {
        guardedUpdate();
        if (isCurrent()) syncRemoteSubscriptions(newRoom);
      };
      const endParticipantScreen = (participant: Participant) => {
        const ownerIdentity = getParticipantOwnerIdentity(participant);
        const owner = useVoiceStore.getState().participants.find(p => p.identity === ownerIdentity);
        // A retiring helper cannot end a replacement helper's stream.
        if (owner?.isScreenSharing && owner.screenPublisherIdentity !== participant.identity) return;
        endRemoteStream(ownerIdentity);
      };
      newRoom.on(RoomEvent.ParticipantConnected, (participant) => {
        if (roomRef.current !== newRoom) return;
        syncSubscriptions();
        if (getNativeHelper(participant)) return;
        // Notify new participant of our effective deafen state
        const vsConn = useVoiceStore.getState();
        const cvIdConn = vsConn.currentVoiceChannelId;
        const connOrigin = cvIdConn ? getChannelOrigin(cvIdConn) : '';
        const connMyId = cvIdConn ? getMyUserIdForOrigin(connOrigin) : undefined;
        const connSpaceId = cvIdConn ? useSpaceStore.getState().channelToSpaceMap.get(cvIdConn) : null;
        const connKey = (connSpaceId && connMyId) ? `${connSpaceId}:${connMyId}` : '';
        const effDeaf = vsConn.isDeafened || vsConn.spaceDeafenedUserIds.has(connKey);
        if (effDeaf) {
          const encoder = new TextEncoder();
          newRoom.localParticipant.publishData(
            encoder.encode(JSON.stringify({ type: 'deafen', deafened: true })),
            { reliable: true }
          ).catch(() => { });
        }
      });
      newRoom.on(RoomEvent.ParticipantDisconnected, (participant: Participant) => {
        const bridgedShareEnded = republish.cancel(participant.identity);
        if (!isCurrent()) return;
        const helper = getNativeHelper(participant);
        if (helper) {
          if (helper.purpose === 'screen-share') endParticipantScreen(participant);
          syncSubscriptions();
          return; // Helper loss must never clear the owner's WS status or watcher identity.
        }
        useVoiceStore.getState().evictWatcher(participant.identity);
        if (bridgedShareEnded) endRemoteStream(participant.identity);
        else endRemoteStream(participant.identity);
        useVoiceStore.getState().clearVoiceUserStatus(resolveParticipantUserId(participant.identity));
        syncSubscriptions();
      });
      newRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        // LiveKit auto-attaches a hidden <audio> element for subscribed audio tracks.
        // GlobalAudioRenderer is the sole audio playback path with volume/attenuation/boost.
        // Detach LiveKit's internal element to prevent double-playback.
        if (track.kind === Track.Kind.Audio) {
          (track as RemoteAudioTrack).detach();
        }
        guardedUpdate();
      });
      newRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          (track as RemoteAudioTrack).detach();
        }
        guardedUpdate();
      });
      newRoom.on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication) => {
        if (publication.source === Track.Source.ScreenShare) {
          const { userId } = parseIdentity(newRoom.localParticipant.identity);
          useVoiceStore.getState().watchStream(userId);
          publication.track?.on(TrackEvent.Restarted, () => {
            scheduleScreenShareOverdrive(newRoom);
          });
        }
        if (publication.source === Track.Source.Camera) {
          const mst = publication.track?.mediaStreamTrack;
          if (mst) {
            // Replace any prior listener — on a re-publish the underlying track is new.
            mst.onended = async () => {
              // User-initiated camera-off → skip the probe + toast entirely.
              if (consumeIntentionalCameraOff()) return;
              // Room is tearing down or has been replaced → skip.
              if (roomRef.current !== newRoom) return;

              // Re-probe getUserMedia to distinguish hardware unplug from
              // OS-level permission revoke. Keep the probe short and tolerant.
              const deviceId = useVoiceStore.getState().cameraDeviceId;
              let copy = 'Camera unavailable';
              try {
                const probe = await navigator.mediaDevices.getUserMedia({
                  video: deviceId ? { deviceId: { exact: deviceId } } : true,
                });
                probe.getTracks().forEach(t => t.stop());
                // Probe succeeded — reason is unknown; keep generic copy.
              } catch (err: any) {
                if (err?.name === 'NotAllowedError') copy = 'Camera permission was revoked';
                else if (err?.name === 'NotFoundError') copy = 'Camera disconnected';
                // Any other error → keep generic copy.
              }

              // The probe is async and may have taken time (especially if the
              // browser surfaced a permission prompt). If the user disconnected
              // while the probe was in flight, `roomRef.current` is no longer
              // `newRoom` — silently no-op so we don't mutate state or surface
              // a toast for a session the user has already left.
              if (roomRef.current !== newRoom) return;

              // Tear down camera state via the unified path. Mark intentional so
              // the disable's own track-end doesn't recurse into this handler.
              markIntentionalCameraOff();
              await roomRef.current.localParticipant.setCameraEnabled(false).catch(() => {});
              useVoiceStore.setState({ isCameraOn: false });
              broadcastVoiceStatus();
              useUIStore.getState().addToast(copy, 'warning');
            };
          }
        }
        // NOTE: Microphone track-loss is handled at the AudioManager layer via
        // `onInputTrackEnded`, NOT here. The published mic track is a clone of
        // a WebAudio destination node and does not end on hardware loss — only
        // the upstream getUserMedia track does. See the `useEffect` that
        // subscribes to `AudioManager.onInputTrackEnded` above.
        guardedUpdate();
      });
      newRoom.on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
        if (publication.source === Track.Source.ScreenShare) {
          // screenShare decides whether the share is over: a stop (ours, the
          // OS stop bar, the source ending) or a republish of the same share
          // (a codec change, a full reconnect). Only an end drops our own
          // stream from the watched set; a republish keeps it, or the local
          // tile would flicker until LocalTrackPublished puts it back.
          if (handleScreenShareUnpublished(newRoom)) {
            const { userId } = parseIdentity(newRoom.localParticipant.identity);
            useVoiceStore.getState().unwatchStream(userId);
          }
        }
        if (publication.source === Track.Source.ScreenShareAudio) {
          handleScreenShareAudioUnpublished(newRoom);
        }
        guardedUpdate();
      });
      newRoom.on(RoomEvent.TrackMuted, guardedUpdate);
      newRoom.on(RoomEvent.TrackUnmuted, guardedUpdate);
      newRoom.on(RoomEvent.ParticipantMetadataChanged, syncSubscriptions);
      newRoom.on(RoomEvent.ParticipantPermissionsChanged, syncSubscriptions);
      newRoom.on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!isCurrent()) return;
        if (getNativeHelper(participant)) {
          syncSubscriptions();
          return;
        }
        if (
          publication.source !== Track.Source.ScreenShare &&
          publication.source !== Track.Source.ScreenShareAudio
        ) {
          publication.setSubscribed(true);
        } else if (publication.source === Track.Source.ScreenShareAudio) {
          // Stream tracks follow the watch state, and the watch click only
          // subscribed what was published then. System Audio can be turned on
          // mid-stream, so audio arriving for a stream being watched joins it.
          if (useVoiceStore.getState().watchingStreams.has(resolveParticipantUserId(participant.identity))) {
            publication.setSubscribed(true);
          }
        } else if (republish.completeWithPublication(participant.identity)) {
          // The new track of an announced republish: a viewer who was watching
          // keeps watching without clicking Watch again. Its audio, published
          // after the video, is picked up by the branch above.
          if (useVoiceStore.getState().watchingStreams.has(resolveParticipantUserId(participant.identity))) {
            publication.setSubscribed(true);
          }
        }
        syncSubscriptions();
      });
      newRoom.on(RoomEvent.TrackUnpublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!isCurrent()) return;
        // An announced republish keeps the watch and the stream's audio
        // settings for the next publication; anything else ends the share.
        if (
          publication.source === Track.Source.ScreenShare
          && !republish.bridgeRemoval(participant.identity)
        ) {
          endParticipantScreen(participant);
        }
        updateParticipants();
      });
      newRoom.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
        if (isCurrent()) handleDataReceived(payload, participant, republish);
      });
      newRoom.on(RoomEvent.ConnectionQualityChanged, (quality: ConnectionQuality, participant: Participant) => {
        const normalizedQuality = toVoiceConnectionQuality(quality);
        useVoiceStore.getState().setConnectionQuality(normalizedQuality, participant.identity);
        if (participant.identity === newRoom.localParticipant.identity) {
          useVoiceStore.getState().setConnectionQuality(normalizedQuality);
        }
      });
      newRoom.on(RoomEvent.SignalReconnecting, () => {
        if (roomRef.current === newRoom) {
          useVoiceStore.getState().setVoiceConnectionStatus('reconnecting');
        }
      });
      newRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (roomRef.current === newRoom) {
          setConnectionState(state);
          const connected = state === ConnectionState.Connected;
          const connecting = state === ConnectionState.Connecting || state === ConnectionState.Reconnecting;

          setIsConnected(connected);
          setIsConnecting(connecting);

          useVoiceStore.getState().setIsLiveKitConnected(connected);
          useVoiceStore.getState().setVoiceConnectionStatus(
            connected ? 'connected' : state === ConnectionState.Reconnecting ? 'reconnecting' : 'connecting',
          );

          if (connected) {
            // A full reconnect republished every local track: the share goes
            // on if its publication came back, and ends here if not.
            settleScreenShareAfterReconnect(newRoom);
            // On LiveKit reconnect, re-register with WS server (server may have restarted)
            if (connectedChannelRef.current) {
              registerWithServer();
            }
            syncSubscriptions();
            if (useVoiceStore.getState().isScreenSharing && !useVoiceStore.getState().nativeVoiceActive) {
              scheduleScreenShareOverdrive(newRoom);
            }
          }
        }
      });
      newRoom.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        // A full reconnect that gave up: a share it had withdrawn ends here.
        settleScreenShareAfterReconnect(newRoom);
        if (roomRef.current !== newRoom) return;
        republish.clear();
        // The SDK emits Disconnected before rejecting an initial connect.
        // Keep that attempt current so its catch can report the failure.
        if (!initialConnectPending) _connectGeneration++;
        AudioManager.getInstance().releaseInputStream();
        SpeakingDetector.getInstance().clear();
        setConnectionState(ConnectionState.Disconnected);
        setIsConnecting(false);
        setConnectedChannelId(null);
        roomRef.current = null; _activeRoom = null; setIsConnected(false); setRoom(null);
        // Batch participants + connected into one setState to prevent SoundController
        // from seeing intermediate states (e.g., participants empty but still "connected"
        // → triggers user_leave sound before the disconnect sound).
        useVoiceStore.getState().setSpeakingParticipants(new Set());
        useVoiceStore.setState({ participants: [], isLiveKitConnected: false });
        useVoiceStore.getState().setVoiceConnectionStatus('disconnected');

        // Semantic terminal reasons must never auto-retry. An exhausted network
        // reconnect keeps voice intent so VoiceControls can offer a user retry.
        const terminal = reason === DisconnectReason.DUPLICATE_IDENTITY
          || reason === DisconnectReason.PARTICIPANT_REMOVED
          || reason === DisconnectReason.ROOM_DELETED;
        if (terminal) {
          useVoiceStore.getState().handleForceDisconnect();
        } else if (reason !== DisconnectReason.CLIENT_INITIATED) {
          setConnectionError('network_disconnect');
          useVoiceStore.getState().setConnectionError('network_disconnect');
        }
      });

      await newRoom.connect(url, token, { autoSubscribe: false });
      initialConnectPending = false;
      if (gen !== _connectGeneration) { destroyRoom(newRoom); return; }
      _activeRoom = newRoom;
      connectedChannelRef.current = storedId;
      setConnectedChannelId(storedId);
      setRoom(newRoom);
      setIsConnected(true);
      useVoiceStore.getState().setIsLiveKitConnected(true);
      useVoiceStore.getState().setVoiceConnectionStatus('connected');

      // Tell WS server we're in the voice channel now that LiveKit is connected
      registerWithServer();

      updateParticipants();

      // Existing helpers follow the same owner/watch rules as publications arriving later.
      syncRemoteSubscriptions(newRoom);

      // Initial mute state check
      const { isDeafened: wasDeafened } = useVoiceStore.getState();

      if (wasDeafened) {
        newRoom.remoteParticipants.forEach((p) => p.setVolume(0));
      }
      
      updateParticipants();
    } catch (err) {
      if (gen === _connectGeneration) {
        AudioManager.getInstance().releaseInputStream();
        setConnectionError('connect_failed');
        useVoiceStore.getState().leaveVoice();
        useVoiceStore.getState().setConnectionError('connect_failed');
      }
    }
    finally { if (gen === _connectGeneration) setIsConnecting(false); }
  }, [updateParticipants, handleDataReceived]);

  const disconnect = useCallback(async () => {
    const gen = ++_connectGeneration;
    // Release before SDK teardown, even if token fetching has not made a Room
    // yet. A late teardown must never stop a subsequent call's fresh capture.
    AudioManager.getInstance().releaseInputStream();
    SpeakingDetector.getInstance().clear();
    deactivateHwOverdrive();
    connectedChannelRef.current = null;
    setConnectedChannelId(null);
    if (roomRef.current) {
      // Null out roomRef BEFORE destroying so that guardedUpdate() skips
      // during teardown. Without this, ParticipantDisconnected events fire
      // before RoomEvent.Disconnected, calling updateParticipants while
      // isLiveKitConnected is still true — SoundController plays user_leave
      // for departing participants alongside the disconnect sound.
      const roomToDestroy = roomRef.current;
      roomRef.current = null;
      _activeRoom = null;
      _republishTrackers.get(roomToDestroy)?.clear();
      await destroyRoom(roomToDestroy);
      if (gen !== _connectGeneration) return;
    }
    setRoom(null);
    setIsConnected(false);
    setIsConnecting(false);
    setConnectionState(ConnectionState.Disconnected);
    useVoiceStore.getState().setVoiceConnectionStatus('disconnected');
    useVoiceStore.getState().setSpeakingParticipants(new Set());
    useVoiceStore.setState({ participants: [], isLiveKitConnected: false });
  }, []);

  const toggleMic = useCallback(async () => { 
    await AudioManager.getInstance().resumeContext();
    useVoiceStore.getState().toggleMic();
  }, []);

  useEffect(() => {
    updateParticipants();
  }, [voiceUserStates, isMuted, isDeafened, isScreenSharing, spaceMutedUserIds, spaceDeafenedUserIds, permissionMutedUserIds, nativeVoiceActive, updateParticipants]);

  useEffect(() => {
    if (!room) return;
    // Superseded by a newer run (config changed again, or the room went away)
    // while this one was still queued behind an in-flight update.
    let superseded = false;
    const updateActiveTracks = async () => {
      if (superseded) return;
      if (isScreenSharing && !nativeVoiceActive) {
        // Native encoding/audio updates are owned by the bridge, not this Web publisher.
        // System Audio first: a toggle change publishes or withdraws only the
        // audio track, never the video.
        await syncScreenShareAudio(room);
        const opts = buildScreenShareOptions(screenShareConfig);
        // Codec changed mid-stream — the codec is baked into SDP negotiation,
        // so republish the same track under the new options (no re-capture).
        const publishedCodec = getRequestedPublishedScreenShareCodec();
        if (publishedCodec && publishedCodec !== opts.publish.videoCodec) {
          await republishScreenShare(room);
          return;
        }

        const screenPub = room.localParticipant.getTrackPublications().find(p => p.source === Track.Source.ScreenShare);
        if (screenPub?.videoTrack) {
          const mediaTrack = getMediaStreamTrack(screenPub.videoTrack);
          if (mediaTrack) {
            if (opts.capture.width > 0 && opts.capture.height > 0) {
              // Standard mode: apply resolution + frameRate together
              await mediaTrack.applyConstraints({ width: { ideal: opts.capture.width }, height: { ideal: opts.capture.height }, frameRate: { ideal: opts.capture.frameRate, min: 15 } });
            } else {
              // Native mode: apply frameRate only — never pass 0 to width/height
              await mediaTrack.applyConstraints({ frameRate: { ideal: opts.capture.frameRate, min: 15 } });
            }
            mediaTrack.contentHint = opts.contentHint;
          }
          // For native mode, recompute overdrive bitrate from actual track dimensions
          resolveNativeOverdrive(mediaTrack ?? null, screenShareConfig, opts);
          await applyOverdrive(room, Track.Source.ScreenShare, opts.overdrive);
        }
      }
      if (isCameraOn) { await applyOverdrive(room, Track.Source.Camera, CAMERA_OVERDRIVE); }
    };
    _activeTrackUpdate = _activeTrackUpdate.then(updateActiveTracks).catch(() => {});
    return () => { superseded = true; };
  }, [room, screenShareConfig, streamHostLimits, isScreenSharing, isCameraOn, nativeVoiceActive]);

  useEffect(() => {
    return () => {
      _connectGeneration++;
      SpeakingDetector.getInstance().clear();
      deactivateHwOverdrive();
      AudioManager.getInstance().releaseInputStream();
      const roomToDestroy = roomRef.current;
      roomRef.current = null;
      _activeRoom = null;
      if (roomToDestroy) {
        _republishTrackers.get(roomToDestroy)?.clear();
        void destroyRoom(roomToDestroy);
      }
    };
  }, []);


  return { room, isConnected, isConnecting, connectionState, connectedChannelId, connectionError, connect, disconnect, toggleMic };
}
