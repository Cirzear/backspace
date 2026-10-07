import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { RolesPanel } from './RolesPanel';
import { useSpaceStore, type TaggedSpace } from '../../../stores/spaceStore';
import { useAuthStore } from '../../../stores/authStore';
import { useUIStore } from '../../../stores/uiStore';
import { api, HttpError } from '../../../api/client';
import { PermissionBits, permissionsToString, stringToPermissions, rolePermissionsVersion } from '../../../utils/permissions';

// #365. The role editor sends the version of the permissions it loaded, says
// so when someone else saved them meanwhile, and follows the role while the
// viewer has no edit of their own. A lower role held by a member ranked above
// the viewer is edited like any other lower role (permissions.md, "Lower
// roles held by senior members").

const SPACE_ID = 'space-1';

const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};

const EVERYONE_BITS = PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES;
const LEAD_BITS = PermissionBits.MANAGE_ROLES | PermissionBits.KICK_MEMBERS | PermissionBits.ATTACH_FILES;
const VIEWER_HELD = LEAD_BITS | EVERYONE_BITS;

function role(id: string, name: string, position: number, permissions: bigint): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: permissionsToString(permissions), createdAt: 1 };
}
const EVERYONE = role(SPACE_ID, '@everyone', 0, EVERYONE_BITS);
const COUNCIL = role('r-council', 'Council', 3, PermissionBits.BAN_MEMBERS);
const LEADS = role('r-lead', 'Leads', 2, LEAD_BITS);
const HELPERS = role('r-helper', 'Helpers', 1, PermissionBits.KICK_MEMBERS);

function user(id: string): User {
  return {
    id, username: id, displayName: id, avatar: null, banner: null, accentColor: null, avatarColor: null, bio: null,
    status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null,
    replicatedInstances: [],
  };
}
function member(id: string, roles: Role[]): MemberWithUser {
  return { spaceId: SPACE_ID, userId: id, nickname: null, joinedAt: 1, user: user(id), roles };
}

const loadSpaceDetail = vi.fn(async (): Promise<undefined> => undefined);

function seed(): void {
  useAuthStore.setState({ user: user('lead') });
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    roles: [EVERYONE, COUNCIL, LEADS, HELPERS],
    // The boss ranks above the viewer (Council) and also holds Helpers.
    members: [member('owner', []), member('lead', [LEADS]), member('boss', [COUNCIL, HELPERS])],
    spacePermissions: new Map([[SPACE_ID, permissionsToString(VIEWER_HELD)]]),
    loadSpaceDetail,
  });
}

const toggle = (name: string): HTMLElement => screen.getByRole('switch', { name });
const saveButton = (): HTMLElement | null => screen.queryByRole('button', { name: 'Save' });

function setHelpers(permissions: bigint): void {
  act(() => {
    useSpaceStore.setState({ roles: [EVERYONE, COUNCIL, LEADS, role('r-helper', 'Helpers', 1, permissions)] });
  });
}

beforeEach(() => {
  loadSpaceDetail.mockReset();
  loadSpaceDetail.mockResolvedValue(undefined);
  useUIStore.setState({ isMobile: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RolesPanel: concurrent edits (#365)', () => {
  it('sends the version of the permissions the edit started from', async () => {
    seed();
    const update = vi.spyOn(api.roles, 'update').mockResolvedValue(HELPERS);
    render(<RolesPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Helpers' }));

    await userEvent.click(toggle('Attach Files'));
    // Someone else saves Helpers while the viewer's edit is open.
    setHelpers(PermissionBits.KICK_MEMBERS | PermissionBits.VIEW_CHANNEL);
    await userEvent.click(saveButton()!);

    expect(update).toHaveBeenCalledTimes(1);
    const body = update.mock.calls[0]![2];
    expect(stringToPermissions(body.permissions)).toBe(PermissionBits.KICK_MEMBERS | PermissionBits.ATTACH_FILES);
    expect(body.permissionsVersion).toBe(rolePermissionsVersion(HELPERS.permissions));
  });

  it('sends no permissions and no version when only the name changed', async () => {
    seed();
    const update = vi.spyOn(api.roles, 'update').mockResolvedValue({ ...HELPERS, name: 'Aides' });
    render(<RolesPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Helpers' }));

    const name = screen.getByDisplayValue('Helpers');
    await userEvent.clear(name);
    await userEvent.type(name, 'Aides');
    await userEvent.click(saveButton()!);

    expect(update).toHaveBeenCalledWith(SPACE_ID, 'r-helper', { name: 'Aides' });
  });

  it('follows the role while the viewer has no edit of their own', async () => {
    seed();
    render(<RolesPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Helpers' }));
    expect(toggle('View Channels')).toHaveAttribute('aria-checked', 'false');

    setHelpers(PermissionBits.KICK_MEMBERS | PermissionBits.VIEW_CHANNEL);

    expect(toggle('View Channels')).toHaveAttribute('aria-checked', 'true');
    expect(saveButton()).toBeNull();
  });

  it('on a conflict says so and shows the permissions stored now', async () => {
    seed();
    vi.spyOn(api.roles, 'update').mockRejectedValue(new HttpError(409, 'Conflict', undefined, 'role_permissions_conflict'));
    loadSpaceDetail.mockImplementation(async () => {
      useSpaceStore.setState({ roles: [EVERYONE, COUNCIL, LEADS, role('r-helper', 'Helpers', 1, PermissionBits.VIEW_CHANNEL)] });
      return undefined;
    });
    render(<RolesPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Helpers' }));

    await userEvent.click(toggle('Attach Files'));
    await userEvent.click(saveButton()!);

    expect(await screen.findByText("Someone else changed this role's permissions. Review them and save again.")).toBeInTheDocument();
    expect(loadSpaceDetail).toHaveBeenCalledWith(SPACE_ID, { quiet: true });
    expect(toggle('View Channels')).toHaveAttribute('aria-checked', 'true');
    expect(toggle('Kick Members')).toHaveAttribute('aria-checked', 'false');
    expect(toggle('Attach Files')).toHaveAttribute('aria-checked', 'false');
    expect(saveButton()).toBeNull();
  });
});

describe('RolesPanel: a lower role a member ranked above the viewer also holds (#365)', () => {
  it('is editable: no rank note, and every held bit switches, including off', async () => {
    seed();
    const update = vi.spyOn(api.roles, 'update').mockResolvedValue(role('r-helper', 'Helpers', 1, 0n));
    render(<RolesPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Helpers' }));

    expect(screen.queryByText(/ranks at or above your highest role/)).toBeNull();
    expect(toggle('Kick Members')).toHaveAttribute('aria-disabled', 'false');
    await userEvent.click(toggle('Kick Members'));
    await userEvent.click(saveButton()!);

    expect(update).toHaveBeenCalledTimes(1);
    expect(stringToPermissions(update.mock.calls[0]![2].permissions)).toBe(0n);
  });

  it('can be deleted when the viewer holds its bits', async () => {
    seed();
    const remove = vi.spyOn(api.roles, 'delete').mockResolvedValue({ success: true });
    render(<RolesPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Helpers' }));

    await userEvent.click(screen.getByRole('button', { name: 'Delete Role' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm?' }));

    expect(remove).toHaveBeenCalledWith(SPACE_ID, 'r-helper');
  });
});
