import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MemberWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useComposerStore } from '../../stores/composerStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { MessageInput } from './MessageInput';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
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
    id,
    username,
    displayName,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 1,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  };
}

function member(spaceId: string, user: User): MemberWithUser {
  return { spaceId, userId: user.id, nickname: null, joinedAt: 1, user, roles: [] };
}

const ORBIT = 'https://orbit.example';
const me = makeUser('me', 'alice', 'Alice');
// The DM is pinned to a remote origin: its member ids are that origin's ids.
const meOnOrbit = makeUser('me-orbit', 'alice@home.example', 'Alice');
const kaiOnOrbit = makeUser('kai-orbit', 'kai', 'Kai');
const zed = makeUser('zed', 'zed', 'Zed');

const dm = {
  id: 'dm-1',
  ownerId: null,
  createdAt: 1,
  members: [meOnOrbit, kaiOnOrbit],
  lastMessage: null,
} as unknown as DmChannel;

function typeInComposer(value: string): HTMLTextAreaElement {
  const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(textbox, { target: { value } });
  return textbox;
}

beforeEach(() => {
  // jsdom does not implement scrollIntoView; the picker scrolls its selection.
  Element.prototype.scrollIntoView = vi.fn();
  useAuthStore.setState({ user: me });
  useUIStore.setState({ isMobile: false });
  useComposerStore.setState({ states: new Map() });
  useAuthStore.getState().recordMyRow(ORBIT, meOnOrbit.id);
});

afterEach(() => {
  useChatStore.getState().clearAllMessages();
  useComposerStore.setState({ states: new Map() });
  useSpaceStore.setState({
    dmChannels: [],
    members: [],
    currentSpaceId: null,
    channelOriginMap: new Map(),
    channelToSpaceMap: new Map(),
  });
  useAuthStore.setState({ user: null });
  useAuthStore.setState({ myRowIds: new Map() });
});

describe('MessageInput mention picker (#338)', () => {
  it("lists the DM's other members, not the roster of the space opened last", () => {
    useSpaceStore.setState({
      dmChannels: [dm],
      channelOriginMap: new Map([[dm.id, ORBIT]]),
      // Stale roster of a space opened earlier in the session.
      members: [member('space-9', zed), member('space-9', me)],
      currentSpaceId: null,
    });
    render(<MessageInput channelId={dm.id} channelName="@Kai" />);

    typeInComposer('@');

    expect(screen.getByText('Kai')).toBeInTheDocument();
    expect(screen.queryByText('Zed')).not.toBeInTheDocument();
    // Self is not offered in a DM.
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it("inserts the member's id on the DM's origin", () => {
    useSpaceStore.setState({
      dmChannels: [dm],
      channelOriginMap: new Map([[dm.id, ORBIT]]),
      members: [member('space-9', zed)],
    });
    render(<MessageInput channelId={dm.id} channelName="@Kai" />);

    const textbox = typeInComposer('hey @k');
    fireEvent.keyDown(textbox, { key: 'Enter' });

    expect(useComposerStore.getState().get(dm.id).draftText).toBe('hey <@kai-orbit> ');
  });

  it("lists a space channel's own roster and nothing from another space", () => {
    const mira = makeUser('mira', 'mira', 'Mira');
    useSpaceStore.setState({
      dmChannels: [],
      channelToSpaceMap: new Map([['chan-1', 'space-1']]),
      channelPermissions: new Map([['chan-1', '1024']]),
      members: [member('space-1', mira), member('space-2', zed)],
      currentSpaceId: 'space-1',
    });
    render(<MessageInput channelId="chan-1" channelName="general" />);

    typeInComposer('@');

    expect(screen.getByText('Mira')).toBeInTheDocument();
    expect(screen.queryByText('Zed')).not.toBeInTheDocument();
  });
});

describe('MessageInput mention labels', () => {
  beforeEach(() => {
    useSpaceStore.setState({
      dmChannels: [dm],
      channelOriginMap: new Map([[dm.id, ORBIT]]),
      // Stale roster of a space opened earlier in the session.
      members: [member('space-9', zed), member('space-9', me)],
    });
  });

  it("shows a picked member by name and stores the id on the DM's origin, keeping the picker open while the query is typed", async () => {
    render(<MessageInput channelId={dm.id} channelName="@Kai" />);

    typeInComposer('hey @k');
    const row = screen.getByText('Kai');
    const textbox = typeInComposer('hey @ka');
    // The same row: the picker is not mounted again for every keystroke.
    expect(screen.getByText('Kai')).toBe(row);
    await act(async () => { fireEvent.keyDown(textbox, { key: 'Enter' }); });

    expect(useComposerStore.getState().get(dm.id).draftText).toBe('hey <@kai-orbit> ');
    expect(textbox).toHaveValue('hey @Kai ');
  });

  it("names the signed-in user's token in the DM's id space, and only that one", () => {
    useComposerStore.getState().setDraft(dm.id, 'hi <@me-orbit> <@me>');
    render(<MessageInput channelId={dm.id} channelName="@Kai" />);

    // `me` is the home id: it names nobody in a DM whose ids are orbit's.
    expect(screen.getByRole('textbox')).toHaveValue('hi @Alice <@me>');
  });

  it("never labels an id from the space roster opened last", () => {
    useComposerStore.getState().setDraft(dm.id, 'hi <@zed>');
    render(<MessageInput channelId={dm.id} channelName="@Kai" />);

    expect(screen.getByRole('textbox')).toHaveValue('hi <@zed>');
  });
});
