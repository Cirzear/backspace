import { useTranslation } from 'react-i18next';
import { isMuteActive } from '@backspace/shared';
import { useUnreadCountStore } from '../../stores/unreadCountStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useStoredNotificationSetting } from '../../hooks/useNotificationSettings';
import { useNotificationSettingsStore } from '../../stores/notificationSettingsStore';
import { UnreadCountBadge } from './UnreadCountBadge';

/**
 * The sum of a space's unread messages, from the counts its own instance sent.
 * Only channels the client also holds as unread are summed, so the badge and
 * the unread dot agree; a host without counts shows no badge.
 */
export function SpaceUnreadBadge({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation('spaces');
  const origin = useSpaceStore(s => s.spaces.find(space => space.id === spaceId)?._instanceOrigin ?? '');
  const channelSpaces = useSpaceStore(s => s.channelToSpaceMap);
  const unread = useChatStore(s => s.unreadChannels);
  const counts = useUnreadCountStore(s => s.counts[origin]);
  const setting = useStoredNotificationSetting(origin, spaceId, null);
  // Subscribed so that the end of a timed mute re-renders the badge.
  useNotificationSettingsStore(s => s.clock);
  const muted = isMuteActive(setting, Date.now());
  let total = 0;
  for (const [channelId, count] of Object.entries(counts ?? {})) {
    if (channelSpaces.get(channelId) === spaceId && unread.has(channelId)) total += count;
  }
  if (total === 0) return null;
  const label = total > 99 ? t('sidebar.space.unreadMessagesOver99') : t('sidebar.space.unreadMessages', { count: total });
  return <UnreadCountBadge count={total} muted={muted} label={label} />;
}
