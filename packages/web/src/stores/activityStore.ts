import { create } from 'zustand';
import type { Activity } from '@backspace/shared';
import { wsSendAll } from '../hooks/useWebSocket';
import { api } from '../api/client';
import { userKey, type PresenceSubject } from '../utils/identity';
import {
  clearOverrides,
  loadOverrides,
  sanitizeGameName,
  saveOverrides,
  setRename,
  withManualGame,
  withRenames,
} from '../utils/gameOverrides';

let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** Monotonic push generation: a debounce that fired but is still enriching must not send after a newer push arrived. */
let pushSeq = 0;

// ─── Game icon enrichment ─────────────────────────────────────────────────

/**
 * The desktop client extracts game icons from the player's own machine and
 * hands them to the renderer, which uploads them to the user's own instance
 * and caches the instance URL by game name. The next activity for the same
 * game carries the URL without another upload.
 */
const GAME_ICON_CACHE_KEY = 'backspace_game_icons';
const GAME_ICON_TYPES = new Set(['playing', 'listening', 'watching', 'streaming']);
const GAME_ICON_ENRICH_TIMEOUT_MS = 4000;
/** A name that failed to resolve is not retried for this long (the desktop warms its cache in the background). */
const GAME_ICON_RETRY_MS = 60_000;
const iconMissAges = new Map<string, number>();

