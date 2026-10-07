import { useChatStore } from '../stores/chatStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { resolveAssetUrl } from '../utils/assetUrls';
import { channelIdsWhere } from '../stores/spaceChannels';
import type { WebSocketEventHandlers } from './webSocketEvents';

export const spaceEvents = {
  channel_created: (origin, event) => {
    useSpaceStore.getState().upsertChannel(event.channel, event.spaceId, origin);
  },
  channel_updated: (origin, event) => {
    // Also how a channel comes back into view after an override change,
    // in whichever space: the index entry is written wherever the space is.
    useSpaceStore.getState().upsertChannel(event.channel, event.spaceId, origin);
  },
  channel_deleted: (origin, event) => {
    // Deleted, or hidden from this user by an override change.
    useSpaceStore.getState().removeChannel(event.channelId);
    if (useChatStore.getState().currentChannelId === event.channelId) {
      useChatStore.getState().setCurrentChannel(null);
    }
    // Clean up voice users for the deleted channel
    {
      const vs = useVoiceStore.getState();
      if (vs.voiceUsers.has(event.channelId) || vs.voiceChannelElapsedSeconds.has(event.channelId)) {
        const newVoiceUsers = new Map(vs.voiceUsers);
        const voiceChannelElapsedSeconds = new Map(vs.voiceChannelElapsedSeconds);
        newVoiceUsers.delete(event.channelId);
        voiceChannelElapsedSeconds.delete(event.channelId);
        useVoiceStore.setState({ voiceUsers: newVoiceUsers, voiceChannelElapsedSeconds });
      }
    }
  },
  space_updated: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && event.space.icon) {
      event.space.icon = resolveAssetUrl(event.space.icon, origin) ?? event.space.icon;
    }
    if (!isHome && event.space.banner) {
      event.space.banner = resolveAssetUrl(event.space.banner, origin) ?? event.space.banner;
    }
    const { spaces: currentSpaces, setSpaces } = useSpaceStore.getState();
    setSpaces(currentSpaces.map(s => s.id === event.space.id ? { ...s, ...event.space } : s));
  },
  category_created: (origin, event) => {
    useSpaceStore.getState().upsertCategory(event.category, origin);
  },
  category_updated: (origin, event) => {
    useSpaceStore.getState().upsertCategory(event.category, origin);
  },
  category_deleted: (origin, event) => {
    useSpaceStore.getState().removeCategory(event.categoryId, event.spaceId, origin);
  },
  channel_layout_updated: (origin, event) => {
    useSpaceStore.getState().applyChannelLayout(event.spaceId, origin, event.channels, event.categories);
  },
  space_layout_updated: (origin, event) => {
    // LWW: only accept if incoming timestamp >= current
    const incomingTs = event.updatedAt ?? 0;
    const currentTs = useSpaceStore.getState()._layoutUpdatedAt;
    if (incomingTs >= currentTs) {
      useSpaceStore.getState().setSpaceLayout(event.layout);
      useSpaceStore.setState({ folders: event.folders, _layoutUpdatedAt: incomingTs });
    }
  },
  join_request_received: (origin, event) => {
    const isHome = origin === '';
    if (!isHome) return;
    console.log('[WebSocket] Join request received from', event.request.user?.username ?? event.request.userId);
  },
  join_request_accepted: (origin, event) => {
    const isHome = origin === '';
    if (!isHome) return;
    // Add the space to our space list
    const { addSpaceFromReady } = useSpaceStore.getState();
    addSpaceFromReady(origin, event.space);
    console.log('[WebSocket] Join request accepted for space', event.space.name);
  },
  join_request_declined: (origin, event) => {
    const isHome = origin === '';
    if (!isHome) return;
    console.log('[WebSocket] Join request declined for space', event.request.spaceId);
  },
  space_access_changed: (origin, event) => {
    void refreshSpaceAccess(origin, event.spaceId);
  },
} satisfies WebSocketEventHandlers;

async function refreshSpaceAccess(origin: string, spaceId: string): Promise<void> {
  const { spaces, loadSpaceDetail } = useSpaceStore.getState();
  if (!spaces.some(s => s.id === spaceId && (s._instanceOrigin ?? '') === origin)) return;
  const { channelToSpaceMap, channelOriginMap } = useSpaceStore.getState();
  const known = [...channelToSpaceMap]
    .filter(([channelId, sId]) => sId === spaceId && (channelOriginMap.get(channelId) ?? '') === origin)
    .map(([channelId]) => channelId);
  const visible = await loadSpaceDetail(spaceId, { quiet: true });
  if (!visible) return;
  const { upsertChannel } = useSpaceStore.getState();
  for (const channel of visible) upsertChannel(channel, spaceId, origin);
  const visibleIds = new Set(visible.map(c => c.id));
  for (const channelId of known) {
    if (!visibleIds.has(channelId)) spaceEvents.channel_deleted(origin, { type: 'channel_deleted', channelId, spaceId });
  }
}

