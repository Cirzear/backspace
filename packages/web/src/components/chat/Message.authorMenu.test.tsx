import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MessageWithUser, Space, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useComposerStore } from '../../stores/composerStore';
import { useChannelPokeStore } from '../../stores/channelPokeStore';
import { useContextMenuStore, type ContextMenuItem } from '../../stores/contextMenuStore';
import { Message } from './Message';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn().mockReturnValue(true) }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

function makeUser(id: string, username: string, displayName: string | null): User {
  return {
    id, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

const me = makeUser('me', 'alice', 'Alice');
const bob = makeUser('bob', 'bob', 'Bob');
const dm = { id: 'dm-1', ownerId: 'me', name: 'Chat', createdAt: 1, members: [me, bob], lastMessage: null } as unknown as DmChannel;

const space = {
  id: 'space-1',
  name: 'General Space',
  ownerId: 'me',
  _instanceOrigin: 'https://host.test',
} as unknown as Space;

function makeMessage(channelId: string, isDm: boolean): MessageWithUser {
  return {
    id: 'msg-1',
    channelId: isDm ? '' : channelId,
    dmChannelId: isDm ? channelId : '',
    userId: bob.id,
    content: 'hello',
    createdAt: 1000,
    user: bob,
    attachments: [],
    embeds: [],
    reactions: [],
  } as unknown as MessageWithUser;
}

describe('Message author context menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: me });
    useSpaceStore.setState({
      currentSpaceId: null,
      spaces: [space],
      dmChannels: [dm],
      channelOriginMap: new Map([['space-ch-1', 'https://host.test'], ['dm-1', '']]),
      channelPermissions: new Map([['space-ch-1', 2048n]]), // SEND_MESSAGES
    });
    useComposerStore.getState().reset?.() || useComposerStore.getState().setDraft('dm-1', '');
    useChannelPokeStore.getState().reset();
  });

  afterEach(() => {
    useContextMenuStore.getState().close();
  });

  it('opens an author menu with mention action on DM author right-click', () => {
    const openSpy = vi.spyOn(useContextMenuStore.getState(), 'open');
    const msg = makeMessage('dm-1', true);
    const { container } = render(
      <Message message={msg} isCompact={false} isFirstInGroup={true} previousMessageId={null} />
    );

    const avatar = container.querySelector('[data-poke-user="bob"]');
    expect(avatar).not.toBeNull();
    fireEvent.contextMenu(avatar!);

    expect(openSpy).toHaveBeenCalled();
    const items = openSpy.mock.calls[0]![1] as ContextMenuItem[];
    expect(items.some((i) => i.key === 'mention-author' && i.label === '@Bob')).toBe(true);
    expect(items.some((i) => i.key === 'poke-author')).toBe(false);

    // Clicking mention-author inserts mention token in composer
    const mentionAction = items.find((i) => i.key === 'mention-author');
    if (mentionAction?.type === 'action') {
      mentionAction.onClick();
      expect(useComposerStore.getState().get('dm-1').draftText).toContain('<@bob>');
    }
  });

  it('includes both mention and poke in space channel when poke is supported', () => {
    useChannelPokeStore.getState().setHost('https://host.test', true);
    useSpaceStore.setState({ currentSpaceId: 'space-1' });

    const openSpy = vi.spyOn(useContextMenuStore.getState(), 'open');
    const msg = makeMessage('space-ch-1', false);
    const { container } = render(
      <Message message={msg} isCompact={false} isFirstInGroup={true} previousMessageId={null} />
    );

    const avatar = container.querySelector('[data-poke-user="bob"]');
    expect(avatar).not.toBeNull();
    fireEvent.contextMenu(avatar!);

    expect(openSpy).toHaveBeenCalled();
    const items = openSpy.mock.calls[0]![1] as ContextMenuItem[];
    expect(items.some((i) => i.key === 'mention-author')).toBe(true);
    expect(items.some((i) => i.key === 'poke-author')).toBe(true);
  });

  it('triggers author menu on author name right-click and respects permissions', () => {
    // Revoke send permissions
    useSpaceStore.setState({ channelPermissions: new Map([['space-ch-1', 0n]]) });
    const openSpy = vi.spyOn(useContextMenuStore.getState(), 'open');
    const msg = makeMessage('space-ch-1', false);
    render(
      <Message message={msg} isCompact={false} isFirstInGroup={true} previousMessageId={null} />
    );

    const nameEl = screen.getByText('Bob');
    fireEvent.contextMenu(nameEl);

    expect(openSpy).toHaveBeenCalled();
    const items = openSpy.mock.calls[0]![1] as ContextMenuItem[];
    const mentionAction = items.find((i) => i.key === 'mention-author');
    expect(mentionAction?.disabled).toBe(true);
  });
});
