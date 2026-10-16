import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity } from '@backspace/shared';
import { setLanguage } from '../../i18n';
import { ActivityCard } from './ActivityCard';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
});

afterEach(async () => {
  await setLanguage('en');
  vi.useRealTimers();
});

describe('ActivityCard', () => {
  it('localizes the elapsed activity time', async () => {
    await setLanguage('ru');
    const activity: Activity = {
      type: 'playing',
      name: 'Escape from Tarkov',
      timestamps: { start: Date.now() - 32 * 60 * 1000 },
    };

    render(<ActivityCard activities={[activity]} />);

    const titleEl = screen.getByText('Escape from Tarkov');
    expect(titleEl).toBeInTheDocument();
    expect(titleEl).toHaveAttribute('title', 'Escape from Tarkov');
    expect(screen.getByText('Прошло 32 мин.')).toBeInTheDocument();
  });

  it('renders emoji shortcodes in a custom status (issue #252)', () => {
    render(<ActivityCard activities={[{ type: 'custom', name: 'on call :pager:' }]} />);
    const el = screen.getByText('on call 📟');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('title', 'on call 📟');
  });

  it('renders emoji shortcodes in the fallback custom status', () => {
    render(<ActivityCard activities={[]} fallbackCustomStatus="on call :pager:" />);
    const el = screen.getByText('on call 📟');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('title', 'on call 📟');
  });

  it('renders music status with song title and artist', () => {
    const musicActivity: Activity = {
      type: 'listening',
      name: '海阔天空',
      details: 'Beyond',
      assets: { smallText: '网易云音乐' },
    };

    render(<ActivityCard activities={[musicActivity]} />);
    expect(screen.getByText('海阔天空 · Beyond')).toBeInTheDocument();
    expect(screen.getByText('网易云音乐')).toBeInTheDocument();
  });

  it('renders dual status when user is gaming and listening to music', () => {
    const gameActivity: Activity = {
      type: 'playing',
      name: 'Cyberpunk 2077',
    };
    const musicActivity: Activity = {
      type: 'listening',
      name: 'Easy On Me',
      details: 'Adele',
    };

    render(<ActivityCard activities={[gameActivity, musicActivity]} />);
    expect(screen.getByText('Cyberpunk 2077')).toBeInTheDocument();
    expect(screen.getByText('Easy On Me · Adele')).toBeInTheDocument();
  });
});
