import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity } from '@backspace/shared';
import { setLanguage } from '../../i18n';
import { ActivityCard, ActivityDetailCard, activityTimeText, isRenderableActivityImage } from './ActivityCard';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
});

afterEach(async () => {
  await setLanguage('en');
  vi.useRealTimers();
});

describe('isRenderableActivityImage', () => {
  it('accepts only http(s) URLs', () => {
    expect(isRenderableActivityImage('https://cdn.discordapp.com/app-assets/1/osu.png')).toBe(true);
    expect(isRenderableActivityImage('http://example.com/a.png')).toBe(true);
    expect(isRenderableActivityImage('data:image/png;base64,AAAA')).toBe(false);
    expect(isRenderableActivityImage('javascript:alert(1)')).toBe(false);
    expect(isRenderableActivityImage('/static/logo.png')).toBe(false);
    expect(isRenderableActivityImage(undefined)).toBe(false);
  });
});

describe('activityTimeText', () => {
  const t = (key: string, opts?: Record<string, unknown>) =>
    key === 'time.left' ? `${opts?.duration as string} left` : `${opts?.duration as string} elapsed`;
  const fmt = (s: number) => {
    const total = Math.max(0, Math.floor(s));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const seg = (v: number) => String(v).padStart(2, '0');
    return h > 0 ? `${h}:${seg(m)}:${seg(sec)}` : `${seg(m)}:${seg(sec)}`;
  };
  const now = Date.parse('2026-09-04T12:00:00Z');

  it('counts down while the end is in the future', () => {
    expect(activityTimeText({ end: now + 90_000 }, now, t, fmt)).toBe('01:30 left');
  });

  it('falls back to elapsed once the end has passed', () => {
    expect(activityTimeText({ start: now - 60_000, end: now - 1000 }, now, t, fmt)).toBe('01:00 elapsed');
  });

  it('shows nothing without usable timestamps', () => {
    expect(activityTimeText({}, now, t, fmt)).toBeNull();
    expect(activityTimeText({ start: now + 60_000 }, now, t, fmt)).toBeNull(); // future start
  });
});

