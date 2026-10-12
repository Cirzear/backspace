import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

// Found by its name rather than its number, which changes whenever another
// migration lands first.
const ownerTitleMigration = fs.readdirSync(migrationsFolder).find((f) => /^\d{4}_space_owner_title\.sql$/.test(f));

function seedLegacySpace(db: Database.Database): void {
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('owner', 'owner', 'x', 1);
  db.prepare('INSERT INTO spaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run('space', 'Space', 'owner', 1);
}

describe('space owner title migration', () => {
  it('upgrades existing spaces without changing ownership or inventing a title', () => {
    const db = new Database(':memory:');
    try {
      expect(ownerTitleMigration).toBeDefined();
      const migration = ownerTitleMigration!;
      const files = fs.readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql') && f < migration).sort();
      for (const file of files) {
        for (const statement of fs.readFileSync(path.join(migrationsFolder, file), 'utf8').split(/-->\s*statement-breakpoint/)) {
          if (statement.trim()) db.exec(statement);
        }
      }
      seedLegacySpace(db);
      db.exec(fs.readFileSync(path.join(migrationsFolder, migration), 'utf8'));
      expect(db.prepare('SELECT owner_id, owner_title FROM spaces').get()).toEqual({ owner_id: 'owner', owner_title: null });
    } finally {
      db.close();
    }
  });

  it('is included in the real migration journal and survives closing and reopening the database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-owner-title-'));
    const filename = path.join(dir, 'db.sqlite');
    let db = new Database(filename);
    try {
      migrate(drizzle(db), { migrationsFolder });
      seedLegacySpace(db);
      db.prepare('UPDATE spaces SET owner_title = ? WHERE id = ?').run('首席摸鱼官', 'space');
      db.close();
      db = new Database(filename);
      migrate(drizzle(db), { migrationsFolder });
      expect(db.prepare('SELECT owner_title FROM spaces WHERE id = ?').get('space')).toEqual({ owner_title: '首席摸鱼官' });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true });
    }
  });
});
