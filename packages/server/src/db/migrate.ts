import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { insertDmMember } from '../utils/dmMemberClosed.js';

/**
 * Ensure data invariants after schema migration. Idempotent — safe to run
 * on every boot. Uses raw better-sqlite3 handle (not Drizzle ORM).
 */
export function ensureDefaults(db: Database.Database): void {
  // 1. Ensure the single-row instance_settings row exists
  const row = db.prepare('SELECT id FROM instance_settings WHERE id = 1').get();
  if (!row) {
    db.prepare(
      `INSERT OR IGNORE INTO instance_settings
        (id, max_bitrate_kbps, min_bitrate_kbps, bitrate_step_kbps,
         allowed_resolutions, allowed_framerates, max_resolution, max_framerate, updated_at)
       VALUES (1, 20000, 500, 500, ?, ?, 1080, 60, ?)`
    ).run('540,720,1080', '30,45,60', Date.now());
    console.log('[defaults] Inserted default instance_settings row');
  }

  // 2. Ensure a unique Snowflake worker ID is persisted (0-1023)
  const settings = db.prepare('SELECT worker_id FROM instance_settings WHERE id = 1').get() as
    { worker_id: number | null } | undefined;
  if (!settings || settings.worker_id === null) {
    const workerId = crypto.randomInt(0, 1024);
    db.prepare('UPDATE instance_settings SET worker_id = ? WHERE id = 1').run(workerId);
    console.log(`[defaults] Generated Snowflake worker ID: ${workerId}`);
  }

  // 2b. Ensure a persistent instance epoch (incarnation UUID) exists. A fresh
  // DB mints a new one — this is the discriminator for detecting resets.
  // The id=1 row is guaranteed by step 1's INSERT OR IGNORE above.
  const epochRow = db.prepare('SELECT instance_id FROM instance_settings WHERE id = 1').get() as
    { instance_id: string | null } | undefined;
  if (!epochRow || epochRow.instance_id === null) {
    const instanceId = crypto.randomUUID();
    const res = db.prepare('UPDATE instance_settings SET instance_id = ? WHERE id = 1').run(instanceId);
    if (res.changes !== 1) throw new Error('ensureDefaults: instance_settings id=1 row missing — cannot mint epoch');
    console.log('[defaults] Generated instance epoch');
  }

  // 2c. Ensure installed_at is set. Existing databases get the oldest local
  // account's creation time, a fresh one gets now. Never overwritten.
  const installedRow = db.prepare('SELECT installed_at FROM instance_settings WHERE id = 1').get() as
    { installed_at: number | null } | undefined;
  if (!installedRow || installedRow.installed_at === null) {
    const oldest = db.prepare(
      'SELECT created_at FROM users WHERE home_instance IS NULL AND (is_deleted IS NULL OR is_deleted = 0) ORDER BY created_at ASC LIMIT 1',
    ).get() as { created_at: number } | undefined;
    const installedAt = oldest?.created_at ?? Date.now();
    db.prepare('UPDATE instance_settings SET installed_at = ? WHERE id = 1').run(installedAt);
    console.log('[defaults] Recorded installed_at');
  }

  // 3. Ensure at least one admin exists (promote earliest registered user)
  const anyAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (!anyAdmin) {
    const firstUser = db.prepare(
      'SELECT id FROM users ORDER BY created_at ASC LIMIT 1'
    ).get() as { id: string } | undefined;
    if (firstUser) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(firstUser.id);
      console.log(`[defaults] Promoted first user ${firstUser.id} to admin`);
    }
  }
}

/**
 * One-time, idempotent recovery of 1-on-1 DM threads broken before the DM
 * tombstone fix: those had the deleted partner's dm_members row removed, making
 * the thread UI-unreachable. For each ownerId-NULL channel with exactly one
 * member, re-insert membership for any distinct dm_messages author that is
 * missing from dm_members and still exists in users. Safe to run every boot.
 */
