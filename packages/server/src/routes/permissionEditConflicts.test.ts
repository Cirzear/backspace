import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import {
  NO_OVERRIDE_VERSION,
  PermissionBits,
  overrideVersion,
  permissionsToString,
  rolePermissionsVersion,
  stringToPermissions,
} from '@backspace/shared/src/permissions.js';

// #365: two admins saving the same override or role at the same time. Each
// editor sends the version of the value it loaded; a write made from an
// outdated copy is refused with 409 instead of dropping the other admin's
// bits. A request without a version (a client from before the check) is not
// compared. See docs/systems/permissions.md, "Concurrent edits".

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = 'owner';
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    addUserSpace: vi.fn(),
    sendToSpace: vi.fn(),
    sendToChannel: vi.fn(),
    announceSpaceAccessChange: vi.fn(),
    sendToUser: vi.fn(),
    getUserSpaceEntries: () => new Map<string, Set<string>>().entries(),
  },
}));

vi.mock('../ws/events.js', () => ({
  checkVoicePermissions: vi.fn(),
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

const SPACE_ID = 'space-1';
const CHANNEL_ID = 'channel-1';
const CATEGORY_ID = 'category-1';
const ROLE_ID = 'r-mod';
const now = 1_700_000_000_000;

const { SEND_MESSAGES, ATTACH_FILES, ADD_REACTIONS, VIEW_CHANNEL, KICK_MEMBERS, BAN_MEMBERS } = PermissionBits;

let app: FastifyInstance;

type Res = Awaited<ReturnType<FastifyInstance['inject']>>;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  testDb.insert(schema.users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: now }).run();
  testDb.insert(schema.spaces).values({
    id: SPACE_ID, name: 'Space', ownerId: 'owner', inviteCode: 'code', visibility: 'public', createdAt: now,
  }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId: 'owner', joinedAt: now }).run();
  testDb.insert(schema.roles).values([
    { id: SPACE_ID, spaceId: SPACE_ID, name: '@everyone', position: 0, permissions: permissionsToString(VIEW_CHANNEL | SEND_MESSAGES), createdAt: now },
    { id: ROLE_ID, spaceId: SPACE_ID, name: 'Mods', position: 1, permissions: permissionsToString(KICK_MEMBERS), createdAt: now },
  ]).run();
  testDb.insert(schema.channelCategories).values({ id: CATEGORY_ID, spaceId: SPACE_ID, name: 'cat', position: 0, createdAt: now }).run();
  testDb.insert(schema.channels).values({ id: CHANNEL_ID, spaceId: SPACE_ID, name: 'general', type: 'text', position: 0, categoryId: CATEGORY_ID, createdAt: now }).run();

  const { spaceRoutes } = await import('./spaces.js');
  const { channelRoutes } = await import('./channels.js');
  app = Fastify();
  await app.register(spaceRoutes);
  await app.register(channelRoutes);
});

function expectConflict(res: Res, code: string): void {
  expect(res.statusCode).toBe(409);
  expect(res.json<{ code: string }>().code).toBe(code);
}

describe('edit versions', () => {
  it('are equal for equal bits and differ otherwise', () => {
    expect(overrideVersion({ allow: '1024', deny: '0' })).toBe(overrideVersion({ allow: '1024', deny: '0' }));
    expect(overrideVersion({ allow: '1024', deny: '0' })).not.toBe(overrideVersion({ allow: '0', deny: '1024' }));
    expect(overrideVersion({ allow: '0', deny: '0' })).not.toBe(NO_OVERRIDE_VERSION);
    expect(overrideVersion(undefined)).toBe(NO_OVERRIDE_VERSION);
    expect(rolePermissionsVersion('8')).toBe(rolePermissionsVersion('8'));
    expect(rolePermissionsVersion('8')).not.toBe(rolePermissionsVersion('9'));
  });

  it('read a stored value the way permission checks do', () => {
    // A legacy hex value means the same bits as its decimal form.
    expect(overrideVersion({ allow: '0x400', deny: '0' })).toBe(overrideVersion({ allow: '1024', deny: '0' }));
    expect(rolePermissionsVersion(null)).toBe(rolePermissionsVersion('0'));
  });
});

