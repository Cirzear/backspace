import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults, healLegacyColumns, healSkippedStickerSizeMigration } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE instance_settings (id integer PRIMARY KEY, worker_id integer, instance_id text, max_bitrate_kbps integer, min_bitrate_kbps integer, bitrate_step_kbps integer, allowed_resolutions text, allowed_framerates text, max_resolution integer, max_framerate integer, installed_at integer, updated_at integer);
    CREATE TABLE users (id text PRIMARY KEY, is_admin integer DEFAULT 0, home_instance text, is_deleted integer DEFAULT 0, created_at integer);`);
  return db;
}

describe('ensureDefaults instance epoch', () => {
  it('mints an instance_id when null and is idempotent', () => {
    const db = freshDb();
    ensureDefaults(db);
    const first = (db.prepare('SELECT instance_id FROM instance_settings WHERE id = 1').get() as { instance_id: string }).instance_id;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    ensureDefaults(db);
    const second = (db.prepare('SELECT instance_id FROM instance_settings WHERE id = 1').get() as { instance_id: string }).instance_id;
    expect(second).toBe(first); // stable across boots
  });

  it('mints a different id for a separate fresh DB', () => {
    const a = freshDb(); ensureDefaults(a);
    const b = freshDb(); ensureDefaults(b);
    const idA = (a.prepare('SELECT instance_id FROM instance_settings WHERE id = 1').get() as { instance_id: string }).instance_id;
    const idB = (b.prepare('SELECT instance_id FROM instance_settings WHERE id = 1').get() as { instance_id: string }).instance_id;
    expect(idA).not.toBe(idB);
  });
});

describe('healSkippedStickerSizeMigration', () => {
  it('backfills __drizzle_migrations if max_sticker_size_bytes already exists but migration was not recorded', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE instance_settings (id integer PRIMARY KEY, max_sticker_size_bytes integer);
      CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY AUTOINCREMENT, hash text, created_at numeric);
    `);
    healSkippedStickerSizeMigration(db, MIGRATIONS_DIR);

    const row = db.prepare('SELECT * FROM __drizzle_migrations WHERE created_at = 1792100000000').get();
    expect(row).toBeDefined();

    // Idempotent: safe to run again
    healSkippedStickerSizeMigration(db, MIGRATIONS_DIR);
    const count = db.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations WHERE created_at = 1792100000000').get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it('no-ops when instance_settings does not have max_sticker_size_bytes', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE instance_settings (id integer PRIMARY KEY);
      CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY AUTOINCREMENT, hash text, created_at numeric);
    `);
    healSkippedStickerSizeMigration(db, MIGRATIONS_DIR);

    const row = db.prepare('SELECT * FROM __drizzle_migrations WHERE created_at = 1792100000000').get();
    expect(row).toBeUndefined();
    db.close();
  });
});

describe('healLegacyColumns', () => {
  it('does not mutate instance_settings schema', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE instance_settings (id integer PRIMARY KEY);`);
    healLegacyColumns(db);
    const cols = db.prepare('PRAGMA table_info(instance_settings)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(['id']);
    db.close();
  });
});
