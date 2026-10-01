import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamTile } from './StreamTile';
import { useVoiceStore } from '../../stores/voiceStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import type { ParticipantInfo, StreamTile as StreamTileInfo } from '../../hooks/useLiveKit';
import type { TrackStatsSnapshot, VideoTrackStat } from '../../hooks/useTrackStats';

const mocks = vi.hoisted(() => ({ subscription: vi.fn(), publishData: vi.fn(), health: vi.fn(), stop: vi.fn() }));
vi.mock('../../hooks/useLiveKit', () => ({
  getActiveRoom: () => ({ localParticipant: { publishData: mocks.publishData } }),
  setStreamSubscription: mocks.subscription,
}));
vi.mock('../../utils/voiceActions', () => ({ handleScreenShareAction: mocks.stop }));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ playSound: vi.fn() }) } }));
vi.mock('../../hooks/useVoiceParticipantMeta', () => ({
  useVoiceParticipantMeta: () => ({ displayName: 'Bob', avatar: null, user: null }),
}));
vi.mock('../../hooks/useStreamHealthWarning', () => ({
  classifyStreamHealth: mocks.health, useStreamHealthWarning: () => null,
}));

function tile(overrides: Partial<ParticipantInfo> = {}): StreamTileInfo {
  const participant: ParticipantInfo = {
    identity: 'home-bob:Bob', userId: 'local-bob', username: 'Bob', homeUserId: 'home-bob',
    isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true, isLocal: false,
    audioTrack: null, videoTrack: null, screenTrack: null, screenAudioTrack: null,
    lkVideoTrack: null, lkScreenTrack: null, cachedUser: null,
    screenPublisherIdentity: 'random-screen-helper', ...overrides,
  };
  return { kind: 'stream', key: 'bob:stream', participant, screenTrack: null, screenAudioTrack: null, lkScreenTrack: null };
}

function stats(): TrackStatsSnapshot {
  const base: VideoTrackStat = {
    key: 'screen', direction: 'recv', source: 'screen_share', participantIdentity: 'random-screen-helper',
    participantName: 'Bob', bitrate: 1000, codec: 'h264', encoderImpl: null,
    width: 1920, height: 1080, fps: 30, qualityLimitation: null, simulcastLayer: null,
    packetLoss: 12, jitter: 17, qpSumDelta: null, nackCountDelta: null, pliCountDelta: null, freezeCountDelta: 4,
  };
  return {
    network: { ping: null, packetLoss: null, jitter: null, serverAddress: null, protocol: null, candidateType: null },
    audioTracks: [], videoTracks: [{ ...base, participantIdentity: 'home-bob:Bob', packetLoss: 0 }, base],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useVoiceStore.setState({ ...useVoiceStore.getInitialState(), watchingStreams: new Set() });
});
afterEach(cleanup);

describe('native helper StreamTile', () => {
  it('watches by owner user id and subscribes the helper, including stop-watching', () => {
    const { container } = render(<StreamTile tile={tile()} stats={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch Stream' }));
    expect(useVoiceStore.getState().watchingStreams.has('local-bob')).toBe(true);
    expect(mocks.subscription).toHaveBeenLastCalledWith(expect.anything(), 'random-screen-helper', true);
    fireEvent.contextMenu(container.firstElementChild!);
    const stop = useContextMenuStore.getState().menu!.items.find(item => item.key === 'stop-watching');
    expect(stop?.type).toBe('action');
    if (stop?.type === 'action') act(() => { stop.onClick?.(); });
    expect(mocks.subscription).toHaveBeenLastCalledWith(expect.anything(), 'random-screen-helper', false);
    expect(useVoiceStore.getState().watchingStreams.has('local-bob')).toBe(false);
  });

  it.each([false, true])('matches native screen statistics by helper identity (local=%s)', isLocal => {
    useVoiceStore.setState({ connectionQualities: new Map([['random-screen-helper', 'poor'], ['home-bob:Bob', 'excellent']]) });
    render(<StreamTile tile={tile({ isLocal })} stats={stats()} />);
    expect(mocks.health).toHaveBeenLastCalledWith(expect.objectContaining({
      isLocal: false, publisherConnectionQuality: 'poor', packetLoss: 12, jitter: 17, freezeCountDelta: 4,
    }));
  });

  it('routes local native stop through the common native-aware action', () => {
    const { container } = render(<StreamTile tile={tile({ isLocal: true })} stats={null} />);
    fireEvent.contextMenu(container.firstElementChild!);
    const stop = useContextMenuStore.getState().menu!.items.find(item => item.key === 'stop-streaming');
    if (stop?.type === 'action') act(() => { stop.onClick?.(); });
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
});
