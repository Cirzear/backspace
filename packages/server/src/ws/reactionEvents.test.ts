import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ServerEvent } from '@backspace/shared';
import { PermissionBits } from '@backspace/shared/src/permissions.js';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import * as snowflake from '../utils/snowflake.js';

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const transport = vi.hoisted(() => ({
  sendToChannel: vi.fn<(spaceId: string, channelId: string, event: ServerEvent) => void>(),
  sendToDmMembers: vi.fn<(dmChannelId: string, event: ServerEvent) => void>(),
  sendToUser: vi.fn<(userId: string, event: ServerEvent) => void>(),
}));
const relay = vi.hoisted(() => ({
  appendMutationLog: vi.fn<typeof import('../utils/federationOutbox.js').appendMutationLog>(),
  queueOutboxEvent: vi.fn<typeof import('../utils/federationOutbox.js').queueOutboxEvent>(),
}));

vi.mock('../db/index.js', () => ({ getDb: () => db, schema }));
vi.mock('./connectionManager.js', () => ({ connectionManager: transport }));
vi.mock('../utils/federationAuth.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/federationAuth.js')>(),
  getOurOrigin: () => 'https://local.example',
}));
// Keep actual message-coordinate and recipient resolution; only delivery/log sinks are mocked.
vi.mock('../utils/federationOutbox.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/federationOutbox.js')>(),
  ...relay,
}));

import { handleClientEvent } from './events.js';

const ACTOR = 'local-federated-actor';
const OTHER_ACTOR = 'local-other-actor';
const HOME_ACTOR = 'actor-at-home';
const HOME_ORIGIN = 'https://home.example';
const SPACE = 'space';
const CHANNEL = 'chat';
const DM = 'dm';
const EMOJI = '👍';
const STICKER = `sticker:https://home.example/api/stickers/assets/${'a'.repeat(64)}.webp`;
type Kind = 'space' | 'dm';
const cases = (['space', 'dm'] as const).flatMap(kind => [
  { kind, label: 'emoji', emoji: EMOJI, messageId: `${kind}-message` },
  { kind, label: 'sticker', emoji: STICKER, messageId: `${kind}-message` },
]);
const ws = { send: vi.fn() } as unknown as WebSocket;

function send(event: Record<string, unknown>, userId = ACTOR): void {
  // The actor is authenticated locally even when the client owns a federated account.
  handleClientEvent(event, userId, userId, ws, userId === ACTOR);
}

function rows(kind: Kind) {
  return kind === 'space'
    ? db.select().from(schema.reactions).all()
    : db.select().from(schema.dmReactions).all();
}

function expectEffects(kind: Kind, count: number): void {
  expect(transport.sendToChannel).toHaveBeenCalledTimes(kind === 'space' ? count : 0);
  expect(transport.sendToDmMembers).toHaveBeenCalledTimes(kind === 'dm' ? count : 0);
  expect(relay.appendMutationLog).toHaveBeenCalledTimes(kind === 'dm' ? count : 0);
  expect(relay.queueOutboxEvent).toHaveBeenCalledTimes(kind === 'dm' ? count : 0);
}

beforeEach(() => {
  vi.resetAllMocks();
  snowflake.setWorkerId(1);
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema });
  // Exercise the production journal, including 0025; no test-only indexes substitute for it.
  migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  sqlite.pragma('foreign_keys = ON');
  db.insert(schema.users).values([
    { id: 'owner', username: 'owner', passwordHash: 'test-only', createdAt: 1 },
    { id: ACTOR, username: 'actor@home.example', passwordHash: 'test-only', homeUserId: HOME_ACTOR, homeInstance: HOME_ORIGIN, createdAt: 1 },
    { id: OTHER_ACTOR, username: 'other-actor', passwordHash: 'test-only', createdAt: 1 },
    { id: 'outsider', username: 'outsider', passwordHash: 'test-only', createdAt: 1 },
  ]).run();
  db.insert(schema.spaces).values({ id: SPACE, name: 'Space', ownerId: 'owner', createdAt: 1 }).run();
  db.insert(schema.spaceMembers).values([ACTOR, OTHER_ACTOR].map(userId => ({
    spaceId: SPACE, userId, joinedAt: 1,
  }))).run();
  db.insert(schema.roles).values({
    id: SPACE, spaceId: SPACE, name: '@everyone',
    permissions: String(PermissionBits.VIEW_CHANNEL | PermissionBits.ADD_REACTIONS), createdAt: 1,
  }).run();
  db.insert(schema.channels).values({ id: CHANNEL, spaceId: SPACE, name: 'Chat', type: 'text', createdAt: 1 }).run();
  db.insert(schema.messages).values(['space-message', 'space-other-message'].map(id => ({
    id, channelId: CHANNEL, userId: OTHER_ACTOR, content: 'hello', createdAt: 1,
  }))).run();
  db.insert(schema.dmChannels).values({ id: DM, federatedId: 'conversation-key', createdAt: 1 }).run();
  db.insert(schema.dmMembers).values([ACTOR, OTHER_ACTOR].map(userId => ({
    dmChannelId: DM, userId, joinedAt: 1,
  }))).run();
  db.insert(schema.dmMessages).values(['dm-message', 'dm-other-message'].map(id => ({
    id, dmChannelId: DM, userId: OTHER_ACTOR, content: 'hello', createdAt: 1,
    sourceMessageId: `source-${id}`, sourceInstance: 'https://message-origin.example',
  }))).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

