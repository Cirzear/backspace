import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { RoomServiceClient } from 'livekit-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativePublisher, type NativePublisherOwner } from './nativeVoicePublisher.js';
import { getNativeVoiceSession, stopNativeVoiceSession } from '../ws/nativeVoiceSessions.js';

// Keep the real SDK, including its URL construction and HTTP transport, in this suite.
const { RoomServiceClient: CommonJsRoomServiceClient } = createRequire(import.meta.url)(
  'livekit-server-sdk',
) as typeof import('livekit-server-sdk');
const livekit = vi.hoisted(() => ({
  url: '', apiKey: 'test-key', apiSecret: 'test-secret-at-least-32-characters-long',
}));
vi.mock('../config.js', () => ({ config: { livekit } }));

type RecordedRequest = { url: string; method: string; body: Record<string, unknown>; authorization: string };
let server: Server;
let origin: string;
let requests: RecordedRequest[];
const identities = new Set<string>();
const permissions = { canStream: true, canSpeak: true, canSubscribe: true };
const owner: NativePublisherOwner = {
  userId: 'native-owner', roomId: 'channel', roomName: 'channel', ownerIdentity: 'native-owner:alice',
  isCurrent: () => true, permissions: () => permissions,
};

beforeEach(async () => {
  requests = [];
  Object.assign(permissions, { canStream: true, canSpeak: true, canSubscribe: true });
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      requests.push({
        url: request.url!, method: request.method!,
        body: JSON.parse(body) as Record<string, unknown>,
        authorization: request.headers.authorization!,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  try {
    await Promise.all(Array.from(identities, identity => stopNativeVoiceSession(identity)));
  } finally {
    identities.clear();
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

describe.each([
  ['ESM', RoomServiceClient],
  ['CommonJS', CommonJsRoomServiceClient],
] as const)('RoomServiceClient %s URL paths', (_format, Client) => {
  it.each(['', '/', '/livekit', '/livekit/'])('preserves base pathname %j for every participant operation', async basePath => {
    const client = new Client(`${origin}${basePath}`, livekit.apiKey, livekit.apiSecret);
    await client.getParticipant('channel', owner.ownerIdentity);
    await client.removeParticipant('channel', owner.ownerIdentity);
    await client.updateParticipant('channel', owner.ownerIdentity, { permission: { canPublish: true } });

    const prefix = basePath.replace(/\/$/, '');
    expect(requests.map(request => request.url)).toEqual([
      `${prefix}/twirp/livekit.RoomService/GetParticipant`,
      `${prefix}/twirp/livekit.RoomService/RemoveParticipant`,
      `${prefix}/twirp/livekit.RoomService/UpdateParticipant`,
    ]);
    for (const request of requests) {
      expect(request.method).toBe('POST');
      expect(request.body).toMatchObject({ room: 'channel', identity: owner.ownerIdentity });
      expect(request.authorization).toMatch(/^Bearer /);
    }
    expect(requests[2]!.body.permission).toMatchObject({ canPublish: true });
  });
});

describe('native publisher RoomService transport', () => {
  it.each(['http', 'ws'])('uses the configured /livekit path through the real SDK for %s', async protocol => {
    livekit.url = `${origin.replace(/^http/, protocol)}/livekit/`;
    const result = await createNativePublisher(owner);
    identities.add(result.identity);
    permissions.canSpeak = false;
    await getNativeVoiceSession(result.identity)!.syncPermissions();
    await stopNativeVoiceSession(result.identity);

    expect(requests.map(request => request.url)).toEqual([
      '/livekit/twirp/livekit.RoomService/GetParticipant',
      '/livekit/twirp/livekit.RoomService/UpdateParticipant',
      '/livekit/twirp/livekit.RoomService/RemoveParticipant',
      '/livekit/twirp/livekit.RoomService/RemoveParticipant',
    ]);
    // Proto3 JSON omits false defaults; the original unit suite checks the full grant.
    expect(requests[1]!.body).toMatchObject({ identity: result.voiceIdentity, permission: { canSubscribe: true } });
    expect(requests.slice(2).map(request => request.body.identity).sort()).toEqual([
      result.identity, result.voiceIdentity,
    ].sort());
    expect(result.url).toBe(livekit.url);
  });

  it.each(['https', 'wss'])('never downgrades %s for owner checks, permission updates or cleanup', async protocol => {
    // Only intercept the actual fetch boundary: token signing and SDK RPC remain real.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);
    livekit.url = `${protocol}://voice.test:8443/livekit/`;
    const result = await createNativePublisher(owner);
    identities.add(result.identity);
    await getNativeVoiceSession(result.identity)!.syncPermissions();
    await stopNativeVoiceSession(result.identity);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://voice.test:8443/livekit/twirp/livekit.RoomService/GetParticipant',
      'https://voice.test:8443/livekit/twirp/livekit.RoomService/UpdateParticipant',
      'https://voice.test:8443/livekit/twirp/livekit.RoomService/RemoveParticipant',
      'https://voice.test:8443/livekit/twirp/livekit.RoomService/RemoveParticipant',
    ]);
  });

  it('surfaces a failed HTTPS request without retrying over HTTP or another URL', async () => {
    const failure = new Error('TLS request failed');
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(failure);
    vi.stubGlobal('fetch', fetchMock);
    livekit.url = 'https://voice.test/livekit';
    await expect(createNativePublisher(owner)).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://voice.test/livekit/twirp/livekit.RoomService/GetParticipant');
  });
});
