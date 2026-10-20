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

describe('unrecognized Wine programs', () => {
  it('offers each one and ties the game to it with one click', async () => {
    installDesktop();
    (window.backspace as unknown as Record<string, unknown>).getUnknownWinePrograms = () => Promise.resolve([{ label: 'Mystery', process: 'Mystery.exe' }]);
    render(<ActivityGameSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use as game' }));
    expect(setBinding).toHaveBeenCalledWith({ name: 'Mystery', process: 'Mystery.exe' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use as game' })).not.toBeInTheDocument());
  });

  it('shows nothing when the desktop does not report any', async () => {
    installDesktop();
    render(<ActivityGameSection />);
    await screen.findByLabelText('Program');
    expect(screen.queryByText('Unrecognized Wine programs')).not.toBeInTheDocument();
  });
});

describe('renaming a detected game', () => {
  it('has no suggestion menu, and Clear brings the detected name back', () => {
    useActivityStore.setState({ detectedActivities: [{ type: 'playing', name: 'Stardew Valley' }] });
    const { container } = render(<ActivityGameSection />);
    const input = screen.getByLabelText('Show Stardew Valley as');
    expect(input).not.toHaveAttribute('list');
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Farm' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Set' })[1]!);
    expect(useActivityStore.getState().gameRenames).toEqual({ 'stardew valley': 'Farm' });

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(useActivityStore.getState().gameRenames).toEqual({});
    expect(screen.getByLabelText('Show Stardew Valley as')).toHaveValue('');
    expect(container.querySelectorAll('datalist')).toHaveLength(1); // only the manual game name keeps its suggestions
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
