import type { DmChannel, DmMessageWithUser, MessageWithUser, ServerEvent } from '@backspace/shared';
import { PermissionBits } from '@backspace/shared/src/permissions.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

// The real migrations, so the counts run against the real indexes.
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const computePermissions = vi.fn<(userId: string, spaceId: string, channelId?: string) => bigint>();

vi.mock('../db/index.js', () => ({ getDb: () => db, schema }));
vi.mock('../utils/permissions.js', async () => {
  const shared = await import('@backspace/shared/src/permissions.js');
  return {
    PermissionBits: shared.PermissionBits,
    computePermissions: (userId: string, spaceId: string, channelId?: string) => computePermissions(userId, spaceId, channelId),
  };
});

const { UNREAD_COUNT_CAP, canCountUnread, countChannelUnread, countDmUnread, readyUnreadCounts, unreadCountFollowUp } =
  await import('./channelUnreadCounts.js');

const READ = PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY;
// Snowflakes grow a digit over time: 17 digits early in 2024, 18 since.
const OLD_ID = '98765432109876543';
const NEW_ID_BASE = 360000000000000000n;

function applyMigrations(): void {
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
}

function addMessage(id: string | bigint, channelId: string, userId: string): void {
  sqlite.prepare('INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, 1)')
    .run(String(id), channelId, userId, 'x');
}

function addDmMessage(id: string | bigint, dmChannelId: string, userId: string): void {
  sqlite.prepare('INSERT INTO dm_messages (id, dm_channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, 1)')
    .run(String(id), dmChannelId, userId, 'x');
}

function setCursor(userId: string, channelId: string, messageId: string): void {
  sqlite.prepare('INSERT OR REPLACE INTO read_states (user_id, channel_id, last_read_message_id, updated_at) VALUES (?, ?, ?, 1)')
    .run(userId, channelId, messageId);
}

function newId(n: number): bigint {
  return NEW_ID_BASE + BigInt(n);
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations();
  db = drizzle(sqlite, { schema });
  computePermissions.mockReset();
  computePermissions.mockImplementation((_u, _s, channelId) => (channelId === 'hidden' ? PermissionBits.VIEW_CHANNEL : READ));
  sqlite.exec(`
    INSERT INTO channels (id, space_id, name, type, created_at) VALUES ('chat', 'space', 'chat', 'text', 1), ('hidden', 'space', 'hidden', 'text', 1);
    INSERT INTO dm_channels (id, created_at, deleted_at) VALUES ('dm', 1, NULL), ('closed', 1, NULL), ('gone', 1, 5);
    INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES ('dm', 'me', 0), ('dm', 'other', 0), ('closed', 'me', 1), ('gone', 'me', 0);
  `);
});

afterEach(() => sqlite.close());

describe('counting', () => {
  it('counts messages after the cursor by others, comparing ids as numbers', () => {
    addMessage(OLD_ID, 'chat', 'other');
    addMessage(newId(1), 'chat', 'other');
    addMessage(newId(2), 'chat', 'me');
    addMessage(newId(3), 'chat', 'other');
    // As text, every 18-digit id sorts below the 17-digit cursor.
    expect(countChannelUnread('me', 'chat', OLD_ID)).toBe(2);
    expect(countChannelUnread('me', 'chat', '0')).toBe(3);
    expect(countChannelUnread('me', 'chat', String(newId(3)))).toBe(0);
  });

  it('leaves out system rows such as pokes', () => {
    addMessage(newId(1), 'chat', 'other');
    sqlite.prepare("INSERT INTO messages (id, channel_id, user_id, content, type, created_at) VALUES (?, 'chat', 'other', '{}', 'system', 1)")
      .run(String(newId(2)));
    expect(countChannelUnread('me', 'chat', '0')).toBe(1);
    expect(countChannelUnread('me', 'chat', String(newId(1)))).toBe(0);
  });

  it('stops at the cap', () => {
    for (let i = 0; i < UNREAD_COUNT_CAP + 50; i++) addMessage(newId(i), 'chat', 'other');
    for (let i = 0; i < UNREAD_COUNT_CAP + 50; i++) addDmMessage(newId(i), 'dm', 'other');
    expect(countChannelUnread('me', 'chat', '0')).toBe(UNREAD_COUNT_CAP);
    expect(countDmUnread('me', 'dm', '0')).toBe(UNREAD_COUNT_CAP);
    expect(countChannelUnread('me', 'chat', String(newId(UNREAD_COUNT_CAP + 40)))).toBe(9);
  });

  it('walks only the unread range of the index, never the channel', () => {
    const sources: string[] = [];
    const prepare = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, 'prepare').mockImplementation((source: string) => {
      sources.push(source);
      return prepare(source);
    });
    countChannelUnread('me', 'chat', '0');
    countDmUnread('me', 'dm', '0');
    vi.mocked(sqlite.prepare).mockRestore();
    const plans = sources.map(source => {
      const params = Array.from({ length: (source.match(/\?/g) ?? []).length }, () => '1');
      return (sqlite.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...params) as Array<{ detail: string }>)
        .map(row => row.detail).join('\n');
    });
    expect(plans).toHaveLength(2);
    expect(plans[0]).toContain('COVERING INDEX idx_messages_channel_unread (channel_id=? AND <expr>>?)');
    expect(plans[1]).toContain('COVERING INDEX idx_dm_messages_channel_unread (dm_channel_id=? AND <expr>>?)');
  });

  it('builds the ready snapshot with a zero for every counted id', () => {
    addMessage(newId(1), 'chat', 'other');
    addMessage(newId(2), 'chat', 'other');
    addDmMessage(newId(3), 'dm', 'other');
    const counts = readyUnreadCounts('me', ['chat', 'quiet'], ['dm'], new Map([['chat', String(newId(1))]]));
    expect(counts).toEqual({ chat: 1, quiet: 0, dm: 1 });
  });

  it('needs history as well as view', () => {
    expect(canCountUnread(READ)).toBe(true);
    expect(canCountUnread(PermissionBits.VIEW_CHANNEL)).toBe(false);
    expect(canCountUnread(PermissionBits.ADMINISTRATOR)).toBe(true);
  });
});

