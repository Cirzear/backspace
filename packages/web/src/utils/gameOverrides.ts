import type { Activity } from '@backspace/shared';
import { ACTIVITY_LIMITS } from '@backspace/shared/src/activities';

/**
 * What the player decided about the game they are shown as playing.
 *
 * - `manual`: a game the player named themselves. It replaces every detected
 *   "playing" activity and stays until the player clears it (no timer): the
 *   whole point is a game rich presence missed, so nothing ends it for us.
 * - `renames`: for a game the detector DID find, the name the player wants
 *   shown instead (detected name, lowercased → chosen name). It is remembered,
 *   so the game is shown under that name every time it is detected.
 *
 * Both live in this browser's storage only: they are a presentation choice of
 * this client, and the server and federation see an ordinary activity.
 */
export interface GameOverrides {
  manual: string | null;
  renames: Record<string, string>;
}

export const GAME_OVERRIDES_KEY = 'backspace_game_overrides';

/** More renames than any library holds; the oldest is dropped past this. */
export const MAX_GAME_RENAMES = 200;

/** Collapse whitespace, drop control characters, cap at the activity name limit. Null when nothing is left. */
export function sanitizeGameName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  return cleaned.slice(0, ACTIVITY_LIMITS.MAX_NAME_LENGTH).trim();
}

/** The key a detected name is remembered under. */
export function renameKey(detectedName: string): string {
  return detectedName.trim().toLowerCase();
}

export function loadOverrides(): GameOverrides {
  try {
    const raw = localStorage.getItem(GAME_OVERRIDES_KEY);
    if (!raw) return { manual: null, renames: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { manual: null, renames: {} };
    const { manual, renames } = parsed as Record<string, unknown>;

    const result: GameOverrides = { manual: null, renames: {} };
    if (typeof manual === 'string') result.manual = sanitizeGameName(manual);
    if (renames && typeof renames === 'object') {
      for (const [key, value] of Object.entries(renames as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        const name = sanitizeGameName(value);
        if (name && key !== '') result.renames[key] = name;
      }
    }
    return result;
  } catch {
    return { manual: null, renames: {} };
  }
}

export function saveOverrides(overrides: GameOverrides): void {
  try {
    if (overrides.manual === null && Object.keys(overrides.renames).length === 0) {
      localStorage.removeItem(GAME_OVERRIDES_KEY);
      return;
    }
    localStorage.setItem(GAME_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    // Storage unavailable: the choice lasts for this session only
  }
}

export function clearOverrides(): void {
  try {
    localStorage.removeItem(GAME_OVERRIDES_KEY);
  } catch {
    // Nothing stored to clear
  }
}

/**
 * Put the player's own game in place of whatever was detected as "playing".
 * Other activity types (music, video) are untouched. The input is returned
 * as is when there is no manual game.
 */
export function withManualGame(detected: Activity[], manual: string | null): Activity[] {
  if (manual === null) return detected;
  const others = detected.filter((activity) => activity.type !== 'playing');
  const game: Activity = { type: 'playing', name: manual };
  return [game, ...others].slice(0, ACTIVITY_LIMITS.MAX_ACTIVITIES_PER_USER);
}

/**
 * Show a detected game under the name the player chose for it. Everything
 * else about the activity (details, timestamps, art) is kept. Applied last, so
 * the icon lookup above it still goes by the name the machine knows the game by.
 */
export function withRenames(activities: Activity[], renames: Record<string, string>): Activity[] {
  if (Object.keys(renames).length === 0) return activities;
  let changed = false;
  const result = activities.map((activity) => {
    if (activity.type !== 'playing') return activity;
    const chosen = renames[renameKey(activity.name)];
    if (!chosen || chosen === activity.name) return activity;
    changed = true;
    return { ...activity, name: chosen };
  });
  return changed ? result : activities;
}

/** Add or replace a rename, dropping the oldest past the cap. An empty or unchanged name removes it. */
export function setRename(
  renames: Record<string, string>,
  detectedName: string,
  chosen: string | null,
): Record<string, string> {
  const key = renameKey(detectedName);
  const name = chosen === null ? null : sanitizeGameName(chosen);
  const next = { ...renames };
  delete next[key];
  if (key === '' || name === null || name === detectedName.trim()) return next;
  next[key] = name; // re-inserted last, so insertion order is age order
  const keys = Object.keys(next);
  for (const oldest of keys.slice(0, Math.max(0, keys.length - MAX_GAME_RENAMES))) {
    delete next[oldest];
  }
  return next;
}