// The channel and category routes share the rule; each case runs on both.
const ENTITIES = [
  {
    kind: 'channel',
    base: `/api/channels/${CHANNEL_ID}/overrides`,
    stored: () => testDb.select().from(schema.channelOverrides).where(and(
      eq(schema.channelOverrides.channelId, CHANNEL_ID),
      eq(schema.channelOverrides.targetType, 'role'),
      eq(schema.channelOverrides.targetId, ROLE_ID),
    )).get(),
  },
  {
    kind: 'category',
    base: `/api/categories/${CATEGORY_ID}/overrides`,
    stored: () => testDb.select().from(schema.categoryOverrides).where(and(
      eq(schema.categoryOverrides.categoryId, CATEGORY_ID),
      eq(schema.categoryOverrides.targetType, 'role'),
      eq(schema.categoryOverrides.targetId, ROLE_ID),
    )).get(),
  },
] as const;

for (const entity of ENTITIES) {
  describe(`${entity.kind} overrides: concurrent edits`, () => {
    function put(allow: bigint, deny: bigint, version?: unknown): Promise<Res> {
      const payload: Record<string, unknown> = {
        targetType: 'role', targetId: ROLE_ID, allow: permissionsToString(allow), deny: permissionsToString(deny),
      };
      if (version !== undefined) payload.version = version;
      return app.inject({ method: 'PUT', url: entity.base, payload });
    }

    function remove(version?: string): Promise<Res> {
      const query = version === undefined ? '' : `?version=${encodeURIComponent(version)}`;
      return app.inject({ method: 'DELETE', url: `${entity.base}/role/${ROLE_ID}${query}` });
    }

    async function listedVersion(): Promise<string | undefined> {
      const res = await app.inject({ method: 'GET', url: entity.base });
      expect(res.statusCode).toBe(200);
      const rows = res.json<{ targetId: string; version: string }[]>();
      return rows.find((r) => r.targetId === ROLE_ID)?.version;
    }

    function storedBits(): { allow: bigint; deny: bigint } | null {
      const row = entity.stored();
      return row ? { allow: stringToPermissions(row.allow), deny: stringToPermissions(row.deny) } : null;
    }

    it('lists each row with its version, and a write answers the new one', async () => {
      const created = await put(SEND_MESSAGES, 0n, NO_OVERRIDE_VERSION);
      expect(created.statusCode).toBe(200);
      const listed = await listedVersion();
      expect(listed).toBe(overrideVersion({ allow: permissionsToString(SEND_MESSAGES), deny: '0' }));
      expect(created.json<{ version: string }>().version).toBe(listed);
    });

    it('refuses the later of two saves made from the same row, and keeps the first', async () => {
      await put(SEND_MESSAGES, 0n);
      const loaded = await listedVersion();

      // Admin A allows Attach Files, admin B (same copy) denies Add Reactions.
      expect((await put(SEND_MESSAGES | ATTACH_FILES, 0n, loaded)).statusCode).toBe(200);
      expectConflict(await put(SEND_MESSAGES, ADD_REACTIONS, loaded), 'overrides_conflict');
      expect(storedBits()).toEqual({ allow: SEND_MESSAGES | ATTACH_FILES, deny: 0n });

      // B reloads and saves again from the current row, keeping A's bit.
      const reloaded = await listedVersion();
      expect((await put(SEND_MESSAGES | ATTACH_FILES, ADD_REACTIONS, reloaded)).statusCode).toBe(200);
      expect(storedBits()).toEqual({ allow: SEND_MESSAGES | ATTACH_FILES, deny: ADD_REACTIONS });
    });

    it('refuses creating a row another admin created meanwhile', async () => {
      expect((await put(SEND_MESSAGES, 0n, NO_OVERRIDE_VERSION)).statusCode).toBe(200);
      expectConflict(await put(0n, SEND_MESSAGES, NO_OVERRIDE_VERSION), 'overrides_conflict');
      expect(storedBits()).toEqual({ allow: SEND_MESSAGES, deny: 0n });
    });

    it('accepts a row that changed and changed back: nothing is lost', async () => {
      await put(SEND_MESSAGES, 0n);
      const loaded = await listedVersion();
      await put(ATTACH_FILES, 0n);
      await put(SEND_MESSAGES, 0n);
      expect((await put(SEND_MESSAGES, ADD_REACTIONS, loaded)).statusCode).toBe(200);
    });

    it('writes unconditionally without a version, as clients from before the check do', async () => {
      await put(SEND_MESSAGES, 0n);
      expect((await put(ATTACH_FILES, 0n)).statusCode).toBe(200);
      expect(storedBits()).toEqual({ allow: ATTACH_FILES, deny: 0n });
    });

    it('refuses a version that is not a string', async () => {
      const res = await put(SEND_MESSAGES, 0n, 42);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('validation_failed');
      expect(storedBits()).toBeNull();
    });

    it('refuses deleting a row that changed since it was loaded, and deletes a current one', async () => {
      await put(SEND_MESSAGES, 0n);
      const loaded = await listedVersion();
      await put(ATTACH_FILES, 0n);

      expectConflict(await remove(loaded), 'overrides_conflict');
      expect(storedBits()).toEqual({ allow: ATTACH_FILES, deny: 0n });

      const current = await listedVersion();
      expect((await remove(current)).statusCode).toBe(200);
      expect(storedBits()).toBeNull();
    });

    it('answers a delete of a row already gone with success, versioned or not', async () => {
      await put(SEND_MESSAGES, 0n);
      const loaded = await listedVersion();
      expect((await remove()).statusCode).toBe(200);
      expect((await remove(loaded)).statusCode).toBe(200);
    });
  });
}

