import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';
import { parseChannelSystemEvent } from '@backspace/shared/src/channelSystemEvents.js';

setWorkerId(5);

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
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToChannel: (...args: unknown[]) => sendToChannel(...args),
  },
}));

const { sendSpaceJoinNotification } = await import('./spaceJoinNotification.js');

const SPACE = 'space';
const CHANNEL = 'welcome-chan';
const VOICE_CHANNEL = 'voice-chan';
const NOW = 1_800_000_000_000;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const statement of fs.readFileSync(path.join(dir, file), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  testDb = drizzle(sqlite, { schema });
  testDb.insert(schema.users).values({
    id: 'joiner',
    username: 'newbie',
    displayName: 'New Friend',
    passwordHash: 'hash',
    createdAt: NOW,
  }).run();

  testDb.insert(schema.spaces).values({
    id: SPACE,
    name: 'My Space',
    ownerId: 'joiner',
    systemChannelId: CHANNEL,
    welcomeMessage: null,
    createdAt: NOW,
  }).run();

  testDb.insert(schema.channels).values({
    id: CHANNEL,
    spaceId: SPACE,
    name: 'welcome',
    type: 'text',
    createdAt: NOW,
  }).run();

  testDb.insert(schema.channels).values({
    id: VOICE_CHANNEL,
    spaceId: SPACE,
    name: 'general-voice',
    type: 'voice',
    createdAt: NOW,
  }).run();

  sendToChannel.mockClear();
});

afterEach(() => {
  sqlite.close();
});

describe('sendSpaceJoinNotification', () => {
  it('inserts a system message and broadcasts to the configured systemChannelId with default message', () => {
    const user = testDb.select().from(schema.users).where(eq(schema.users.id, 'joiner')).get()!;
    sendSpaceJoinNotification(SPACE, user);

    const msgs = testDb.select().from(schema.messages).where(eq(schema.messages.channelId, CHANNEL)).all();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.type).toBe('system');
    expect(msgs[0]!.userId).toBe('joiner');

    const event = parseChannelSystemEvent(msgs[0]!.content);
    expect(event).toEqual({
      event: 'member_join',
      userId: 'joiner',
      displayName: 'New Friend',
      customMessage: null,
    });

    expect(sendToChannel).toHaveBeenCalledTimes(1);
    expect(sendToChannel).toHaveBeenCalledWith(
      SPACE,
      CHANNEL,
      expect.objectContaining({
        type: 'message_created',
        message: expect.objectContaining({
          type: 'system',
          userId: 'joiner',
        }),
      }),
    );
  });

  it('includes custom welcomeMessage when configured on the space', () => {
    testDb.update(schema.spaces)
      .set({ welcomeMessage: 'Welcome {username} to the server!' })
      .where(eq(schema.spaces.id, SPACE))
      .run();

    const user = testDb.select().from(schema.users).where(eq(schema.users.id, 'joiner')).get()!;
    sendSpaceJoinNotification(SPACE, user);

    const msg = testDb.select().from(schema.messages).where(eq(schema.messages.channelId, CHANNEL)).get()!;
    const event = parseChannelSystemEvent(msg.content);
    expect(event).toEqual({
      event: 'member_join',
      userId: 'joiner',
      displayName: 'New Friend',
      customMessage: 'Welcome {username} to the server!',
    });
  });

  it('does nothing when space has no systemChannelId configured', () => {
    testDb.update(schema.spaces).set({ systemChannelId: null }).where(eq(schema.spaces.id, SPACE)).run();

    const user = testDb.select().from(schema.users).where(eq(schema.users.id, 'joiner')).get()!;
    sendSpaceJoinNotification(SPACE, user);

    expect(testDb.select().from(schema.messages).all()).toHaveLength(0);
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it('does nothing when configured systemChannelId does not exist or is voice channel', () => {
    testDb.update(schema.spaces).set({ systemChannelId: VOICE_CHANNEL }).where(eq(schema.spaces.id, SPACE)).run();

    const user = testDb.select().from(schema.users).where(eq(schema.users.id, 'joiner')).get()!;
    sendSpaceJoinNotification(SPACE, user);

    expect(testDb.select().from(schema.messages).all()).toHaveLength(0);
    expect(sendToChannel).not.toHaveBeenCalled();
  });
});
