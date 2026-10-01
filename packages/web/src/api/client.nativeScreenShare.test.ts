import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackspaceApiClient } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('native screen sharing HTTP transport', () => {
  it('accepts the screen-stop 204 response without attempting JSON decoding', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const client = new BackspaceApiClient('https://relay.test/api', () => 'relay-jwt');
    await expect(client.livekit.screenStop('screen:random')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('https://relay.test/api/livekit/screen-stop', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ identity: 'screen:random' }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer relay-jwt' },
    }));
  });
});
