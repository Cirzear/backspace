import { Track, type Room, type RemoteTrackPublication } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import { encodeStreamWatch, streamWatchFor } from '../utils/streamWatchProtocol';
import type { StreamResumeMemory, RememberedStream } from '../utils/streamResume';
import { getParticipantOwnerIdentity, getNativeHelper, resolveParticipantUserId } from './liveKitParticipants';

export function setStreamSubscription(room: Room | null, targetIdentity: string, subscribed: boolean) {
  if (!room) return;
  // Watch state belongs to the owner, while Android publishes from an authenticated helper.
  for (const participant of room.remoteParticipants.values()) {
    const helper = getNativeHelper(participant);
    const matches = participant.identity === targetIdentity
      || (helper?.purpose === 'screen-share' && helper.ownerIdentity === targetIdentity);
    if (!matches) continue;
    participant.trackPublications.forEach((pub) => {
      if (pub.source !== Track.Source.ScreenShare && pub.source !== Track.Source.ScreenShareAudio) return;
      const loopback = helper?.ownerIdentity === room.localParticipant.identity && pub.source === Track.Source.ScreenShareAudio;
      (pub as RemoteTrackPublication).setSubscribed(subscribed && !loopback);
    });
  }
}

/**
 * A remote screen share ended. When this viewer was watching it, the share is
 * remembered for a while with its volume and mute (`StreamResumeMemory`), in
 * case a full reconnect ended it.
 */
export function rememberWatchedShare(memory: StreamResumeMemory, identity: string): void {
  const userId = resolveParticipantUserId(identity);
  const state = useVoiceStore.getState();
  if (!state.watchingStreams.has(userId)) return;
  memory.rememberEnded(identity, { volume: state.streamVolumes.get(userId), muted: state.streamMutes.get(userId) });
}

/**
 * Watch a remembered share again once it is published: the watch, its volume
 * and mute, the subscription, and the `stream_watch` ping that puts this
 * viewer back in the sharer's watcher set (a full reconnect on either side
 * dropped it there). No cue plays here: nobody clicked anything.
 */
export function resumeRemoteStream(room: Room, identity: string, stream: RememberedStream): void {
  const userId = resolveParticipantUserId(identity);
  const state = useVoiceStore.getState();
  state.watchStream(userId);
  if (stream.volume !== undefined) state.setStreamVolume(userId, stream.volume);
  if (stream.muted !== undefined) state.setStreamMute(userId, stream.muted);
  setStreamSubscription(room, identity, true);
  room.localParticipant
    .publishData(encodeStreamWatch(streamWatchFor({ userId, identity }, true)), { reliable: true })
    .catch((err: unknown) => console.warn('[LiveKit] Could not tell the sharer the watch resumed:', err));
}

/** Resume the remembered share of `identity` when it is published now. */
export function resumeIfPublished(room: Room, memory: StreamResumeMemory, identity: string): void {
  const participant = room.remoteParticipants.get(identity);
  if (!participant) return;
  const published = [...room.remoteParticipants.values()]
    .filter((publisher) => getParticipantOwnerIdentity(publisher) === identity)
    .some((publisher) => [...publisher.trackPublications.values()].some((pub) => pub.source === Track.Source.ScreenShare));
  if (!published) return;
  const stream = memory.takeOnPublication(identity);
  if (stream) resumeRemoteStream(room, identity, stream);
}

/** A remote screen share ended: drop the watch and the per-stream audio settings. */
export function endRemoteStream(identity: string): void {
  const userId = resolveParticipantUserId(identity);
  const state = useVoiceStore.getState();
  state.unwatchStream(userId);
  state.clearStreamVolume(userId);
  state.clearStreamMute(userId);
}
