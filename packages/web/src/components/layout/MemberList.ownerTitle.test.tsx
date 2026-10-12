import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MemberWithUser, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { MemberSidebar } from './MemberSidebar';
import { MobileMembersScreen } from './MobileMembersScreen';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';

// The owner title labels the owner's group on every member list. It never
// replaces the owner's name: the row still shows their nickname.

const SPACE_ID = 'space-1';

const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Aether Drift', icon: null, banner: null, avatarColor: 'lavender',
  ownerId: 'u-owner', ownerTitle: 'Captain', inviteCode: null, visibility: 'public', directoryListed: false,
  description: '', createdAt: 1, _instanceOrigin: '',
};

function user(id: string, name: string): User {
  return {
    id, username: name.toLowerCase(), displayName: name, avatar: null, banner: null, accentColor: null,
    avatarColor: null, bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

const OWNER: MemberWithUser = { spaceId: SPACE_ID, userId: 'u-owner', nickname: 'Skipper', joinedAt: 1, user: user('u-owner', 'Jannis'), roles: [] };
const GUEST: MemberWithUser = { spaceId: SPACE_ID, userId: 'u-guest', nickname: null, joinedAt: 1, user: user('u-guest', 'Mira'), roles: [] };

beforeEach(() => {
  useAuthStore.setState({ user: user('u-guest', 'Mira'), myRowIds: new Map() });
  useSpaceStore.setState({ spaces: [SPACE], currentSpaceId: SPACE_ID, loadingSpaceId: null, members: [OWNER, GUEST] });
  useUIStore.setState({ isMobile: false, memberListOpen: true });
});

describe.each([
  ['the desktop member list', () => <MemberSidebar />],
  ['the phone members screen', () => <MobileMembersScreen params={{ spaceId: SPACE_ID }} />],
])('owner title on %s', (_surface, renderSurface) => {
  it('heads the owner group with the title and keeps the owner named by their nickname', () => {
    render(<MemoryRouter>{renderSurface()}</MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Captain — 1' })).toBeInTheDocument();
    expect(screen.getByText('Skipper')).toBeInTheDocument();
    expect(screen.queryByText('Jannis')).not.toBeInTheDocument();
  });

  it('shows the default heading after a reset', () => {
    useSpaceStore.setState({ spaces: [{ ...SPACE, ownerTitle: null }] });
    render(<MemoryRouter>{renderSurface()}</MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Owner — 1' })).toBeInTheDocument();
  });

  it('offers the editor to the owner only', () => {
    const { unmount } = render(<MemoryRouter>{renderSurface()}</MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'Edit owner title' })).not.toBeInTheDocument();
    unmount();
    useAuthStore.setState({ user: user('u-owner', 'Jannis') });
    render(<MemoryRouter>{renderSurface()}</MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Edit owner title' })).toBeInTheDocument();
  });
});
