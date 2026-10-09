import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVoiceStore } from './voiceStore';
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));

afterEach(() => {
  useVoiceStore.setState(useVoiceStore.getInitialState(), true);
  localStorage.removeItem('backspace-voice-settings');
});

describe('native voice session routing', () => {
  it('keeps native call routing in the active slot when another call rings', () => {
    const activeCall = { dmChannelId: 'dm', callOrigin: 'https://relay.test', federatedCallId: 'call', livekit: null };
    useVoiceStore.getState().setActiveDmCall(activeCall);
    useVoiceStore.getState().setIncomingCall({
      dmChannelId: null, callOrigin: 'https://other.test', federatedCallId: 'other-call',
      callerId: 'other', callerName: 'Other', livekit: { token: 'jwt', url: 'wss://media.test' },
    });
    expect(useVoiceStore.getState().activeDmCall).toEqual(activeCall);
    useVoiceStore.getState().setIncomingCall(null);
    expect(useVoiceStore.getState().activeDmCall).toEqual(activeCall);
    useVoiceStore.getState().setActiveDmCall(null);
    expect(useVoiceStore.getState().activeDmCall).toBeNull();
  });

  it('clears federation routing when moving into space voice', () => {
    useVoiceStore.getState().setActiveDmCall({
      dmChannelId: null, callOrigin: 'https://relay.test', federatedCallId: 'call', livekit: null,
    });
    useVoiceStore.getState().setCurrentVoiceChannel('space-channel');
    expect(useVoiceStore.getState()).toMatchObject({ currentVoiceChannelId: 'space-channel', activeDmCall: null });
  });

  it('never persists native capture ownership or clears it ahead of native teardown', () => {
    useVoiceStore.setState({ nativeVoiceActive: true });
    const state = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}').state as Record<string, unknown>;
    expect(state).not.toHaveProperty('nativeVoiceActive');
    useVoiceStore.getState().resetSession();
    expect(useVoiceStore.getState().nativeVoiceActive).toBe(true);
  });
});