describe('follow-up events', () => {
  const created = (channelId: string): ServerEvent => ({ type: 'message_created', message: { channelId } as MessageWithUser });
  const dmCreated = (dmChannelId: string): ServerEvent => ({ type: 'dm_message_created', message: { dmChannelId } as DmMessageWithUser });

  it('uses the permissions the fan-out already computed', () => {
    addMessage(newId(1), 'chat', 'other');
    expect(unreadCountFollowUp('me', created('chat'), READ)).toEqual({ type: 'channel_unread_count', counts: { chat: 1 } });
    expect(computePermissions).not.toHaveBeenCalled();
  });

  it('computes permissions when the caller has none, and counts zero without history', () => {
    addMessage(newId(1), 'hidden', 'other');
    expect(unreadCountFollowUp('me', { type: 'channel_ack', channelId: 'hidden', messageId: '0' })).toEqual({ type: 'channel_unread_count', counts: { hidden: 0 } });
    expect(computePermissions).toHaveBeenCalledWith('me', 'space', 'hidden');
  });

  it('recounts after deletion, acknowledgement and mark-unread from the persisted cursor', () => {
    addMessage(newId(1), 'chat', 'other');
    addMessage(newId(2), 'chat', 'other');
    sqlite.exec(`DELETE FROM messages WHERE id = '${newId(1)}'`);
    expect(unreadCountFollowUp('me', { type: 'message_deleted', channelId: 'chat', messageId: String(newId(1)) }, READ))
      .toEqual({ type: 'channel_unread_count', counts: { chat: 1 } });
    setCursor('me', 'chat', String(newId(2)));
    expect(unreadCountFollowUp('me', { type: 'channel_ack', channelId: 'chat', messageId: String(newId(2)) }))
      .toEqual({ type: 'channel_unread_count', counts: { chat: 0 } });
    sqlite.exec("DELETE FROM read_states WHERE channel_id = 'chat'");
    expect(unreadCountFollowUp('me', { type: 'mark_unread', channelId: 'chat', messageId: '0' }))
      .toEqual({ type: 'channel_unread_count', counts: { chat: 1 } });
  });

  it('counts a DM only for an open member of a live conversation', () => {
    addDmMessage(newId(1), 'dm', 'other');
    addDmMessage(newId(2), 'dm', 'me');
    addDmMessage(newId(3), 'closed', 'other');
    addDmMessage(newId(4), 'gone', 'other');
    expect(unreadCountFollowUp('me', dmCreated('dm'))).toEqual({ type: 'channel_unread_count', counts: { dm: 1 } });
    expect(unreadCountFollowUp('me', dmCreated('closed'))).toBeNull();
    expect(unreadCountFollowUp('me', dmCreated('gone'))).toBeNull();
    expect(unreadCountFollowUp('stranger', dmCreated('dm'))).toBeNull();
    setCursor('me', 'dm', String(newId(1)));
    expect(unreadCountFollowUp('me', { type: 'channel_ack', channelId: 'dm', messageId: String(newId(1)) }))
      .toEqual({ type: 'channel_unread_count', counts: { dm: 0 } });
    // The other member has one unread: the message 'me' sent.
    expect(unreadCountFollowUp('other', { type: 'dm_channel_created', dmChannel: { id: 'dm' } as DmChannel }))
      .toEqual({ type: 'channel_unread_count', counts: { dm: 1 } });
    expect(computePermissions).not.toHaveBeenCalled();
  });

  it('follows nothing that leaves the counts as they are', () => {
    expect(unreadCountFollowUp('me', { type: 'typing', channelId: 'chat', userId: 'other', username: 'Other' })).toBeNull();
    expect(unreadCountFollowUp('me', { type: 'channel_deleted', channelId: 'chat', spaceId: 'space' })).toBeNull();
    expect(unreadCountFollowUp('me', { type: 'dm_channel_closed', dmChannelId: 'dm' })).toBeNull();
    expect(unreadCountFollowUp('me', { type: 'channel_ack', channelId: 'unknown', messageId: '1' })).toBeNull();
  });
});
