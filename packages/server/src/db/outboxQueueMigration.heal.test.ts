import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { healSkippedOutboxMigration } from './migrate.js';
import { backfillOutboxQueueKeys, outboxQueueKey } from '../utils/federationOutboxQueue.js';
import { initDatabase, closeDatabase } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(__dirname, '../../drizzle');

function applySqlFile(db: Database.Database, filename: string): void {
  const text = fs.readFileSync(path.join(MIGRATIONS, filename), 'utf8');
  for (const stmt of text.split(/-->\s*statement-breakpoint/)) {
    const clean = stmt.trim();
    if (clean) db.exec(clean);
  }
}

function recordMigration(db: Database.Database, filename: string, when: number): void {
  const text = fs.readFileSync(path.join(MIGRATIONS, filename), 'utf8');
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  db.exec('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "hash" text NOT NULL, "created_at" numeric)');
  db.prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)').run(hash, when);
}

describe('healSkippedOutboxMigration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-heal-test-'));
  });

  afterEach(() => {
    closeDatabase();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('heals databases where 0027 ran ahead of 0026 and allows outbox backfill', () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const db = new Database(dbPath);

    // 1. Migrate up through 0025
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')).entries as Array<{
      idx: number;
      tag: string;
      when: number;
    }>;
    const journalMap = new Map(journal.map((j) => [j.tag, j.when]));

    for (const f of files) {
      if (f.startsWith('0026_') || f.startsWith('0027_')) break;
      applySqlFile(db, f);
      const tag = f.replace(/\.sql$/, '');
      recordMigration(db, f, journalMap.get(tag)!);
    }

    // 2. Simulate the bug: skip 0026 and apply 0027 directly
    applySqlFile(db, '0027_peer_resync.sql');
    recordMigration(db, '0027_peer_resync.sql', 1791335942928);

    // 3. Confirm federation_outbox exists but is missing queue_key
    const columnsBefore = db.prepare('PRAGMA table_info(federation_outbox)').all() as Array<{ name: string }>;
    expect(columnsBefore.some((c) => c.name === 'queue_key')).toBe(false);

    // Seed a peer and an un-keyed outbox row
    db.prepare(
      'INSERT INTO federation_peers (id, origin, hmac_secret, status, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('peer-1', 'https://peer-1.example', 'secret', 'active', 'admin', 100);

    db.prepare(
      `INSERT INTO federation_outbox (id, peer_id, context_id, entity_id, context_type, event_type, payload, attempts, next_retry_at, expires_at, created_at)
       VALUES (?, ?, 'ctx-1', 'entity-1', 'dm', 'create', '{"text":"hi"}', 0, 0, 9999999999999, 150)`,
    ).run('msg-1', 'peer-1');

    // 4. Run healSkippedOutboxMigration
    healSkippedOutboxMigration(db, MIGRATIONS);

    // 5. Verify queue_key exists, offered_at is populated, and migration 0026 is recorded
    const columnsAfter = db.prepare('PRAGMA table_info(federation_outbox)').all() as Array<{ name: string }>;
    expect(columnsAfter.some((c) => c.name === 'queue_key')).toBe(true);

    const row = db.prepare('SELECT id, offered_at AS offeredAt, queue_key AS queueKey FROM federation_outbox WHERE id = ?').get('msg-1') as {
      id: string;
      offeredAt: number;
      queueKey: string | null;
    };
    expect(row).toEqual({
      id: 'msg-1',
      offeredAt: 150,
      queueKey: null,
    });

    const recorded0026 = db.prepare('SELECT 1 FROM __drizzle_migrations WHERE created_at = 1790860000000').get();
    expect(recorded0026).toBeTruthy();

    // 6. Verify backfillOutboxQueueKeys succeeds on healed database
    expect(backfillOutboxQueueKeys(db)).toBe(1);
    const keyedRow = db.prepare('SELECT queue_key AS queueKey FROM federation_outbox WHERE id = ?').get('msg-1') as {
      queueKey: string;
    };
    expect(keyedRow.queueKey).toBe(outboxQueueKey('create', 'entity-1', 'ctx-1', '{"text":"hi"}'));

    // 7. Verify subsequent run is a no-op
    healSkippedOutboxMigration(db, MIGRATIONS);
    expect(backfillOutboxQueueKeys(db)).toBe(0);

    db.close();
  });

  it('allows initDatabase() to boot successfully from corrupted state without throwing', async () => {
    const dbPath = path.join(tmpDir, 'boot-heal.db');
    const db = new Database(dbPath);

    // Setup DB up to 0025, plus 0027 (simulating the crash site on production)
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')).entries as Array<{
      idx: number;
      tag: string;
      when: number;
    }>;
    const journalMap = new Map(journal.map((j) => [j.tag, j.when]));

    for (const f of files) {
      if (f.startsWith('0026_') || f.startsWith('0027_')) break;
      applySqlFile(db, f);
      const tag = f.replace(/\.sql$/, '');
      recordMigration(db, f, journalMap.get(tag)!);
    }
    applySqlFile(db, '0027_peer_resync.sql');
    recordMigration(db, '0027_peer_resync.sql', 1791335942928);

    db.prepare(
      'INSERT INTO federation_peers (id, origin, hmac_secret, status, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('peer-boot', 'https://peer-boot.example', 'secret', 'active', 'admin', 100);

    db.prepare(
      `INSERT INTO federation_outbox (id, peer_id, context_id, entity_id, context_type, event_type, payload, attempts, next_retry_at, expires_at, created_at)
       VALUES (?, ?, 'ctx-boot', 'entity-boot', 'dm', 'create', '{}', 0, 0, 9999999999999, 100)`,
    ).run('row-boot', 'peer-boot');

    db.close();

    // Boot via initDatabase() using environment variables
    const origDbPath = process.env.DB_PATH;
    const origBackup = process.env.BACKUP_DISABLED;
    try {
      vi.resetModules();
      process.env.DB_PATH = dbPath;
      process.env.BACKUP_DISABLED = 'true';
      const { initDatabase: freshInit, closeDatabase: freshClose } = await import('./index.js');
      try {
        const liveDb = freshInit();
        expect(liveDb).toBeTruthy();
      } finally {
        freshClose();
      }

      const rawDb = new Database(dbPath);
      const row = rawDb.prepare('SELECT queue_key AS queueKey FROM federation_outbox WHERE id = ?').get('row-boot') as {
        queueKey: string | null;
      };
      expect(row.queueKey).not.toBeNull();
      rawDb.close();
    } finally {
      process.env.DB_PATH = origDbPath;
      process.env.BACKUP_DISABLED = origBackup;
      vi.resetModules();
    }
  });

  it('does nothing on fresh database or normal database before 0026', () => {
    const freshDb = new Database(':memory:');
    // Fresh DB has no federation_outbox: should return immediately
    expect(() => healSkippedOutboxMigration(freshDb, MIGRATIONS)).not.toThrow();

    // Database at 0025 with no future migrations applied: should not prematurely run 0026
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (f.startsWith('0026_')) break;
      applySqlFile(freshDb, f);
    }
    healSkippedOutboxMigration(freshDb, MIGRATIONS);
    const columns = freshDb.prepare('PRAGMA table_info(federation_outbox)').all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === 'queue_key')).toBe(false);
  });
});
