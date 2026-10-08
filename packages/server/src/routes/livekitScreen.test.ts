import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { registerLivekitScreenRoutes } from './livekitScreen.js';
import { connectionManager } from '../ws/connectionManager.js';
import { stopNativeVoiceSessionsForUser } from '../ws/nativeVoiceSessions.js';
import { getOurOrigin } from '../utils/federationAuth.js';
import { PermissionBits } from '../utils/permissions.js';

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: FastifyInstance;
let authenticatedUser = 'owner';
const sfu = vi.hoisted(() => ({ getParticipant: vi.fn(), removeParticipant: vi.fn(), updateParticipant: vi.fn() }));
const peerAuth = vi.hoisted(() => ({ origin: 'https://remote.test' }));
const peerFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/federationFetch.js', () => ({ federationFetch: peerFetch }));
vi.mock('../db/index.js', () => ({ getDb: () => db, getRawDb: () => sqlite, schema }));
vi.mock('../utils/auth.js', () => ({ authenticate: async (request: { userId: string }) => { request.userId = authenticatedUser; } }));
vi.mock('./federation/handlers/s2sAuth.js', () => ({ authenticateS2SPeer: () => ({ ok: true, peer: { origin: peerAuth.origin } }) }));
vi.mock('livekit-server-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('livekit-server-sdk')>(),
  RoomServiceClient: class {
    getParticipant = sfu.getParticipant;
    removeParticipant = sfu.removeParticipant;
    updateParticipant = sfu.updateParticipant;
  },
}));
vi.mock('../config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { config: { ...actual.config, livekit: { url: 'wss://voice.test/livekit', apiKey: 'test-key', apiSecret: 'test-secret-at-least-32-characters' } } };
});

function user(id: string, home?: { id: string; origin: string }) {
  db.insert(schema.users).values({
    id, username: id, passwordHash: 'x', createdAt: 1,
    homeUserId: home?.id ?? null, homeInstance: home?.origin ?? null,
  }).run();
}
function spaceSession() {
  user('owner'); user('outsider');
  db.insert(schema.spaces).values({ id: 'space', name: 'Space', ownerId: 'owner', createdAt: 1 }).run();
  db.insert(schema.channels).values({ id: 'channel', spaceId: 'space', name: 'Voice', type: 'voice', createdAt: 1 }).run();
  connectionManager.createRoom('channel', 'space', { type: 'space', spaceId: 'space' });
  connectionManager.joinRoom('channel', 'owner');
}
async function token(payload: Record<string, unknown>, url = '/api/livekit/screen-token') {
  return app.inject({ method: 'POST', url, payload });
}
beforeEach(async () => {
  vi.clearAllMocks();
  sfu.getParticipant.mockResolvedValue({});
  sfu.removeParticipant.mockResolvedValue(undefined);
  sfu.updateParticipant.mockResolvedValue({});
  authenticatedUser = 'owner';
  peerAuth.origin = 'https://remote.test';
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema });
  const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(`${migrations}/${name}`, 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  app = Fastify();
  registerLivekitScreenRoutes(app);
});
afterEach(async () => {
  for (const id of ['owner', 'member', 'outsider', 'remote', 'collision']) await stopNativeVoiceSessionsForUser(id);
  connectionManager.clearFederatedCall('proxy-call');
  for (const id of ['channel', 'dm']) connectionManager.destroyRoom(id);
  await app.close();
  sqlite.close();
});

