import { create } from 'zustand';
import {
  resolveChannelNotificationPolicy,
  type ChannelNotificationPolicy,
  type NotificationSetting,
  type UpdateNotificationSettingRequest,
} from '@backspace/shared';
import { getApiForOrigin } from '../utils/crossStoreResolvers';

/**
 * The signed-in user's per-space and per-channel notification settings, from
 * every connected instance.
 *
 * Each instance stores the settings of the spaces it hosts, for the user's
 * row there (docs/systems/sounds.md, "Notification settings"). Entries are
 * therefore keyed by origin as well as by id: ids are issued per instance, so
 * two instances can use the same space or channel id.
 *
 * Sources, merged last-write-wins on the server's `updatedAt`:
 * - `load(origin)`, called when that instance's `ready` arrives;
 * - `notification_settings_updated` from that instance's socket (`apply`);
 * - the response to the user's own change (`update`).
 *
 * The store imports no other store (it reaches the instance through
 * `crossStoreResolvers`), so `utils/alerts.ts` and the components can read it
 * without import cycles.
 */

export interface NotificationTarget {
  spaceId: string;
  /** null for the space-wide setting. */
  channelId: string | null;
}

/** Map key of one setting: the instance, then the space or the channel id. */
export function notificationSettingKey(origin: string, target: NotificationTarget): string {
  return target.channelId === null
    ? `${origin}\u0000space\u0000${target.spaceId}`
    : `${origin}\u0000channel\u0000${target.channelId}`;
}

function originOfKey(key: string): string {
  return key.slice(0, key.indexOf('\u0000'));
}

interface NotificationSettingsState {
  /** Keyed by `notificationSettingKey`. A cleared setting stays as an entry with nothing chosen. */
  settings: ReadonlyMap<string, NotificationSetting>;
  /**
   * Bumped when a timed mute ends, so components that show a mute re-render
   * at that moment. Read alongside `settings`; its value means nothing else.
   */
  clock: number;

  /** Replace this instance's settings with its listing. Errors are logged and leave the store as it was. */
  load: (origin: string) => Promise<void>;
  /** A setting this instance pushed (`notification_settings_updated`). */
  apply: (origin: string, setting: NotificationSetting) => void;
  /** Change one setting on the instance that hosts it. Rejects with the API error. */
  update: (origin: string, target: NotificationTarget, change: UpdateNotificationSettingRequest) => Promise<NotificationSetting>;
  /** The instance is gone (removed or signed out of): drop what it said. */
  forgetOrigin: (origin: string) => void;
  reset: () => void;
}

/**
 * Settings pushed while a `load` for the same origin is in flight. The
 * listing may have been read before or after they were written, so they are
 * merged over it by `updatedAt` instead of being overwritten by it.
 */
const pushedDuringLoad = new Map<string, Map<string, NotificationSetting>>();
/** The latest `load` per origin; a response for an older one is dropped. */
const loadSeq = new Map<string, number>();
/** Bumped by `reset`, so a response for the previous session is dropped. */
let sessionGeneration = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/** setTimeout's ceiling; a later end is re-checked when this one fires. */
const MAX_TIMER_MS = 2_147_483_647;

function newer(current: NotificationSetting | undefined, incoming: NotificationSetting): boolean {
  return !current || incoming.updatedAt >= current.updatedAt;
}

