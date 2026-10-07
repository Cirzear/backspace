import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { oneOnOneKey } from './dmConversation.js';
import { getOurOrigin } from './federationAuth.js';
import { setWorkerId } from './snowflake.js';

setWorkerId(17);

// Detached accounts are homed here (#310): detaching rewrites the row so that
// every outbound path presents the account as one of this instance's users,
// and every inbound path resolves both that identity and the former one to
// the same row.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
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

const OUR_ORIGIN = getOurOrigin();
const OUR_DOMAIN = new URL(OUR_ORIGIN).hostname;
const RESET_DOMAIN = 'reset.example';
const DETACHED = 'detached-1';
const FORMER_ID = 'old-home-uid';

/** The detached account as detaching before #310 left it: flagged, home pair kept. */
function insertLegacyDetached(overrides: Partial<typeof schema.users.$inferInsert> = {}): void {
  testDb.insert(schema.users).values({
    id: DETACHED,
    username: `kai@${RESET_DOMAIN}`,
    passwordHash: 'real-hash',
    status: 'online',
    homeInstance: RESET_DOMAIN,
    homeUserId: FORMER_ID,
    federationHomeOrphaned: 1,
    createdAt: 1,
    ...overrides,
  }).run();
}

function insertUser(row: Partial<typeof schema.users.$inferInsert> & { id: string; username: string }): void {
  testDb.insert(schema.users).values({ passwordHash: 'x', createdAt: 1, ...row }).run();
}

