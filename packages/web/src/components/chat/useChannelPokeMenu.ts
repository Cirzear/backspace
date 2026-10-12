import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useChannelPokeStore } from '../../stores/channelPokeStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { useUIStore } from '../../stores/uiStore';
import { wsSend } from '../../hooks/useWebSocket';

interface Options {
  channelId: string;
  /** The author's id on `origin`, the instance hosting the space. */
  targetUserId: string;
  origin: string;
  /** A sent message in a space channel where the viewer may send messages. */
  enabled: boolean;
}

/**
 * The right-click handler of a message author's avatar and name: a menu with
 * Poke, kept apart from the message menu. Where no poke can be sent (a DM, a
 * message still sending, no SEND_MESSAGES, a host whose ready did not offer
 * pokes) it does nothing, so the right click reaches the message row and
 * opens the message menu as it does without this feature.
 */
export function useChannelPokeMenu({ channelId, targetUserId, origin, enabled }: Options) {
  const { t } = useTranslation('chat');
  const supported = useChannelPokeStore(s => s.hosts[origin] === true);
  return (event: MouseEvent) => {
    if (!enabled || !supported) return;
    event.preventDefault();
    event.stopPropagation();
    useContextMenuStore.getState().open({ x: event.clientX, y: event.clientY }, [{
      type: 'action', key: 'poke-author', label: t('poke.action'),
      onClick: () => {
        if (!wsSend({ type: 'channel_poke', channelId, targetUserId }, origin)) {
          useUIStore.getState().addToast(t('poke.disconnected'), 'warning');
        }
      },
    }]);
  };
}
