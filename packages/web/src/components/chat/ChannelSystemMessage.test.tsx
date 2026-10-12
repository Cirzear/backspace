import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { MemberWithUser, MessageWithUser, User } from '@backspace/shared';

// jsdom has no AudioWorkletNode; the space store's imports reach the voice stack.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ setOutputDevice: vi.fn(), setVolume: vi.fn(), playSound: vi.fn(() => Promise.resolve(null)) }) },
}));

const { ChannelSystemMessage } = await import('./ChannelSystemMessage');
const { useSpaceStore } = await import('../../stores/spaceStore');

function user(id: string, displayName: string | null, username = id): User {
  return {
    id, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: 'mint', bio: null,
    status: 'online', customStatus: null, isAdmin: false, createdAt: 0, homeUserId: null, homeInstance: null,
    replicatedInstances: [],
  } as User;
}

function member(u: User, nickname: string | null): MemberWithUser {
  return { spaceId: 'space', userId: u.id, joinedAt: 0, nickname, roles: [], user: u } as unknown as MemberWithUser;
}

const actor = user('actor', 'Actor account');
const target = user('target', null, 'target@peer.example');

function poke(content: object | string = { event: 'channel_poke', targetUserId: 'target', targetDisplayName: 'Stored name' }): MessageWithUser {
  return {
    id: 'M1', channelId: 'chat', userId: 'actor', user: actor, type: 'system', createdAt: 1, editedAt: null,
    replyToId: null, replyTo: null, attachments: [], embeds: [], reactions: [],
    content: typeof content === 'string' ? content : JSON.stringify(content),
  } as MessageWithUser;
}

beforeEach(() => {
  useSpaceStore.getState().reset();
});

describe('ChannelSystemMessage', () => {
  it('names both people by their nickname in the space', () => {
    useSpaceStore.setState({ members: [member(actor, 'Captain'), member(target, 'Navigator')] });
    const { container } = render(<ChannelSystemMessage message={poke()} />);
    expect(container.textContent).toBe('Captain poked Navigator');
  });

  it('names a member without a nickname by their account name, without the instance', () => {
    useSpaceStore.setState({ members: [member(actor, null), member(target, null)] });
    const { container } = render(<ChannelSystemMessage message={poke()} />);
    expect(container.textContent).toBe('Actor account poked target');
  });

  it('uses the stored name for a target who is no longer in the roster', () => {
    useSpaceStore.setState({ members: [member(actor, null)] });
    const { container } = render(<ChannelSystemMessage message={poke()} />);
    expect(container.textContent).toBe('Actor account poked Stored name');
  });

  it('shows the generic label for content it does not know, never the content', () => {
    const unknown = render(<ChannelSystemMessage message={poke({ event: 'channel_hug', targetUserId: 'target', note: 'visible text' })} />);
    expect(unknown.container.textContent).toBe('System message');
    unknown.unmount();
    const text = render(<ChannelSystemMessage message={poke('Actor poked someone')} />);
    expect(text.container.textContent).toBe('System message');
  });
});