export function backfillOneOnOneDmMembership(db: Database.Database): void {
  const broken = db.prepare(`
    SELECT dc.id AS channelId
    FROM dm_channels dc
    WHERE dc.owner_id IS NULL
      AND (SELECT COUNT(*) FROM dm_members dm WHERE dm.dm_channel_id = dc.id) = 1
  `).all() as { channelId: string }[];
  if (broken.length === 0) return;

  const missingAuthors = db.prepare(`
    SELECT DISTINCT msg.user_id AS userId
    FROM dm_messages msg
    JOIN users u ON u.id = msg.user_id
    WHERE msg.dm_channel_id = ?
      AND msg.user_id NOT IN (SELECT user_id FROM dm_members WHERE dm_channel_id = ?)
  `);

  let restored = 0;
  const run = db.transaction(() => {
    for (const { channelId } of broken) {
      const authors = missingAuthors.all(channelId, channelId) as { userId: string }[];
      for (const { userId } of authors) { insertDmMember(db, channelId, userId); restored++; }
    }
  });
  run();
  if (restored > 0) console.log(`[backfill] restored ${restored} deleted-partner DM membership row(s)`);
}

/**
 * Migration 0026 was originally published with an inverted journal timestamp
 * (earlier than 0025). When an upgrade encountered 0027, Drizzle recorded 0027's
 * timestamp in `__drizzle_migrations` and permanently skipped 0026.
 *
 * This function detects if 0026 was skipped (outbox exists without queue_key, but
 * migrations have already progressed past 0026), executes 0026's migration SQL,
 * and records it in `__drizzle_migrations`. Idempotent — no-op on healthy databases.
 */
export function healSkippedOutboxMigration(db: Database.Database, migrationsFolder: string): void {
  const outboxExists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'federation_outbox'").get();
  if (!outboxExists) return;

  const columns = db.prepare('PRAGMA table_info(federation_outbox)').all() as Array<{ name: string }>;
  const hasQueueKey = columns.some((col) => col.name === 'queue_key');
  if (hasQueueKey) return;

  const migrationsTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
  if (!migrationsTableExists) return;

  // If migrations have already recorded timestamps >= 0026's timestamp (1790860000000),
  // Drizzle's migrator will skip 0026 because max(created_at) is already past it.
  const OUTBOX_MIGRATION_TIMESTAMP = 1790860000000;
  const newerApplied = db.prepare('SELECT 1 FROM __drizzle_migrations WHERE created_at >= ? LIMIT 1').get(OUTBOX_MIGRATION_TIMESTAMP);
  if (!newerApplied) return;

  const fileName = fs.existsSync(path.join(migrationsFolder, '0021_outbox_queue_keys.sql'))
    ? '0021_outbox_queue_keys.sql'
    : '0026_outbox_queue_keys.sql';
  console.log(`[migrate] Detected skipped migration ${fileName}. Healing schema...`);
  const migrationPath = path.join(migrationsFolder, fileName);
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const hash = crypto.createHash('sha256').update(sql).digest('hex');
  const statements = sql.split(/-->\s*statement-breakpoint/).map((s) => s.trim()).filter(Boolean);

  const run = db.transaction(() => {
    for (const stmt of statements) {
      db.exec(stmt);
    }
    const alreadyRecorded = db.prepare('SELECT 1 FROM __drizzle_migrations WHERE hash = ? OR created_at = ?').get(hash, OUTBOX_MIGRATION_TIMESTAMP);
    if (!alreadyRecorded) {
      db.prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)').run(hash, OUTBOX_MIGRATION_TIMESTAMP);
    }
  });
  run();
  console.log('[migrate] Successfully healed migration 0026_outbox_queue_keys');
}

/**
 * Ensures required columns on messages and spaces exist even if legacy migration timestamps
 * caused 0029 or 0030 to be skipped during upgrade from older shapes (e.g. pre-squash).
 * Idempotent — no-op if columns already exist or if tables do not exist yet.
 *
 * Only columns of a migration the migrator can skip belong here: 0029 and 0030
 * carry journal timestamps older than 0028's, so a database that already
 * applied 0028 never runs them. A column of a migration the migrator still
 * runs must not be added here, or that migration stops the boot on
 * "duplicate column name" (see `PRE_ADDED_COLUMN_MIGRATIONS`).
 */