describe.each(cases)('$kind $label reaction adds', ({ kind, emoji, messageId }) => {
  it('keeps one row and emits/logs/queues only the first add', () => {
    const event = { type: 'reaction_add', messageId, emoji, userId: 'forged-actor' };
    send(event);
    const first = rows(kind)[0]!;
    send(event);
    send(event);
    expect(rows(kind)).toEqual([first]);
    expect(first).toMatchObject({ userId: ACTOR, emoji });
    expectEffects(kind, 1);
    expect(transport.sendToUser).not.toHaveBeenCalled();
    const added = {
      type: 'reaction_added', messageId,
      reaction: expect.objectContaining({
        id: first.id, messageId, userId: ACTOR, emoji, createdAt: first.createdAt,
        user: expect.objectContaining({ id: ACTOR, homeUserId: HOME_ACTOR, homeInstance: HOME_ORIGIN }),
      }),
    };
    if (kind === 'space') {
      expect(transport.sendToChannel).toHaveBeenCalledWith(SPACE, CHANNEL, added);
      return;
    }
    expect(transport.sendToDmMembers).toHaveBeenCalledWith(DM, added);
    expect(relay.appendMutationLog).toHaveBeenCalledWith(messageId, DM, 'reaction_add', JSON.stringify({
      userId: ACTOR, homeUserId: HOME_ACTOR, homeInstance: HOME_ORIGIN, emoji, createdAt: first.createdAt,
    }));
    expect(relay.queueOutboxEvent).toHaveBeenCalledWith(first.id, DM, 'reaction_add', JSON.stringify({
      reaction: {
        messageId: `source-${messageId}`, messageHomeInstance: 'https://message-origin.example',
        userId: ACTOR, homeUserId: HOME_ACTOR, homeInstance: HOME_ORIGIN, emoji, createdAt: first.createdAt,
      },
    }), [HOME_ORIGIN]);
  });

  it('distinguishes actors, messages and exact emoji values', () => {
    send({ type: 'reaction_add', messageId, emoji });
    send({ type: 'reaction_add', messageId, emoji }, OTHER_ACTOR);
    send({ type: 'reaction_add', messageId: `${kind}-other-message`, emoji });
    send({ type: 'reaction_add', messageId, emoji: emoji === EMOJI ? STICKER : EMOJI });
    expect(rows(kind)).toHaveLength(4);
    expectEffects(kind, 4);
  });

  it('removes only the local actor and allows a fresh add after removal', () => {
    send({ type: 'reaction_add', messageId, emoji });
    send({ type: 'reaction_add', messageId, emoji }, OTHER_ACTOR);
    const first = rows(kind).find(row => row.userId === ACTOR)!;
    send({ type: 'reaction_remove', messageId, emoji, userId: OTHER_ACTOR });
    expect(rows(kind)).toEqual([expect.objectContaining({ userId: OTHER_ACTOR, emoji })]);
    send({ type: 'reaction_remove', messageId, emoji });
    expectEffects(kind, 3);
    send({ type: 'reaction_add', messageId, emoji });
    expect(rows(kind)).toHaveLength(2);
    expect(rows(kind).find(row => row.userId === ACTOR)!.id).not.toBe(first.id);
    expectEffects(kind, 4);
    if (kind === 'dm') {
      expect(relay.appendMutationLog.mock.calls.map(call => call[2])).toEqual([
        'reaction_add', 'reaction_add', 'reaction_remove', 'reaction_add',
      ]);
    }
  });

  it('rejects non-members without persistence or side effects', () => {
    send({ type: 'reaction_add', messageId, emoji }, 'outsider');
    send({ type: 'reaction_remove', messageId, emoji }, 'outsider');
    expect(rows(kind)).toHaveLength(0);
    expectEffects(kind, 0);
  });

  it('propagates unrelated SQLite failures instead of announcing success', () => {
    const table = kind === 'space' ? 'reactions' : 'dm_reactions';
    sqlite.exec(`CREATE TRIGGER reject_reaction BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'reaction storage failure'); END`);
    expect(() => send({ type: 'reaction_add', messageId, emoji })).toThrow('reaction storage failure');
    expect(rows(kind)).toHaveLength(0);
    expectEffects(kind, 0);
  });

  it('does not swallow a primary-key collision for a different reaction', () => {
    send({ type: 'reaction_add', messageId, emoji });
    const first = rows(kind)[0]!;
    vi.spyOn(snowflake, 'generateSnowflake').mockReturnValue(first.id);
    expect(() => send({ type: 'reaction_add', messageId: `${kind}-other-message`, emoji })).toThrow(/UNIQUE constraint failed/);
    expect(rows(kind)).toEqual([first]);
    expectEffects(kind, 1);
  });
});

