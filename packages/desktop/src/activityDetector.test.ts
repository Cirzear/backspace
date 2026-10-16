import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  resolveActiveActivity,
  type TrackedApp,
} from './activityDetector';
import {
  loadActivitySettings,
  saveActivitySettings,
  DEFAULT_ACTIVITY_SETTINGS,
} from './activitySettings';

const tempDir = path.join(os.tmpdir(), `activity-test-${Date.now()}`);

vi.mock('electron', () => ({
  app: {
    getPath: () => tempDir,
  },
}));

beforeEach(() => {
  fs.mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

describe('resolveActiveActivity', () => {
  const gameA: TrackedApp = {
    entry: { id: 'cloudmusic', name: 'NetEase Cloud Music', processes: ['cloudmusic.exe'], type: 'listening' },
    firstSeenAt: 1000,
    lastStartedAt: 1000,
  };

  const gameB: TrackedApp = {
    entry: { id: 'wukong', name: 'Black Myth: Wukong', processes: ['b1.exe'], type: 'playing' },
    firstSeenAt: 2000,
    lastStartedAt: 2000,
  };

  const gameC: TrackedApp = {
    entry: { id: 'apex', name: 'Apex Legends', processes: ['r5apex.exe'], type: 'playing' },
    firstSeenAt: 500,
    lastStartedAt: 3000,
  };

  it('returns null when no applications are tracked', () => {
    const map = new Map<string, TrackedApp>();
    expect(resolveActiveActivity(map, false, null)).toBeNull();
    expect(resolveActiveActivity(map, true, null)).toBeNull();
  });

  it('returns the single running application regardless of preemption flag', () => {
    const map = new Map<string, TrackedApp>([['cloudmusic', gameA]]);
    expect(resolveActiveActivity(map, false, null)).toEqual(gameA);
    expect(resolveActiveActivity(map, true, null)).toEqual(gameA);
  });

  describe('when preemption is disabled (enablePreemption = false)', () => {
    it('preserves the currently active application if it is still running', () => {
      const map = new Map<string, TrackedApp>([
        ['cloudmusic', gameA],
        ['wukong', gameB],
      ]);

      // Currently showing NetEase Cloud Music (gameA) -> should keep gameA even though gameB started later
      const resolved = resolveActiveActivity(map, false, 'cloudmusic');
      expect(resolved).toEqual(gameA);
    });

    it('falls back to the first-detected application when current exits', () => {
      const map = new Map<string, TrackedApp>([
        ['wukong', gameB], // firstSeenAt: 2000
        ['cloudmusic', gameA], // firstSeenAt: 1000
      ]);

      // No current app running or previous app exited -> chooses earliest firstSeenAt (gameA)
      const resolved = resolveActiveActivity(map, false, null);
      expect(resolved).toEqual(gameA);
    });
  });

  describe('when preemption is enabled (enablePreemption = true)', () => {
    it('selects the most recently launched application', () => {
      const map = new Map<string, TrackedApp>([
        ['cloudmusic', gameA], // lastStartedAt: 1000
        ['wukong', gameB], // lastStartedAt: 2000
      ]);

      // Preemption enabled -> Wukong (2000) preempts NetEase Cloud Music (1000)
      const resolved = resolveActiveActivity(map, true, 'cloudmusic');
      expect(resolved).toEqual(gameB);
    });

    it('preempts again when a newer application starts', () => {
      const map = new Map<string, TrackedApp>([
        ['cloudmusic', gameA], // lastStartedAt: 1000
        ['wukong', gameB], // lastStartedAt: 2000
        ['apex', gameC], // lastStartedAt: 3000
      ]);

      // Apex Legends started at 3000 -> preempts Wukong
      const resolved = resolveActiveActivity(map, true, 'wukong');
      expect(resolved).toEqual(gameC);
    });

    it('falls back to the next most recently started application when latest exits', () => {
      const map = new Map<string, TrackedApp>([
        ['cloudmusic', gameA], // lastStartedAt: 1000
        ['wukong', gameB], // lastStartedAt: 2000
      ]);

      // VS Code closed, remaining are Wukong and NetEase -> Wukong wins
      const resolved = resolveActiveActivity(map, true, null);
      expect(resolved).toEqual(gameB);
    });
  });
});

describe('activitySettings persistence', () => {
  it('returns default settings when file does not exist', () => {
    const settings = loadActivitySettings();
    expect(settings).toEqual(DEFAULT_ACTIVITY_SETTINGS);
    expect(settings.enablePreemption).toBe(false);
  });

  it('saves and reloads activity settings correctly', () => {
    saveActivitySettings({ enablePreemption: true });
    const loaded = loadActivitySettings();
    expect(loaded.enablePreemption).toBe(true);

    saveActivitySettings({ enablePreemption: false });
    expect(loadActivitySettings().enablePreemption).toBe(false);
  });
});
