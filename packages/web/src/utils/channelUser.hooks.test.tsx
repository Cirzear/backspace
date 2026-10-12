import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel, DmChannel, MemberWithUser, User } from '@backspace/shared';
// The store graph reaches the audio engine, which needs Web Audio at import.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { useAuthStore } from '../stores/authStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useChannelMentionCandidates, useChannelUser, useChannelUserResolver, useSelfIdInChannel } from './channelUser';

function makeUser(id: string, username: string, displayName: string | null): User {
  return {
    id, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

function member(spaceId: string, user: User): MemberWithUser {
  return { spaceId, userId: user.id, nickname: null, joinedAt: 1, user, roles: [] };
}

function channel(id: string, spaceId: string): Channel {
  return { id, spaceId, name: id, type: 'text', topic: null, position: 0, categoryId: null, createdAt: 0 };
}

const ORBIT = 'https://orbit.example';
const me = makeUser('me', 'alice', 'Alice');
const meOnOrbit = makeUser('me-orbit', 'alice@home.example', 'Alice');
const kai = makeUser('kai', 'kai', 'Kai');

afterEach(() => {
  useAuthStore.setState({ user: null });
  useSpaceStore.getState().reset();
  useAuthStore.setState({ myRowIds: new Map() });
});

// The channel lookup maps are updated in place by `upsertChannel` and several
// WS handlers; a hook must still see the new entry on the next store update.
describe('channelUser hooks and in-place lookup map updates', () => {
  it('resolves a member once a new channel of the loaded space is upserted', () => {
    useSpaceStore.setState({ currentSpaceId: 'space-1', members: [member('space-1', kai)] });
    const { result } = renderHook(() => useChannelUser('chan-new', kai.id));
    expect(result.current).toBeNull();

    act(() => useSpaceStore.getState().upsertChannel(channel('chan-new', 'space-1'), 'space-1', ''));

    expect(result.current?.userId).toBe(kai.id);
  });

  it("lists the new channel's space roster once the channel is upserted", () => {
    useSpaceStore.setState({ currentSpaceId: 'space-1', members: [member('space-1', kai)] });
    const { result } = renderHook(() => useChannelMentionCandidates('chan-new'));
    expect(result.current).toEqual([]);

    act(() => useSpaceStore.getState().upsertChannel(channel('chan-new', 'space-1'), 'space-1', ''));

    expect(result.current.map((c) => c.userId)).toEqual([kai.id]);
  });

  it("follows a channel's origin set in place", () => {
    useAuthStore.setState({ user: me });
    useAuthStore.getState().recordMyRow(ORBIT, meOnOrbit.id);
    useSpaceStore.setState({ currentSpaceId: 'space-9' });
    const { result } = renderHook(() => useSelfIdInChannel('chan-orbit'));
    expect(result.current).toBe(me.id);

    act(() => useSpaceStore.getState().upsertChannel(channel('chan-orbit', 'space-9'), 'space-9', ORBIT));

    expect(result.current).toBe(meOnOrbit.id);
  });
});

describe('useChannelUserResolver', () => {
  it("answers for the channel's own people, as useChannelUser does, and nobody else", () => {
    const zed = makeUser('zed', 'zed', null);
    useSpaceStore.setState({
      channelToSpaceMap: new Map([['chan-1', 'space-1'], ['chan-2', 'space-2']]),
      members: [member('space-1', kai)],
    });
    const { result } = renderHook(() => ({
      resolve: useChannelUserResolver('chan-1'),
      single: useChannelUser('chan-1', kai.id),
      other: useChannelUserResolver('chan-2'),
    }));
    expect(result.current.resolve(kai.id)).toEqual(result.current.single);
    expect(result.current.resolve(zed.id)).toBeNull();
    // The roster loaded is space-1's; chan-2's people are not known.
    expect(result.current.other(kai.id)).toBeNull();
  });

  it("reads a remote DM's ids in its origin's id space, the signed-in user included", () => {
    const kaiOnOrbit = makeUser('kai-orbit', 'kai', 'Kai');
    const orbitDm = { id: 'dm-orbit', ownerId: null, createdAt: 1, members: [meOnOrbit, kaiOnOrbit], lastMessage: null } as unknown as DmChannel;
    useAuthStore.setState({ user: me });
    useAuthStore.getState().recordMyRow(ORBIT, meOnOrbit.id);
    useSpaceStore.setState({ dmChannels: [orbitDm], channelOriginMap: new Map([[orbitDm.id, ORBIT]]), members: [member('space-1', kai)] });
    const { result } = renderHook(() => useChannelUserResolver(orbitDm.id));
    expect(result.current(kaiOnOrbit.id)?.origin).toBe(ORBIT);
    expect(result.current(meOnOrbit.id)?.user.displayName).toBe('Alice');
    // A home id names nobody in a DM whose ids are orbit's.
    expect(result.current(me.id)).toBeNull();
    expect(result.current(kai.id)).toBeNull();
  });

  it('gives a new lookup with the better view once the user-view cache learns one', () => {
    const stub = { ...makeUser('stub', '1234567890123456789@friend.example', null), homeUserId: '999', homeInstance: 'friend.example' };
    const dm = { id: 'dm-1', ownerId: null, createdAt: 1, members: [me, stub], lastMessage: null } as unknown as DmChannel;
    useSpaceStore.setState({ dmChannels: [dm] });
    const { result } = renderHook(() => useChannelUserResolver(dm.id));
    expect(result.current(stub.id)?.user.displayName).toBeNull();

    const home = { ...makeUser('999', 'quinn', 'Quinn'), homeUserId: '999', homeInstance: 'friend.example' };
    act(() => useSpaceStore.getState().upsertUserView(home, 'https://friend.example'));

    expect(result.current(stub.id)?.user.displayName).toBe('Quinn');
    expect(result.current(stub.id)?.userId).toBe(stub.id);
  });
});