export function healLegacyColumns(db: Database.Database): void {
  const messagesTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
  if (messagesTable) {
    const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'type')) {
      db.exec("ALTER TABLE `messages` ADD `type` text DEFAULT 'user' NOT NULL");
    }
  }
  const spacesTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spaces'").get();
  if (spacesTable) {
    const cols = db.prepare("PRAGMA table_info('spaces')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'owner_title')) {
      db.exec("ALTER TABLE `spaces` ADD `owner_title` text DEFAULT NULL");
    }
  }
}

/** A migration that only adds columns, and that an earlier build added ahead of the migrator. */
interface PreAddedColumnMigration {
  /** The migration's file in the migrations folder. */
  file: string;
  /** The journal's `when` for it: the `created_at` the migrator records. */
  createdAt: number;
  table: string;
  /** Every column the migration adds. */
  columns: readonly string[];
}

/**
 * Migrations whose columns a past build added at boot before the migrator ran
 * them. On such a database the migrator's own ALTER TABLE stopped the boot on
 * "duplicate column name" and rolled back, leaving the columns in place and
 * the migration unrecorded, so every later boot stopped the same way.
 */
const PRE_ADDED_COLUMN_MIGRATIONS = {
  stickerSize: {
    file: '0035_max_sticker_size.sql',
    createdAt: 1792100000000,
    table: 'instance_settings',
    columns: ['max_sticker_size_bytes'],
  },
  systemChannel: {
    file: '0037_space_system_channel_and_welcome.sql',
    createdAt: 1792300000000,
    table: 'spaces',
    columns: ['system_channel_id', 'welcome_message'],
  },
} as const satisfies Record<string, PreAddedColumnMigration>;

/**
 * Records `migration` as applied when all of its columns are there and
 * `__drizzle_migrations` has no row for it, so the migrator does not run it
 * again. Returns whether it recorded anything. A no-op in every other state:
 * no table yet (first boot), a column missing (the migrator adds them; with
 * only some present it stops the boot, which is the state to look at by
 * hand), no migration history, or already recorded.
 */
function recordPreAddedColumnMigration(
  db: Database.Database,
  migrationsFolder: string,
  migration: PreAddedColumnMigration,
): boolean {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(migration.table);
  if (!table) return false;

  const present = new Set(
    (db.prepare('SELECT name FROM pragma_table_info(?)').all(migration.table) as Array<{ name: string }>).map((c) => c.name),
  );
  if (!migration.columns.every((column) => present.has(column))) return false;

  const migrationsTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
  if (!migrationsTableExists) return false;

  const alreadyRecorded = db.prepare('SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1').get(migration.createdAt);
  if (alreadyRecorded) return false;

  const migrationPath = path.join(migrationsFolder, migration.file);
  if (!fs.existsSync(migrationPath)) return false;

  const hash = crypto.createHash('sha256').update(fs.readFileSync(migrationPath, 'utf8')).digest('hex');
  db.prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)').run(hash, migration.createdAt);
  return true;
}

/**
 * If an earlier boot attempt ran with a build that added max_sticker_size_bytes to
 * instance_settings before migrate() crashed with a duplicate column error, the
 * column is already present but __drizzle_migrations lacks the 0035 entry.
 * Record 0035 so Drizzle migrator does not attempt to execute 0035_max_sticker_size.sql again.
 */
export function healSkippedStickerSizeMigration(db: Database.Database, migrationsFolder: string): void {
  if (recordPreAddedColumnMigration(db, migrationsFolder, PRE_ADDED_COLUMN_MIGRATIONS.stickerSize)) {
    console.log('[migrate] Detected pre-existing max_sticker_size_bytes. Backfilled migration 0035_max_sticker_size record.');
  }
}

/**
 * The same repair for 0037. Builds between the migration's introduction and
 * this fix added `spaces.system_channel_id` and `spaces.welcome_message` in
 * `healLegacyColumns`, ahead of the migrator, so a database upgraded with one
 * of them holds both columns and no 0037 record.
 */
export function healPreAddedSystemChannelMigration(db: Database.Database, migrationsFolder: string): void {
  if (recordPreAddedColumnMigration(db, migrationsFolder, PRE_ADDED_COLUMN_MIGRATIONS.systemChannel)) {
    console.log('[migrate] Detected pre-existing spaces.system_channel_id and welcome_message. Backfilled migration 0037_space_system_channel_and_welcome record.');
  }
}

