import { beforeEach, describe, expect, it } from 'vitest';
import {
  GAME_OVERRIDES_KEY,
  MAX_GAME_RENAMES,
  loadOverrides,
  sanitizeGameName,
  setRename,
  withManualGame,
  withRenames,
} from './gameOverrides';
import type { Activity } from '@backspace/shared';

beforeEach(() => localStorage.clear());

describe('sanitizeGameName', () => {
  it('collapses whitespace, drops control characters and caps the length', () => {
    expect(sanitizeGameName('  Half \t Life\n2 ')).toBe('Half Life 2');
    expect(sanitizeGameName('a\u0000b')).toBe('a b');
    expect(sanitizeGameName('x'.repeat(500))).toHaveLength(128);
  });

  it('is null for nothing', () => {
    expect(sanitizeGameName('   \n')).toBeNull();
  });
});

describe('loadOverrides', () => {
  it('survives junk in storage', () => {
    localStorage.setItem(GAME_OVERRIDES_KEY, 'not json');
    expect(loadOverrides()).toEqual({ manual: null, manualProcess: null, renames: {} });
    localStorage.setItem(GAME_OVERRIDES_KEY, JSON.stringify({ manual: 5, renames: { a: 7, b: 'Ok', '': 'x' } }));
    expect(loadOverrides()).toEqual({ manual: null, manualProcess: null, renames: { b: 'Ok' } });
  });

  it('keeps the program of a manual game, and drops a program without a game', () => {
    localStorage.setItem(GAME_OVERRIDES_KEY, JSON.stringify({ manual: 'Hades', manualProcess: ' Hades.exe ', renames: {} }));
    expect(loadOverrides()).toMatchObject({ manual: 'Hades', manualProcess: 'Hades.exe' });
    localStorage.setItem(GAME_OVERRIDES_KEY, JSON.stringify({ manualProcess: 'Hades.exe', renames: {} }));
    expect(loadOverrides().manualProcess).toBeNull();
    localStorage.setItem(GAME_OVERRIDES_KEY, JSON.stringify({ manual: 'Hades', manualProcess: 7 }));
    expect(loadOverrides().manualProcess).toBeNull();
  });
});

describe('withManualGame / withRenames', () => {
  const list: Activity[] = [{ type: 'playing', name: 'A' }, { type: 'listening', name: 'M' }];

  it('returns the very same list when there is nothing to apply', () => {
    expect(withManualGame(list, null)).toBe(list);
    expect(withRenames(list, {})).toBe(list);
    expect(withRenames(list, { zzz: 'Q' })).toBe(list);
  });

  it('stays within the activity limit', () => {
    const many: Activity[] = Array.from({ length: 5 }, (_, i) => ({ type: 'listening', name: `m${i}` }));
    expect(withManualGame(many, 'G')).toHaveLength(5);
  });
});

describe('setRename', () => {
  it('drops the oldest past the cap', () => {
    let renames: Record<string, string> = {};
    for (let i = 0; i < MAX_GAME_RENAMES + 3; i++) renames = setRename(renames, `game${i}`, `Name ${i}`);
    expect(Object.keys(renames)).toHaveLength(MAX_GAME_RENAMES);
    expect(renames['game0']).toBeUndefined();
    expect(renames[`game${MAX_GAME_RENAMES + 2}`]).toBe(`Name ${MAX_GAME_RENAMES + 2}`);
  });

  it('removes the entry for a blank or unchanged name', () => {
    expect(setRename({ a: 'B' }, 'A', '  ')).toEqual({});
    expect(setRename({ a: 'B' }, 'A', 'A')).toEqual({});
  });
});
