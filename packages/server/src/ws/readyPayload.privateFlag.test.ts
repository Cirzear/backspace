import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';
import type { SpaceWithChannelsAndMembers } from '@backspace/shared';

// The ready payload marks channels and categories private with the same rule
// as the space detail and the broadcasts (`isHiddenFromEveryone`, #365): the
// @everyone override of that entity's own space denies View Channels. It reads
// the overrides of all the user's spaces in one pass, so an override whose
// target is another space's @everyone must not count.

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;
let sqlite: Database.Database;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const OWNER_ID = 'owner';
const now = 1_700_000_000_000;
const VIEW = permissionsToString(PermissionBits.VIEW_CHANNEL);

function seedSpace(spaceId: string): void {
  testDb.insert(schema.spaces).values({
    id: spaceId, name: spaceId, ownerId: OWNER_ID, inviteCode: `inv-${spaceId}`, visibility: 'public', createdAt: now,
  }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId, userId: OWNER_ID, joinedAt: now }).run();
  testDb.insert(schema.roles).values({ id: spaceId, spaceId, name: '@everyone', position: 0, permissions: VIEW, createdAt: now }).run();
  testDb.insert(schema.channelCategories).values({ id: `${spaceId}-cat`, spaceId, name: 'cat', position: 0, createdAt: now }).run();
  testDb.insert(schema.channels).values({ id: `${spaceId}-ch`, spaceId, name: 'general', type: 'text', position: 0, categoryId: `${spaceId}-cat`, createdAt: now }).run();
}

function override(table: 'channel_overrides' | 'category_overrides', entityId: string, targetType: string, targetId: string, deny: string): void {
  const column = table === 'channel_overrides' ? 'channel_id' : 'category_id';
  sqlite.prepare(`INSERT INTO ${table} (${column}, target_type, target_id, allow, deny) VALUES (?, ?, ?, '0', ?)`)
    .run(entityId, targetType, targetId, deny);
}

interface ReadyMessage {
  spaces: SpaceWithChannelsAndMembers[];
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  testDb.insert(schema.users).values({ id: OWNER_ID, username: OWNER_ID, passwordHash: 'x', createdAt: now }).run();
  seedSpace('a');
  seedSpace('b');
});

async function readyFlags(): Promise<{ channels: Record<string, boolean | undefined>; categories: Record<string, boolean | undefined> }> {
  const { buildReadyPayload } = await import('./handler.js');
  const message = JSON.parse(JSON.stringify(buildReadyPayload(OWNER_ID))) as ReadyMessage;
  const channels: Record<string, boolean | undefined> = {};
  const categories: Record<string, boolean | undefined> = {};
  for (const space of message.spaces) {
    for (const ch of space.channels) channels[ch.id] = ch.isPrivate;
    for (const cat of space.categories ?? []) categories[cat.id] = cat.isPrivate;
  }
  return { channels, categories };
}

describe('ready payload private flags', () => {
  it('marks a channel and a category private by their own space\'s @everyone override', async () => {
    override('channel_overrides', 'a-ch', 'role', 'a', VIEW);
    override('category_overrides', 'b-cat', 'role', 'b', '["VIEW_CHANNEL"]');

    expect(await readyFlags()).toEqual({
      channels: { 'a-ch': true, 'b-ch': false },
      categories: { 'a-cat': false, 'b-cat': true },
    });
  });

  it('does not count an override on another space\'s @everyone, a member override, or another bit', async () => {
    override('channel_overrides', 'a-ch', 'role', 'b', VIEW);
    override('category_overrides', 'a-cat', 'role', 'b', VIEW);
    override('channel_overrides', 'b-ch', 'member', 'b', VIEW);
    override('category_overrides', 'b-cat', 'role', 'b', permissionsToString(PermissionBits.SEND_MESSAGES));

    expect(await readyFlags()).toEqual({
      channels: { 'a-ch': false, 'b-ch': false },
      categories: { 'a-cat': false, 'b-cat': false },
    });
  });
});
