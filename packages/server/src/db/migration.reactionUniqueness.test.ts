import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dmReactions, reactions } from './schema.js';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const tag = '0025_reaction_uniqueness';
const sticker = `sticker:https://home.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
const otherSticker = `sticker:https://home.test/api/stickers/assets/${'b'.repeat(64)}.webp`;
const reactionTables = [
  {
    table: 'reactions',
    messageColumn: 'message_id',
    indexName: 'idx_reactions_message_user_emoji',
    schema: reactions,
  },
  {
    table: 'dm_reactions',
    messageColumn: 'dm_message_id',
    indexName: 'idx_dm_reactions_message_user_emoji',
    schema: dmReactions,
  },
] as const;
type ReactionTable = typeof reactionTables[number];
type ReactionRow = [id: string, messageId: string, userId: string, emoji: string, createdAt: number];

const legacyRows: ReactionRow[] = [
  // Earlier creation wins even when its ID sorts after a later duplicate.
  ['90', 'm1', 'u1', '👍', 1],
  ['01', 'm1', 'u1', '👍', 2],
  // IDs are TEXT: a tie keeps '10', not the first inserted or numeric minimum '2'.
  ['2', 'm1', 'u1', '❤️', 3],
  ['10', 'm1', 'u1', '❤️', 3],
  ['other-user', 'm1', 'u2', '👍', 1],
  ['other-message', 'm2', 'u1', '👍', 1],
  ['other-emoji', 'm1', 'u1', '😂', 1],
  ['sticker-early', 'm1', 'u1', sticker, 1],
  ['sticker-late', 'm1', 'u1', sticker, 2],
  ['sticker-other-token', 'm1', 'u1', otherSticker, 1],
  ['sticker-other-user', 'm1', 'u2', sticker, 1],
  ['sticker-other-message', 'm2', 'u1', sticker, 1],
];

const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};
const migrationIndex = journal.entries.findIndex(entry => entry.tag === tag);
let legacyFolder: string;
let db: Database.Database;

beforeAll(() => {
  expect(migrationIndex).toBeGreaterThan(0);
  legacyFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-reaction-migration-'));
  fs.mkdirSync(path.join(legacyFolder, 'meta'));
  const entries = journal.entries.slice(0, migrationIndex);
  // Use the actual historical journal and SQL, not a fabricated schema or ledger.
  fs.writeFileSync(path.join(legacyFolder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    fs.copyFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(legacyFolder, `${entry.tag}.sql`));
  }
});

afterAll(() => fs.rmSync(legacyFolder, { recursive: true }));
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});
afterEach(() => db.close());

function seedParents(): void {
  db.exec(`
    INSERT INTO users (id, username, password_hash, created_at)
      VALUES ('u1', 'user1', 'x', 1), ('u2', 'user2', 'x', 1), ('u3', 'user3', 'x', 1);
    INSERT INTO spaces (id, name, owner_id, created_at) VALUES ('space', 'Space', 'u1', 1);
    INSERT INTO channels (id, space_id, name, type, created_at)
      VALUES ('channel', 'space', 'Chat', 'text', 1);
    INSERT INTO messages (id, channel_id, user_id, created_at)
      VALUES ('m1', 'channel', 'u1', 1), ('m2', 'channel', 'u1', 1), ('m3', 'channel', 'u1', 1);
    INSERT INTO dm_channels (id, created_at) VALUES ('dm', 1);
    INSERT INTO dm_messages (id, dm_channel_id, user_id, created_at)
      VALUES ('m1', 'dm', 'u1', 1), ('m2', 'dm', 'u1', 1), ('m3', 'dm', 'u1', 1);
  `);
}

function insertReaction(table: ReactionTable, row: ReactionRow): void {
  db.prepare(`INSERT INTO ${table.table} (id, ${table.messageColumn}, user_id, emoji, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(...row);
}

function readReactions(table: ReactionTable): unknown[] {
  return db.prepare(`SELECT id, ${table.messageColumn}, user_id, emoji, created_at
    FROM ${table.table} ORDER BY id`).raw().all();
}

function assertUniqueIndex(table: ReactionTable): void {
  expect(db.pragma(`index_list('${table.table}')`)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: table.indexName, unique: 1, partial: 0 }),
  ]));
  expect(db.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`).all(table.indexName)).toEqual([
    { name: table.messageColumn }, { name: 'user_id' }, { name: 'emoji' },
  ]);
}

