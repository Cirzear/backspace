import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeInstanceHeader } from './NativeInstanceHeader';

const mocks = vi.hoisted(() => ({ token: null as string | null, storedToken: null as string | null, clear: vi.fn(), flush: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../stores/authStore', () => ({ useAuthStore: Object.assign(
  (selector: (state: { token: string | null }) => unknown) => selector({ token: mocks.token }),
  { getState: () => ({ token: mocks.token }) },
) }));
vi.mock('../platform/instanceRuntime', () => ({
  getSelectedMobileOrigin: () => 'https://example.com', clearSelectedMobileOrigin: mocks.clear,
}));
vi.mock('../platform/sessionStorage', () => ({ flushSessionStorage: mocks.flush, getSessionItem: () => mocks.storedToken }));
beforeEach(() => { vi.clearAllMocks(); mocks.token = null; mocks.storedToken = null; mocks.flush.mockResolvedValue(undefined); });

describe('native instance switching', () => {
  it('does not offer switching while authenticated', () => {
    mocks.token = 'session-token';
    render(<NativeInstanceHeader />);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('refuses switching when secure storage still contains a token', async () => {
    mocks.storedToken = 'session-token';
    render(<NativeInstanceHeader />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('instance.logoutRequired'));
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it('refuses switching if logout could not be persisted', async () => {
    mocks.flush.mockRejectedValue(new Error('Secure write failed'));
    render(<NativeInstanceHeader />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Secure write failed'));
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it('rechecks authentication after pending storage writes', async () => {
    mocks.flush.mockImplementation(async () => { mocks.token = 'new-token'; });
    render(<NativeInstanceHeader />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(mocks.flush).toHaveBeenCalled());
    expect(mocks.clear).not.toHaveBeenCalled();
  });
});
