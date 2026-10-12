import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from 'react';
import type { ContextMenuItem } from '../../stores/contextMenuStore';
const mocks = vi.hoisted(() => ({ open: vi.fn(), send: vi.fn(), toast: vi.fn() }));
vi.mock('../../stores/contextMenuStore', () => ({ useContextMenuStore: { getState: () => ({ open: mocks.open }) } }));
vi.mock('../../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast: mocks.toast }) } }));
vi.mock('../../hooks/useWebSocket', () => ({ wsSend: mocks.send }));
import { useChannelPokeStore } from '../../stores/channelPokeStore';
import { useChannelPokeMenu } from './useChannelPokeMenu';

const options = { channelId: 'chat', targetUserId: 'target', origin: 'https://host.test', enabled: true };

function rightClick(change: Partial<typeof options> = {}) {
  const { result } = renderHook(() => useChannelPokeMenu({ ...options, ...change }));
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 5, clientY: 6 };
  result.current(event as unknown as MouseEvent);
  return event;
}

beforeEach(() => { vi.clearAllMocks(); useChannelPokeStore.getState().reset(); });

describe('the author menu', () => {
  it('leaves the right click to the message menu where no poke can be sent', () => {
    // A host whose ready did not offer pokes.
    const unsupported = rightClick();
    useChannelPokeStore.getState().setHost(options.origin, true);
    // A DM, a message still sending, or no SEND_MESSAGES.
    const disabled = rightClick({ enabled: false });
    for (const event of [unsupported, disabled]) {
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('opens a menu with Poke alone where a poke can be sent', () => {
    useChannelPokeStore.getState().setHost(options.origin, true);
    const event = rightClick();
    expect(event.preventDefault).toHaveBeenCalled();
    const items = mocks.open.mock.calls[0]![1] as ContextMenuItem[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'poke-author', type: 'action' });
  });

  it('sends to the instance hosting the space and says so when the socket is closed', () => {
    useChannelPokeStore.getState().setHost(options.origin, true);
    rightClick();
    const item = (mocks.open.mock.calls[0]![1] as ContextMenuItem[])[0];
    if (item?.type !== 'action') throw Error('Expected poke action');
    mocks.send.mockReturnValue(false);
    item.onClick();
    expect(mocks.send).toHaveBeenCalledWith({ type: 'channel_poke', channelId: 'chat', targetUserId: 'target' }, options.origin);
    expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), 'warning');
  });
});