function assertNoOpMigration(): void {
  const ledger = db.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
  const rows = reactionTables.map(readReactions);
  const changes = db.prepare('SELECT total_changes() AS count').get();
  migrate(drizzle(db), { migrationsFolder });
  expect(db.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()).toEqual(ledger);
  expect(reactionTables.map(readReactions)).toEqual(rows);
  expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
}

describe(tag, () => {
  it('uses a journal timestamp newer than every previous migration', () => {
    const entry = journal.entries[migrationIndex]!;
    expect(entry).toMatchObject({ idx: 25, version: '6', breakpoints: true });
    expect(entry.when).toBeGreaterThan(Math.max(...journal.entries.slice(0, migrationIndex).map(item => item.when)));
  });

  it('applies on a fresh database through the real journal, then becomes a no-op', () => {
    migrate(drizzle(db), { migrationsFolder });
    for (const table of reactionTables) assertUniqueIndex(table);
    expect(db.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({
      count: journal.entries.length,
    });
    seedParents();
    for (const table of reactionTables) insertReaction(table, ['fresh', 'm1', 'u1', sticker, 1]);
    assertNoOpMigration();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('upgrades legacy duplicates in both tables without changing other triples or parent rows', () => {
    migrate(drizzle(db), { migrationsFolder: legacyFolder });
    seedParents();
    for (const table of reactionTables) {
      for (const row of legacyRows) insertReaction(table, row);
    }
    const previousLedger = db.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
    const expectedRows = legacyRows.filter(([id]) => !['01', '2', 'sticker-late'].includes(id))
      .sort(([left], [right]) => left < right ? -1 : 1);

    migrate(drizzle(db), { migrationsFolder });

    for (const table of reactionTables) {
      expect(readReactions(table)).toEqual(expectedRows);
      assertUniqueIndex(table);
    }
    const currentLedger = db.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
    expect(currentLedger).toHaveLength(journal.entries.length);
    expect(currentLedger.slice(0, migrationIndex)).toEqual(previousLedger);
    expect(currentLedger[migrationIndex]).toMatchObject({ created_at: journal.entries[migrationIndex]!.when });
    expect(db.prepare('SELECT id FROM messages ORDER BY id').all()).toEqual([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
    expect(db.prepare('SELECT id FROM dm_messages ORDER BY id').all()).toEqual([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    assertNoOpMigration();
  });
});

describe.each(reactionTables)('$table uniqueness', (table) => {
  it('rejects duplicate inserts and updates, but accepts different users, messages and emoji tokens', () => {
    migrate(drizzle(db), { migrationsFolder });
    seedParents();
    insertReaction(table, ['initial', 'm1', 'u1', '👍', 1]);
    insertReaction(table, ['sticker-initial', 'm1', 'u1', sticker, 1]);

    expect(() => insertReaction(table, ['duplicate', 'm1', 'u1', '👍', 2])).toThrow(/UNIQUE constraint failed/);
    expect(() => insertReaction(table, ['sticker-duplicate', 'm1', 'u1', sticker, 2])).toThrow(/UNIQUE constraint failed/);
    insertReaction(table, ['different-user', 'm1', 'u2', '👍', 1]);
    insertReaction(table, ['different-message', 'm2', 'u1', '👍', 1]);
    insertReaction(table, ['different-emoji', 'm1', 'u1', '❤️', 1]);
    insertReaction(table, ['different-sticker', 'm1', 'u1', otherSticker, 1]);
    insertReaction(table, ['different-sticker-user', 'm1', 'u2', sticker, 1]);
    insertReaction(table, ['different-sticker-message', 'm2', 'u1', sticker, 1]);

    expect(() => db.prepare(`UPDATE ${table.table} SET emoji = ? WHERE id = ?`)
      .run('👍', 'different-emoji')).toThrow(/UNIQUE constraint failed/);
    expect(readReactions(table)).toHaveLength(8);
  });

  it('keeps the Drizzle schema and generated snapshot aligned with the unique index', () => {
    const index = getTableConfig(table.schema).indexes.find(candidate => candidate.config.name === table.indexName);
    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map(column => 'name' in column ? column.name : null))
      .toEqual([table.messageColumn, 'user_id', 'emoji']);

    const previous = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta/0024_snapshot.json'), 'utf8')) as { id: string };
    const snapshot = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta/0025_snapshot.json'), 'utf8')) as {
      prevId: string;
      tables: Record<string, { indexes: Record<string, unknown> }>;
    };
    expect(snapshot.prevId).toBe(previous.id);
    expect(snapshot.tables[table.table]?.indexes[table.indexName]).toEqual({
      name: table.indexName,
      columns: [table.messageColumn, 'user_id', 'emoji'],
      isUnique: true,
    });
  });
});
