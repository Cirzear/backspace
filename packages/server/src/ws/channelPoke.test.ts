import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
const mocks = vi.hoisted(() => ({ permission: vi.fn(), broadcast: vi.fn(), get: vi.fn() }));
vi.mock('../utils/permissions.js', () => ({ getChannelSpaceId: () => 'space', hasPermission: mocks.permission, PermissionBits: { VIEW_CHANNEL: 1n, SEND_MESSAGES: 2n } }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: mocks.get }) }) }) }), schema: { users: { id: 'id' } } }));
vi.mock('./handler.js', () => ({ connectionManager: { sendToChannel: mocks.broadcast } }));
import { handleChannelPoke } from './channelPoke.js';
beforeEach(() => { vi.clearAllMocks(); mocks.permission.mockReturnValue(true); mocks.get.mockReturnValue({ username: 'User', displayName: null }); });
describe('channel poke authorization', () => {
  it('broadcasts a confirmed lightweight event using server-resolved names', () => {
    handleChannelPoke({ event: { channelId: 'chat', targetUserId: 'target', username: 'forged' }, userId: 'actor', ws: { send: vi.fn() } as unknown as WebSocket });
    expect(mocks.broadcast).toHaveBeenCalledWith('space', 'chat', { type: 'channel_poke', channelId: 'chat', userId: 'actor', targetUserId: 'target', username: 'User', targetUsername: 'User' });
  });
  it('rejects inaccessible channels and malformed target IDs instead of broadcasting', () => {
    const send = vi.fn();
    mocks.permission.mockReturnValue(false);
    handleChannelPoke({ event: { channelId: 'chat', targetUserId: 'target' }, userId: 'actor', ws: { send } as unknown as WebSocket });
    handleChannelPoke({ event: { channelId: 123, targetUserId: {} }, userId: 'actor', ws: { send } as unknown as WebSocket });
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
