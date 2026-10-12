import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import type { MessageWithUser } from '@backspace/shared';
import { PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, schema }));

const { connectionManager, buildReadyPayload } = await import('./handler.js');

const SPACE = 'space-1';
const CHAT = 'chat-1';
const STAFF = 'staff-1';
const HISTORYLESS = 'announce-1';
const DM = 'dm-1';
const BASE = 360000000000000000n;

interface Frame { type: string; [key: string]: unknown }

const sockets = new Map<string, { send: ReturnType<typeof vi.fn> }>();

function applyMigrations(): void {
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
}

function connect(userId: string): void {
  const socket = { readyState: 1, send: vi.fn() };
  connectionManager.addConnection(userId, socket as unknown as WebSocket);
  connectionManager.setUserSpaces(userId, [SPACE]);
  sockets.set(userId, socket);
}

function frames(userId: string): Frame[] {
  return sockets.get(userId)!.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Frame);
}

function addMessage(n: number, channelId: string, userId: string): string {
  const id = String(BASE + BigInt(n));
  sqlite.prepare('INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, 1)').run(id, channelId, userId, 'x');
  return id;
}

beforeEach(() => {
  // Removing the last socket starts the offline grace timer.
  vi.useFakeTimers();
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations();
  testDb = drizzle(sqlite, { schema });
  const everyone = permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY | PermissionBits.SEND_MESSAGES);
  const noHistory = permissionsToString(PermissionBits.READ_MESSAGE_HISTORY);
  sqlite.exec(`
    INSERT INTO users (id, username, password_hash, created_at) VALUES ('owner', 'owner', 'x', 1), ('alice', 'alice', 'x', 1), ('bob', 'bob', 'x', 1);
    INSERT INTO spaces (id, name, owner_id, created_at) VALUES ('${SPACE}', 'Space', 'owner', 1);
    INSERT INTO space_members (space_id, user_id, joined_at) VALUES ('${SPACE}', 'owner', 1), ('${SPACE}', 'alice', 1), ('${SPACE}', 'bob', 1);
    INSERT INTO roles (id, space_id, name, permissions, created_at) VALUES ('${SPACE}', '${SPACE}', '@everyone', '${everyone}', 1);
    INSERT INTO channels (id, space_id, name, type, created_at) VALUES ('${CHAT}', '${SPACE}', 'chat', 'text', 1), ('${STAFF}', '${SPACE}', 'staff', 'text', 1), ('${HISTORYLESS}', '${SPACE}', 'announce', 'text', 1);
    INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES
      ('${STAFF}', 'member', 'bob', '0', '${permissionsToString(PermissionBits.VIEW_CHANNEL)}'),
      ('${HISTORYLESS}', 'role', '${SPACE}', '0', '${noHistory}');
    INSERT INTO dm_channels (id, created_at) VALUES ('${DM}', 1);
    INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES ('${DM}', 'alice', 0), ('${DM}', 'bob', 0);
  `);
  sockets.clear();
  for (const user of ['alice', 'bob']) connect(user);
});

afterEach(() => {
  for (const socket of sockets.values()) connectionManager.removeConnection(socket as unknown as WebSocket);
  sockets.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  sqlite.close();
});

describe('unread count fan-out', () => {
  it('follows a new message with each viewer\'s own count, on the same socket, after the message', () => {
    addMessage(1, CHAT, 'alice');
    const id = addMessage(2, CHAT, 'bob');
    connectionManager.sendToChannel(SPACE, CHAT, { type: 'message_created', message: { id, channelId: CHAT, userId: 'bob' } as MessageWithUser });
    expect(frames('alice').map(f => f.type)).toEqual(['message_created', 'channel_unread_count']);
    expect(frames('alice')[1]).toEqual({ type: 'channel_unread_count', counts: { [CHAT]: 1 } });
    // The author's own messages are not unread for them.
    expect(frames('bob')[1]).toEqual({ type: 'channel_unread_count', counts: { [CHAT]: 1 } });
  });

  it('reaches no one who cannot see the channel', () => {
    const id = addMessage(1, STAFF, 'alice');
    connectionManager.sendToChannel(SPACE, STAFF, { type: 'message_created', message: { id, channelId: STAFF, userId: 'alice' } as MessageWithUser });
    expect(frames('bob')).toEqual([]);
    expect(frames('alice')).toEqual([
      expect.objectContaining({ type: 'message_created' }),
      { type: 'channel_unread_count', counts: { [STAFF]: 0 } },
    ]);
  });

  it('adds nothing to space-wide events', () => {
    connectionManager.sendToSpace(SPACE, { type: 'space_access_changed', spaceId: SPACE });
    expect(frames('alice').map(f => f.type)).toEqual(['space_access_changed']);
  });

  it('follows a DM deletion with the member\'s count, and a closed DM with nothing', () => {
    sqlite.prepare('INSERT INTO dm_messages (id, dm_channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, 1)').run(String(BASE), DM, 'alice', 'x');
    connectionManager.sendToDmMembers(DM, { type: 'dm_channel_closed', dmChannelId: DM });
    expect(frames('bob').map(f => f.type)).toEqual(['dm_channel_closed']);
    connectionManager.sendToUser('bob', { type: 'dm_message_deleted', dmChannelId: DM, messageId: '1' });
    expect(frames('bob')[2]).toEqual({ type: 'channel_unread_count', counts: { [DM]: 1 } });
  });
});

describe('ready snapshot', () => {
  it('counts every readable channel and open DM, zero included, and leaves out the rest', () => {
    addMessage(1, CHAT, 'alice');
    addMessage(2, CHAT, 'alice');
    addMessage(3, STAFF, 'alice');
    addMessage(4, HISTORYLESS, 'alice');
    sqlite.prepare('INSERT INTO read_states (user_id, channel_id, last_read_message_id, updated_at) VALUES (?, ?, ?, 1)').run('bob', CHAT, String(BASE + 1n));
    const ready = buildReadyPayload('bob');
    // STAFF is hidden from bob, HISTORYLESS is visible without history.
    expect(ready.unreadCounts).toEqual({ [CHAT]: 1, [DM]: 0 });
  });
});
