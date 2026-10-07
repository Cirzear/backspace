import { describe, it, expect } from 'vitest';
import {
  PermissionBits,
  permissionsToString,
  isHiddenFromEveryone,
  idsHiddenFromEveryone,
} from '@backspace/shared/src/permissions.js';

// The private rule in @backspace/shared (docs/systems/permissions.md, "Private
// channels and categories"): a channel or category is private when its
// @everyone override (the role whose id is the space id) denies View Channels.
// The server's isPrivate flags and the client's Private switch both read it,
// so it is tested once here, as pure functions.

const VIEW = PermissionBits.VIEW_CHANNEL;
const SEND = PermissionBits.SEND_MESSAGES;
const row = (targetId: string, deny: bigint | string, targetType = 'role') => ({
  targetType,
  targetId,
  allow: '0',
  deny: typeof deny === 'string' ? deny : permissionsToString(deny),
});

describe('isHiddenFromEveryone', () => {
  it('is the View Channels deny on the @everyone override', () => {
    expect(isHiddenFromEveryone([row('space', VIEW | SEND)], 'space')).toBe(true);
    expect(isHiddenFromEveryone([row('space', SEND)], 'space')).toBe(false);
    expect(isHiddenFromEveryone([row('r-mod', VIEW)], 'space')).toBe(false);
    expect(isHiddenFromEveryone([], 'space')).toBe(false);
  });

  it('ignores a member override whose id happens to equal the space id', () => {
    expect(isHiddenFromEveryone([row('space', VIEW, 'member')], 'space')).toBe(false);
    expect(isHiddenFromEveryone([row('space', VIEW, 'member'), row('space', VIEW)], 'space')).toBe(true);
  });

  it('reads a stored deny the way permission checks do', () => {
    expect(isHiddenFromEveryone([row('space', '["VIEW_CHANNEL"]')], 'space')).toBe(true);
    expect(isHiddenFromEveryone([row('space', '-1')], 'space')).toBe(true);
    expect(isHiddenFromEveryone([row('space', `0x${VIEW.toString(16)}`)], 'space')).toBe(true);
    expect(isHiddenFromEveryone([row('space', 'not a number')], 'space')).toBe(false);
    expect(isHiddenFromEveryone([row('space', '')], 'space')).toBe(false);
  });
});

describe('idsHiddenFromEveryone', () => {
  const channelRow = (channelId: string, targetId: string, deny: bigint, targetType = 'role') => ({
    channelId,
    ...row(targetId, deny, targetType),
  });
  const spaceOf: Record<string, string> = { 'a-1': 'a', 'a-2': 'a', 'b-1': 'b' };

  it('reads each entity against its own space', () => {
    const rows = [
      channelRow('a-1', 'a', VIEW),
      channelRow('a-2', 'b', VIEW),
      channelRow('b-1', 'b', VIEW),
    ];
    expect(idsHiddenFromEveryone(rows, (o) => o.channelId, (id) => spaceOf[id])).toEqual(new Set(['a-1', 'b-1']));
  });

  it('looks at every row of an entity, not only the first', () => {
    const rows = [
      channelRow('a-1', 'r-mod', SEND),
      channelRow('a-1', 'a', VIEW, 'member'),
      channelRow('a-1', 'a', VIEW),
    ];
    expect(idsHiddenFromEveryone(rows, (o) => o.channelId, (id) => spaceOf[id])).toEqual(new Set(['a-1']));
  });

  it('leaves out an entity whose space is not known', () => {
    expect(idsHiddenFromEveryone([channelRow('gone', 'a', VIEW)], (o) => o.channelId, (id) => spaceOf[id])).toEqual(new Set());
  });
});