describe('ActivityCard', () => {
  it('localizes the elapsed activity time with locale-native digits', async () => {
    await setLanguage('ru');
    const activity: Activity = {
      type: 'playing',
      name: 'Escape from Tarkov',
      timestamps: { start: Date.now() - 32 * 60 * 1000 },
    };

    render(<ActivityCard activities={[activity]} />);

    expect(screen.getByText('Escape from Tarkov')).toBeInTheDocument();
    expect(screen.getByText('Прошло 32:00')).toBeInTheDocument();
  });

  it('ticks the elapsed time forward every second', () => {
    const activity: Activity = {
      type: 'playing',
      name: 'Minecraft',
      timestamps: { start: Date.now() - 5000 },
    };
    render(<ActivityCard activities={[activity]} />);
    expect(screen.getByText('00:05 elapsed')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('00:06 elapsed')).toBeInTheDocument();
  });

  it('counts down while the activity end is in the future, then switches to elapsed', () => {
    const activity: Activity = {
      type: 'playing',
      name: 'osu!',
      timestamps: { start: Date.now() - 60_000, end: Date.now() + 120_000 },
    };
    render(<ActivityCard activities={[activity]} />);
    expect(screen.getByText('02:00 left')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(121_000);
    });
    expect(screen.getByText('03:01 elapsed')).toBeInTheDocument();
  });

  it('renders details and state lines with emoji shortcodes', () => {
    const activity: Activity = {
      type: 'playing',
      name: 'osu!lazer',
      details: 'Playing [Big Black] :fire:',
      state: 'by Blue Stahli',
      timestamps: { start: Date.now() - 1000 },
    };
    render(<ActivityCard activities={[activity]} />);
    expect(screen.getByText('Playing [Big Black] 🔥')).toBeInTheDocument();
    expect(screen.getByText('by Blue Stahli')).toBeInTheDocument();
  });

  it('renders no art in a list row, whatever the activity carries', () => {
    const activity: Activity = {
      type: 'playing',
      name: 'osu!',
      assets: { largeImage: 'https://cdn.example.com/osu.png', smallImage: 'https://cdn.example.com/rank.png' },
    };
    render(<ActivityCard activities={[activity]} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('osu!')).toBeInTheDocument();
  });

  it('shows the first game and how many more are running', () => {
    const games: Activity[] = [
      { type: 'playing', name: 'Honkai: Star Rail' },
      { type: 'playing', name: 'Stardew Valley' },
      { type: 'playing', name: 'Zenless Zone Zero' },
    ];
    render(<ActivityCard activities={games} />);
    expect(screen.getByText('Honkai: Star Rail')).toBeInTheDocument();
    expect(screen.getByText('+2')).toHaveAttribute('title', 'Stardew Valley, Zenless Zone Zero');
    expect(screen.queryByText('Stardew Valley')).not.toBeInTheDocument();
  });

  it('shows no counter for a single game, nor for music next to a game', () => {
    render(<ActivityCard activities={[{ type: 'playing', name: 'cs2' }, { type: 'listening', name: 'Spotify' }]} />);
    expect(screen.getByText('cs2')).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();
  });

  it('renders emoji shortcodes in a custom status (issue #252)', () => {
    render(<ActivityCard activities={[{ type: 'custom', name: 'on call :pager:' }]} />);
    expect(screen.getByText('on call 📟')).toBeInTheDocument();
  });

  it('renders emoji shortcodes in the fallback custom status', () => {
    render(<ActivityCard activities={[]} fallbackCustomStatus="on call :pager:" />);
    expect(screen.getByText('on call 📟')).toBeInTheDocument();
  });

  it('shows no time line without timestamps', () => {
    render(<ActivityCard activities={[{ type: 'playing', name: 'cs2' }]} />);
    expect(screen.getByText('cs2')).toBeInTheDocument();
    expect(screen.queryByText(/elapsed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
  });
});

describe('ActivityDetailCard', () => {
  it('renders the full activity with details, state, time and art', () => {
    const activity: Activity = {
      type: 'playing',
      name: 'osu!',
      details: 'Playing Freedom Dive',
      state: 'On the beatmap',
      timestamps: { start: Date.now() - 32 * 60 * 1000 },
      assets: {
        largeImage: 'https://cdn.example.com/osu.png',
        largeText: 'osu!',
        smallImage: 'https://cdn.example.com/mode.png',
        smallText: 'osu! mode',
      },
    };

    render(<ActivityDetailCard activities={[activity]} />);

    expect(screen.getByText('osu!')).toBeInTheDocument();
    expect(screen.getByText('Playing Freedom Dive')).toBeInTheDocument();
    expect(screen.getByText('On the beatmap')).toBeInTheDocument();
    expect(screen.getByText('32:00 elapsed')).toBeInTheDocument();
    const large = screen.getByAltText('osu!');
    expect(large).toHaveAttribute('src', 'https://cdn.example.com/osu.png');
    expect(large).toHaveAttribute('title', 'osu!');
    const badge = screen.getByAltText('osu! mode');
    expect(badge).toHaveAttribute('src', 'https://cdn.example.com/mode.png');
    expect(badge).toHaveAttribute('title', 'osu! mode');
  });

  it('falls back to details as the headline when the activity lost its name', () => {
    // An empty name leaves the details as the headline; the details are not
    // repeated on a second line (that line needs a name to sit under).
    const activity: Activity = {
      type: 'playing',
      name: '',
      details: 'backspace push test',
      state: 'Playing (RPC test)',
      timestamps: { start: Date.now() - 32 * 60 * 1000 },
    };

    render(<ActivityDetailCard activities={[activity]} />);

    expect(screen.getByText('backspace push test')).toBeInTheDocument();
    expect(screen.getByText('Playing (RPC test)')).toBeInTheDocument();
    expect(screen.getByText('32:00 elapsed')).toBeInTheDocument();
  });

  it('renders nothing without a displayable activity', () => {
    const { container } = render(<ActivityDetailCard activities={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a custom status activity', () => {
    const { container } = render(
      <ActivityDetailCard activities={[{ type: 'custom', name: 'on call' }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('hides each art image independently when it fails to load', () => {
    const activity: Activity = {
      type: 'playing',
      name: 'osu!',
      assets: {
        largeImage: 'https://cdn.example.com/broken.png',
        largeText: 'osu!',
        smallImage: 'https://cdn.example.com/rank.png',
        smallText: 'SS',
      },
    };

    render(<ActivityDetailCard activities={[activity]} />);

    fireEvent.error(screen.getByAltText('osu!'));
    expect(screen.queryByAltText('osu!')).not.toBeInTheDocument();
    // Only the broken image hides itself; the badge survives.
    expect(screen.getByAltText('SS')).toBeInTheDocument();
  });

  it('promotes the badge to the full-size image when the large image fails', () => {
    const activity: Activity = {
      type: 'playing',
      name: 'osu!',
      assets: {
        largeImage: 'https://cdn.example.com/broken.png',
        largeText: 'osu!',
        smallImage: 'https://cdn.example.com/rank.png',
        smallText: 'SS',
      },
    };

    render(<ActivityDetailCard activities={[activity]} />);

    expect(screen.getByAltText('SS').className).toContain('absolute');
    fireEvent.error(screen.getByAltText('osu!'));
    const promoted = screen.getByAltText('SS');
    expect(promoted.className).toContain('w-[60px]');
    expect(promoted.className).not.toContain('absolute');
  });

  it('leaves no empty frame behind when every image fails', () => {
    const activity: Activity = {
      type: 'playing',
      name: 'osu!',
      assets: {
        largeImage: 'https://cdn.example.com/broken.png',
        largeText: 'osu!',
        smallImage: 'https://cdn.example.com/rank2.png',
        smallText: 'SS',
      },
    };

    const { container } = render(<ActivityDetailCard activities={[activity]} />);

    expect(container.querySelector('.w-\\[60px\\]')).not.toBeNull();
    fireEvent.error(screen.getByAltText('osu!'));
    fireEvent.error(screen.getByAltText('SS'));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.w-\\[60px\\]')).toBeNull();
  });

  it('tries a new image after a different one failed', () => {
    const broken: Activity = { type: 'playing', name: 'osu!', assets: { largeImage: 'https://cdn.example.com/broken.png' } };
    const fixed: Activity = { type: 'playing', name: 'osu!', assets: { largeImage: 'https://cdn.example.com/fixed.png' } };

    const { rerender } = render(<ActivityDetailCard activities={[broken]} />);
    fireEvent.error(screen.getByAltText('osu!'));
    expect(screen.queryByAltText('osu!')).not.toBeInTheDocument();

    rerender(<ActivityDetailCard activities={[fixed]} />);
    expect(screen.getByAltText('osu!')).toHaveAttribute('src', 'https://cdn.example.com/fixed.png');
  });

  it('renders a small-only badge as the full-size image', () => {
    const activity: Activity = {
      type: 'playing',
      name: 'osu!',
      assets: { smallImage: 'https://cdn.example.com/rank.png', smallText: 'SS' },
    };

    render(<ActivityDetailCard activities={[activity]} />);

    expect(screen.getByText('osu!')).toBeInTheDocument();
    const img = screen.getByAltText('SS');
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/rank.png');
    expect(img.className).toContain('w-[60px]');
  });

  it('never renders non-http art URLs', () => {
    const activity: Activity = {
      type: 'playing',
      name: 'osu!',
      assets: { largeImage: 'data:image/png;base64,AAAA', smallImage: 'javascript:alert(1)' },
    };

    render(<ActivityDetailCard activities={[activity]} />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