export const useNotificationSettingsStore = create<NotificationSettingsState>((set, get) => {
  /** Arms one timer for the nearest end of a timed mute still in the future. */
  function scheduleExpiry(settings: ReadonlyMap<string, NotificationSetting>): void {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    const now = Date.now();
    let nearest = Infinity;
    for (const setting of settings.values()) {
      if (setting.muted && setting.mutedUntil !== null && setting.mutedUntil > now) {
        nearest = Math.min(nearest, setting.mutedUntil);
      }
    }
    if (nearest === Infinity) return;
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      set({ clock: Date.now() });
      scheduleExpiry(get().settings);
    }, Math.min(nearest - now + 1, MAX_TIMER_MS));
  }

  function commit(settings: Map<string, NotificationSetting>): void {
    set({ settings });
    scheduleExpiry(settings);
  }

  function applyOne(origin: string, setting: NotificationSetting): void {
    const key = notificationSettingKey(origin, setting);
    const pending = pushedDuringLoad.get(origin);
    if (pending && newer(pending.get(key), setting)) pending.set(key, setting);
    const current = get().settings.get(key);
    if (!newer(current, setting)) return;
    const settings = new Map(get().settings);
    settings.set(key, setting);
    commit(settings);
  }

  return {
    settings: new Map(),
    clock: 0,

    load: async (origin) => {
      const seq = (loadSeq.get(origin) ?? 0) + 1;
      loadSeq.set(origin, seq);
      const generation = sessionGeneration;
      pushedDuringLoad.set(origin, new Map());
      try {
        const { settings: listed } = await getApiForOrigin(origin).notificationSettings.list();
        if (generation !== sessionGeneration || loadSeq.get(origin) !== seq) return;
        const merged = new Map<string, NotificationSetting>();
        for (const [key, value] of get().settings) {
          if (originOfKey(key) !== origin) merged.set(key, value);
        }
        for (const setting of listed) merged.set(notificationSettingKey(origin, setting), setting);
        for (const [key, pushed] of pushedDuringLoad.get(origin) ?? []) {
          if (newer(merged.get(key), pushed)) merged.set(key, pushed);
        }
        commit(merged);
      } catch (err) {
        console.warn(`[notificationSettings] could not load the settings of ${origin || 'home'}:`, err);
      } finally {
        if (loadSeq.get(origin) === seq) pushedDuringLoad.delete(origin);
      }
    },

    apply: (origin, setting) => {
      applyOne(origin, setting);
    },

    update: async (origin, target, change) => {
      const client = getApiForOrigin(origin).notificationSettings;
      const generation = sessionGeneration;
      const setting = target.channelId === null
        ? await client.updateSpace(target.spaceId, change)
        : await client.updateChannel(target.channelId, change);
      if (generation === sessionGeneration) applyOne(origin, setting);
      return setting;
    },

    forgetOrigin: (origin) => {
      loadSeq.set(origin, (loadSeq.get(origin) ?? 0) + 1);
      pushedDuringLoad.delete(origin);
      const settings = new Map<string, NotificationSetting>();
      for (const [key, value] of get().settings) {
        if (originOfKey(key) !== origin) settings.set(key, value);
      }
      commit(settings);
    },

    reset: () => {
      sessionGeneration += 1;
      loadSeq.clear();
      pushedDuringLoad.clear();
      if (expiryTimer !== null) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
      }
      set({ settings: new Map(), clock: 0 });
    },
  };
});

/** The stored setting for a space or channel on an instance, if any. */
export function selectNotificationSetting(
  state: Pick<NotificationSettingsState, 'settings'>,
  origin: string,
  target: NotificationTarget,
): NotificationSetting | undefined {
  return state.settings.get(notificationSettingKey(origin, target));
}

/**
 * What applies to a space channel at `now`: the inheritance and mute rules of
 * `resolveChannelNotificationPolicy`, over this store's entries. A space id
 * that is not known yet resolves to the defaults.
 */
export function selectChannelNotificationPolicy(
  state: Pick<NotificationSettingsState, 'settings'>,
  origin: string,
  spaceId: string | undefined,
  channelId: string,
  now: number,
): ChannelNotificationPolicy {
  const spaceSetting = spaceId ? selectNotificationSetting(state, origin, { spaceId, channelId: null }) : undefined;
  const channelSetting = selectNotificationSetting(state, origin, { spaceId: spaceId ?? '', channelId });
  return resolveChannelNotificationPolicy(spaceSetting, channelSetting, now);
}
