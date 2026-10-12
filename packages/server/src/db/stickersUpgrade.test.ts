import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Migration 0031 adds the two sticker tables to an existing database and
 * changes nothing that was there. The files are found by name, so a later
 * migration does not move what this test applies.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');
const TAG = '0031_personal_stickers';

function statementsOf(file: string): string[] {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    .split(/-->\s*statement-breakpoint/)
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);
}

/** Every migration before the one under test, so an older database can be seeded first. */
function applyUpTo(db: Database.Database, tag: string): void {
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    if (file.startsWith(tag)) return;
    for (const statement of statementsOf(file)) db.exec(statement);
  }
  throw new Error(`migration ${tag} not found`);
}

function tables(db: Database.Database): { name: string; sql: string }[] {
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string; sql: string }[];
}

describe(TAG, () => {
  it('adds only the sticker tables to an existing database', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      applyUpTo(db, TAG);
      db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES ('existing-user', 'alice', 'test-hash', 1)").run();
      const before = tables(db);
      expect(before.map(row => row.name)).not.toContain('sticker_assets');

      for (const statement of statementsOf(`${TAG}.sql`)) db.exec(statement);

      const after = tables(db);
      expect(after.filter(row => !before.some(old => old.name === row.name)).map(row => row.name))
        .toEqual(['personal_stickers', 'sticker_assets']);
      expect(after.filter(row => before.some(old => old.name === row.name))).toEqual(before);
      expect(db.prepare("SELECT username FROM users WHERE id = 'existing-user'").get()).toEqual({ username: 'alice' });

      const id = 'a'.repeat(64);
      db.prepare('INSERT INTO sticker_assets (id, created_at) VALUES (?, 2)').run(id);
      const collect = db.prepare('INSERT INTO personal_stickers (user_id, sticker_id, name, created_at) VALUES (?, ?, ?, 2)');
      collect.run('existing-user', id, 'Happy');
      expect(() => collect.run('missing-user', id, 'Happy')).toThrow(/FOREIGN KEY/);
      expect(() => collect.run('existing-user', 'missing-asset', 'Happy')).toThrow(/FOREIGN KEY/);
      expect(() => collect.run('existing-user', id, 'Happy')).toThrow(/UNIQUE/);
      db.prepare("DELETE FROM users WHERE id = 'existing-user'").run();
      expect(db.prepare('SELECT * FROM personal_stickers').all()).toEqual([]);
      expect(db.prepare('SELECT id FROM sticker_assets').all()).toEqual([{ id }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
