import { describe, it, expect } from 'vitest';
import { detachedHomeOf, isChosenUserStatus, ownsChosenStatus } from '@backspace/shared';
import { statusOnConnect } from './presenceStatus.js';

describe('isChosenUserStatus', () => {
  it.each(['online', 'idle', 'dnd'])('accepts %s', (value) => {
    expect(isChosenUserStatus(value)).toBe(true);
  });

  it.each(['offline', '', 'DND', null, undefined, 3])('rejects %s', (value) => {
    expect(isChosenUserStatus(value)).toBe(false);
  });
});

describe('ownsChosenStatus', () => {
  it('is true for a native row and for a detached one', () => {
    expect(ownsChosenStatus({ homeInstance: null, federationHomeOrphaned: 0 })).toBe(true);
    expect(ownsChosenStatus({ homeInstance: 'reset.example', federationHomeOrphaned: 1 })).toBe(true);
    expect(ownsChosenStatus({ homeInstance: 'reset.example', federationHomeOrphaned: true })).toBe(true);
  });

  it('is false for a replicated row', () => {
    expect(ownsChosenStatus({ homeInstance: 'home.example', federationHomeOrphaned: 0 })).toBe(false);
    expect(ownsChosenStatus({ homeInstance: 'home.example', federationHomeOrphaned: null })).toBe(false);
    expect(ownsChosenStatus({ homeInstance: 'home.example', federationHomeOrphaned: false })).toBe(false);
  });
});

describe('detachedHomeOf', () => {
  it('names the former home of a detached account homed here (#310 shape)', () => {
    expect(detachedHomeOf({ homeInstance: null, detachedHomeInstance: 'reset.example', federationHomeOrphaned: true })).toBe('reset.example');
    expect(detachedHomeOf({ homeInstance: null, detachedHomeInstance: 'reset.example', federationHomeOrphaned: 1 })).toBe('reset.example');
  });

  it('falls back to homeInstance for a row served by an instance that predates #310', () => {
    expect(detachedHomeOf({ homeInstance: 'reset.example', federationHomeOrphaned: true })).toBe('reset.example');
  });

  it('is null for an account that is not detached', () => {
    expect(detachedHomeOf({ homeInstance: null, federationHomeOrphaned: false })).toBeNull();
    expect(detachedHomeOf({ homeInstance: 'home.example', federationHomeOrphaned: 0 })).toBeNull();
    expect(detachedHomeOf({ homeInstance: null, detachedHomeInstance: 'reset.example', federationHomeOrphaned: 0 })).toBeNull();
  });

  it('ownsChosenStatus holds for the #310 shape by homeInstance alone', () => {
    expect(ownsChosenStatus({ homeInstance: null, federationHomeOrphaned: true })).toBe(true);
  });
});

describe('statusOnConnect', () => {
  const native = { homeInstance: null, federationHomeOrphaned: 0 };
  const detached = { homeInstance: 'reset.example', federationHomeOrphaned: 1 };
  const replicated = { homeInstance: 'home.example', federationHomeOrphaned: 0 };

  it('publishes the chosen status of a native user, whatever the live column says', () => {
    expect(statusOnConnect({ ...native, chosenStatus: 'dnd', status: 'offline' })).toBe('dnd');
    expect(statusOnConnect({ ...native, chosenStatus: 'idle', status: 'online' })).toBe('idle');
    expect(statusOnConnect({ ...native, chosenStatus: 'online', status: 'dnd' })).toBe('online');
  });

  it('publishes the chosen status of a detached account, which owns its choice', () => {
    expect(statusOnConnect({ ...detached, chosenStatus: 'dnd', status: 'offline' })).toBe('dnd');
    expect(statusOnConnect({ ...detached, chosenStatus: 'online', status: 'dnd' })).toBe('online');
  });

  it('falls back to online for an owning row holding an unknown chosen value', () => {
    expect(statusOnConnect({ ...native, chosenStatus: 'offline', status: 'offline' })).toBe('online');
  });

  it("keeps the home instance's projection for a replicated row and ignores its local chosen copy", () => {
    expect(statusOnConnect({ ...replicated, chosenStatus: 'idle', status: 'dnd' })).toBe('dnd');
    expect(statusOnConnect({ ...replicated, chosenStatus: 'dnd', status: 'online' })).toBe('online');
  });

  it('falls back to online for a replicated row with no live projection', () => {
    expect(statusOnConnect({ ...replicated, chosenStatus: 'dnd', status: 'offline' })).toBe('online');
    expect(statusOnConnect({ ...replicated, chosenStatus: 'dnd', status: null })).toBe('online');
  });
});
