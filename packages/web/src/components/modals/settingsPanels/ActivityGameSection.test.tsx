import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../hooks/useWebSocket', () => ({ wsSendAll: vi.fn() }));
vi.mock('../../../api/client', () => ({ api: { gameIcons: { upload: vi.fn() } } }));

import { ActivityGameSection } from './ActivityGameSection';
import { useActivityStore } from '../../../stores/activityStore';

const setBindings = vi.fn(() => Promise.resolve());

function installDesktop(extra: Record<string, unknown> = {}) {
  (window as unknown as { backspace: unknown }).backspace = {
    listRunningPrograms: () => Promise.resolve([
      { label: 'Weird Game', process: 'Weird Game.exe' },
      { label: 'mygame', process: 'mygame' },
    ]),
    setManualGameBindings: setBindings,
    ...extra,
  };
}

const NAME_INPUT = 'Created manually';

beforeEach(() => {
  localStorage.clear();
  useActivityStore.getState().reset();
  setBindings.mockClear();
});
afterEach(() => {
  delete (window as unknown as { backspace?: unknown }).backspace;
});

describe('manual games on the desktop', () => {
  it('ties a game to the program picked from the running ones', async () => {
    installDesktop();
    render(<ActivityGameSection />);
    const select = await screen.findByLabelText('Program');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Weird Game' })).toBeInTheDocument());

    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled(); // no program yet

    fireEvent.change(select, { target: { value: 'Weird Game.exe' } });
    expect(screen.getByLabelText(NAME_INPUT)).toHaveValue('Weird Game'); // the name defaults to the program
    fireEvent.change(screen.getByLabelText(NAME_INPUT), { target: { value: 'Weird' } });
    fireEvent.click(add);

    expect(setBindings).toHaveBeenCalledWith([{ name: 'Weird', process: 'Weird Game.exe' }]);
    expect(useActivityStore.getState().manualGames).toEqual([{ name: 'Weird', process: 'Weird Game.exe' }]);
    expect(screen.getByLabelText(NAME_INPUT)).toHaveValue(''); // ready for the next one
  });

  it('holds several games, each shown with its state, and removes one', () => {
    installDesktop();
    useActivityStore.getState().addManualGame('Weird', 'Weird Game.exe');
    useActivityStore.getState().addManualGame('Other', 'other.exe');
    useActivityStore.setState({ detectedActivities: [{ type: 'playing', name: 'Weird' }] });
    render(<ActivityGameSection />);
    const status = (text: string) => screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === text);
    expect(status('Weird · running')).toBeInTheDocument();
    expect(status('Other · waiting for other.exe')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0] as HTMLElement);
    expect(useActivityStore.getState().manualGames.map((g) => g.name)).toEqual(['Other']);
  });

  it('has no suggestion menu on the name field', () => {
    installDesktop();
    const { container } = render(<ActivityGameSection />);
    expect(screen.getByLabelText(NAME_INPUT)).not.toHaveAttribute('list');
    expect(container.querySelectorAll('datalist')).toHaveLength(0);
  });
});

describe('manual games in a browser', () => {
  it('takes just a name', () => {
    render(<ActivityGameSection />);
    expect(screen.queryByLabelText('Program')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(NAME_INPUT), { target: { value: 'Hades' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(useActivityStore.getState().manualGames).toEqual([{ name: 'Hades', process: null }]);
  });
});

describe('unrecognized Wine programs', () => {
  it('offers each one and adds it to the games with one click', async () => {
    installDesktop({ getUnknownWinePrograms: () => Promise.resolve([{ label: 'Mystery', process: 'Mystery.exe' }]) });
    render(<ActivityGameSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add to my games' }));
    expect(setBindings).toHaveBeenCalledWith([{ name: 'Mystery', process: 'Mystery.exe' }]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add to my games' })).not.toBeInTheDocument());
  });

  it('shows nothing when the desktop does not report any', async () => {
    installDesktop();
    render(<ActivityGameSection />);
    await screen.findByLabelText('Program');
    expect(screen.queryByText('Unrecognized Wine programs')).not.toBeInTheDocument();
  });
});

describe('your games: hide and order', () => {
  const games = [
    { type: 'playing', name: 'Game A' },
    { type: 'playing', name: 'Game B' },
    { type: 'playing', name: 'Game C' },
  ];
  const rowNames = () => screen.getAllByRole('listitem').map((li) => li.textContent ?? '');

  it('lists every detected game and moves one up or down', () => {
    useActivityStore.setState({ detectedActivities: games });
    render(<ActivityGameSection />);
    expect(screen.getByRole('button', { name: 'Move Game A up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Game C down' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Move Game C up' }));
    expect(useActivityStore.getState().gameOrder).toEqual(['game a', 'game c', 'game b']);
    expect(rowNames()[1]).toContain('Game C');

    fireEvent.click(screen.getByRole('button', { name: 'Move Game C up' }));
    expect(useActivityStore.getState().gameOrder).toEqual(['game c', 'game a', 'game b']);
  });

  it('hides a game and shows it again, also when it is no longer running', () => {
    useActivityStore.setState({ detectedActivities: games });
    render(<ActivityGameSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Game B' }));
    expect(useActivityStore.getState().hiddenGames).toEqual(['game b']);

    act(() => useActivityStore.setState({ detectedActivities: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Show game b' }));
    expect(useActivityStore.getState().hiddenGames).toEqual([]);
  });
});

describe('renaming a detected game', () => {
  it('has no suggestion menu, and Clear brings the detected name back', () => {
    useActivityStore.setState({ detectedActivities: [{ type: 'playing', name: 'Stardew Valley' }] });
    render(<ActivityGameSection />);
    const input = screen.getByLabelText('Show Stardew Valley as');
    expect(input).not.toHaveAttribute('list');
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Farm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(useActivityStore.getState().gameRenames).toEqual({ 'stardew valley': 'Farm' });

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(useActivityStore.getState().gameRenames).toEqual({});
    expect(screen.getByLabelText('Show Stardew Valley as')).toHaveValue('');
  });
});
