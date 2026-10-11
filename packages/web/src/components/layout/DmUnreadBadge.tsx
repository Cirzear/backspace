import { useTranslation } from 'react-i18next';
import { useUnreadCountStore } from '../../stores/unreadCountStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { UnreadCountBadge } from './UnreadCountBadge';

/**
 * The sum of unread direct messages. `dmChannels` holds one pinned copy per
 * conversation, and each copy is counted by the instance it came from
 * (`channelOriginMap`), so a conversation mirrored on several instances is
 * counted once (client-federation.md, "DM Origin Failover").
 */
export function DmUnreadBadge() {
  const { t } = useTranslation('spaces');
  const dms = useSpaceStore(s => s.dmChannels);
  const origins = useSpaceStore(s => s.channelOriginMap);
  const unread = useChatStore(s => s.unreadChannels);
  const counts = useUnreadCountStore(s => s.counts);
  let total = 0;
  for (const dm of dms) {
    if (unread.has(dm.id)) total += counts[origins.get(dm.id) ?? '']?.[dm.id] ?? 0;
  }
  if (total === 0) return null;
  const label = total > 99 ? t('sidebar.dmUnreadMessagesOver99') : t('sidebar.dmUnreadMessages', { count: total });
  return <UnreadCountBadge count={total} label={label} />;
}