function userRow(id: string): typeof schema.users.$inferSelect {
  return testDb.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  insertUser({ id: 'alice', username: 'alice' });
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

describe('rehomeDetachedAccount', () => {
  it('moves the former identity aside and homes the account here', async () => {
    insertLegacyDetached();
    const { rehomeDetachedAccount } = await import('./detachedIdentity.js');
    const result = rehomeDetachedAccount(sqlite, DETACHED, OUR_ORIGIN);
    expect(result?.userId).toBe(DETACHED);

    const row = userRow(DETACHED);
    expect(row.homeInstance).toBeNull();
    expect(row.homeUserId).toBeNull();
    expect(row.detachedHomeInstance).toBe(RESET_DOMAIN);
    expect(row.detachedHomeUserId).toBe(FORMER_ID);
    // Still detached, with its login name and credentials.
    expect(row.federationHomeOrphaned).toBe(1);
    expect(row.username).toBe(`kai@${RESET_DOMAIN}`);
    expect(row.passwordHash).toBe('real-hash');
  });

  it('is idempotent and leaves every other kind of row alone', async () => {
    insertLegacyDetached();
    insertUser({ id: 'fed', username: `lee@${RESET_DOMAIN}`, passwordHash: 'real', homeInstance: RESET_DOMAIN, homeUserId: 'lee-home' });
    insertUser({ id: 'stub', username: `max@${RESET_DOMAIN}`, passwordHash: '!federation-replicated', homeInstance: RESET_DOMAIN, homeUserId: 'max-home' });
    insertUser({ id: 'gone', username: '!deleted:gone', homeInstance: RESET_DOMAIN, homeUserId: 'gone-home', federationHomeOrphaned: 1, isDeleted: 1 });
    const { rehomeDetachedAccount } = await import('./detachedIdentity.js');

    expect(rehomeDetachedAccount(sqlite, DETACHED, OUR_ORIGIN)).not.toBeNull();
    expect(rehomeDetachedAccount(sqlite, DETACHED, OUR_ORIGIN)).toBeNull();
    expect(userRow(DETACHED).detachedHomeUserId).toBe(FORMER_ID);

    for (const id of ['fed', 'stub', 'gone', 'alice']) {
      expect(rehomeDetachedAccount(sqlite, id, OUR_ORIGIN)).toBeNull();
    }
    expect(userRow('fed').homeInstance).toBe(RESET_DOMAIN);
    expect(userRow('stub').homeUserId).toBe('max-home');
    expect(userRow('gone').homeInstance).toBe(RESET_DOMAIN);
  });

  it('gives the groups it owns this instance as owner home', async () => {
    insertLegacyDetached();
    testDb.insert(schema.dmChannels).values([
      { id: 'grp-fed', ownerId: DETACHED, ownerHomeUserId: FORMER_ID, ownerHomeInstance: `https://${RESET_DOMAIN}`, federatedId: 'g-1', createdAt: 1 },
      { id: 'grp-local', ownerId: DETACHED, ownerHomeUserId: null, ownerHomeInstance: null, federatedId: null, createdAt: 1 },
      { id: 'grp-alice', ownerId: 'alice', ownerHomeUserId: 'alice', ownerHomeInstance: OUR_ORIGIN, federatedId: 'g-2', createdAt: 1 },
    ]).run();
    const { rehomeDetachedAccount } = await import('./detachedIdentity.js');
    rehomeDetachedAccount(sqlite, DETACHED, OUR_ORIGIN);

    const owners = Object.fromEntries(testDb.select().from(schema.dmChannels).all()
      .map(c => [c.id, [c.ownerHomeUserId, c.ownerHomeInstance]]));
    expect(owners['grp-fed']).toEqual([DETACHED, OUR_ORIGIN]);
    expect(owners['grp-local']).toEqual([null, null]);
    expect(owners['grp-alice']).toEqual(['alice', OUR_ORIGIN]);
  });

  it('re-keys its 1-on-1 to the key of its identity here', async () => {
    insertLegacyDetached();
    const formerKey = oneOnOneKey({ id: 'alice', homeUserId: null }, { id: DETACHED, homeUserId: FORMER_ID });
    testDb.insert(schema.dmChannels).values({ id: 'dm-1', federatedId: formerKey, createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'dm-1', userId: 'alice', closed: 0 },
      { dmChannelId: 'dm-1', userId: DETACHED, closed: 0 },
    ]).run();
    const { rehomeDetachedAccount } = await import('./detachedIdentity.js');
    const result = rehomeDetachedAccount(sqlite, DETACHED, OUR_ORIGIN)!;

    const newKey = oneOnOneKey({ id: 'alice', homeUserId: null }, { id: DETACHED, homeUserId: null });
    expect(testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'dm-1')).get()!.federatedId).toBe(newKey);
    expect(result.reconciled.map(r => [r.action, r.channelId])).toEqual([['rekeyed', 'dm-1']]);
  });

  it('merges its 1-on-1 into a row that already holds the new key', async () => {
    insertLegacyDetached();
    const formerKey = oneOnOneKey({ id: 'alice', homeUserId: null }, { id: DETACHED, homeUserId: FORMER_ID });
    const newKey = oneOnOneKey({ id: 'alice', homeUserId: null }, { id: DETACHED, homeUserId: null });
    testDb.insert(schema.dmChannels).values([
      { id: 'dm-old', federatedId: formerKey, createdAt: 1 },
      { id: 'dm-new', federatedId: newKey, createdAt: 2 },
    ]).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'dm-old', userId: 'alice', closed: 0 },
      { dmChannelId: 'dm-old', userId: DETACHED, closed: 0 },
      { dmChannelId: 'dm-new', userId: 'alice', closed: 0 },
      { dmChannelId: 'dm-new', userId: DETACHED, closed: 0 },
    ]).run();
    testDb.insert(schema.dmMessages).values([
      { id: 'm1', dmChannelId: 'dm-old', userId: 'alice', content: 'old', createdAt: 10 },
      { id: 'm2', dmChannelId: 'dm-new', userId: DETACHED, content: 'new', createdAt: 20 },
    ]).run();
    const { rehomeDetachedAccount } = await import('./detachedIdentity.js');
    rehomeDetachedAccount(sqlite, DETACHED, OUR_ORIGIN);

    expect(testDb.select().from(schema.dmChannels).all().map(c => c.id)).toEqual(['dm-new']);
    expect(testDb.select().from(schema.dmMessages).all().every(m => m.dmChannelId === 'dm-new')).toBe(true);
  });
});

describe('rehomeDetachedAccountsOnBoot', () => {
  it('homes every legacy detached row and snapshots once before the first change', async () => {
    insertLegacyDetached();
    insertUser({ id: 'detached-2', username: 'lee@other.example', passwordHash: 'real', homeInstance: 'other.example', homeUserId: 'lee-home', federationHomeOrphaned: 1 });
    const beforeChanges = vi.fn();
    const { rehomeDetachedAccountsOnBoot } = await import('./detachedIdentity.js');

    expect(rehomeDetachedAccountsOnBoot(sqlite, OUR_ORIGIN, { beforeChanges })).toBe(2);
    expect(beforeChanges).toHaveBeenCalledTimes(1);
    expect(userRow(DETACHED).homeInstance).toBeNull();
    expect(userRow('detached-2').detachedHomeInstance).toBe('other.example');
  });

  it('changes nothing and takes no snapshot on a database without legacy rows', async () => {
    const beforeChanges = vi.fn();
    const { rehomeDetachedAccountsOnBoot } = await import('./detachedIdentity.js');
    expect(rehomeDetachedAccountsOnBoot(sqlite, OUR_ORIGIN, { beforeChanges })).toBe(0);
    expect(beforeChanges).not.toHaveBeenCalled();
  });
});