describe('native screen API authorization', () => {
  it('requires exactly one locator and a connected authenticated owner', async () => {
    spaceSession();
    expect((await token({ channelId: 'channel', dmChannelId: 'dm', ownerIdentity: 'owner:alice' })).statusCode).toBe(400);
    expect((await token({ channelId: 'channel', ownerIdentity: 'outsider:alice' })).statusCode).toBe(403);
    authenticatedUser = 'outsider';
    expect((await token({ channelId: 'channel', ownerIdentity: 'outsider:alice' })).statusCode).toBe(403);
  });
  it('returns a token pair and restricts stop to its issuer', async () => {
    spaceSession();
    const result = await token({ channelId: 'channel', ownerIdentity: 'owner:alice' });
    expect(result.statusCode).toBe(200);
    const body = result.json<{ identity: string; voiceIdentity: string; ownerIdentity: string; roomName: string }>();
    expect(body).toMatchObject({ ownerIdentity: 'owner:alice', roomName: 'channel' });
    authenticatedUser = 'outsider';
    expect((await app.inject({ method: 'POST', url: '/api/livekit/screen-stop', payload: { identity: body.identity } })).statusCode).toBe(403);
    authenticatedUser = 'owner';
    expect((await app.inject({ method: 'POST', url: '/api/livekit/screen-stop', payload: { identity: body.identity } })).statusCode).toBe(204);
    expect(sfu.removeParticipant).toHaveBeenCalledWith('channel', body.voiceIdentity);
    expect((await app.inject({ method: 'POST', url: '/api/livekit/screen-stop', payload: { identity: body.identity } })).statusCode).toBe(204);
  });
  it('requires both CONNECT and STREAM for an ordinary member', async () => {
    spaceSession();
    user('member');
    db.insert(schema.spaceMembers).values({ spaceId: 'space', userId: 'member', joinedAt: 1 }).run();
    db.insert(schema.roles).values({ id: 'space', spaceId: 'space', name: '@everyone', permissions: String(PermissionBits.CONNECT), position: 0, createdAt: 1 }).run();
    connectionManager.joinRoom('channel', 'member');
    authenticatedUser = 'member';
    expect((await token({ channelId: 'channel', ownerIdentity: 'member:member' })).statusCode).toBe(403);
  });
  it('accepts only the authenticated home pair for host-issued federated DM helpers', async () => {
    user('owner');
    user('remote', { id: 'same-home-id', origin: 'remote.test' });
    user('collision', { id: 'same-home-id', origin: 'evil.test' });
    db.insert(schema.dmChannels).values({ id: 'dm', federatedId: 'fed-call', createdAt: 1 }).run();
    db.insert(schema.dmMembers).values([{ dmChannelId: 'dm', userId: 'owner' }, { dmChannelId: 'dm', userId: 'remote' }]).run();
    connectionManager.createRoom('dm', 'dm', {
      type: 'dm', callerId: 'owner', state: 'active', group: false,
      declinedUserIds: new Set(), remoteParticipants: new Map(),
    });
    const payload = { federatedCallId: 'fed-call', ownerIdentity: 'same-home-id:remote', actor: { homeUserId: 'same-home-id', homeInstance: 'remote.test' } };
    const response = await token(payload, '/api/federation/livekit/screen-token');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ roomName: 'fed-call', ownerIdentity: 'same-home-id:remote' });
    expect(sfu.getParticipant).toHaveBeenCalledWith('fed-call', 'same-home-id:remote');
    peerAuth.origin = 'https://evil.test';
    expect((await token(payload, '/api/federation/livekit/screen-token')).statusCode).toBe(403);
    expect((await token({ ...payload, actor: { homeUserId: 'same-home-id', homeInstance: 'evil.test' } }, '/api/federation/livekit/screen-token')).statusCode).toBe(403);
    expect(getOurOrigin()).not.toBe('https://evil.test');
    db.insert(schema.dmMembers).values({ dmChannelId: 'dm', userId: 'collision' }).run();
    peerAuth.origin = 'https://remote.test';
    expect((await token(payload, '/api/federation/livekit/screen-token')).statusCode).toBe(403);
  });
  it('proxies remote-call tokens to the actual host and stops both helpers there', async () => {
    user('owner');
    db.insert(schema.federationPeers).values({ id: 'peer', origin: 'https://host.test', hmacSecret: 'shared-secret', status: 'active', createdAt: 1 }).run();
    connectionManager.createFederatedCall({
      dmChannelId: null, federatedId: 'proxy-call', callerId: 'remote', callerHomeUserId: 'remote',
      federatedCallHost: 'https://host.test', livekitUrl: 'wss://host.test/livekit',
      tokens: new Map([['owner', 'main-token']]), ringedUserIds: ['owner'], joinedUserIds: ['owner'], group: false, state: 'active', startedAt: 1,
    });
    const pair = {
      token: 'screen-token', voiceToken: 'voice-token', url: 'wss://host.test/livekit', roomName: 'proxy-call',
      identity: 'screen:12345678-1234-1234-1234-123456789012', voiceIdentity: 'native-voice:voice-id', ownerIdentity: 'owner:alice',
    };
    peerFetch.mockResolvedValueOnce(new Response(JSON.stringify(pair), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await token({ federatedCallId: 'proxy-call', ownerIdentity: 'owner:alice' });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(pair);
    expect(peerFetch).toHaveBeenCalledWith('https://host.test', '/api/federation/livekit/screen-token', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ federatedCallId: 'proxy-call', ownerIdentity: 'owner:alice', actor: { homeUserId: 'owner', homeInstance: getOurOrigin() } }),
    }), 'approved');
    expect(sfu.getParticipant).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/api/livekit/screen-stop', payload: { identity: pair.identity } })).statusCode).toBe(204);
    expect(peerFetch).toHaveBeenLastCalledWith('https://host.test', '/api/federation/livekit/screen-stop', expect.anything(), 'approved');
  });
});
