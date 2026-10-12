import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { parseChannelSystemEvent } from '@backspace/shared/src/channelSystemEvents.js';
import { DEFAULT_EVERYONE_PERMISSIONS, PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';

setWorkerId(3);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

const sendToChannel = vi.fn();
const sendToWs = vi.fn();
const sendToUser = vi.fn();
vi.mock('./handler.js', () => ({
  connectionManager: {
    sendToChannel: (...args: unknown[]) => sendToChannel(...args),
    sendToWs: (...args: unknown[]) => sendToWs(...args),
    sendToUser: (...args: unknown[]) => sendToUser(...args),
  },
}));

const { handleChannelPoke, _resetChannelPokeLimit, CHANNEL_POKE_RATE_LIMIT } = await import('./channelPoke.js');

const SPACE = 'space';
const CHANNEL = 'chat';
const NOW = 1_800_000_000_000;
const socket = {} as WebSocket;

function poke(event: Record<string, unknown>, userId = 'actor'): void {
  handleChannelPoke({ event, userId, ws: socket });
}

function refusals(): unknown[] {
  return sendToWs.mock.calls.map(call => call[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetChannelPokeLimit();
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of fs.readFileSync(path.join(dir, file), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (sql.trim()) sqlite.exec(sql);
    }
  }
  testDb = drizzle(sqlite, { schema });
  testDb.insert(schema.users).values([
    { id: 'owner', username: 'owner', passwordHash: 'test-only', createdAt: NOW },
    { id: 'actor', username: 'actor', passwordHash: 'test-only', displayName: 'Actor', createdAt: NOW },
    { id: 'target', username: 'target@peer.example', passwordHash: 'test-only', createdAt: NOW },
    { id: 'outsider', username: 'outsider', passwordHash: 'test-only', createdAt: NOW },
    { id: 'admin', username: 'admin', passwordHash: 'test-only', isAdmin: 1, createdAt: NOW },
  ]).run();
  testDb.insert(schema.spaces).values({ id: SPACE, name: SPACE, ownerId: 'owner', createdAt: NOW }).run();
  testDb.insert(schema.roles).values({ id: SPACE, spaceId: SPACE, name: '@everyone', permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS), createdAt: NOW }).run();
  testDb.insert(schema.spaceMembers).values([
    { spaceId: SPACE, userId: 'owner', joinedAt: NOW },
    { spaceId: SPACE, userId: 'actor', joinedAt: NOW },
    { spaceId: SPACE, userId: 'target', joinedAt: NOW },
  ]).run();
  testDb.insert(schema.channels).values({ id: CHANNEL, spaceId: SPACE, name: CHANNEL, type: 'text', createdAt: NOW }).run();
});

afterEach(() => { sqlite.close(); });

describe('channel poke refusals', () => {
  it('refuses a malformed event with validation_failed', () => {
    poke({ channelId: 123, targetUserId: {} });
    expect(refusals()).toEqual([expect.objectContaining({ type: 'error', code: 'validation_failed' })]);
  });

  it('answers a channel the actor cannot see as channel_not_found', () => {
    poke({ channelId: 'missing', targetUserId: 'target' });
    poke({ channelId: CHANNEL, targetUserId: 'target' }, 'outsider');
    expect(refusals()).toEqual([
      expect.objectContaining({ code: 'channel_not_found' }),
      expect.objectContaining({ code: 'channel_not_found' }),
    ]);
  });

  it('needs SEND_MESSAGES in the channel', () => {
    testDb.insert(schema.channelOverrides).values({ channelId: CHANNEL, targetType: 'role', targetId: SPACE, allow: '0', deny: permissionsToString(PermissionBits.SEND_MESSAGES) }).run();
    poke({ channelId: CHANNEL, targetUserId: 'target' });
    expect(refusals()).toEqual([expect.objectContaining({ code: 'missing_permission', details: { permission: 'SEND_MESSAGES' } })]);
  });

  it('refuses a target who is not a member, an instance admin included', () => {
    poke({ channelId: CHANNEL, targetUserId: 'outsider' });
    poke({ channelId: CHANNEL, targetUserId: 'admin' });
    poke({ channelId: CHANNEL, targetUserId: 'nobody' });
    expect(refusals()).toEqual([
      expect.objectContaining({ code: 'member_not_found' }),
      expect.objectContaining({ code: 'member_not_found' }),
      expect.objectContaining({ code: 'member_not_found' }),
    ]);
  });

  it('refuses a target who cannot see the channel', () => {
    testDb.insert(schema.channelOverrides).values({ channelId: CHANNEL, targetType: 'member', targetId: 'target', allow: '0', deny: permissionsToString(PermissionBits.VIEW_CHANNEL) }).run();
    poke({ channelId: CHANNEL, targetUserId: 'target' });
    expect(refusals()).toEqual([expect.objectContaining({ code: 'poke_target_no_access' })]);
  });

  it('stores and sends nothing when it refuses', () => {
    poke({ channelId: CHANNEL, targetUserId: 'outsider' });
    expect(testDb.select().from(schema.messages).all()).toEqual([]);
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(sendToUser).not.toHaveBeenCalled();
  });
});