describe('outbound identity of a detached account', () => {
  beforeEach(async () => {
    insertLegacyDetached();
    const { rehomeDetachedAccount } = await import('./detachedIdentity.js');
    rehomeDetachedAccount(sqlite, DETACHED, OUR_ORIGIN);
  });

  it('relayActorOfUser presents it as a user of this instance', async () => {
    const { relayActorOfUser } = await import('../routes/federation.js');
    expect(relayActorOfUser(userRow(DETACHED))).toEqual({ homeUserId: DETACHED, homeInstance: OUR_ORIGIN });
  });

  it('the DM message builder carries its identity here, never the former one', async () => {
    const { buildRelayPayload } = await import('./federationOutbox.js');
    const payload = buildRelayPayload({ id: 'm1', content: 'hello', createdAt: 5 }, userRow(DETACHED));
    expect(payload.userId).toBe(DETACHED);
    expect(payload.homeUserId).toBe(DETACHED);
    expect(payload.homeInstance).toBe(OUR_ORIGIN);
    expect(JSON.stringify(payload)).not.toContain(FORMER_ID);
  });

  it('DM participant lists carry its identity here and its handle', async () => {
    testDb.insert(schema.dmChannels).values({ id: 'dm-p', federatedId: 'fed-p', createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'dm-p', userId: 'alice' },
      { dmChannelId: 'dm-p', userId: DETACHED },
    ]).run();
    const { getDmParticipants } = await import('./federationOutbox.js');
    const participants = getDmParticipants('dm-p');
    const detached = participants.find(p => p.homeUserId === DETACHED);
    expect(detached).toBeDefined();
    expect(detached!.homeInstance).toBe(OUR_ORIGIN);
    expect(detached!.profile).toMatchObject({ username: 'kai' });
    expect(JSON.stringify(participants)).not.toContain(FORMER_ID);
    expect(JSON.stringify(participants)).not.toContain(RESET_DOMAIN);
  });

  it('relayed snapshots name it by its handle, not its login name', async () => {
    const { relayHandleOf } = await import('../routes/federation/stubName.js');
    expect(relayHandleOf(userRow(DETACHED))).toBe('kai');
    expect(relayHandleOf(userRow('alice'))).toBe('alice');
  });

  it('a 1-on-1 opened with it after detaching is keyed by its identity here', async () => {
    const { findOrCreateOneOnOne } = await import('./dmConversation.js');
    const detached = userRow(DETACHED);
    const result = findOrCreateOneOnOne(testDb, { id: 'alice', homeUserId: null }, detached, { open: 'first' });
    const key = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, result.channelId)).get()!.federatedId;
    expect(key).toBe(oneOnOneKey({ id: 'alice', homeUserId: null }, { id: DETACHED, homeUserId: null }));
  });
});

