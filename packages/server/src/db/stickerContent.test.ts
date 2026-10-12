import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { and, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';
import * as schema from './schema.js';
import { notStickerContent } from './stickerContent.js';

const token = `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;

describe('notStickerContent', () => {
  it('keeps a text search from matching the words inside a sticker token', () => {
    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: path.resolve('drizzle') });
      sqlite.exec(`
        INSERT INTO users (id, username, password_hash, created_at) VALUES ('alice', 'alice', 'x', 1);
        INSERT INTO spaces (id, name, owner_id, created_at) VALUES ('space', 'Space', 'alice', 1);
        INSERT INTO channels (id, space_id, name, type, position, created_at) VALUES ('channel', 'space', 'general', 'text', 0, 1);
        INSERT INTO dm_channels (id, created_at) VALUES ('dm', 1);
      `);
      const insert = sqlite.prepare("INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, 'channel', 'alice', ?, 1)");
      insert.run('sticker', token);
      insert.run('text', 'the stickers api docs are at https://chat.test');
      insert.run('prefixed', 'sticker: the one with the cat');
      const insertDm = sqlite.prepare("INSERT INTO dm_messages (id, dm_channel_id, user_id, content, created_at) VALUES (?, 'dm', 'alice', ?, 1)");
      insertDm.run('dm-sticker', token);
      insertDm.run('dm-text', 'which stickers');

      const channelHits = (q: string) => db.select({ id: schema.messages.id }).from(schema.messages)
        .where(and(like(schema.messages.content, `%${q}%`), notStickerContent(schema.messages.content))).all().map(row => row.id).sort();
      expect(channelHits('stickers')).toEqual(['text']);
      expect(channelHits('https')).toEqual(['text']);
      expect(channelHits('sticker')).toEqual(['prefixed', 'text']);

      const dmHits = db.select({ id: schema.dmMessages.id }).from(schema.dmMessages)
        .where(and(like(schema.dmMessages.content, '%stickers%'), notStickerContent(schema.dmMessages.content))).all();
      expect(dmHits).toEqual([{ id: 'dm-text' }]);
    } finally {
      sqlite.close();
    }
  });
});
