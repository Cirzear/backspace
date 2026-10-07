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
import { computePermissions } from '../utils/permissions.js';
import { PermissionBits, permissionsToString, stringToPermissions } from '@backspace/shared/src/permissions.js';

// #365: a role ranked below the actor may be edited even when a member ranked
// above the actor also holds it, as in Discord. The role hierarchy decides
// who may change a role, not who the change reaches; the held-bits rule still
// decides which bits. Moderating the senior member themselves (taking the role
// from them) stays refused. See docs/systems/permissions.md, "Lower roles held
// by senior members".

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'mod';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
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
const now = 1_700_000_000_000;

const { VIEW_CHANNEL, SEND_MESSAGES, MANAGE_ROLES, KICK_MEMBERS, ATTACH_FILES, BAN_MEMBERS } = PermissionBits;

let app: FastifyInstance;
type Res = Awaited<ReturnType<FastifyInstance['inject']>>;

function addMember(id: string, roleIds: string[]): void {
  testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: now }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId: id, joinedAt: now }).run();
  for (const roleId of roleIds) testDb.insert(schema.memberRoles).values({ spaceId: SPACE_ID, userId: id, roleId }).run();
}

function rolePermissions(roleId: string): bigint {
  return stringToPermissions(testDb.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get()?.permissions);
}

function rolesOf(userId: string): string[] {
  return testDb.select().from(schema.memberRoles)
    .where(and(eq(schema.memberRoles.spaceId, SPACE_ID), eq(schema.memberRoles.userId, userId)))
    .all().map(r => r.roleId).sort();
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  currentUserId = 'mod';

  testDb.insert(schema.users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: now }).run();
  testDb.insert(schema.spaces).values({
    id: SPACE_ID, name: 'Space', ownerId: 'owner', inviteCode: 'code', visibility: 'public', createdAt: now,
  }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId: 'owner', joinedAt: now }).run();

  // Highest first: Top 3, Mods 2 (the actor), Helpers 1, @everyone 0.
  testDb.insert(schema.roles).values([
    { id: SPACE_ID, spaceId: SPACE_ID, name: '@everyone', position: 0, permissions: permissionsToString(VIEW_CHANNEL | SEND_MESSAGES), createdAt: now },
    { id: 'r-top', spaceId: SPACE_ID, name: 'Top', position: 3, permissions: permissionsToString(BAN_MEMBERS), createdAt: now },
    { id: 'r-mod', spaceId: SPACE_ID, name: 'Mods', position: 2, permissions: permissionsToString(MANAGE_ROLES | KICK_MEMBERS | ATTACH_FILES), createdAt: now },
    { id: 'r-helper', spaceId: SPACE_ID, name: 'Helpers', position: 1, permissions: permissionsToString(KICK_MEMBERS | ATTACH_FILES), createdAt: now },
  ]).run();

  addMember('mod', ['r-mod']);
  // Ranked above the actor (Top), and also holds the lower Helpers role.
  addMember('boss', ['r-top', 'r-helper']);

  testDb.insert(schema.channels).values({ id: CHANNEL_ID, spaceId: SPACE_ID, name: 'general', type: 'text', position: 0, createdAt: now }).run();

  const { spaceRoutes } = await import('./spaces.js');
  const { channelRoutes } = await import('./channels.js');
  app = Fastify();
  await app.register(spaceRoutes);
  await app.register(channelRoutes);
});

function patchRole(roleId: string, permissions: bigint): Promise<Res> {
  return app.inject({
    method: 'PATCH',
    url: `/api/spaces/${SPACE_ID}/roles/${roleId}`,
    payload: { permissions: permissionsToString(permissions) },
  });
}

describe('a lower role that a member ranked above the actor also holds', () => {
  it('can have a held bit switched off, which reaches the senior member too', async () => {
    expect(computePermissions('boss', SPACE_ID) & KICK_MEMBERS).toBe(KICK_MEMBERS);
    expect((await patchRole('r-helper', ATTACH_FILES)).statusCode).toBe(200);
    expect(rolePermissions('r-helper')).toBe(ATTACH_FILES);
    expect(computePermissions('boss', SPACE_ID) & KICK_MEMBERS).toBe(0n);
  });

  it('can have a held bit switched on', async () => {
    expect((await patchRole('r-helper', KICK_MEMBERS | ATTACH_FILES | MANAGE_ROLES)).statusCode).toBe(200);
    expect(rolePermissions('r-helper')).toBe(KICK_MEMBERS | ATTACH_FILES | MANAGE_ROLES);
  });

  it('can get a channel override that denies its holders a held bit', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/channels/${CHANNEL_ID}/overrides`,
      payload: { targetType: 'role', targetId: 'r-helper', allow: '0', deny: permissionsToString(ATTACH_FILES) },
    });
    expect(res.statusCode).toBe(200);
    expect(computePermissions('boss', SPACE_ID, CHANNEL_ID) & ATTACH_FILES).toBe(0n);
  });

  it('can be deleted when the actor holds its bits', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/roles/r-helper` });
    expect(res.statusCode).toBe(200);
    expect(rolesOf('boss')).toEqual(['r-top']);
  });

  it('still follows the held-bits rule: an unheld bit is refused', async () => {
    const res = await patchRole('r-helper', KICK_MEMBERS | ATTACH_FILES | BAN_MEMBERS);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('cannot_grant_unowned_permissions');
  });

  it('does not let the actor moderate the senior member or edit their higher role', async () => {
    // Taking the role from the senior member acts on that member.
    const take = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/members/boss/roles/r-helper` });
    expect(take.statusCode).toBe(403);
    expect(take.json<{ code: string }>().code).toBe('role_hierarchy');
    expect(rolesOf('boss')).toEqual(['r-helper', 'r-top']);

    const top = await patchRole('r-top', 0n);
    expect(top.statusCode).toBe(403);
    expect(top.json<{ code: string }>().code).toBe('role_hierarchy');
  });
});
