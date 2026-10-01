import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalAudioRenderer } from './GlobalAudioRenderer';
import { useVoiceStore } from '../../stores/voiceStore';
import type { ParticipantInfo } from '../../hooks/useLiveKit';

const mocks = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../../hooks/useAudioTrackPlayer', () => ({ useAudioTrackPlayer: (options: unknown) => {
  mocks.play(options);
  return { ref: null };
} }));

const mic = { id: 'native-mic' } as MediaStreamTrack;
const screenAudio = { id: 'system-audio' } as MediaStreamTrack;
function participant(isLocal = false): ParticipantInfo {
  return {
    identity: 'owner:Bob', userId: 'local-owner', username: 'Bob', homeUserId: 'owner',
    isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true, isLocal,
    voicePublisherIdentity: 'random-mic', screenPublisherIdentity: 'random-screen',
    audioTrack: mic, videoTrack: null, screenTrack: null, screenAudioTrack: screenAudio,
    lkVideoTrack: null, lkScreenTrack: null, cachedUser: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useVoiceStore.setState({ ...useVoiceStore.getInitialState(), participants: [participant()], outputVolume: 100,
    watchingStreams: new Set(['local-owner']), streamAttenuationEnabled: false,
    participantVolumes: new Map([['local-owner', 130]]), streamVolumes: new Map([['local-owner', 70]]) });
});
afterEach(cleanup);

describe('native-aware receive audio', () => {
  it('uses owner preferences for native MIC and screen audio without duplicate helper renderers', () => {
    render(<GlobalAudioRenderer />);
    expect(mocks.play).toHaveBeenCalledTimes(2);
    expect(mocks.play).toHaveBeenCalledWith({ track: mic, volume: 1.3, muted: false });
    expect(mocks.play).toHaveBeenCalledWith({ track: screenAudio, volume: 0.7, muted: false });
  });

  it('pauses Web MIC output during takeover, retains watched screen audio, then restores MIC', () => {
    render(<GlobalAudioRenderer />);
    mocks.play.mockClear();
    act(() => { useVoiceStore.setState({ nativeVoiceActive: true }); });
    expect(mocks.play).toHaveBeenCalledWith({ track: mic, volume: 1.3, muted: true });
    expect(mocks.play).toHaveBeenCalledWith({ track: screenAudio, volume: 0.7, muted: false });
    mocks.play.mockClear();
    act(() => { useVoiceStore.setState({ nativeVoiceActive: false }); });
    expect(mocks.play).toHaveBeenCalledWith({ track: mic, volume: 1.3, muted: false });
  });

  it('never plays own helper audio even when nativeVoiceActive is already false', () => {
    useVoiceStore.setState({ participants: [participant(true)] });
    render(<GlobalAudioRenderer />);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(mocks.play).toHaveBeenCalledWith({ track: mic, volume: 1.3, muted: true });
  });

  it('does not render unwatched system audio and respects owner stream mute', () => {
    useVoiceStore.setState({ watchingStreams: new Set() });
    render(<GlobalAudioRenderer />);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    mocks.play.mockClear();
    act(() => { useVoiceStore.setState({ watchingStreams: new Set(['local-owner']), streamMutes: new Map([['local-owner', true]]) }); });
    expect(mocks.play).toHaveBeenCalledWith({ track: screenAudio, volume: 0.7, muted: true });
  });
});
