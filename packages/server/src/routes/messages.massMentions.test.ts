import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId, generateSnowflake } from '../utils/snowflake.js';
import {
  PermissionBits,
  DEFAULT_EVERYONE_PERMISSIONS,
  permissionsToString,
} from '@backspace/shared/src/permissions.js';

setWorkerId(2);

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
  await app.register(messageRoutes);
  await app.ready();
});
afterEach(async () => { await app.close(); sqlite.close(); });

function grantMassMentions(): void {
  testDb.update(schema.roles).set({ permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS | PermissionBits.MENTION_EVERYONE) }).where(eq(schema.roles.id, SPACE)).run();
}
function seedMessage(content = 'before'): string {
  const id = generateSnowflake();
  testDb.insert(schema.messages).values({ id, channelId: CHANNEL, userId: 'member', content, createdAt: NOW }).run();
  return id;
}
async function ws(event: Record<string, unknown>): Promise<void> {
  const { handleClientEvent } = await import('../ws/events.js');
  handleClientEvent(event, 'member', 'member', {} as never, false);
}

describe('mass mention authorization across transports and edits', () => {
  it.each(['@everyone', '@here', '<@&role>'])('refuses REST creation of %s without the bit', async content => {
    const res = await app.inject({ method: 'POST', url: '/api/channels/' + CHANNEL + '/messages', payload: { content } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'missing_permission' });
    expect(testDb.select().from(schema.messages).all()).toEqual([]);
  });
  it.each(['@everyone', '@here', '<@&role>'])('refuses WS creation of %s without the bit', async content => {
    await ws({ type: 'message_create', channelId: CHANNEL, content });
    expect(testDb.select().from(schema.messages).all()).toEqual([]);
    expect(sendToUser).toHaveBeenCalledWith('member', expect.objectContaining({
      type: 'error', code: 'missing_permission', details: { permission: 'MENTION_EVERYONE' }, message: expect.stringContaining('MENTION_EVERYONE'),
    }));
  });
  it('cannot acquire a mass mention by editing over REST or WS', async () => {
    const id = seedMessage();
    const res = await app.inject({ method: 'PATCH', url: '/api/messages/' + id, payload: { content: '@everyone' } });
    expect(res.statusCode).toBe(403);
    await ws({ type: 'message_edit', messageId: id, content: '<@&role>' });
    expect(testDb.select().from(schema.messages).get()?.content).toBe('before');
  });
  it('lets an edit keep the mass mentions a message already has without the bit', async () => {
    const id = seedMessage('@everyone <@&role> meeting at 5');
    const res = await app.inject({ method: 'PATCH', url: '/api/messages/' + id, payload: { content: '@everyone <@&role> meeting at 6' } });
    expect(res.statusCode).toBe(200);
    await ws({ type: 'message_edit', messageId: id, content: '@here <@&role> meeting at 7' });
    expect(testDb.select().from(schema.messages).get()?.content).toBe('@here <@&role> meeting at 7');
    const added = await app.inject({ method: 'PATCH', url: '/api/messages/' + id, payload: { content: '@here <@&role> <@&other> meeting at 7' } });
    expect(added.statusCode).toBe(403);
  });
  it('stamps the stored mass mentions on created, broadcast and edited messages', async () => {
    grantMassMentions();
    const created = await app.inject({ method: 'POST', url: '/api/channels/' + CHANNEL + '/messages', payload: { content: '@here <@&role> \x60<@&code>\x60' } });
    expect(created.json()).toMatchObject({ mentionEveryone: true, mentionRoleIds: ['role'] });
    expect(sendToChannel).toHaveBeenCalledWith(SPACE, CHANNEL, expect.objectContaining({
      type: 'message_created', message: expect.objectContaining({ mentionEveryone: true, mentionRoleIds: ['role'] }),
    }));
    const edited = await app.inject({ method: 'PATCH', url: '/api/messages/' + created.json().id, payload: { content: 'plain' } });
    expect(edited.json()).toMatchObject({ mentionEveryone: false, mentionRoleIds: [] });
    sendToChannel.mockClear();
    await ws({ type: 'message_create', channelId: CHANNEL, content: '@everyone' });
    expect(sendToChannel).toHaveBeenCalledWith(SPACE, CHANNEL, expect.objectContaining({
      type: 'message_created', message: expect.objectContaining({ mentionEveryone: true, mentionRoleIds: [] }),
    }));
    const history = await app.inject({ method: 'GET', url: '/api/channels/' + CHANNEL + '/messages' });
    expect(history.json().map((m: { mentionEveryone: boolean }) => m.mentionEveryone).sort()).toEqual([false, true]);
  });
  it.each(['hello <@member>', '\x60@everyone\x60', '\x60\x60\x60<@&role>\x60\x60\x60', 'email@everyone', '@everyone-else'])('allows non-mass content %s', async content => {
    const res = await app.inject({ method: 'POST', url: '/api/channels/' + CHANNEL + '/messages', payload: { content } });
    expect(res.statusCode).toBe(201);
  });
  it('allows all four paths with the permission', async () => {
    grantMassMentions();
    const created = await app.inject({ method: 'POST', url: '/api/channels/' + CHANNEL + '/messages', payload: { content: '@everyone' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await app.inject({ method: 'PATCH', url: '/api/messages/' + id, payload: { content: '@here' } })).statusCode).toBe(200);
    await ws({ type: 'message_edit', messageId: id, content: '<@&role>' });
    expect(testDb.select().from(schema.messages).where(eq(schema.messages.id, id)).get()?.content).toBe('<@&role>');
    await ws({ type: 'message_create', channelId: CHANNEL, content: '@everyone' });
    expect(testDb.select().from(schema.messages).all()).toHaveLength(2);
  });
  it('respects channel-level denial even if the space grants the bit', async () => {
    grantMassMentions();
    testDb.insert(schema.channelOverrides).values({ channelId: CHANNEL, targetType: 'role', targetId: SPACE, allow: '0', deny: permissionsToString(PermissionBits.MENTION_EVERYONE) }).run();
    const res = await app.inject({ method: 'POST', url: '/api/channels/' + CHANNEL + '/messages', payload: { content: '@everyone' } });
    expect(res.statusCode).toBe(403);
    await ws({ type: 'message_create', channelId: CHANNEL, content: '@everyone' });
    expect(testDb.select().from(schema.messages).all()).toEqual([]);
  });
});

describe('system messages carry no mass mention stamps', () => {
  it('reads a system row whose recorded name is a mass mention as plain text', async () => {
    const id = generateSnowflake();
    testDb.insert(schema.messages).values({
      id, channelId: CHANNEL, userId: 'member', type: 'system', createdAt: NOW,
      content: JSON.stringify({ event: 'channel_poke', targetUserId: 'owner', targetDisplayName: '@everyone <@&role>' }),
    }).run();
    const history = await app.inject({ method: 'GET', url: '/api/channels/' + CHANNEL + '/messages' });
    expect(history.json()).toEqual([expect.objectContaining({ id, type: 'system', mentionEveryone: false, mentionRoleIds: [] })]);
  });
});
