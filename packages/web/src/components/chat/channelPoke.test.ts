import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ current: 'chat', status: 'online', muted: false, level: 'mentions' }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => ({}) }, selectMyChosenStatus: () => state.status, getMyUserIdForOrigin: () => 'me' }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => ({ currentChannelId: state.current }) } }));
vi.mock('../../stores/spaceStore', () => ({ getChannelOrigin: () => '' }));
vi.mock('../../hooks/useNotificationSettings', () => ({ getChannelNotificationPolicy: () => state }));
import type { MessageWithUser } from '@backspace/shared';
import { receiveChannelPoke } from './channelPoke';
const event = {
  id: '1', channelId: 'chat', userId: 'actor', type: 'system', replyToId: null, editedAt: null, createdAt: 1,
  content: JSON.stringify({ event: 'channel_poke', targetUserId: 'target', targetDisplayName: 'Target' }),
  attachments: [], embeds: [], reactions: [],
} as unknown as MessageWithUser;
const animate = vi.fn(() => ({ onfinish: null }));
const originalAnimate = Element.prototype.animate;
beforeEach(() => {
  Object.assign(state, { current: 'chat', status: 'online', muted: false, level: 'mentions' });
  animate.mockClear();
  Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  document.body.innerHTML = '<div data-poke-user="target"></div>';
});
afterEach(() => { document.body.replaceChildren(); Element.prototype.animate = originalAnimate; vi.unstubAllGlobals(); });
describe('server-confirmed poke cue', () => {
  it('animates the target and removes the finger when finished', () => {
    receiveChannelPoke('', event);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(document.body).toHaveTextContent('👈');
    const fingerAnimation = animate.mock.results[1]!.value as { onfinish: () => void };
    fingerAnimation.onfinish();
    expect(document.body).not.toHaveTextContent('👈');
  });
  it('ignores a system row that is not a poke', () => {
    receiveChannelPoke('', { ...event, content: JSON.stringify({ event: 'something_else', targetUserId: 'target' }) });
    expect(animate).not.toHaveBeenCalled();
  });
  it('does not animate reduced-motion, unrelated channels or origins', () => {
    receiveChannelPoke('https://other.example', event);
    state.current = 'other'; receiveChannelPoke('', event);
    state.current = 'chat'; vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    receiveChannelPoke('', event);
    expect(animate).not.toHaveBeenCalled();
  });
  it('respects DND, mute and suppression for recipients', () => {
    state.status = 'dnd'; receiveChannelPoke('', event);
    state.status = 'online'; state.muted = true; receiveChannelPoke('', event);
    state.muted = false; state.level = 'nothing'; receiveChannelPoke('', event);
    expect(animate).not.toHaveBeenCalled();
  });
});
