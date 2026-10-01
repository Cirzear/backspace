import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  native: true, origin: null as string | null,
  initialize: vi.fn(), render: vi.fn(), pending: vi.fn(), appImport: vi.fn(),
  initI18n: vi.fn(), scale: vi.fn(() => vi.fn()),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => mocks.native } }));
vi.mock('../platform/instanceRuntime', () => ({ getSelectedMobileOrigin: () => mocks.origin }));
vi.mock('../platform/sessionStorage', () => ({ initializeSessionStorage: mocks.initialize }));
vi.mock('../platform/interfaceScale', () => ({ initializeInterfaceScale: mocks.scale }));
vi.mock('../i18n', () => ({ default: { t: (key: string) => key }, initI18n: mocks.initI18n }));
vi.mock('../utils/emojiShortcodes', () => ({ loadDiscordEmojiAliases: async () => {} }));
vi.mock('react-dom/client', () => ({ default: { createRoot: () => ({ render: mocks.render }) } }));
vi.mock('./InstanceSelectionPage', () => ({ InstanceSelectionPage: () => null }));
vi.mock('./StartupError', () => ({ StartupError: () => null }));
vi.mock('../App', () => { mocks.appImport(); return { App: () => null }; });
vi.mock('../stores/pendingMessageRehydrate', () => ({ startPendingMessageOrchestrator: mocks.pending }));

let listeners: EventListener[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.native = true;
  mocks.origin = null;
  mocks.initialize.mockResolvedValue(undefined);
  mocks.initI18n.mockResolvedValue(undefined);
  document.body.innerHTML = '<div id="root"></div>';
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'backspace:session-storage-error') listeners.push(listener as EventListener);
    add(type, listener, options);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const listener of listeners) window.removeEventListener('backspace:session-storage-error', listener);
  listeners = [];
  vi.restoreAllMocks();
});

describe('native bootstrap boundary', () => {
  it('shows the picker without importing session-bound stores', async () => {
    await import('../main');
    await waitFor(() => expect(mocks.render).toHaveBeenCalled());
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.appImport).not.toHaveBeenCalled();
    expect(mocks.pending).not.toHaveBeenCalled();
  });
  it('waits for secure storage before importing App or pending orchestration', async () => {
    mocks.origin = 'https://example.com';
    let finish!: () => void;
    mocks.initialize.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    await import('../main');
    await waitFor(() => expect(mocks.initialize).toHaveBeenCalledWith(mocks.origin));
    expect(mocks.appImport).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(mocks.pending).toHaveBeenCalledOnce());
    expect(mocks.appImport).toHaveBeenCalledOnce();
  });
  it('blocks on secure storage failure rather than rendering App', async () => {
    mocks.origin = 'https://example.com';
    mocks.initialize.mockRejectedValue(new Error('Keystore unavailable'));
    await import('../main');
    await waitFor(() => expect(mocks.render).toHaveBeenCalled());
    expect(mocks.appImport).not.toHaveBeenCalled();
    expect(mocks.render.mock.calls[0]?.[0].props.error.message).toBe('Keystore unavailable');
  });
  it('blocks on initialization failure', async () => {
    mocks.initI18n.mockRejectedValue(new Error('Catalog failed'));
    await import('../main');
    await waitFor(() => expect(mocks.render).toHaveBeenCalled());
    expect(mocks.appImport).not.toHaveBeenCalled();
  });
  it('unmounts the app when a later session write fails', async () => {
    mocks.native = false;
    await import('../main');
    await waitFor(() => expect(mocks.pending).toHaveBeenCalled());
    window.dispatchEvent(new CustomEvent('backspace:session-storage-error', { detail: new Error('Write failed') }));
    expect(mocks.render.mock.lastCall?.[0].props.error.message).toBe('Write failed');
  });
  it('keeps web startup independent of mobile selection and secure storage', async () => {
    mocks.native = false;
    await import('../main');
    await waitFor(() => expect(mocks.pending).toHaveBeenCalled());
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.render).toHaveBeenCalledOnce();
  });
});
