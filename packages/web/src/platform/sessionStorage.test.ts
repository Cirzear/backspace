import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  native: false,
  read: vi.fn<() => Promise<{ value: string | null }>>(),
  write: vi.fn<(options: { value: string }) => Promise<void>>(),
  clear: vi.fn<() => Promise<void>>(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => bridge.native },
  registerPlugin: () => bridge,
}));

const origin = 'https://home.example';
const otherOrigin = 'https://other.example';
const tokenKey = 'backspace_token';
const cacheKey = 'backspace_instances_user-1';
const load = () => import('./sessionStorage');

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  bridge.native = false;
  bridge.read.mockReset().mockResolvedValue({ value: null });
  bridge.write.mockReset().mockResolvedValue();
  bridge.clear.mockReset().mockResolvedValue();
  localStorage.clear();
});

describe('platform credential storage', () => {
  it('keeps web and Electron credentials in localStorage without the native plugin', async () => {
    const storage = await load();
    storage.setSessionItem(tokenKey, 'web-token');
    expect(storage.getSessionItem(tokenKey)).toBe('web-token');
    expect(localStorage.getItem(tokenKey)).toBe('web-token');
    await storage.initializeSessionStorage('');
    await storage.flushSessionStorage();
    storage.removeSessionItem(tokenKey);
    expect(storage.getSessionItem(tokenKey)).toBeNull();
    expect(bridge.read).not.toHaveBeenCalled();
    expect(bridge.write).not.toHaveBeenCalled();
  });

  it('restores native credentials without touching localStorage', async () => {
    bridge.native = true;
    bridge.read.mockResolvedValue({ value: JSON.stringify({ version: 1, origins: {
      [origin]: { [tokenKey]: 'native-token', [cacheKey]: '{"remote":{}}' },
    } }) });
    const storage = await load();
    expect(() => storage.getSessionItem(tokenKey)).toThrow('not been initialized');
    await storage.initializeSessionStorage(origin);
    expect(storage.getSessionItem(tokenKey)).toBe('native-token');
    expect(storage.getSessionItem(cacheKey)).toBe('{"remote":{}}');
    storage.setSessionItem(tokenKey, 'rotated');
    await storage.flushSessionStorage();
    expect(localStorage.length).toBe(0);
  });

  it('isolates origins and preserves other origins when removing the active token', async () => {
    bridge.native = true;
    const storage = await load();
    await storage.initializeSessionStorage(origin);
    storage.setSessionItem(tokenKey, 'home-token');
    await storage.initializeSessionStorage(otherOrigin);
    expect(storage.getSessionItem(tokenKey)).toBeNull();
    storage.setSessionItem(tokenKey, 'other-token');
    await storage.initializeSessionStorage(origin);
    expect(storage.getSessionItem(tokenKey)).toBe('home-token');
    storage.removeSessionItem(tokenKey);
    await storage.flushSessionStorage();
    expect(JSON.parse(bridge.write.mock.lastCall![0].value)).toEqual({
      version: 1, origins: { [otherOrigin]: { [tokenKey]: 'other-token' } },
    });
    expect(bridge.clear).not.toHaveBeenCalled();
  });

  it('serializes writes and clear behind pending native operations', async () => {
    bridge.native = true;
    let release!: () => void;
    bridge.write.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const storage = await load();
    await storage.initializeSessionStorage(origin);
    storage.setSessionItem(tokenKey, 'first');
    storage.setSessionItem(tokenKey, 'second');
    storage.removeSessionItem(tokenKey);
    await Promise.resolve();
    expect(bridge.write).toHaveBeenCalledTimes(1);
    expect(bridge.clear).not.toHaveBeenCalled();
    release();
    await storage.flushSessionStorage();
    expect(bridge.write.mock.calls.map(([entry]) => JSON.parse(entry.value).origins[origin][tokenKey])).toEqual(['first', 'second']);
    expect(bridge.clear).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
  });

  it('reports async failures once, rejects flush, and never retries or falls back', async () => {
    bridge.native = true;
    const error = new Error('Keystore locked');
    bridge.write.mockRejectedValue(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener('backspace:session-storage-error', listener);
    try {
      const storage = await load();
      await storage.initializeSessionStorage(origin);
      storage.setSessionItem(tokenKey, 'first');
      storage.setSessionItem(tokenKey, 'second');
      await expect(storage.flushSessionStorage()).rejects.toBe(error);
      expect(events).toEqual([error]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(bridge.write).toHaveBeenCalledTimes(1);
      expect(() => storage.getSessionItem(tokenKey)).toThrow(error);
      expect(() => storage.setSessionItem(tokenKey, 'third')).toThrow(error);
      expect(localStorage.length).toBe(0);
    } finally {
      window.removeEventListener('backspace:session-storage-error', listener);
    }
  });

  it.each(['invalid json', '{"version":2,"origins":{}}', '{"version":1,"origins":[]}',
    JSON.stringify({ version: 1, origins: { [origin]: { arbitrary: 'secret' } } }),
    JSON.stringify({ version: 1, origins: { [origin]: { [tokenKey]: 123 } } }),
    JSON.stringify({ version: 1, origins: { 'https://home.example/path': {} } }),
  ])('fails closed on corrupt persisted schema: %s', async (value) => {
    bridge.native = true;
    bridge.read.mockResolvedValue({ value });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = await load();
    await expect(storage.initializeSessionStorage(origin)).rejects.toThrow();
    expect(() => storage.setSessionItem(tokenKey, 'replacement')).toThrow();
    expect(bridge.write).not.toHaveBeenCalled();
    expect(bridge.clear).not.toHaveBeenCalled();
  });

  it('restricts the adapter to credential keys', async () => {
    const storage = await load();
    expect(() => storage.getSessionItem('backspace_mobile_origin')).toThrow('Unsupported');
    expect(() => storage.setSessionItem('backspace_instances_', 'value')).toThrow('Unsupported');
    storage.setSessionItem('backspace_instances', '{}');
    expect(storage.getSessionItem('backspace_instances')).toBe('{}');
  });
});
