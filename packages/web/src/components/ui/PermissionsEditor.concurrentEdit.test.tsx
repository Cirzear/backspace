import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { PermissionsEditor, type Override } from './PermissionsEditor';
import { useSpaceStore } from '../../stores/spaceStore';
import { HttpError } from '../../api/client';
import { PermissionBits, permissionsToString, overrideVersion } from '../../utils/permissions';
import { NO_OVERRIDE_VERSION } from '@backspace/shared/src/permissions';
import type { PermissionDef } from './OverrideEntry';

// #365: each staged row names the version of the saved row it was made from,
// and a save refused because someone else changed a row meanwhile says so and
// has the owner list the overrides again (permissions.md, "Concurrent edits").

const SPACE_ID = 'space-1';
const { SEND_MESSAGES, ADD_REACTIONS } = PermissionBits;

function role(id: string, name: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: '0', createdAt: 1 };
}

const PERM_DEFS: PermissionDef[] = [
  { key: 'SEND_MESSAGES', bit: SEND_MESSAGES },
  { key: 'ADD_REACTIONS', bit: ADD_REACTIONS },
];

function override(targetId: string, allow: bigint, deny: bigint): Override {
  return { targetType: 'role', targetId, allow: permissionsToString(allow), deny: permissionsToString(deny) };
}

const CONFLICT_TEXT = 'Someone else changed these permissions. Review them and save again.';

function editor(overrides: Override[], putOverride: ReturnType<typeof vi.fn>, onSaved = vi.fn()) {
  return (
    <PermissionsEditor
      entityId="channel-1"
      spaceId={SPACE_ID}
      permDefs={PERM_DEFS}
      unhideNote="note"
      overrides={overrides}
      onSaved={onSaved}
      putOverride={putOverride}
      deleteOverride={vi.fn().mockResolvedValue({ success: true })}
    />
  );
}

async function allowSend(user: ReturnType<typeof userEvent.setup>, roleName: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${roleName}`) }));
  const panel = screen.getByRole('region', { name: roleName });
  const send = within(panel).getByRole('group', { name: 'Send Messages' });
  await user.click(within(send).getByRole('button', { name: 'Allow' }));
}

beforeEach(() => {
  useSpaceStore.setState({ roles: [role(SPACE_ID, '@everyone', 0), role('r-mod', 'Moderators', 2), role('r-guest', 'Guests', 1)], members: [] });
});

describe('PermissionsEditor: concurrent edits (#365)', () => {
  it('names the version of the row an edit started from, even after the list is read again', async () => {
    const user = userEvent.setup();
    const putOverride = vi.fn().mockResolvedValue({ success: true });
    const loaded = override('r-mod', 0n, ADD_REACTIONS);
    const { rerender } = render(editor([loaded], putOverride));

    await allowSend(user, 'Moderators');
    // The list is read again while the edit is open (another tab saved).
    rerender(editor([override('r-mod', 0n, 0n)], putOverride));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putOverride).toHaveBeenCalledTimes(1));
    expect(putOverride.mock.calls[0]![0]).toMatchObject({ targetId: 'r-mod', version: overrideVersion(loaded) });
  });

  it('names the "none" version for a row added in the edit', async () => {
    const user = userEvent.setup();
    const putOverride = vi.fn().mockResolvedValue({ success: true });
    render(editor([], putOverride));

    await user.click(screen.getByRole('button', { name: 'Add Role' }));
    await user.click(screen.getByRole('button', { name: 'Guests' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putOverride).toHaveBeenCalledTimes(1));
    expect(putOverride.mock.calls[0]![0]).toMatchObject({ targetId: 'r-guest', version: NO_OVERRIDE_VERSION });
  });

  it('says someone else changed the permissions, ahead of other refusals, and lists them again', async () => {
    const user = userEvent.setup();
    const putOverride = vi.fn()
      .mockRejectedValueOnce(new HttpError(403, 'Forbidden', undefined, 'role_hierarchy'))
      .mockRejectedValueOnce(new HttpError(409, 'Conflict', undefined, 'overrides_conflict'));
    const onSaved = vi.fn();
    render(editor([override('r-mod', 0n, 0n), override('r-guest', 0n, 0n)], putOverride, onSaved));

    await allowSend(user, 'Moderators');
    await allowSend(user, 'Guests');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(CONFLICT_TEXT)).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledTimes(1);
    // The staged edit is dropped: the viewer reviews the reloaded list.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
