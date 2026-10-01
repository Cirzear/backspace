import { Track, type LocalAudioTrack, type Room } from 'livekit-client';
import { AudioManager } from '../audio/AudioManager';

// A pending publish must finish (and be withdrawn) before native starts using the mic.
const microphoneUpdates = new WeakMap<Room, Promise<void>>();
const nativeSuspensions = new WeakMap<Room, Promise<void>>();

function queueMicrophoneUpdate(room: Room, update: () => Promise<void>): Promise<void> {
  const previous = microphoneUpdates.get(room) ?? Promise.resolve();
  const next = previous.then(update, update);
  microphoneUpdates.set(room, next);
  return next;
}

/** Native start awaits this boundary; mute alone leaves the Web Audio capture device open. */
export function suspendWebMicrophoneForNative(room: Room): Promise<void> {
  const pending = nativeSuspensions.get(room);
  if (pending) return pending;
  // Release immediately, including acquisitions currently waiting for getUserMedia.
  AudioManager.getInstance().releaseInputStream();
  const result = queueMicrophoneUpdate(room, async () => {
    const mic = room.localParticipant.getTrackPublications().find(p => p.source === Track.Source.Microphone);
    if (!mic?.track) return;
    const track = mic.track;
    try { await room.localParticipant.unpublishTrack(track as LocalAudioTrack, true); }
    finally { track.stop(); }
  });
  nativeSuspensions.set(room, result);
  const cleanup = () => { nativeSuspensions.delete(room); };
  void result.then(cleanup, cleanup);
  return result;
}

/** Publish only the current AudioManager generation, with room/handoff checks after every await. */
export function republishMicrophone(
  room: Room,
  lastGeneration: { current: number },
  isCurrent: () => boolean,
): Promise<void> {
  return queueMicrophoneUpdate(room, async () => {
    if (!isCurrent()) return;
    const audioManager = AudioManager.getInstance();
    const generation = audioManager.getStreamGeneration();
    const mic = room.localParticipant.getTrackPublications().find(p => p.source === Track.Source.Microphone);
    if (mic?.track?.mediaStreamTrack?.readyState === 'live' && lastGeneration.current === generation) {
      if (mic.isMuted) await room.localParticipant.setMicrophoneEnabled(true);
      return;
    }
    if (mic?.track) await room.localParticipant.unpublishTrack(mic.track as LocalAudioTrack, true);
    if (!isCurrent()) return;
    const track = audioManager.getFreshTrack();
    if (!track) return;
    try {
      await room.localParticipant.publishTrack(track, { name: 'microphone', source: Track.Source.Microphone });
      if (!isCurrent()) {
        await room.localParticipant.unpublishTrack(track, true);
        track.stop();
        return;
      }
      lastGeneration.current = generation;
    } catch (error) {
      track.stop();
      throw error;
    }
  });
}
