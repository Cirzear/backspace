import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

interface DrizzleJournal { entries: Array<{ idx: number; tag: string; when: number }>; }

/**
 * True when migrations are pending. Drizzle's better-sqlite3 migrator executes
 * every journal migration whose `when` timestamp is greater than the maximum
 * `created_at` in `__drizzle_migrations`. Comparing `MAX(created_at)` to the newest
 * journal entry timestamp accurately predicts whether `migrate()` will apply anything.
 * A missing table means a pre-drizzle or empty DB: treat as pending.
 */
export function hasPendingMigrations(db: Database.Database, migrationsFolder: string): boolean {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as DrizzleJournal;

  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (!tableExists) return true;

  const last = db.prepare('SELECT MAX(created_at) AS t FROM __drizzle_migrations').get() as { t: number | null };
  const newest = Math.max(...journal.entries.map((e) => e.when));
  return (last.t ?? 0) < newest;
}
