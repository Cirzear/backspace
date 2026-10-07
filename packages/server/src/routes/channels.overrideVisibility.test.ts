import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';

// Who can see a channel changes with an override on it or on its category, and
// with a move to another category (#365). Every such change tells each
// connected member where the channel now stands for them, and a member who can
// see a voice channel among them is sent the space's voice state, since
// channel_updated and channel_layout_updated carry no voice presence. The
// lock icon comes from one rule (`isHiddenFromEveryone`) in every payload.

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

interface SentEvent {
  type: string;
  channelId?: string;
  channel?: { id: string; isPrivate?: boolean };
  channels?: { id: string; isPrivate?: boolean }[];
  categories?: { id: string; isPrivate?: boolean }[];
}

const sendToUser = vi.fn<(userId: string, event: SentEvent) => void>();
const sendToSpace = vi.fn<(spaceId: string, event: SentEvent) => void>();
const pushSpaceVoiceState = vi.fn<(userId: string, spaceId: string) => void>();
const checkVoicePermissions = vi.fn<(spaceId: string) => void>();

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    addUserSpace: vi.fn(),
    announceSpaceAccessChange: vi.fn(),
    sendToSpace: (spaceId: string, event: SentEvent) => sendToSpace(spaceId, event),
    sendToChannel: vi.fn(),
    sendToUser: (userId: string, event: SentEvent) => sendToUser(userId, event),
    pushSpaceVoiceState: (userId: string, spaceId: string) => pushSpaceVoiceState(userId, spaceId),
    getUserSpaceEntries: () => new Map([
      ['owner', new Set([SPACE_ID])],
      ['member', new Set([SPACE_ID])],
    ]).entries(),
  },
}));

vi.mock('../ws/events.js', () => ({
  checkVoicePermissions: (spaceId: string) => checkVoicePermissions(spaceId),
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
const CATEGORY_ID = 'category-1';
const OPEN_CATEGORY_ID = 'category-open';
const TEXT_ID = 'text-1';
const VOICE_ID = 'voice-1';
const VOICE_2_ID = 'voice-2';
const now = 1_700_000_000_000;
const VIEW = permissionsToString(PermissionBits.VIEW_CHANNEL);

let app: FastifyInstance;

beforeEach(async () => {
  sendToUser.mockClear();
  sendToSpace.mockClear();
  pushSpaceVoiceState.mockClear();
  checkVoicePermissions.mockClear();
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  for (const id of ['owner', 'member']) {
    testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: now }).run();
  }
  testDb.insert(schema.spaces).values({
    id: SPACE_ID, name: 'Space', ownerId: 'owner', inviteCode: 'code', visibility: 'public', createdAt: now,
  }).run();
  for (const userId of ['owner', 'member']) {
    testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId, joinedAt: now }).run();
  }
  testDb.insert(schema.roles).values({
    id: SPACE_ID, spaceId: SPACE_ID, name: '@everyone', position: 0,
    permissions: permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES | PermissionBits.CONNECT),
    createdAt: now,
  }).run();
  testDb.insert(schema.channelCategories).values([
    { id: CATEGORY_ID, spaceId: SPACE_ID, name: 'staff', position: 0, createdAt: now },
    { id: OPEN_CATEGORY_ID, spaceId: SPACE_ID, name: 'open', position: 1, createdAt: now },
  ]).run();
  testDb.insert(schema.channels).values([
    { id: TEXT_ID, spaceId: SPACE_ID, name: 'general', type: 'text', position: 0, categoryId: CATEGORY_ID, createdAt: now },
    { id: VOICE_ID, spaceId: SPACE_ID, name: 'lounge', type: 'voice', position: 1, categoryId: CATEGORY_ID, createdAt: now },
    { id: VOICE_2_ID, spaceId: SPACE_ID, name: 'stage', type: 'voice', position: 2, categoryId: CATEGORY_ID, createdAt: now },
  ]).run();

  const { spaceRoutes } = await import('./spaces.js');
  const { channelRoutes } = await import('./channels.js');
  app = Fastify();
  await app.register(spaceRoutes);
  await app.register(channelRoutes);
});

function eventsTo(userId: string, type: string): SentEvent[] {
  return sendToUser.mock.calls.filter(([uid, event]) => uid === userId && event.type === type).map(([, event]) => event);
}

