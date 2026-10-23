import type { MediaActivity, MediaTrackInfo } from './types';
import { startDarwinMedia, stopDarwinMedia } from './darwinMedia';
import { startWin32Media, stopWin32Media } from './win32Media';
import { startLinuxMedia, stopLinuxMedia } from './linuxMpris';

export type { MediaActivity, MediaTrackInfo };

let currentActivity: MediaActivity | null = null;
let changeCallback: ((activity: MediaActivity | null) => void) | null = null;
let isRunning = false;

// Continuous listening session tracking:
// While the user continues listening to music, switching tracks must preserve the session's
// start time rather than resetting elapsed duration back to 0:00 on every single track.
let sessionStartTime: number | null = null;
let lastActiveTrackTime = 0;
const SESSION_GRACE_MS = 60_000; // 60s grace period for track switching or brief pause

export function getSessionStartTime(): number | null {
  return sessionStartTime;
}

export function resetMediaSession(): void {
  sessionStartTime = null;
  lastActiveTrackTime = 0;
}

export function convertTrackToActivity(
  track: MediaTrackInfo | null,
  sessionStart?: number | null,
): MediaActivity | null {
  if (!track || !track.title) return null;

  const now = Date.now();
  let start = sessionStart ?? now;
  let end: number | undefined;

  // If a continuous sessionStart is provided (runtime live detection), we omit `end`
  // so the activity card displays cumulative elapsed time ("已用 XX:XX") across tracks.
  // If sessionStart is not provided, we support track duration & progress countdown.
  if (typeof sessionStart === 'number') {
    start = sessionStart;
  } else if (typeof track.durationMs === 'number' && track.durationMs > 0) {
    if (typeof track.positionMs === 'number' && track.positionMs >= 0) {
      start = now - track.positionMs;
    }
    end = start + track.durationMs;
  } else if (typeof track.positionMs === 'number' && track.positionMs >= 0) {
    start = now - track.positionMs;
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
  const now = Date.now();

  if (track && track.title) {
    if (sessionStartTime === null || (lastActiveTrackTime > 0 && now - lastActiveTrackTime > SESSION_GRACE_MS)) {
      sessionStartTime = typeof track.positionMs === 'number' && track.positionMs >= 0
        ? now - track.positionMs
        : now;
    }
    lastActiveTrackTime = now;

    const activity = convertTrackToActivity(track, sessionStartTime);
    currentActivity = activity;
    changeCallback?.(currentActivity);
  } else {
    currentActivity = null;
    changeCallback?.(null);
  }
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
  resetMediaSession();
  changeCallback = null;
}

export function getCurrentMediaActivity(): MediaActivity | null {
  return currentActivity;
}
