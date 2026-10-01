import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeScreenShareSetup } from './NativeScreenShareSetup';
import { useScreenShareSetupStore } from '../stores/screenShareSetupStore';
const mock = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('./nativeScreenShare', () => ({ startNativeScreenShare: mock.start, stopNativeScreenShare: mock.stop }));
vi.mock('../hooks/useLiveKit', () => ({ getActiveRoom: () => ({ localParticipant: { identity: 'local:alice' } }) }));
vi.mock('../hooks/usePortalContainer', () => ({ usePortalContainer: () => document.body }));
vi.mock('../components/voice/StreamQualityControls', () => ({ StreamQualityControls: () => <div>Quality controls</div> }));
vi.mock('../components/ui/Modal', () => ({ Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => isOpen ? <div>{children}</div> : null }));

beforeEach(() => {
  vi.clearAllMocks();
  mock.stop.mockResolvedValue(undefined);
  useScreenShareSetupStore.setState({ isOpen: true });
});

describe('Android screen sharing setup', () => {
  it('offers quality and Android consent without creating a browser preview', () => {
    const { container } = render(<NativeScreenShareSetup />);
    expect(screen.getByText('Quality controls')).toBeInTheDocument();
    expect(screen.getByText(/approve Android/)).toBeInTheDocument();
    expect(container.querySelector('video')).toBeNull();
    expect(mock.start).not.toHaveBeenCalled();
  });

  it('keeps cancelled consent visible instead of closing as a successful share', async () => {
    mock.start.mockRejectedValueOnce({ code: 'SCREEN_SHARE_CANCELLED' });
    render(<NativeScreenShareSetup />);
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Screen sharing was cancelled');
    expect(useScreenShareSetupStore.getState().isOpen).toBe(true);
  });

  it('closes only after native start succeeds', async () => {
    mock.start.mockResolvedValueOnce(undefined);
    render(<NativeScreenShareSetup />);
    fireEvent.click(screen.getByRole('button', { name: 'Start stream' }));
    await waitFor(() => expect(useScreenShareSetupStore.getState().isOpen).toBe(false));
  });
});
