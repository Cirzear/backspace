import type { ChannelNotificationPolicy, NotificationSetting } from '@backspace/shared';
import { useSpaceStore } from '../stores/spaceStore';
import {
  selectChannelNotificationPolicy,
  selectNotificationSetting,
  useNotificationSettingsStore,
} from '../stores/notificationSettingsStore';

/**
 * Where a space channel lives: its space (`channelToSpaceMap`) and the
 * instance that issued it (`channelOriginMap`, '' for home), both derived
 * from the space-channel index (client-federation.md, "Channel index and
 * lookup maps"). Undefined for a DM or a channel no listing has named yet.
 */
export interface SpaceChannelLocation {
  origin: string;
  spaceId: string;
}

export function getSpaceChannelLocation(channelId: string): SpaceChannelLocation | undefined {
  const state = useSpaceStore.getState();
  const spaceId = state.channelToSpaceMap.get(channelId);
  return spaceId === undefined ? undefined : { origin: state.channelOriginMap.get(channelId) ?? '', spaceId };
}

/**
 * The notification policy of a space channel now, for event-time code (the
 * alert filter). A channel the index does not know resolves to the defaults
 * on the home instance.
 */
export function getChannelNotificationPolicy(channelId: string, now: number = Date.now()): ChannelNotificationPolicy {
  const location = getSpaceChannelLocation(channelId);
  return selectChannelNotificationPolicy(
    useNotificationSettingsStore.getState(),
    location?.origin ?? '',
    location?.spaceId,
    channelId,
    now,
  );
}

/** Reactive location of a space channel; see `getSpaceChannelLocation`. */
export function useSpaceChannelLocation(channelId: string | null | undefined): SpaceChannelLocation | undefined {
  const spaceId = useSpaceStore((s) => (channelId ? s.channelToSpaceMap.get(channelId) : undefined));
  const origin = useSpaceStore((s) => (channelId ? s.channelOriginMap.get(channelId) ?? '' : undefined));
  return origin !== undefined && spaceId !== undefined ? { origin, spaceId } : undefined;
}

/**
 * Reactive policy of a space channel. Re-renders when a setting changes and
 * when a timed mute ends (the store's `clock`).
 */
export function useChannelNotificationPolicy(channelId: string | null | undefined): ChannelNotificationPolicy | undefined {
  const location = useSpaceChannelLocation(channelId);
  const settings = useNotificationSettingsStore((s) => s.settings);
  // Subscribed so that the end of a timed mute re-renders the caller.
  useNotificationSettingsStore((s) => s.clock);
  if (!channelId || !location) return undefined;
  return selectChannelNotificationPolicy({ settings }, location.origin, location.spaceId, channelId, Date.now());
}

/** Reactive stored setting of a space (`channelId` null) or channel, if any. */
export function useStoredNotificationSetting(
  origin: string | undefined,
  spaceId: string | undefined,
  channelId: string | null,
): NotificationSetting | undefined {
  return useNotificationSettingsStore((s) =>
    origin !== undefined && spaceId !== undefined
      ? selectNotificationSetting(s, origin, { spaceId, channelId })
      : undefined,
  );
}