describe('inbound resolution of a detached account', () => {
  beforeEach(async () => {
    insertLegacyDetached();
    const { rehomeDetachedAccount } = await import('./detachedIdentity.js');
    rehomeDetachedAccount(sqlite, DETACHED, OUR_ORIGIN);
  });

  it('resolves a peer reference to its identity here back to the row', async () => {
    const { resolveRelayActor } = await import('../routes/federation/identity.js');
    for (const homeInstance of [OUR_ORIGIN, OUR_DOMAIN]) {
      const found = resolveRelayActor({ homeUserId: DETACHED, homeInstance }, testDb);
      expect(found.kind).toBe('found');
      expect(found.kind === 'found' && found.user.id).toBe(DETACHED);
    }
  });

  it('creates no stub for its identity here', async () => {
    const { resolveOrCreateReplicatedUser } = await import('../routes/federation.js');
    const resolved = resolveOrCreateReplicatedUser(DETACHED, OUR_ORIGIN, testDb, { username: 'kai' });
    expect(resolved?.id).toBe(DETACHED);
    expect(testDb.select().from(schema.users).all()).toHaveLength(2);
  });

  it('still resolves its former identity to the row, as a historical reference', async () => {
    const { resolveRelayActor } = await import('../routes/federation/identity.js');
    const found = resolveRelayActor({ homeUserId: FORMER_ID, homeInstance: `https://${RESET_DOMAIN}` }, testDb);
    expect(found.kind === 'found' && found.user.id).toBe(DETACHED);
    // Only the pair counts: the former id at another domain is someone else.
    expect(resolveRelayActor({ homeUserId: FORMER_ID, homeInstance: 'elsewhere.example' }, testDb).kind).toBe('mismatch');
  });

  it('refuses the reset domain acting as the former identity (hijack guard)', async () => {
    const { attributionRefusal } = await import('../routes/federation/identity.js');
    expect(attributionRefusal({ homeUserId: FORMER_ID, homeInstance: RESET_DOMAIN }, `https://${RESET_DOMAIN}`, testDb))
      .toBe('attribution_mismatch');
  });

  it('accepts a homeward event for its identity here under the normal standing rule', async () => {
    const { attributionRefusal, localUserStandingOnPeer } = await import('../routes/federation/identity.js');
    const actor = { homeUserId: DETACHED, homeInstance: OUR_ORIGIN };
    // Only this instance speaks for the identity directly; a peer carrying it
    // home needs proof that the account holds an account there.
    expect(localUserStandingOnPeer(DETACHED, 'https://orbit.example', testDb)).toBe('unproven');
    expect(attributionRefusal(actor, 'https://orbit.example', testDb)).toBe('attribution_unproven');

    testDb.insert(schema.userFederationRegistry).values({
      userId: DETACHED, origin: 'https://orbit.example', username: `kai@${OUR_DOMAIN}`, addedAt: 1,
    }).run();
    expect(localUserStandingOnPeer(DETACHED, 'https://orbit.example', testDb)).toBe('proven');
    expect(attributionRefusal(actor, 'https://orbit.example', testDb)).toBeNull();
    // A third instance can never speak for it.
    expect(attributionRefusal({ homeUserId: DETACHED, homeInstance: 'orbit.example' }, 'https://orbit.example', testDb))
      .toBe('attribution_mismatch');
  });

  it('never resurrects the former identity of a deleted detached account as a stub', async () => {
    testDb.update(schema.users).set({ isDeleted: 1 }).where(eq(schema.users.id, DETACHED)).run();
    const { resolveOrCreateReplicatedUser } = await import('../routes/federation.js');
    expect(resolveOrCreateReplicatedUser(FORMER_ID, RESET_DOMAIN, testDb, { username: 'kai' })).toBeNull();
    expect(testDb.select().from(schema.users).all()).toHaveLength(2);
  });
});

describe('quarantineOrphanedAccounts homes what it detaches', () => {
  it('detaches the flagged real account, homes it here, and announces the new identity', async () => {
    insertLegacyDetached({ federationHomeOrphaned: 0, federationHealPending: 1 });
    insertUser({ id: 'stub', username: `max@${RESET_DOMAIN}`, passwordHash: '!federation-replicated', homeInstance: RESET_DOMAIN, homeUserId: 'max-home', federationHealPending: 1 });
    testDb.insert(schema.friends).values({ userId: 'alice', friendId: DETACHED, createdAt: 1 }).run();
    const formerKey = oneOnOneKey({ id: 'alice', homeUserId: null }, { id: DETACHED, homeUserId: FORMER_ID });
    testDb.insert(schema.dmChannels).values({ id: 'dm-1', federatedId: formerKey, createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'dm-1', userId: 'alice', closed: 0 },
      { dmChannelId: 'dm-1', userId: DETACHED, closed: 0 },
    ]).run();

    const { connectionManager } = await import('../ws/handler.js');
    const send = vi.spyOn(connectionManager, 'sendToUser');
    const { quarantineOrphanedAccounts } = await import('./federationReset.js');
    expect(quarantineOrphanedAccounts(`https://${RESET_DOMAIN}`)).toBe(1);

    const row = userRow(DETACHED);
    expect(row.federationHomeOrphaned).toBe(1);
    expect(row.federationHealPending).toBe(0);
    expect(row.homeInstance).toBeNull();
    expect(row.detachedHomeInstance).toBe(RESET_DOMAIN);
    // A stub is not an account: the heal tombstones it, it is never detached.
    expect(userRow('stub').homeInstance).toBe(RESET_DOMAIN);
    expect(userRow('stub').federationHomeOrphaned).toBe(0);

    const events = send.mock.calls.map(([userId, event]) => [userId, event as { type: string; user?: { id: string; homeInstance: string | null; detachedHomeInstance?: string | null } }] as const);
    const toAlice = events.find(([userId, e]) => userId === 'alice' && e.type === 'user_updated');
    expect(toAlice?.[1].user).toMatchObject({ id: DETACHED, homeInstance: null });
    expect(toAlice?.[1].user?.detachedHomeInstance).toBeUndefined(); // self-view only
    const toSelf = events.find(([userId, e]) => userId === DETACHED && e.type === 'user_updated');
    expect(toSelf?.[1].user).toMatchObject({ id: DETACHED, homeInstance: null, detachedHomeInstance: RESET_DOMAIN });
    expect(events.some(([, e]) => e.type === 'dm_channel_created')).toBe(true);
  });
});
