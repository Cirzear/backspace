import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockWsSendAll = vi.fn();
vi.mock('../hooks/useWebSocket', () => ({
  wsSendAll: (...args: unknown[]) => mockWsSendAll(...args),
}));

const mockUpload = vi.fn();
vi.mock('../api/client', () => ({
  api: { gameIcons: { upload: (...args: unknown[]) => mockUpload(...args) } },
}));

import { useActivityStore } from './activityStore';
import { GAME_OVERRIDES_KEY } from '../utils/gameOverrides';
import type { Activity } from '@backspace/shared';

const RUNTIME: Activity = { type: 'playing', name: 'Steam Linux Runtime', timestamps: { start: 1000 } };
const MUSIC: Activity = { type: 'listening', name: 'Spotify' };

const getGameIcon = vi.fn<(name: string) => Promise<{ data: string; mime: string } | null>>();

function lastSent(): Activity[] {
  const calls = mockWsSendAll.mock.calls;
  return calls[calls.length - 1][0].activities as Activity[];
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  (window as unknown as { backspace: unknown }).backspace = { getGameIcon };
  getGameIcon.mockReset();
  getGameIcon.mockResolvedValue(null);
  useActivityStore.getState().reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { backspace: unknown }).backspace;
});

describe('manual game', () => {
  it('is shown when nothing is detected, and is remembered', async () => {
    useActivityStore.getState().setManualGame('  Hades  ');
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([{ type: 'playing', name: 'Hades' }]);
    expect(JSON.parse(localStorage.getItem(GAME_OVERRIDES_KEY) ?? '{}').manual).toBe('Hades');
  });

  it('replaces a detected game and keeps other activity types', async () => {
    useActivityStore.getState().pushActivities([RUNTIME, MUSIC]);
    useActivityStore.getState().setManualGame('Hades');
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([{ type: 'playing', name: 'Hades' }, MUSIC]);
  });

  it('survives the detector reporting nothing', async () => {
    useActivityStore.getState().setManualGame('Hades');
    useActivityStore.getState().pushActivities([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([{ type: 'playing', name: 'Hades' }]);
  });

  it('is cleared back to what is detected', async () => {
    useActivityStore.getState().pushActivities([RUNTIME]);
    useActivityStore.getState().setManualGame('Hades');
    await vi.advanceTimersByTimeAsync(5000);
    useActivityStore.getState().setManualGame(null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([RUNTIME]);
    expect(localStorage.getItem(GAME_OVERRIDES_KEY)).toBeNull();
  });

  it('clearing it with nothing detected tells the others the player stopped', async () => {
    useActivityStore.getState().setManualGame('Hades');
    await vi.advanceTimersByTimeAsync(5000);
    useActivityStore.getState().setManualGame(null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([]);
  });

  it('looks its icon up by the name the player typed', async () => {
    getGameIcon.mockResolvedValue({ data: 'aWNvbg==', mime: 'image/png' });
    mockUpload.mockResolvedValue({ id: 'a', url: 'https://chat.test/api/game-icons/assets/a.webp' });
    useActivityStore.getState().setManualGame('Hades');
    await vi.advanceTimersByTimeAsync(5000);
    expect(getGameIcon).toHaveBeenCalledWith('Hades');
    expect(lastSent()[0].assets?.largeImage).toBe('https://chat.test/api/game-icons/assets/a.webp');
  });

  it('is not sent while sharing is off, and shows up when it is switched on', async () => {
    useActivityStore.getState().setShowActivity(false);
    mockWsSendAll.mockClear();
    useActivityStore.getState().setManualGame('Hades');
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockWsSendAll).not.toHaveBeenCalled();
    useActivityStore.getState().setShowActivity(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([{ type: 'playing', name: 'Hades' }]);
  });

  it('is forgotten when the account signs out', () => {
    useActivityStore.getState().setManualGame('Hades');
    useActivityStore.getState().reset();
    expect(useActivityStore.getState().manualGame).toBeNull();
    expect(localStorage.getItem(GAME_OVERRIDES_KEY)).toBeNull();
  });
});

describe('renamed games', () => {
  it('shows a detected game under the chosen name, case-insensitively, and keeps the rest', async () => {
    useActivityStore.getState().setGameRename('steam linux runtime', 'Hades');
    useActivityStore.getState().pushActivities([RUNTIME]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([{ ...RUNTIME, name: 'Hades' }]);
  });

  it('is applied after the icon lookup, which goes by the detected name', async () => {
    getGameIcon.mockResolvedValue({ data: 'aWNvbg==', mime: 'image/png' });
    mockUpload.mockResolvedValue({ id: 'a', url: 'https://chat.test/api/game-icons/assets/a.webp' });
    useActivityStore.getState().setGameRename('Steam Linux Runtime', 'Hades');
    useActivityStore.getState().pushActivities([RUNTIME]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getGameIcon).toHaveBeenCalledWith('Steam Linux Runtime');
    expect(getGameIcon).not.toHaveBeenCalledWith('Hades');
    expect(lastSent()[0].name).toBe('Hades');
  });

  it('is remembered and applies to the next detection, until restored', async () => {
    useActivityStore.getState().setGameRename('Steam Linux Runtime', 'Hades');
    useActivityStore.getState().pushActivities([]);
    useActivityStore.getState().pushActivities([RUNTIME]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()[0].name).toBe('Hades');

    useActivityStore.getState().setGameRename('Steam Linux Runtime', null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()[0].name).toBe('Steam Linux Runtime');
  });

  it('does not rename music', async () => {
    useActivityStore.getState().setGameRename('Spotify', 'Other');
    useActivityStore.getState().pushActivities([MUSIC]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([MUSIC]);
  });
});
