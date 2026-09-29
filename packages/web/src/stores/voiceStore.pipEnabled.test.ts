import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVoiceStore } from './voiceStore';

// AudioManager loads an AudioWorklet module that jsdom cannot evaluate.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));

const STORAGE_KEY = 'backspace-voice-settings';

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  useVoiceStore.setState(useVoiceStore.getInitialState(), true);
});

function storedState(): Record<string, unknown> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) throw new Error('voice settings were not persisted');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !('state' in parsed)) {
    throw new Error('unexpected persisted shape');
  }
  return (parsed as { state: Record<string, unknown> }).state;
}

describe('voiceStore floating window preference persistence', () => {
  it('defaults to on', () => {
    expect(useVoiceStore.getInitialState().pipEnabled).toBe(true);
  });

  it('writes the preference to storage', () => {
    useVoiceStore.getState().setPipEnabled(false);
    expect(storedState().pipEnabled).toBe(false);

    useVoiceStore.getState().setPipEnabled(true);
    expect(storedState().pipEnabled).toBe(true);
  });

  it('keeps the preference on when a stored state predates the key', async () => {
    const version = useVoiceStore.persist.getOptions().version;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { messageSoundAllChannels: true }, version }),
    );

    await useVoiceStore.persist.rehydrate();

    const state = useVoiceStore.getState();
    // The stored value was applied, so the rehydrate did run.
    expect(state.messageSoundAllChannels).toBe(true);
    expect(state.pipEnabled).toBe(true);
  });

  it('restores an off preference from storage', async () => {
    const version = useVoiceStore.persist.getOptions().version;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { pipEnabled: false }, version }));

    await useVoiceStore.persist.rehydrate();

    expect(useVoiceStore.getState().pipEnabled).toBe(false);
  });
});
