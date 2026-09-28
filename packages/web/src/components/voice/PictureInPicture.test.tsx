import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PictureInPicture } from './PictureInPicture';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';

// AudioManager loads an AudioWorklet module that jsdom cannot evaluate.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));

function renderPip() {
  return render(
    <MemoryRouter>
      <PictureInPicture />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // In a space voice channel while looking at a text channel elsewhere: the
  // state in which the floating window appears.
  useVoiceStore.setState({
    currentVoiceChannelId: 'voice-1',
    activeDmCall: null,
    participants: [],
    focusedParticipantId: null,
    watchingStreams: new Set(),
    speakingParticipantIds: new Set(),
    pipEnabled: true,
  });
  useChatStore.setState({ currentChannelId: 'text-1' });
  useUIStore.setState({ voiceFullscreen: false, pipCollapsed: false });
});

afterEach(() => {
  cleanup();
  useVoiceStore.setState({ currentVoiceChannelId: null, activeDmCall: null, pipEnabled: true });
  useChatStore.setState({ currentChannelId: null });
});

describe('PictureInPicture and the floating window setting', () => {
  it('shows while in voice and viewing another channel when the setting is on', () => {
    const { container } = renderPip();
    expect(container).not.toBeEmptyDOMElement();
  });

  it('renders nothing in the same state when the setting is off', () => {
    useVoiceStore.setState({ pipEnabled: false });
    const { container } = renderPip();
    expect(container).toBeEmptyDOMElement();
  });

  it('follows the setting during a DM call viewed from elsewhere', () => {
    useVoiceStore.setState({ currentVoiceChannelId: null, activeDmCall: { dmChannelId: 'dm-1' } });
    const shown = renderPip();
    expect(shown.container).not.toBeEmptyDOMElement();
    cleanup();

    useVoiceStore.setState({ pipEnabled: false });
    const hidden = renderPip();
    expect(hidden.container).toBeEmptyDOMElement();
  });
});
