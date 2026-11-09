import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

const systemChannelMigration = fs.readdirSync(migrationsFolder).find((f) => /^\d{4}_space_system_channel_and_welcome\.sql$/.test(f));

function seedLegacySpace(db: Database.Database): void {
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('owner', 'owner', 'x', 1);
  db.prepare('INSERT INTO spaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run('space', 'Space', 'owner', 1);
}

describe('space system channel and welcome migration', () => {
  it('upgrades existing spaces adding system_channel_id and welcome_message columns defaulting to null', () => {
    const db = new Database(':memory:');
    try {
      expect(systemChannelMigration).toBeDefined();
      const migration = systemChannelMigration!;
      const files = fs.readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql') && f < migration).sort();
      for (const file of files) {
        for (const statement of fs.readFileSync(path.join(migrationsFolder, file), 'utf8').split(/-->\s*statement-breakpoint/)) {
          if (statement.trim()) db.exec(statement);
        }
      }
      seedLegacySpace(db);
      db.exec(fs.readFileSync(path.join(migrationsFolder, migration), 'utf8'));
      expect(db.prepare('SELECT system_channel_id, welcome_message FROM spaces').get()).toEqual({
        system_channel_id: null,
        welcome_message: null,
      });
    } finally {
      db.close();
    }
  });

  it('survives full migration run and supports reading/writing system_channel_id and welcome_message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-syschan-'));
    const filename = path.join(dir, 'db.sqlite');
    let db = new Database(filename);
    try {
      migrate(drizzle(db), { migrationsFolder });
      seedLegacySpace(db);
      db.prepare('UPDATE spaces SET system_channel_id = ?, welcome_message = ? WHERE id = ?').run('c1', 'Welcome!', 'space');
      db.close();
      db = new Database(filename);
      expect(db.prepare('SELECT system_channel_id, welcome_message FROM spaces WHERE id = ?').get('space')).toEqual({
        system_channel_id: 'c1',
        welcome_message: 'Welcome!',
      });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
