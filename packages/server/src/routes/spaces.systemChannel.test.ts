import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(2);
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let app: FastifyInstance;
let currentUserId = 'owner';
const sendToSpace = vi.fn();
vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../utils/auth.js', () => ({ authenticate: async (req: { userId?: string }) => { req.userId = currentUserId; } }));
vi.mock('../ws/handler.js', () => ({ connectionManager: { announceSpaceAccessChange: vi.fn(), sendToSpace: (...args: unknown[]) => sendToSpace(...args) } }));

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  testDb = drizzle(sqlite, { schema });
  currentUserId = 'owner';
  sendToSpace.mockClear();

  testDb.insert(schema.users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 }).run();
  testDb.insert(schema.users).values({ id: 'member', username: 'member', passwordHash: 'x', createdAt: 1 }).run();

  testDb.insert(schema.spaces).values({ id: 'space', name: 'space', ownerId: 'owner', createdAt: 1 }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: 'space', userId: 'owner', joinedAt: 1 }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: 'space', userId: 'member', joinedAt: 1 }).run();

  testDb.insert(schema.channels).values({ id: 'chan-text', spaceId: 'space', name: 'general', type: 'text', createdAt: 1 }).run();
  testDb.insert(schema.channels).values({ id: 'chan-voice', spaceId: 'space', name: 'voice', type: 'voice', createdAt: 1 }).run();

  const { spaceRoutes } = await import('./spaces.js');
  app = Fastify();
  await app.register(spaceRoutes);
});

afterEach(async () => {
  await app.close();
  sqlite.close();
});

describe('space system channel and welcome message updates', () => {
  it('updates systemChannelId and welcomeMessage and broadcasts space_updated', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/spaces/space',
      payload: {
        systemChannelId: 'chan-text',
        welcomeMessage: 'Welcome {username} to the server!',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.systemChannelId).toBe('chan-text');
    expect(body.welcomeMessage).toBe('Welcome {username} to the server!');

    const stored = testDb.select().from(schema.spaces).where(eq(schema.spaces.id, 'space')).get()!;
    expect(stored.systemChannelId).toBe('chan-text');
    expect(stored.welcomeMessage).toBe('Welcome {username} to the server!');

    expect(sendToSpace).toHaveBeenCalledWith('space', expect.objectContaining({
      type: 'space_updated',
      space: expect.objectContaining({
        systemChannelId: 'chan-text',
        welcomeMessage: 'Welcome {username} to the server!',
      }),
    }));
  });

  it('allows clearing systemChannelId and welcomeMessage with null', async () => {
    testDb.update(schema.spaces)
      .set({ systemChannelId: 'chan-text', welcomeMessage: 'Hello' })
      .where(eq(schema.spaces.id, 'space'))
      .run();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/spaces/space',
      payload: {
        systemChannelId: null,
        welcomeMessage: null,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.systemChannelId).toBeNull();
    expect(body.welcomeMessage).toBeNull();

    const stored = testDb.select().from(schema.spaces).where(eq(schema.spaces.id, 'space')).get()!;
    expect(stored.systemChannelId).toBeNull();
    expect(stored.welcomeMessage).toBeNull();
  });

  it('rejects setting systemChannelId to a non-existent or voice channel', async () => {
    const notFound = await app.inject({
      method: 'PATCH',
      url: '/api/spaces/space',
      payload: { systemChannelId: 'fake-channel' },
    });
    expect(notFound.statusCode).toBe(400);
    expect(notFound.json()).toMatchObject({ code: 'channel_not_found' });

    const voice = await app.inject({
      method: 'PATCH',
      url: '/api/spaces/space',
      payload: { systemChannelId: 'chan-voice' },
    });
    expect(voice.statusCode).toBe(400);
    expect(voice.json()).toMatchObject({ code: 'channel_not_found' });
  });
});
