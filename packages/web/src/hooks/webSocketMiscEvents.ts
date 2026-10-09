import { dmCallOrigin, dmCallRoomKey } from '../utils/dmCall';
import { receiveChannelPoke } from '../components/chat/channelPoke';
import { describeErrorCode } from '../i18n/errors';
import { useChannelActivityStore } from '../stores/channelActivityStore';
import { useChatStore } from '../stores/chatStore';
import { useNotificationSettingsStore } from '../stores/notificationSettingsStore';
import { useNotificationStore } from '../stores/notificationStore';
import { getChannelOrigin } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { teardownDmCall } from './webSocketCallEvents';
import type { WebSocketEventHandlers } from './webSocketEvents';

export const miscEvents = {
  notification_setting_updated: (origin, event) => {
    useNotificationSettingsStore.getState().apply(origin, event.setting);
    useNotificationStore.getState().apply(origin, event.setting);
  },
  notification_settings_updated: (origin, event) => {
    useNotificationSettingsStore.getState().apply(origin, event.setting);
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
  pong: () => {
    // Heartbeat replies need no application-state update.
  },
  error: (origin, event) => {
    console.error(`WebSocket error (${origin || 'home'}):`, event.message);
    if (event.dmChannelId) {
      const { outgoingCall, setOutgoingCall, activeDmCall } = useVoiceStore.getState();
      if (outgoingCall?.dmChannelId === event.dmChannelId
          && getChannelOrigin(event.dmChannelId) === origin) {
        setOutgoingCall(null);
      }
      if ((event.code === 'dm_call_not_found' || event.code === 'not_dm_member')
          && activeDmCall && dmCallRoomKey(activeDmCall) === event.dmChannelId
          && dmCallOrigin(activeDmCall) === origin) {
        teardownDmCall();
      }
    }
    // Preserve server details so localized refusal messages fill their placeholders.
    if (event.code) {
      useUIStore.getState().addToast(describeErrorCode(event.code, event.message, event.details), 'warning');
    }
  },
} satisfies WebSocketEventHandlers;
