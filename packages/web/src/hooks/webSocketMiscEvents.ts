import { receiveChannelPoke } from '../components/chat/channelPoke';
import { describeErrorCode } from '../i18n/errors';
import { useChannelActivityStore } from '../stores/channelActivityStore';
import { useChatStore } from '../stores/chatStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import type { WebSocketEventHandlers } from './webSocketEvents';

export const miscEvents = {
  notification_setting_updated: (origin, event) => {
    useNotificationStore.getState().apply(origin, event.setting);
  },
  channel_unread_count: (origin, event) => {
    useChannelActivityStore.getState().updateCounts(origin, event.counts);
  },
  channel_poke_failed: (origin, event) => {
    useUIStore.getState().addToast(event.message, 'warning');
  },
  channel_poke: (origin, event) => {
    receiveChannelPoke(origin, event);
  },
  mark_unread: (origin, event) => {
    const { onMarkUnread } = useChatStore.getState();
    onMarkUnread(event.channelId, event.messageId);
  },
  pong: (origin, event) => {

  },
  error: (origin, event) => {
    console.error(`WebSocket error (${origin || 'home'}):`, event.message);
    if (event.code) {
      useUIStore.getState().addToast(describeErrorCode(event.code, event.message), 'warning');
    }
  },
} satisfies WebSocketEventHandlers;
