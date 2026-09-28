import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
vi.mock('../db/index.js', () => ({ getDb: () => db, schema }));
vi.mock('../utils/permissions.js', () => ({ PermissionBits: { VIEW_CHANNEL: 1n, READ_MESSAGE_HISTORY: 2n }, hasPermission: (_u: string, _s: string, _p: bigint, ch: string) => ch !== 'hidden' }));
import { channelUnreadCounts, unreadCountEvent } from './channelUnreadCounts.js';
beforeEach(() => {
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE channels (id TEXT PRIMARY KEY, space_id TEXT, name TEXT, type TEXT, topic TEXT, position INTEGER, category_id TEXT, created_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT, user_id TEXT, reply_to_id TEXT, content TEXT, edited_at INTEGER, created_at INTEGER);
    CREATE TABLE read_states (user_id TEXT, channel_id TEXT, last_read_message_id TEXT, updated_at INTEGER);
    INSERT INTO channels (id, space_id) VALUES ('chat', 'space'), ('hidden', 'space');
    INSERT INTO messages (id, channel_id, user_id) VALUES ('9', 'chat', 'other'), ('100', 'chat', 'other'), ('101', 'chat', 'other'), ('102', 'chat', 'me'), ('103', 'hidden', 'other');
    INSERT INTO read_states VALUES ('me', 'chat', '9', 0);
  `);
});
afterEach(() => sqlite.close());
describe('exact channel unread counts', () => {
  it('counts messages after the numeric read cursor, excluding own messages and hidden channels', () => {
    expect(channelUnreadCounts('me', ['chat', 'hidden'])).toEqual({ chat: 2 });
  });
  it('recounts deletion and read/mark-unread changes without cached-message assumptions', () => {
    sqlite.exec("DELETE FROM messages WHERE id = '100'");
    expect(channelUnreadCounts('me', ['chat'])).toEqual({ chat: 1 });
    sqlite.exec("UPDATE read_states SET last_read_message_id = '101'");
    expect(unreadCountEvent('me', { type: 'channel_ack', channelId: 'chat', messageId: '101' })).toEqual({ type: 'channel_unread_count', counts: { chat: 0 } });
    sqlite.exec('DELETE FROM read_states');
    expect(channelUnreadCounts('me', ['chat'])).toEqual({ chat: 2 });
  });
  it('does not count typing, pokes or unrelated events', () => {
    expect(unreadCountEvent('me', { type: 'typing', channelId: 'chat', userId: 'other', username: 'Other' })).toBeNull();
    expect(channelUnreadCounts('me', [])).toEqual({});
  });
});
