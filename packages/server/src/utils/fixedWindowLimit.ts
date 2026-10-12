/**
 * A fixed-window counter for limits on WebSocket events, which the HTTP rate
 * limiter (`@fastify/rate-limit`) does not see: a window starts at a key's
 * first event and admits `max` events until `windowMs` has passed. It counts
 * the way the plugin's in-memory store does. `DISABLE_RATE_LIMITS=1` (or
 * `true`) turns it off, as it turns off the plugin (api.md, "Rate limiting").
 *
 * Windows live in memory and go away when they end, swept at most once per
 * window length.
 */
export interface FixedWindowLimit {
  /** Count one event for `key`. True when it is within the limit, false when it is refused. */
  consume(key: string, now?: number): boolean;
  /** Tests only: forget every window. */
  reset(): void;
}

function rateLimitsDisabled(): boolean {
  const value = process.env.DISABLE_RATE_LIMITS;
  return value === '1' || value === 'true';
}

export function createFixedWindowLimit(limit: { readonly max: number; readonly windowMs: number }): FixedWindowLimit {
  const windows: Map<string, { count: number; startedAt: number }> = new Map();
  let lastSweepAt = 0;

  function sweep(now: number): void {
    if (now - lastSweepAt < limit.windowMs) return;
    lastSweepAt = now;
    for (const [key, window] of windows) {
      if (now - window.startedAt >= limit.windowMs) windows.delete(key);
    }
  }

  return {
    consume(key: string, now: number = Date.now()): boolean {
      if (rateLimitsDisabled()) return true;
      sweep(now);
      const window = windows.get(key);
      if (!window || now - window.startedAt >= limit.windowMs) {
        windows.set(key, { count: 1, startedAt: now });
        return true;
      }
      window.count += 1;
      return window.count <= limit.max;
    },
    reset(): void {
      windows.clear();
      lastSweepAt = 0;
    },
  };
}
