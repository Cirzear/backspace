import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';
import { normalizeStoredPermissions } from './permissionStrings.js';

// The boot pass that rewrites stored permission values (#365): on a space
// seeded with roles and overrides in every stored form an old database can
// hold, `computePermissions` gives every member the same answer in the space
// and in every channel before and after the pass (docs/systems/permissions.md,
// "Stored form"). A negative value reads as every bit, defined or not, and
// becomes the defined bits, so the comparison is over the defined bits, which
// is all any permission check reads.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('./index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

const { computePermissions } = await import('../utils/permissions.js');

function applyMigrations(target: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) target.exec(clean);
    }
  }
}

const now = 1_700_000_000_000;
const SPACE = 's';
const hex = (bits: bigint) => `0x${bits.toString(16)}`;
const VIEW = PermissionBits.VIEW_CHANNEL;
const SEND = PermissionBits.SEND_MESSAGES;
const SPEAK = PermissionBits.SPEAK;
const CONNECT = PermissionBits.CONNECT;
const REACT = PermissionBits.ADD_REACTIONS;
const MANAGE = PermissionBits.MANAGE_MESSAGES;

const USERS = ['owner', 'instance-admin', 'plain', 'mod', 'helper', 'legacy', 'negative', 'muted', 'outsider'] as const;
const CHANNELS = ['general', 'staff', 'lounge', 'loose'] as const;

