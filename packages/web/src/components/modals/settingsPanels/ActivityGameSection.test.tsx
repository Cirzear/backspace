import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../hooks/useWebSocket', () => ({ wsSendAll: vi.fn() }));
vi.mock('../../../api/client', () => ({ api: { gameIcons: { upload: vi.fn() } } }));

import { ActivityGameSection } from './ActivityGameSection';
import { useActivityStore } from '../../../stores/activityStore';

const setBinding = vi.fn(() => Promise.resolve());

function installDesktop() {
  (window as unknown as { backspace: unknown }).backspace = {
    listKnownGames: () => Promise.resolve([]),
    listRunningPrograms: () => Promise.resolve([
      { label: 'Weird Game', process: 'Weird Game.exe' },
      { label: 'mygame', process: 'mygame' },
    ]),
    setManualGameBinding: setBinding,
  };
}

beforeEach(() => {
  localStorage.clear();
  setBinding.mockClear();
  useActivityStore.getState().reset();
  setBinding.mockClear();
});
afterEach(() => {
  delete (window as unknown as { backspace?: unknown }).backspace;
});

describe('ActivityGameSection on the desktop', () => {
  it('ties the game to the program picked from the running ones', async () => {
    installDesktop();
    render(<ActivityGameSection />);
    const select = await screen.findByLabelText('Program');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Weird Game' })).toBeInTheDocument());

    const setButton = screen.getByRole('button', { name: 'Set' });
    expect(setButton).toBeDisabled(); // no program yet

    fireEvent.change(select, { target: { value: 'Weird Game.exe' } });
    expect(screen.getByLabelText("Game you're playing")).toHaveValue('Weird Game'); // the name defaults to the program
    fireEvent.change(screen.getByLabelText("Game you're playing"), { target: { value: 'Weird' } });
    fireEvent.click(setButton);

    expect(setBinding).toHaveBeenCalledWith({ name: 'Weird', process: 'Weird Game.exe' });
    expect(useActivityStore.getState().manualProcess).toBe('Weird Game.exe');
  });

  it('says it is waiting while the program is not running, then that it runs', () => {
    installDesktop();
    useActivityStore.getState().setManualGame('Weird', 'Weird Game.exe');
    render(<ActivityGameSection />);
    expect(screen.getByText(/Waiting for Weird Game\.exe/)).toBeInTheDocument();
  });
});

describe('ActivityGameSection in a browser', () => {
  it('takes just a name, as before', () => {
    render(<ActivityGameSection />);
    expect(screen.queryByLabelText('Program')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Game you're playing"), { target: { value: 'Hades' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(useActivityStore.getState()).toMatchObject({ manualGame: 'Hades', manualProcess: null });
  });
});
