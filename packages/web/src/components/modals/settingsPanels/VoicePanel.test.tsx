import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VoicePanel } from './VoicePanel';
import { useUIStore } from '../../../stores/uiStore';
import { useVoiceStore } from '../../../stores/voiceStore';

// The device sections drive AudioManager and the media devices, which jsdom
// lacks. They are not what these tests are about.
vi.mock('../../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));
vi.mock('./AudioInputSection', () => ({ AudioInputSection: () => null }));
vi.mock('./AudioOutputSection', () => ({ AudioOutputSection: () => null }));
vi.mock('./VideoSection', () => ({ VideoSection: () => null }));

const PIP_LABEL = 'Show floating window during calls';

beforeEach(() => {
  useVoiceStore.setState({ pipEnabled: true });
});

afterEach(() => {
  cleanup();
  useUIStore.setState({ isMobile: false });
});

describe('VoicePanel floating window setting', () => {
  // The floating window is mounted only by the desktop layout. The mobile
  // Voice settings screen renders this same panel, so the switch would do
  // nothing there.
  it('shows the section on the desktop layout', () => {
    useUIStore.setState({ isMobile: false });
    render(<VoicePanel />);

    expect(screen.getByText('Floating Window')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: PIP_LABEL })).toBeInTheDocument();
  });

  it('leaves the section out on the mobile layout', () => {
    useUIStore.setState({ isMobile: true });
    render(<VoicePanel />);

    expect(screen.queryByText('Floating Window')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: PIP_LABEL })).not.toBeInTheDocument();
  });

  it('flips the stored preference when the switch is clicked', () => {
    render(<VoicePanel />);
    const toggle = screen.getByRole('switch', { name: PIP_LABEL });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    expect(useVoiceStore.getState().pipEnabled).toBe(false);
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    expect(useVoiceStore.getState().pipEnabled).toBe(true);
  });
});