function seed(): void {
  const run = (sql: string, ...params: (string | number | null)[]) => sqlite.prepare(sql).run(...params);
  for (const id of USERS) {
    run('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)', id, id, 'x', id === 'instance-admin' ? 1 : 0, now);
  }
  run("INSERT INTO spaces (id, name, owner_id, invite_code, visibility, created_at) VALUES (?, 'S', 'owner', 'c', 'public', ?)", SPACE, now);
  for (const id of USERS) {
    if (id === 'outsider') continue;
    run('INSERT INTO space_members (space_id, user_id, joined_at) VALUES (?, ?, ?)', SPACE, id, now);
  }

  // Roles in every stored form: hex, padded, legacy name list, negative,
  // leading zeros, empty, NULL and unreadable text.
  const roles: [string, number, string | null][] = [
    [SPACE, 0, ` ${permissionsToString(VIEW | SEND | CONNECT)} `],
    ['r-mod', 7, hex(MANAGE | SPEAK)],
    ['r-helper', 6, '["ADD_REACTIONS","SPEAK","NOT_A_PERMISSION"]'],
    ['r-legacy', 5, `00${permissionsToString(REACT)}`],
    ['r-negative', 4, '-1'],
    ['r-empty', 3, ''],
    ['r-null', 2, null],
    ['r-garbage', 1, 'garbage'],
  ];
  for (const [id, position, permissions] of roles) {
    run('INSERT INTO roles (id, space_id, name, position, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, SPACE, id, position, permissions, now);
  }
  const memberRoles: [string, string][] = [
    ['mod', 'r-mod'], ['mod', 'r-empty'],
    ['helper', 'r-helper'], ['helper', 'r-null'],
    ['legacy', 'r-legacy'], ['legacy', 'r-garbage'],
    ['negative', 'r-negative'],
    ['muted', 'r-helper'],
  ];
  for (const [userId, roleId] of memberRoles) {
    run('INSERT INTO member_roles (space_id, user_id, role_id) VALUES (?, ?, ?)', SPACE, userId, roleId);
  }

  run("INSERT INTO channel_categories (id, space_id, name, position, created_at) VALUES ('cat-staff', ?, 'staff', 0, ?)", SPACE, now);
  run("INSERT INTO channel_categories (id, space_id, name, position, created_at) VALUES ('cat-voice', ?, 'voice', 1, ?)", SPACE, now);
  const channels: [string, string, string | null][] = [
    ['general', 'text', null],
    ['staff', 'text', 'cat-staff'],
    ['lounge', 'voice', 'cat-voice'],
    ['loose', 'text', 'cat-voice'],
  ];
  channels.forEach(([id, type, categoryId], position) => {
    run('INSERT INTO channels (id, space_id, name, type, position, category_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, SPACE, id, type, position, categoryId, now);
  });

  // Overrides at every tier, in the same stored forms.
  const categoryOverrides: [string, string, string, string, string][] = [
    ['cat-staff', 'role', SPACE, '', hex(VIEW)],
    ['cat-staff', 'role', 'r-mod', permissionsToString(VIEW), '0'],
    ['cat-staff', 'member', 'legacy', '["VIEW_CHANNEL"]', ' 0 '],
    ['cat-voice', 'role', 'r-helper', '0', '-1'],
    ['cat-voice', 'member', 'muted', hex(VIEW | CONNECT), permissionsToString(SPEAK)],
  ];
  for (const [categoryId, targetType, targetId, allow, deny] of categoryOverrides) {
    run('INSERT INTO category_overrides (category_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)', categoryId, targetType, targetId, allow, deny);
  }
  const channelOverrides: [string, string, string, string, string][] = [
    ['general', 'role', SPACE, '0', ` ${permissionsToString(REACT)}`],
    ['general', 'role', 'r-legacy', hex(MANAGE), '0'],
    ['staff', 'role', 'r-mod', '0', '["SEND_MESSAGES"]'],
    ['staff', 'member', 'helper', '-1', '0'],
    ['lounge', 'role', SPACE, '0', '0x0'],
    ['lounge', 'role', 'r-helper', permissionsToString(VIEW | CONNECT), hex(SPEAK)],
    ['lounge', 'member', 'negative', '0', '-8'],
    ['loose', 'role', 'r-negative', '0', 'garbage'],
  ];
  for (const [channelId, targetType, targetId, allow, deny] of channelOverrides) {
    run('INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)', channelId, targetType, targetId, allow, deny);
  }
}

/** Every member's defined bits in the space and in each channel, keyed `user/channel`. */
function resolvedPermissions(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const userId of USERS) {
    result[`${userId}/space`] = permissionsToString(computePermissions(userId, SPACE) & ALL_PERMISSIONS);
    for (const channelId of CHANNELS) {
      result[`${userId}/${channelId}`] = permissionsToString(computePermissions(userId, SPACE, channelId) & ALL_PERMISSIONS);
    }
  }
  return result;
}

function storedValues(): string[] {
  return [
    ...(sqlite.prepare('SELECT permissions AS v FROM roles').all() as { v: string | null }[]).map((r) => r.v ?? 'NULL'),
    ...(sqlite.prepare('SELECT allow AS v FROM channel_overrides UNION ALL SELECT deny FROM channel_overrides').all() as { v: string }[]).map((r) => r.v),
    ...(sqlite.prepare('SELECT allow AS v FROM category_overrides UNION ALL SELECT deny FROM category_overrides').all() as { v: string }[]).map((r) => r.v),
  ];
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  seed();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('normalizeStoredPermissions and permission resolution', () => {
  it('leaves every member\'s permissions in the space and in every channel as they were', () => {
    const before = resolvedPermissions();

    const rewritten = normalizeStoredPermissions(sqlite);

    expect(rewritten).toBeGreaterThan(0);
    expect(storedValues().every((v) => /^(0|[1-9][0-9]*)$/.test(v))).toBe(true);
    expect(resolvedPermissions()).toEqual(before);
  });

  it('resolves the seeded space to answers that depend on the stored values', () => {
    // Guards the comparison above against a seed that resolves to the same
    // answer everywhere: the stored forms are read, and they matter.
    const p = resolvedPermissions();
    expect(p['owner/staff']).toBe(permissionsToString(ALL_PERMISSIONS));
    expect(p['instance-admin/staff']).toBe(permissionsToString(ALL_PERMISSIONS));
    expect(p['negative/space']).toBe(permissionsToString(ALL_PERMISSIONS));
    expect(p['outsider/general']).toBe('0');
    expect(p['plain/general']).toBe(permissionsToString(VIEW | SEND | CONNECT));
    expect(p['plain/staff']).toBe(permissionsToString(SEND | CONNECT));
    expect(p['mod/staff']).toBe(permissionsToString(VIEW | CONNECT | MANAGE | SPEAK));
    expect(p['legacy/staff']).toBe(permissionsToString(VIEW | SEND | CONNECT | REACT));
    expect(p['legacy/general']).toBe(permissionsToString(VIEW | SEND | CONNECT | MANAGE));
    expect(p['helper/staff']).toBe(permissionsToString(ALL_PERMISSIONS));
    expect(p['helper/lounge']).toBe(permissionsToString(VIEW | CONNECT));
    expect(p['muted/lounge']).toBe(permissionsToString(VIEW | CONNECT));
  });

  it('gives the same answers after a second pass, which rewrites nothing', () => {
    normalizeStoredPermissions(sqlite);
    const once = resolvedPermissions();
    expect(normalizeStoredPermissions(sqlite)).toBe(0);
    expect(resolvedPermissions()).toEqual(once);
  });
});
