import { act, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChannelActivityStore } from '../../stores/channelActivityStore';
vi.mock('../../stores/spaceStore', () => ({ useSpaceStore: (selector: any) => selector({ channelOriginMap: new Map() }) }));
import { PokeNotices, usePokeTimeline } from './PokeNotice';
const event = { type: 'channel_poke', channelId: 'chat', userId: 'a', targetUserId: 'b', username: 'Alice', targetUsername: 'Bob' } as const;
beforeEach(() => useChannelActivityStore.getState().reset());
describe('poke timeline', () => {
  it('renders a centered passive notice', () => {
    useChannelActivityStore.getState().addPoke('', event);
    const { container } = render(<PokeNotices notices={useChannelActivityStore.getState().pokes} />);
    expect(container.querySelector('[data-poke-notice]')).toHaveClass('text-center', 'text-txt-tertiary');
    expect(screen.getByText(/Alice.*Bob/)).toBeInTheDocument();
  });
  it('inserts before later messages and keeps newer events at the bottom', () => {
    useChannelActivityStore.getState().addPoke('', event);
    const time = useChannelActivityStore.getState().pokes[0].createdAt;
    const { result } = renderHook(() => usePokeTimeline({ channelId: 'chat', messages: [{ id: 'old', createdAt: time - 1 }, { id: 'new', createdAt: time + 1 }], detached: false }));
    expect(result.current.before.get('new')).toHaveLength(1);
    expect(result.current.tail).toHaveLength(0);
    const tail = renderHook(() => usePokeTimeline({ channelId: 'chat', messages: [], detached: false }));
    expect(tail.result.current.tail).toHaveLength(1);
  });
  it('isolates channels, origins and detached history; reset removes session entries', () => {
    useChannelActivityStore.getState().addPoke('remote', event);
    useChannelActivityStore.getState().addPoke('', { ...event, channelId: 'other' });
    useChannelActivityStore.getState().addPoke('', event);
    const { result } = renderHook(() => usePokeTimeline({ channelId: 'chat', messages: [], detached: true }));
    expect(result.current.before.size).toBe(0);
    expect(result.current.tail).toHaveLength(0);
    act(() => useChannelActivityStore.getState().reset());
    expect(useChannelActivityStore.getState().pokes).toEqual([]);
  });
});
