import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeMobileInstance } from './instanceProbe';

vi.mock('../i18n', () => ({ default: { t: (key: string) => key } }));
const info = {
  name: 'My instance', version: '1.7.0', instanceId: 'instance-id', sourceCodeUrl: 'https://example.com/source',
  registrationOpen: true, federatedRegistrationOpen: false, commit: null,
  directoryConfigured: false, directoryAvailable: false, directoryEnabled: false, supportCardEnabled: true,
};
afterEach(() => vi.unstubAllGlobals());

describe('mobile instance probe', () => {
  it('probes the validated HTTPS origin anonymously without redirects', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => info });
    vi.stubGlobal('fetch', fetch);
    expect(await probeMobileInstance(' https://EXAMPLE.com/ ')).toEqual({ origin: 'https://example.com', info });
    expect(fetch).toHaveBeenCalledWith('https://example.com/api/instance/info', {
      credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal),
    });
  });
  it.each(['http://example.com', 'example.com', 'https://user:pass@example.com', 'https://example.com/api'])('rejects unsafe origin %s before fetching', async origin => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(probeMobileInstance(origin)).rejects.toThrow('mobile:instance.invalidOrigin');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ...info, registrationOpen: 'true' }, { ...info, commit: 1 }])('rejects invalid response %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
    await expect(probeMobileInstance('https://example.com')).rejects.toThrow('mobile:instance.invalidResponse');
  });
  it('exposes HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(probeMobileInstance('https://example.com')).rejects.toThrow('mobile:instance.httpError');
  });
  it('does not bypass certificate errors or retry network failures', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    await expect(probeMobileInstance('https://example.com')).rejects.toThrow('Failed to fetch');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
