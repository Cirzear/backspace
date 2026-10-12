import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId, generateSnowflake } from '../utils/snowflake.js';
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  permissionsToString,
} from '@backspace/shared/src/permissions.js';

setWorkerId(4);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'member';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

const sendToUser = vi.fn();
const sendToChannel = vi.fn();
const sendToSpace = vi.fn();
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: (...args: unknown[]) => sendToUser(...args),
    sendToChannel: (...args: unknown[]) => sendToChannel(...args),
    sendToSpace: (...args: unknown[]) => sendToSpace(...args),
    sendToDmMembers: vi.fn(),
    sendToRoom: vi.fn(),
    sendToAdmins: vi.fn(),
    getUserRoom: () => undefined,
    getRoom: () => undefined,
    getAllRooms: () => new Map(),
    getAllOnlineUserIds: () => [],
  },
}));

// Embed resolution performs network work; the mass-mention rules are unrelated to it.
vi.mock('../utils/embedResolver.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/embedResolver.js')>();
  return {
    ...actual,
    resolveEmbeds: vi.fn(async () => {}),
    reResolveEmbeds: vi.fn(async () => {}),
  };
});


let app: FastifyInstance;
const SPACE = 'space';
const CHANNEL = 'channel';
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of fs.readFileSync(path.join(dir, file), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (sql.trim()) sqlite.exec(sql);
    }
  }
  testDb = drizzle(sqlite, { schema });
  for (const id of ['owner', 'member']) testDb.insert(schema.users).values({ id, username: id, passwordHash: 'test', createdAt: NOW }).run();
  testDb.insert(schema.spaces).values({ id: SPACE, name: SPACE, ownerId: 'owner', createdAt: NOW }).run();
  testDb.insert(schema.roles).values({ id: SPACE, spaceId: SPACE, name: '@everyone', permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS), createdAt: NOW }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE, userId: 'member', joinedAt: NOW }).run();
  testDb.insert(schema.channels).values({ id: CHANNEL, spaceId: SPACE, name: CHANNEL, type: 'text', createdAt: NOW }).run();
  currentUserId = 'member';
  sendToUser.mockClear(); sendToChannel.mockClear(); sendToSpace.mockClear();
  app = Fastify();
  const { messageRoutes } = await import('./messages.js');
  const { searchRoutes } = await import('./search.js');
  await app.register(messageRoutes);
  await app.register(searchRoutes);
  await app.ready();
});
afterEach(async () => { await app.close(); sqlite.close(); });

function seed(type: 'user' | 'system', content: string): string {
  const id = generateSnowflake();
  testDb.insert(schema.messages).values({ id, channelId: CHANNEL, userId: 'member', type, content, createdAt: NOW }).run();
  return id;
}

const POKE = JSON.stringify({ event: 'channel_poke', targetUserId: 'owner', targetDisplayName: 'owner' });

describe('channel system messages are not what members wrote', () => {
  it('leaves them out of search and its count', async () => {
    seed('system', POKE);
    const written = seed('user', 'a poke would be nice');
    for (const q of ['poke', 'owner', 'event']) {
      const res = await app.inject({ method: 'GET', url: '/api/channels/' + CHANNEL + '/search?q=' + q });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { results: Array<{ id: string }>; totalCount: number };
      expect(body.results.map(m => m.id)).toEqual(q === 'poke' ? [written] : []);
      expect(body.totalCount).toBe(q === 'poke' ? 1 : 0);
    }
  });

  it('refuses a reply to one over REST and WebSocket', async () => {
    const poke = seed('system', POKE);
    const res = await app.inject({ method: 'POST', url: '/api/channels/' + CHANNEL + '/messages', payload: { content: 'hi', replyToId: poke } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'reply_target_invalid' });
    const { handleClientEvent } = await import('../ws/events.js');
    handleClientEvent({ type: 'message_create', channelId: CHANNEL, content: 'hi', replyToId: poke }, 'member', 'member', {} as never, false);
    expect(testDb.select().from(schema.messages).all()).toHaveLength(1);
  });

  it('still takes a reply to a message a member wrote', async () => {
    const written = seed('user', 'hello');
    const res = await app.inject({ method: 'POST', url: '/api/channels/' + CHANNEL + '/messages', payload: { content: 'hi', replyToId: written } });
    expect(res.statusCode).toBe(201);
  });

  it('refuses an edit, by its author too, with system_message_immutable over REST and WebSocket', async () => {
    const poke = seed('system', POKE);
    const res = await app.inject({ method: 'PATCH', url: '/api/messages/' + poke, payload: { content: 'rewritten' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'system_message_immutable' });
    const { handleClientEvent } = await import('../ws/events.js');
    handleClientEvent({ type: 'message_edit', messageId: poke, content: 'rewritten' }, 'member', 'member', {} as never, false);
    expect(sendToUser).toHaveBeenCalledWith('member', expect.objectContaining({ type: 'error', code: 'system_message_immutable' }));
    expect(testDb.select().from(schema.messages).get()?.content).toBe(POKE);
  });
});
