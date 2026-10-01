import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVoiceStore } from './voiceStore';
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));

afterEach(() => {
  useVoiceStore.setState(useVoiceStore.getInitialState(), true);
  localStorage.removeItem('backspace-voice-settings');
});

describe('native voice session routing', () => {
  it('retains the federation locator when consuming the initial LiveKit token', () => {
    useVoiceStore.setState({ activeDmCall: { dmChannelId: 'dm' }, callOrigin: 'https://relay.test', federatedCallId: 'call', federatedCallToken: 'jwt', federatedCallUrl: 'wss://media.test' });
    useVoiceStore.getState().clearFederatedCallData();
    expect(useVoiceStore.getState()).toMatchObject({ callOrigin: 'https://relay.test', federatedCallId: 'call', federatedCallToken: null, federatedCallUrl: null });
    useVoiceStore.getState().setActiveDmCall(null);
    expect(useVoiceStore.getState()).toMatchObject({ callOrigin: null, federatedCallId: null });
  });

  it('clears federation routing when moving into space voice', () => {
    useVoiceStore.setState({ callOrigin: 'https://relay.test', federatedCallId: 'call' });
    useVoiceStore.getState().setCurrentVoiceChannel('space-channel');
    expect(useVoiceStore.getState()).toMatchObject({ currentVoiceChannelId: 'space-channel', callOrigin: null, federatedCallId: null });
  });

  it('never persists native capture ownership or clears it ahead of native teardown', () => {
    useVoiceStore.setState({ nativeVoiceActive: true });
    const state = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}').state as Record<string, unknown>;
    expect(state).not.toHaveProperty('nativeVoiceActive');
    useVoiceStore.getState().resetSession();
    expect(useVoiceStore.getState().nativeVoiceActive).toBe(true);
  });
});
