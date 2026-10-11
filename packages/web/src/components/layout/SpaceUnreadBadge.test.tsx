import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Space } from '@backspace/shared';
import { useUnreadCountStore } from '../../stores/unreadCountStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useNotificationSettingsStore } from '../../stores/notificationSettingsStore';
import { SpaceUnreadBadge } from './SpaceUnreadBadge';

vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));

beforeEach(() => {
  useUnreadCountStore.getState().reset();
  useNotificationSettingsStore.getState().reset();
  useSpaceStore.setState({ spaces: [{ id: 'space' } as Space], channelToSpaceMap: new Map([['a', 'space'], ['b', 'space'], ['c', 'other']]) });
  useChatStore.setState({ unreadChannels: new Set(['a', 'b', 'c']) });
});

describe('space unread message badge', () => {
  it('sums message counts of the space\'s channels and caps the number at 99+', () => {
    useUnreadCountStore.getState().hydrate('', { a: 80, b: 25, c: 999 });
    render(<SpaceUnreadBadge spaceId="space" />);
    expect(screen.getByText('99+')).toHaveClass('bg-notification');
    // Counts stop at 100 per channel, so above 99 the label says no more than the badge.
    expect(screen.getByText('More than 99 unread messages')).toBeInTheDocument();
  });

  it('reads counts from the space\'s own instance', () => {
    useSpaceStore.setState({ spaces: [{ id: 'space', _instanceOrigin: 'https://remote.example' } as Space] });
    useUnreadCountStore.getState().hydrate('', { a: 50 });
    useUnreadCountStore.getState().hydrate('https://remote.example', { a: 2 });
    render(<SpaceUnreadBadge spaceId="space" />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('leaves out channels already read', () => {
    useUnreadCountStore.getState().hydrate('', { a: 3, b: 4 });
    useChatStore.setState({ unreadChannels: new Set(['a']) });
    render(<SpaceUnreadBadge spaceId="space" />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('keeps the count of a muted space in the quiet colour', () => {
    useUnreadCountStore.getState().hydrate('', { a: 7 });
    useNotificationSettingsStore.getState().apply('', { spaceId: 'space', channelId: null, level: null, muted: true, mutedUntil: Date.now() + 60000, updatedAt: Date.now() });
    render(<SpaceUnreadBadge spaceId="space" />);
    expect(screen.getByText('7')).toHaveClass('bg-interactive-muted');
    expect(screen.getByText('7')).not.toHaveClass('bg-notification');
    expect(useUnreadCountStore.getState().counts[''].a).toBe(7);
    expect(useChatStore.getState().unreadChannels.has('a')).toBe(true);
  });

  it('shows nothing when the instance sent no counts', () => {
    useUnreadCountStore.getState().hydrate('', undefined);
    expect(render(<SpaceUnreadBadge spaceId="space" />).container).toBeEmptyDOMElement();
  });
});
