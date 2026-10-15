import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  resetSystemAudioCapabilityForTests,
  systemAudioNote,
  useOwnAudioInSystemAudio,
} from './systemAudioNote';

describe('systemAudioNote', () => {
  it('warns before System Audio is on where the OS captures Backspace too', () => {
    for (const checked of [false, true]) {
      expect(systemAudioNote('win32', 'included', checked)).toEqual({ key: 'includedWindows', tone: 'warning' });
      expect(systemAudioNote('darwin', 'included', checked)).toEqual({ key: 'includedMac', tone: 'warning' });
      expect(systemAudioNote('linux', 'included', checked)).toEqual({ key: 'includedLinux', tone: 'warning' });
      expect(systemAudioNote('darwin', 'unavailable', checked)).toEqual({ key: 'unavailableMac', tone: 'warning' });
    }
  });

  it('says Backspace is left out once System Audio is on where the OS can', () => {
    expect(systemAudioNote('win32', 'excluded', true)).toEqual({ key: 'excluded', tone: 'info' });
    expect(systemAudioNote('darwin', 'excluded', true)).toEqual({ key: 'excludedMac', tone: 'info' });
    expect(systemAudioNote('win32', 'excluded', false)).toBeNull();
  });

  it('keeps the older per-platform note when the desktop app cannot tell (older app, unreadable version)', () => {
    expect(systemAudioNote('win32', null, true)).toEqual({ key: 'legacyWindows', tone: 'warning' });
    expect(systemAudioNote('darwin', 'unknown', true)).toEqual({ key: 'legacyMac', tone: 'warning' });
    expect(systemAudioNote('linux', null, true)).toEqual({ key: 'legacyLinux', tone: 'warning' });
    expect(systemAudioNote('win32', null, false)).toBeNull();
  });

  it('keeps the browser note in a browser', () => {
    expect(systemAudioNote(null, null, true)).toEqual({ key: 'browser', tone: 'warning' });
    expect(systemAudioNote(null, null, false)).toBeNull();
  });
});

describe('useOwnAudioInSystemAudio', () => {
  // On Linux the main process answers `excluded` only to a client that opens its
  // PipeWire source; the loopback an older client uses carries Backspace's playback.
  beforeEach(() => { resetSystemAudioCapabilityForTests(); });
  afterEach(() => {
    delete (window as { backspace?: BackspaceElectronAPI }).backspace;
    resetSystemAudioCapabilityForTests();
  });

  it('tells the desktop app that this client opens the system-audio source', async () => {
    const ask = vi.fn<(usesAppSource?: boolean) => Promise<OwnAudioInSystemAudio>>(() => Promise.resolve('excluded'));
    window.backspace = {
      platform: 'linux',
      getSystemAudioCapability: ask,
      startSystemAudio: vi.fn(),
      stopSystemAudio: vi.fn(),
    } as unknown as BackspaceElectronAPI;
    const { result } = renderHook(() => useOwnAudioInSystemAudio());
    await waitFor(() => expect(result.current).toBe('excluded'));
    expect(ask).toHaveBeenCalledWith(true);
  });

  it('does not claim the source on a desktop app without the bridge to open it', async () => {
    const ask = vi.fn<(usesAppSource?: boolean) => Promise<OwnAudioInSystemAudio>>(() => Promise.resolve('included'));
    window.backspace = { platform: 'linux', getSystemAudioCapability: ask } as unknown as BackspaceElectronAPI;
    const { result } = renderHook(() => useOwnAudioInSystemAudio());
    await waitFor(() => expect(result.current).toBe('included'));
    expect(ask).toHaveBeenCalledWith(false);
  });
});
