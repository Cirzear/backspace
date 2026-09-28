import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ toast: vi.fn(), current: 'chat', status: 'online' }));
vi.mock('../../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast: state.toast }) } }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => ({}) }, selectMyChosenStatus: () => state.status }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => ({ currentChannelId: state.current }) } }));
vi.mock('../../stores/spaceStore', () => ({ useSpaceStore: { getState: () => ({ channelToSpaceMap: new Map([['chat', 'space']]) }) }, getChannelOrigin: () => '' }));
vi.mock('../../utils/identity', () => ({ isRegisteredSelfId: (id: string) => id === 'me' }));
vi.mock('../../i18n', () => ({ default: { t: () => 'Actor poked Target' } }));
import { useNotificationStore } from '../../stores/notificationStore';
import { receiveChannelPoke } from './channelPoke';
const event = { type: 'channel_poke', channelId: 'chat', userId: 'actor', targetUserId: 'target', username: 'Actor', targetUsername: 'Target' } as const;
beforeEach(() => { vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true }))); state.toast.mockClear(); state.current = 'chat'; state.status = 'online'; useNotificationStore.getState().reset(); });
describe('server-confirmed poke cue', () => {
  it('shows a lightweight cue for the current channel', () => {
    receiveChannelPoke('', event);
    expect(state.toast).toHaveBeenCalledWith('Actor poked Target', 'info', 3500);
  });
  it('does not interrupt unrelated channels or another origin', () => {
    receiveChannelPoke('https://other.example', event);
    state.current = 'other';
    receiveChannelPoke('', event);
    expect(state.toast).not.toHaveBeenCalled();
  });
  it('respects Do Not Disturb', () => {
    state.status = 'dnd';
    receiveChannelPoke('', event);
    expect(state.toast).not.toHaveBeenCalled();
  });
});
