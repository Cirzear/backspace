import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserActivityTracker } from './userActivityTracker.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UserActivityTracker activity rate limit', () => {
  it('allows clearing a published activity inside the normal update window', () => {
    const tracker = new UserActivityTracker();

    expect(tracker.checkActivityRateLimit('user')).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(tracker.checkActivityRateLimit('user')).toBe(false);
    expect(tracker.checkActivityRateLimit('user', true)).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(tracker.checkActivityRateLimit('user')).toBe(false);
  });
});

describe('UserActivityTracker media progress', () => {
  it('projects cached playback progress to the current time', () => {
    const tracker = new UserActivityTracker();
    tracker.setUserActivities('user', [{
      type: 'watching',
      name: 'Video',
      playback: { positionMs: 10_000, durationMs: 30_000 },
    }]);

    vi.advanceTimersByTime(5_000);

    expect(tracker.getUserActivities('user')).toEqual([{
      type: 'watching',
      name: 'Video',
      playback: { positionMs: 15_000, durationMs: 30_000 },
    }]);
  });
});