describe('the poke rate limit', () => {
  it('refuses the poke after the limit with rate_limited, without storing it', () => {
    for (let i = 0; i < CHANNEL_POKE_RATE_LIMIT.max; i++) poke({ channelId: CHANNEL, targetUserId: 'target' });
    expect(refusals()).toEqual([]);
    poke({ channelId: CHANNEL, targetUserId: 'owner' });
    expect(refusals()).toEqual([expect.objectContaining({ code: 'rate_limited' })]);
    expect(testDb.select().from(schema.messages).all()).toHaveLength(CHANNEL_POKE_RATE_LIMIT.max);
  });

  it('counts each actor on their own and does not count refused pokes', () => {
    for (let i = 0; i < CHANNEL_POKE_RATE_LIMIT.max; i++) poke({ channelId: CHANNEL, targetUserId: 'outsider' });
    for (let i = 0; i < CHANNEL_POKE_RATE_LIMIT.max; i++) poke({ channelId: CHANNEL, targetUserId: 'target' });
    poke({ channelId: CHANNEL, targetUserId: 'actor' }, 'target');
    expect(testDb.select().from(schema.messages).all()).toHaveLength(CHANNEL_POKE_RATE_LIMIT.max + 1);
  });
});

describe('a channel poke', () => {
  it('is stored as a system message before it is sent', () => {
    sendToChannel.mockImplementation(() => {
      expect(testDb.select().from(schema.messages).all()).toHaveLength(1);
    });
    poke({ channelId: CHANNEL, targetUserId: 'target' });
    const row = testDb.select().from(schema.messages).where(eq(schema.messages.channelId, CHANNEL)).get();
    expect(row).toMatchObject({ type: 'system', userId: 'actor' });
    expect(refusals()).toEqual([]);
  });

  it('is sent once, as a channel_poke carrying the stored row, never as a message_created', () => {
    poke({ channelId: CHANNEL, targetUserId: 'target' });
    const row = testDb.select().from(schema.messages).get()!;
    expect(sendToChannel).toHaveBeenCalledTimes(1);
    expect(sendToChannel).toHaveBeenCalledWith(SPACE, CHANNEL, {
      type: 'channel_poke',
      message: expect.objectContaining({
        id: row.id, channelId: CHANNEL, userId: 'actor', type: 'system', content: row.content,
        user: expect.objectContaining({ id: 'actor' }), mentionEveryone: false, mentionRoleIds: [],
      }),
    });
    expect(parseChannelSystemEvent(row.content)).toMatchObject({ event: 'channel_poke', targetUserId: 'target' });
  });

  it('ignores names and ids the client sends beyond the channel and target', () => {
    poke({ channelId: CHANNEL, targetUserId: 'target', targetDisplayName: 'forged', userId: 'owner' });
    const row = testDb.select().from(schema.messages).get()!;
    expect(row.userId).toBe('actor');
    expect(row.content).not.toContain('forged');
  });

  it("records the target's nickname in the space as the stored name", () => {
    testDb.update(schema.spaceMembers).set({ nickname: 'Navigator' }).where(eq(schema.spaceMembers.userId, 'target')).run();
    poke({ channelId: CHANNEL, targetUserId: 'target' });
    expect(parseChannelSystemEvent(testDb.select().from(schema.messages).get()!.content)).toEqual({
      event: 'channel_poke', targetUserId: 'target', targetDisplayName: 'Navigator',
    });
  });

  it('records the account name without the instance for a target without a nickname', () => {
    poke({ channelId: CHANNEL, targetUserId: 'target' });
    expect(parseChannelSystemEvent(testDb.select().from(schema.messages).get()!.content)).toEqual({
      event: 'channel_poke', targetUserId: 'target', targetDisplayName: 'target',
    });
  });

  it('propagates a storage failure without sending anything', () => {
    sqlite.exec("CREATE TRIGGER reject_poke BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    expect(() => poke({ channelId: CHANNEL, targetUserId: 'target' })).toThrow('storage failure');
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it('leaves ordinary messages typed as user messages', () => {
    testDb.insert(schema.messages).values({ id: '1', channelId: CHANNEL, userId: 'actor', content: 'hello', createdAt: NOW }).run();
    expect(testDb.select().from(schema.messages).get()?.type).toBe('user');
  });
});
