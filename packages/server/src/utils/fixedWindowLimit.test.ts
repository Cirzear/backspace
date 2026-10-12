import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixedWindowLimit } from './fixedWindowLimit.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('createFixedWindowLimit', () => {
  it('admits max events per key until the window ends', () => {
    const limit = createFixedWindowLimit({ max: 2, windowMs: 1000 });
    expect([limit.consume('a', 0), limit.consume('a', 10), limit.consume('a', 20)]).toEqual([true, true, false]);
    expect(limit.consume('b', 20)).toBe(true);
    expect(limit.consume('a', 1000)).toBe(true);
  });

  it('admits everything when rate limits are disabled', () => {
    vi.stubEnv('DISABLE_RATE_LIMITS', '1');
    const limit = createFixedWindowLimit({ max: 1, windowMs: 1000 });
    expect([limit.consume('a', 0), limit.consume('a', 1)]).toEqual([true, true]);
  });

  it('forgets every window on reset', () => {
    const limit = createFixedWindowLimit({ max: 1, windowMs: 1000 });
    limit.consume('a', 0);
    limit.reset();
    expect(limit.consume('a', 1)).toBe(true);
  });
});
