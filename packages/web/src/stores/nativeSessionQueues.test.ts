import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadOptions } from 'tus-js-client';

const native = vi.hoisted(() => ({ enabled: true }));
const uploads = vi.hoisted(() => ({ options: [] as UploadOptions[], abort: vi.fn().mockResolvedValue(undefined), start: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.enabled }, registerPlugin: () => ({}) }));
vi.mock('./authStore', () => ({ useAuthStore: { getState: () => ({ token: 'token', user: { id: 'user' } }) } }));
vi.mock('tus-js-client', () => ({ Upload: class {
  constructor(_file: File, options: UploadOptions) { uploads.options.push(options); }
  start() { uploads.start(); }
  abort() { return uploads.abort(); }
} }));
vi.mock('../utils/idbHandles', () => ({ getHandle: vi.fn(), putHandle: vi.fn(), ensurePermission: vi.fn(), queryHandlePermission: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  native.enabled = true;
  uploads.options.length = 0;
  uploads.abort.mockClear();
  uploads.start.mockClear();
  localStorage.clear();
  // Native stores load only after the bootstrap has selected the home instance.
  localStorage.setItem('backspace_mobile_origin', 'https://home.example');
});

async function stores() {
  const { setTokenForOriginResolver } = await import('../utils/crossStoreResolvers');
  setTokenForOriginResolver(() => 'token');
  const { useComposerStore } = await import('./composerStore');
  const { usePendingMessageStore } = await import('./pendingMessageStore');
  const { useTransferStore } = await import('./transferStore');
  return { composer: useComposerStore, pending: usePendingMessageStore, transfer: useTransferStore };
}

describe('Android session-only unsent work', () => {
  it('never hydrates old persisted drafts or writes new work to localStorage', async () => {
    localStorage.setItem('composerStore@v1', JSON.stringify({ version: 1, state: { states: [['old', { draftText: 'other account' }]] } }));
    const { composer, pending, transfer } = await stores();
    expect(composer.getState().states.size).toBe(0);
    composer.getState().setDraft('channel', 'private draft');
    pending.getState().append({ clientId: 'pending', channelId: 'channel', content: 'private', replyToId: null, transferIds: [], createdAtLocal: 1, state: 'sending', tusExpiresAt: 100, retryCount: 0 });
    await transfer.getState().startUpload(new File(['data'], 'private.txt'), {});
    expect(localStorage.getItem('pendingMessageStore@v1')).toBeNull();
    expect(localStorage.getItem('transferStore@v1')).toBeNull();
    expect(localStorage.getItem('composerStore@v1')).not.toContain('private draft');
    expect(uploads.options[0].storeFingerprintForResuming).toBe(false);
    transfer.getState().resetSession();
    pending.getState().resetSession();
    composer.getState().resetSession();
    expect(uploads.abort).toHaveBeenCalledOnce();
    expect(transfer.getState().transfers.size).toBe(0);
    expect(transfer.getState().hasInMemoryFile.size).toBe(0);
    expect(pending.getState().bubbles.size).toBe(0);
    expect(composer.getState().states.size).toBe(0);
  });

  it('does not resurrect an upload whose file handle resolves after logout', async () => {
    const { transfer } = await stores();
    const { getHandle } = await import('../utils/idbHandles');
    let release!: (value: undefined) => void;
    vi.mocked(getHandle).mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const id = transfer.getState().createTransfer({ type: 'upload', tray: true, file: { name: 'private.txt', size: 5, mimetype: 'text/plain' }, fileHandleId: 'old-handle' });
    const resuming = transfer.getState().resumeUpload(id);
    transfer.getState().resetSession();
    release(undefined);
    await resuming;
    expect(uploads.start).not.toHaveBeenCalled();
    expect(transfer.getState().transfers.size).toBe(0);
  });

  it('keeps web draft persistence unchanged', async () => {
    native.enabled = false;
    const { composer } = await stores();
    composer.getState().setDraft('channel', 'web draft');
    expect(localStorage.getItem('composerStore@v1')).toContain('web draft');
  });
});
