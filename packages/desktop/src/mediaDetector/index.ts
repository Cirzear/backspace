import type { MediaActivity, MediaTrackInfo } from './types';
import { startDarwinMedia, stopDarwinMedia } from './darwinMedia';
import { startWin32Media, stopWin32Media } from './win32Media';
import { startLinuxMedia, stopLinuxMedia } from './linuxMpris';

export type { MediaActivity, MediaTrackInfo };

let currentActivity: MediaActivity | null = null;
let changeCallback: ((activity: MediaActivity | null) => void) | null = null;
let isRunning = false;

export function convertTrackToActivity(track: MediaTrackInfo | null): MediaActivity | null {
  if (!track || !track.title) return null;

  const now = Date.now();
  let start = now;
  let end: number | undefined;

  if (typeof track.positionMs === 'number' && track.positionMs >= 0) {
    start = now - track.positionMs;
  }

  if (typeof track.durationMs === 'number' && track.durationMs > 0) {
    end = start + track.durationMs;
  }

  return {
    type: 'listening',
    name: track.title,
    details: track.artist || undefined,
    state: track.album || undefined,
    timestamps: {
      start,
      end,
    },
    assets: {
      largeImage: track.artUrl,
      largeText: track.album,
      smallText: track.player,
    },
    url: track.sourceUrl,
  };
}

function handleTrackChange(track: MediaTrackInfo | null): void {
  const activity = convertTrackToActivity(track);
  currentActivity = activity;
  changeCallback?.(currentActivity);
}

export function startMediaDetection(
  onMediaChange: (activity: MediaActivity | null) => void,
): void {
  if (isRunning) return;
  isRunning = true;
  changeCallback = onMediaChange;

  if (process.platform === 'darwin') {
    startDarwinMedia(handleTrackChange);
  } else if (process.platform === 'win32') {
    startWin32Media(handleTrackChange);
  } else if (process.platform === 'linux') {
    startLinuxMedia(handleTrackChange);
  }
}

export function stopMediaDetection(): void {
  if (!isRunning) return;
  isRunning = false;

  if (process.platform === 'darwin') {
    stopDarwinMedia();
  } else if (process.platform === 'win32') {
    stopWin32Media();
  } else if (process.platform === 'linux') {
    stopLinuxMedia();
  }

  currentActivity = null;
  changeCallback = null;
}

export function getCurrentMediaActivity(): MediaActivity | null {
  return currentActivity;
}