describe('role permissions: concurrent edits', () => {
  function patch(payload: Record<string, unknown>): Promise<Res> {
    return app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/${ROLE_ID}`, payload });
  }

  function stored(): bigint {
    const row = testDb.select().from(schema.roles).where(eq(schema.roles.id, ROLE_ID)).get();
    return stringToPermissions(row?.permissions);
  }

  it('refuses the later of two saves made from the same permissions, and keeps the first', async () => {
    const loaded = rolePermissionsVersion(permissionsToString(KICK_MEMBERS));
    expect((await patch({ permissions: permissionsToString(KICK_MEMBERS | BAN_MEMBERS), permissionsVersion: loaded })).statusCode).toBe(200);
    expectConflict(await patch({ permissions: '0', permissionsVersion: loaded }), 'role_permissions_conflict');
    expect(stored()).toBe(KICK_MEMBERS | BAN_MEMBERS);
  });

  it('refuses the whole request on a conflict, name included', async () => {
    await patch({ permissions: permissionsToString(BAN_MEMBERS) });
    const res = await patch({
      name: 'Renamed',
      permissions: '0',
      permissionsVersion: rolePermissionsVersion(permissionsToString(KICK_MEMBERS)),
    });
    expectConflict(res, 'role_permissions_conflict');
    const row = testDb.select().from(schema.roles).where(eq(schema.roles.id, ROLE_ID)).get();
    expect(row?.name).toBe('Mods');
  });

  it('writes unconditionally without permissionsVersion, and ignores it without permissions', async () => {
    expect((await patch({ permissions: permissionsToString(BAN_MEMBERS) })).statusCode).toBe(200);
    expect(stored()).toBe(BAN_MEMBERS);
    const res = await patch({ name: 'Renamed', permissionsVersion: rolePermissionsVersion('0') });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a permissionsVersion that is not a string', async () => {
    const res = await patch({ permissions: '0', permissionsVersion: 7 });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('validation_failed');
    expect(stored()).toBe(KICK_MEMBERS);
  });
});