function pushedTo(): string[] {
  return pushSpaceVoiceState.mock.calls.map(([userId, spaceId]) => `${userId}@${spaceId}`).sort();
}

describe('channel override changes and voice presence', () => {
  it('sends the voice state to every member who can see a voice channel after its override changes', async () => {
    testDb.insert(schema.channelOverrides).values({ channelId: VOICE_ID, targetType: 'role', targetId: SPACE_ID, allow: '0', deny: VIEW }).run();

    // Making the channel public again shows it to the member.
    const res = await app.inject({ method: 'DELETE', url: `/api/channels/${VOICE_ID}/overrides/role/${SPACE_ID}` });

    expect(res.statusCode).toBe(200);
    expect(eventsTo('member', 'channel_updated').map((e) => e.channel?.id)).toEqual([VOICE_ID]);
    expect(pushedTo()).toEqual([`member@${SPACE_ID}`, `owner@${SPACE_ID}`]);
    expect(checkVoicePermissions).toHaveBeenCalledWith(SPACE_ID);
  });

  it('sends no voice state to a member who can no longer see the voice channel', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/channels/${VOICE_ID}/overrides`,
      payload: { targetType: 'role', targetId: SPACE_ID, allow: '0', deny: VIEW },
    });

    expect(res.statusCode).toBe(200);
    expect(eventsTo('member', 'channel_deleted').map((e) => e.channelId)).toEqual([VOICE_ID]);
    // The owner still sees it (and is told it is private now); the member is not sent voice state.
    expect(eventsTo('owner', 'channel_updated')).toEqual([expect.objectContaining({ channel: expect.objectContaining({ id: VOICE_ID, isPrivate: true }) })]);
    expect(pushedTo()).toEqual([`owner@${SPACE_ID}`]);
  });

  it('sends no voice state for a text channel', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/channels/${TEXT_ID}/overrides`,
      payload: { targetType: 'role', targetId: SPACE_ID, allow: '0', deny: permissionsToString(PermissionBits.SEND_MESSAGES) },
    });

    expect(res.statusCode).toBe(200);
    expect(eventsTo('member', 'channel_updated').map((e) => e.channel?.id)).toEqual([TEXT_ID]);
    expect(pushSpaceVoiceState).not.toHaveBeenCalled();
  });

  it('sends one voice state per member for a category override that reaches several voice channels', async () => {
    testDb.insert(schema.categoryOverrides).values({ categoryId: CATEGORY_ID, targetType: 'role', targetId: SPACE_ID, allow: '0', deny: VIEW }).run();

    const res = await app.inject({ method: 'DELETE', url: `/api/categories/${CATEGORY_ID}/overrides/role/${SPACE_ID}` });

    expect(res.statusCode).toBe(200);
    expect(eventsTo('member', 'channel_updated').map((e) => e.channel?.id).sort()).toEqual([TEXT_ID, VOICE_ID, VOICE_2_ID]);
    expect(pushedTo()).toEqual([`member@${SPACE_ID}`, `owner@${SPACE_ID}`]);
    expect(sendToSpace).toHaveBeenCalledWith(SPACE_ID, expect.objectContaining({
      type: 'category_updated', category: expect.objectContaining({ id: CATEGORY_ID, isPrivate: false }),
    }));
  });
});