function cachedIconUrl(name: string): string | null {
  try {
    const raw = localStorage.getItem(GAME_ICON_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, unknown>;
    const url = map[name];
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

function rememberIconUrl(name: string, url: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(GAME_ICON_CACHE_KEY) ?? '{}') as Record<string, string>;
    map[name] = url;
    localStorage.setItem(GAME_ICON_CACHE_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable: the icon re-uploads next session
  }
}

/** Fetch the locally extracted icon, upload it to the instance, return the URL. Null on any failure. */
async function resolveGameIconUrl(name: string): Promise<string | null> {
  const getGameIcon = window.backspace?.getGameIcon;
  if (!getGameIcon) return null;
  try {
    const icon = await getGameIcon(name);
    if (!icon?.data) return null;
    const { url } = await api.gameIcons.upload({ image: icon.data });
    rememberIconUrl(name, url);
    return url;
  } catch {
    return null;
  }
}

function withTimeout(promise: Promise<string | null>, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((url) => {
      clearTimeout(timer);
      resolve(url);
    }, () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** Attach cached instance URLs to icon-able activities that lack art. Returns the input when nothing changed. */
function attachCachedIcons(activities: Activity[]): Activity[] {
  let changed = false;
  const result = activities.map((activity) => {
    if (!GAME_ICON_TYPES.has(activity.type) || activity.assets?.largeImage) return activity;
    const cached = cachedIconUrl(activity.name);
    if (!cached) return activity;
    changed = true;
    return { ...activity, assets: { ...activity.assets, largeImage: cached } };
  });
  return changed ? result : activities;
}

/** Names that would benefit from an icon upload: game activity, no art, no cached URL, no fresh miss, and a desktop bridge to ask. */
function pendingIconNames(activities: Activity[]): string[] {
  if (!window.backspace?.getGameIcon) return [];
  const names: string[] = [];
  for (const activity of activities) {
    if (!GAME_ICON_TYPES.has(activity.type) || activity.assets?.largeImage) continue;
    if (cachedIconUrl(activity.name)) continue;
    const missedAt = iconMissAges.get(activity.name);
    if (missedAt !== undefined && Date.now() - missedAt <= GAME_ICON_RETRY_MS) continue;
    names.push(activity.name);
  }
  return names;
}

/** Upload the icons for `names` and attach the instance URLs they resolve to. */
async function uploadAndAttachIcons(activities: Activity[], names: string[]): Promise<Activity[]> {
  const urls = new Map<string, string>();
  await Promise.all(names.map(async (name) => {
    const url = await withTimeout(resolveGameIconUrl(name), GAME_ICON_ENRICH_TIMEOUT_MS);
    if (url) {
      urls.set(name, url);
    } else {
      iconMissAges.set(name, Date.now());
    }
  }));
  if (urls.size === 0) return activities;
  return activities.map((activity) => {
    const url = urls.get(activity.name);
    return url && !activity.assets?.largeImage
      ? { ...activity, assets: { ...activity.assets, largeImage: url } }
      : activity;
  });
}

/** An activity list delivered for one user by one origin. */
export interface ActivityEntry {
  subject: PresenceSubject;
  activities: Activity[];
}

/**
 * The activities held for `subject` as delivered or listed by `origin`.
 * Every reader goes through this, so all views of one person agree.
 */
export function activitiesFor(
  userActivities: Map<string, Activity[]>,
  subject: PresenceSubject,
  origin: string,
): Activity[] {
  return userActivities.get(userKey(subject, origin)) ?? [];
}

interface ActivityState {
  /** Keyed by `userKey` (the person's home identity), never by a raw row id. */
  userActivities: Map<string, Activity[]>;
  /**
   * `userKey` → the origin whose delivery set that entry last. A `ready`
   * is an origin's full snapshot, so it replaces exactly the entries that
   * origin set (`initActivities`); an entry another origin set last is that
   * origin's to change.
   */
  activityWriters: Map<string, string>;
  /**
   * origin → (row id → subject), from the members an older server's `ready`
   * listed. Such a server sends `presence_update` with its row id only; this
   * is how `presenceSubjectOf` names a row of a space that is not open
   * (`utils/presenceSubject.ts`). No entry for a server that sends the
   * identity fields itself.
   */
  originRows: Map<string, Map<string, PresenceSubject>>;
  showActivity: boolean;
  myActivities: Activity[] | null;
  /** What the machine detected, before the player's own choices (`utils/gameOverrides.ts`). */
  detectedActivities: Activity[];
  /** A game the player named themselves; replaces detected "playing" activities until cleared. */
  manualGame: string | null;
  /** Detected name (lowercased) → the name the player wants shown for it. */
  gameRenames: Record<string, string>;

  setUserActivities: (subject: PresenceSubject, origin: string, activities: Activity[]) => void;
  clearUserActivities: (subject: PresenceSubject, origin: string) => void;
  /**
   * Replace what `origin` set with its `ready` snapshot `entries`.
   * `coveredRows` is null for a current server, whose snapshot covers everyone
   * it reports on: every entry it set is replaced. An older server's snapshot
   * covered only the space and DM members its `ready` lists (`readyRowIndex`),
   * so only the entries of those rows are replaced; a friend it reports on
   * only live keeps what it last reported.
   */
  initActivities: (entries: ActivityEntry[], origin: string, coveredRows?: ReadonlyMap<string, PresenceSubject> | null) => void;
  /** Record (or, with null, drop) the rows an older server's `ready` listed. */
  setOriginRows: (origin: string, rows: Map<string, PresenceSubject> | null) => void;
  setShowActivity: (show: boolean) => void;
  pushActivities: (activities: Activity[]) => void;
  /** Name the game being played (null clears it). Blank names clear it too. */
  setManualGame: (name: string | null) => void;
  /** Show a detected game under another name from now on (null restores its own name). */
  setGameRename: (detectedName: string, chosen: string | null) => void;
  /** Push again what is currently effective, when there is something to show. */
  republish: () => void;
  reset: () => void;
}

const initialOverrides = loadOverrides();

export const useActivityStore = create<ActivityState>((set, get) => ({
  userActivities: new Map(),
  activityWriters: new Map(),
  originRows: new Map(),
  showActivity: true,
  myActivities: null,
  detectedActivities: [],
  manualGame: initialOverrides.manual,
  gameRenames: initialOverrides.renames,

  setUserActivities: (subject, origin, activities) => {
    const key = userKey(subject, origin);
    set((state) => {
      const next = new Map(state.userActivities);
      const writers = new Map(state.activityWriters);
      if (activities.length === 0) {
        next.delete(key);
        writers.delete(key);
      } else {
        next.set(key, activities);
        writers.set(key, origin);
      }
      return { userActivities: next, activityWriters: writers };
    });
  },

  clearUserActivities: (subject, origin) => {
    const key = userKey(subject, origin);
    set((state) => {
      const next = new Map(state.userActivities);
      const writers = new Map(state.activityWriters);
      next.delete(key);
      writers.delete(key);
      return { userActivities: next, activityWriters: writers };
    });
  },

  initActivities: (entries, origin, coveredRows) => {
    set((state) => {
      const next = new Map(state.userActivities);
      const writers = new Map(state.activityWriters);
      const covered = coveredRows
        ? new Set([...coveredRows.values()].map((subject) => userKey(subject, origin)))
        : null;
      // What this origin reported before and its snapshot no longer lists has
      // ended while the client was not hearing from it.
      for (const [key, writer] of state.activityWriters) {
        if (writer !== origin) continue;
        if (covered && !covered.has(key)) continue;
        next.delete(key);
        writers.delete(key);
      }
      for (const { subject, activities } of entries) {
        const key = userKey(subject, origin);
        if (activities.length > 0) {
          next.set(key, activities);
          writers.set(key, origin);
        } else {
          next.delete(key);
          writers.delete(key);
        }
      }
      return { userActivities: next, activityWriters: writers };
    });
  },

  setOriginRows: (origin, rows) => {
    set((state) => {
      if (!rows && !state.originRows.has(origin)) return state;
      const originRows = new Map(state.originRows);
      if (rows) originRows.set(origin, rows);
      else originRows.delete(origin);
      return { originRows };
    });
  },

  setShowActivity: (show) => {
    set({ showActivity: show });
    if (!show) {
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      // A push still uploading its icon must not send after sharing was switched off
      pushSeq++;
      wsSendAll({ type: 'activity_update', activities: [] });
      set({ myActivities: null });
    } else {
      get().republish();
    }
  },

  pushActivities: (activities) => {
    set({ detectedActivities: activities });
    if (!get().showActivity) return;
    const effective = (list: Activity[]) => withRenames(
      withManualGame(list, get().manualGame),
      get().gameRenames,
    );
    set({ myActivities: effective(activities) });
    if (pushTimer) clearTimeout(pushTimer);
    const seq = ++pushSeq;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      // Icons are looked up by the name the machine knows the game by, so the
      // player's rename is applied after they are attached, not before.
      const base = withManualGame(activities, get().manualGame);
      // Cached icons attach synchronously, so a push that needs no upload
      // sends exactly as it did before icons existed.
      const withCached = attachCachedIcons(base);
      const pending = pendingIconNames(withCached);
      if (pending.length === 0) {
        const final = withRenames(withCached, get().gameRenames);
        set({ myActivities: final });
        wsSendAll({ type: 'activity_update', activities: final });
        return;
      }
      void uploadAndAttachIcons(withCached, pending).then((enriched) => {
        // A newer push arrived while this one was uploading: it supersedes
        // this send, and its own timer will deliver the fresher list.
        if (seq !== pushSeq) return;
        const final = withRenames(enriched, get().gameRenames);
        set({ myActivities: final });
        wsSendAll({ type: 'activity_update', activities: final });
      });
    }, 5000);
  },

  setManualGame: (name) => {
    const manualGame = name === null ? null : sanitizeGameName(name);
    set({ manualGame });
    saveOverrides({ manual: manualGame, renames: get().gameRenames });
    get().republish();
  },

  setGameRename: (detectedName, chosen) => {
    const gameRenames = setRename(get().gameRenames, detectedName, chosen);
    set({ gameRenames });
    saveOverrides({ manual: get().manualGame, renames: gameRenames });
    get().republish();
  },

  republish: () => {
    const { detectedActivities, manualGame, myActivities, showActivity } = get();
    if (!showActivity) return;
    // Nothing to show and nothing shown before: do not send an empty update.
    // With something shown before (a cleared manual game), the empty list is
    // exactly what must reach the others.
    if (detectedActivities.length === 0 && manualGame === null && (myActivities?.length ?? 0) === 0) return;
    get().pushActivities(detectedActivities);
  },

  reset: () => {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    pushSeq++;
    iconMissAges.clear();
    set({
      userActivities: new Map(),
      activityWriters: new Map(),
      originRows: new Map(),
      showActivity: true,
      myActivities: null,
      detectedActivities: [],
      manualGame: null,
      gameRenames: {},
    });
    // The choices belong to the signed-in player; the next account starts clean
    clearOverrides();
  },
}));