describe('reaction authorization and boundary behavior', () => {
  it.each([EMOJI, STICKER])('checks channel ADD_REACTIONS even for an existing %s reaction', emoji => {
    send({ type: 'reaction_add', messageId: 'space-message', emoji });
    db.insert(schema.channelOverrides).values({
      channelId: CHANNEL, targetType: 'member', targetId: ACTOR,
      allow: '0', deny: String(PermissionBits.ADD_REACTIONS),
    }).run();
    send({ type: 'reaction_add', messageId: 'space-message', emoji });
    send({ type: 'reaction_add', messageId: 'space-other-message', emoji });
    expect(rows('space')).toHaveLength(1);
    expectEffects('space', 1);
    expect(transport.sendToUser).toHaveBeenCalledTimes(2);
    expect(transport.sendToUser).toHaveBeenCalledWith(ACTOR, {
      type: 'error', message: 'Missing ADD_REACTIONS permission',
    });
    // ADD_REACTIONS is not required to remove one's existing reaction.
    send({ type: 'reaction_remove', messageId: 'space-message', emoji });
    expect(rows('space')).toHaveLength(0);
    expectEffects('space', 2);
  });

  it.each([EMOJI, STICKER])('keeps a dead one-on-one read-only for %s adds and removals', emoji => {
    send({ type: 'reaction_add', messageId: 'dm-message', emoji });
    const first = rows('dm')[0]!;
    db.update(schema.users).set({ isDeleted: 1 }).where(eq(schema.users.id, OTHER_ACTOR)).run();
    send({ type: 'reaction_add', messageId: 'dm-message', emoji });
    send({ type: 'reaction_add', messageId: 'dm-other-message', emoji });
    send({ type: 'reaction_remove', messageId: 'dm-message', emoji });
    expect(rows('dm')).toEqual([first]);
    expectEffects('dm', 1);
  });

  it.each(['reaction_add', 'reaction_remove'])('retains missing-field and unknown-message handling for %s', type => {
    for (const fields of [{}, { messageId: 'space-message' }, { emoji: EMOJI }, { messageId: 'unknown', emoji: EMOJI }]) {
      send({ type, ...fields });
    }
    expect(rows('space')).toHaveLength(0);
    expect(rows('dm')).toHaveLength(0);
    expectEffects('space', 0);
    expect(transport.sendToUser).not.toHaveBeenCalled();
  });

  it('does not hide a federation-log failure behind duplicate handling', () => {
    relay.appendMutationLog.mockImplementationOnce(() => { throw new Error('mutation log unavailable'); });
    expect(() => send({ type: 'reaction_add', messageId: 'dm-message', emoji: EMOJI })).toThrow('mutation log unavailable');
    expect(rows('dm')).toHaveLength(1);
    expect(transport.sendToDmMembers).toHaveBeenCalledTimes(1);
    expect(relay.queueOutboxEvent).not.toHaveBeenCalled();
  });
});