describe('category moves and voice presence', () => {
  beforeEach(() => {
    testDb.insert(schema.categoryOverrides).values({ categoryId: CATEGORY_ID, targetType: 'role', targetId: SPACE_ID, allow: '0', deny: VIEW }).run();
  });

  it('a layout change that moves a voice channel out of a private category sends the voice state', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/spaces/${SPACE_ID}/channel-layout`,
      payload: {
        channels: [
          { id: TEXT_ID, position: 0, categoryId: CATEGORY_ID },
          { id: VOICE_ID, position: 1, categoryId: OPEN_CATEGORY_ID },
          { id: VOICE_2_ID, position: 2, categoryId: CATEGORY_ID },
        ],
        categories: [{ id: CATEGORY_ID, position: 0 }, { id: OPEN_CATEGORY_ID, position: 1 }],
      },
    });

    expect(res.statusCode).toBe(200);
    const [layout] = eventsTo('member', 'channel_layout_updated');
    expect(layout?.channels?.map((c) => c.id)).toEqual([VOICE_ID]);
    expect(layout?.categories?.find((c) => c.id === CATEGORY_ID)?.isPrivate).toBe(true);
    expect(layout?.categories?.find((c) => c.id === OPEN_CATEGORY_ID)?.isPrivate).toBe(false);
    expect(pushedTo()).toEqual([`member@${SPACE_ID}`, `owner@${SPACE_ID}`]);
    expect(checkVoicePermissions).toHaveBeenCalledWith(SPACE_ID);
  });

  it('a layout change that only reorders sends no voice state', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/spaces/${SPACE_ID}/channel-layout`,
      payload: {
        channels: [
          { id: VOICE_ID, position: 0, categoryId: CATEGORY_ID },
          { id: TEXT_ID, position: 1, categoryId: CATEGORY_ID },
          { id: VOICE_2_ID, position: 2, categoryId: CATEGORY_ID },
        ],
        categories: [],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(eventsTo('member', 'channel_layout_updated')).toHaveLength(1);
    expect(pushSpaceVoiceState).not.toHaveBeenCalled();
    expect(checkVoicePermissions).not.toHaveBeenCalled();
  });

  it('deleting a private category sends the voice state for the voice channels it held', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/categories/${CATEGORY_ID}` });

    expect(res.statusCode).toBe(200);
    const [layout] = eventsTo('member', 'channel_layout_updated');
    expect(layout?.channels?.map((c) => c.id).sort()).toEqual([TEXT_ID, VOICE_ID, VOICE_2_ID]);
    expect(pushedTo()).toEqual([`member@${SPACE_ID}`, `owner@${SPACE_ID}`]);
    expect(checkVoicePermissions).toHaveBeenCalledWith(SPACE_ID);
  });

  it('moving a voice channel with PATCH /api/channels/:id sends the voice state', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/channels/${VOICE_ID}`, payload: { categoryId: null } });

    expect(res.statusCode).toBe(200);
    expect(eventsTo('member', 'channel_updated').map((e) => e.channel?.id)).toEqual([VOICE_ID]);
    expect(pushedTo()).toEqual([`member@${SPACE_ID}`, `owner@${SPACE_ID}`]);
  });
});

describe('the private flag', () => {
  it('reads the @everyone override of each entity the same way in the space detail and the broadcasts', async () => {
    // A stored deny in a legacy form still means View Channels is denied.
    sqlite.prepare("INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, 'role', ?, '0', ?)")
      .run(TEXT_ID, SPACE_ID, '["VIEW_CHANNEL"]');
    // A member override whose id equals the space id is not @everyone.
    sqlite.prepare("INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, 'member', ?, '0', ?)")
      .run(VOICE_ID, SPACE_ID, VIEW);
    sqlite.prepare("INSERT INTO category_overrides (category_id, target_type, target_id, allow, deny) VALUES (?, 'role', ?, '0', ?)")
      .run(OPEN_CATEGORY_ID, SPACE_ID, VIEW);

    const detail = await app.inject({ method: 'GET', url: `/api/spaces/${SPACE_ID}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json<{ channels: { id: string; isPrivate: boolean }[]; categories: { id: string; isPrivate: boolean }[] }>();
    const detailChannels = Object.fromEntries(body.channels.map((c) => [c.id, c.isPrivate]));
    const detailCategories = Object.fromEntries(body.categories.map((c) => [c.id, c.isPrivate]));
    expect(detailChannels).toEqual({ [TEXT_ID]: true, [VOICE_ID]: false, [VOICE_2_ID]: false });
    expect(detailCategories).toEqual({ [CATEGORY_ID]: false, [OPEN_CATEGORY_ID]: true });

    // The layout broadcast agrees with the detail.
    await app.inject({ method: 'DELETE', url: `/api/categories/${CATEGORY_ID}` });
    const [layout] = eventsTo('owner', 'channel_layout_updated');
    expect(Object.fromEntries((layout?.channels ?? []).map((c) => [c.id, c.isPrivate]))).toEqual(detailChannels);
    expect(layout?.categories?.find((c) => c.id === OPEN_CATEGORY_ID)?.isPrivate).toBe(true);
  });
});
