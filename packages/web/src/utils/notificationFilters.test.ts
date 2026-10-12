import { describe, it, expect } from 'vitest';
import { isAlertAllowed, isMessageAlert, mentionsReader, messageMentions, type MessageAlertInput } from './notificationFilters';

/** A space channel nobody configured: mentions, not muted. */
const DEFAULT_POLICY: MessageAlertInput['notification'] = { level: 'mentions', muted: false };

describe('isMessageAlert', () => {
  it('does not alert for my token inside code in a space channel', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId: 'local-snowflake',
        isDmChannel: false,
        content: 'the syntax is `<@local-snowflake>`',
        allChannels: false,
        notification: DEFAULT_POLICY,
      }),
    ).toBe(false);
  });

  const myId = 'local-snowflake';

  it('suppresses messages the user wrote', () => {
    expect(
      isMessageAlert({
        authoredBySelf: true,
        myId,
        isDmChannel: true,
        content: 'hi',
        allChannels: false,
        notification: DEFAULT_POLICY,
      }),
    ).toBe(false);
  });

  it('plays for DM messages from others', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: true,
        content: 'yo',
        allChannels: false,
        notification: DEFAULT_POLICY,
      }),
    ).toBe(true);
  });

  it('suppresses non-DM, non-mention messages from others', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: 'general chatter',
        allChannels: false,
        notification: DEFAULT_POLICY,
      }),
    ).toBe(false);
  });

  it('plays when content mentions my id on the channel\'s instance', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: 'hey <@local-snowflake> look',
        allChannels: false,
        notification: DEFAULT_POLICY,
      }),
    ).toBe(true);
  });

  it('does not play for mentions of someone else', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: 'pinging <@third-party>',
        allChannels: false,
        notification: DEFAULT_POLICY,
      }),
    ).toBe(false);
  });

  it('plays for any non-self message when allChannels=true', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: 'general chatter',
        allChannels: true,
        notification: DEFAULT_POLICY,
      }),
    ).toBe(true);
  });

  it('still suppresses self-authored even when allChannels=true', () => {
    expect(
      isMessageAlert({
        authoredBySelf: true,
        myId,
        isDmChannel: false,
        content: 'my own message',
        allChannels: true,
        notification: DEFAULT_POLICY,
      }),
    ).toBe(false);
  });

  it('handles null content (attachment-only) gracefully', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: true,
        content: null,
        allChannels: false,
        notification: DEFAULT_POLICY,
      }),
    ).toBe(true);
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: null,
        allChannels: false,
        notification: DEFAULT_POLICY,
      }),
    ).toBe(false);
  });
});

describe('isMessageAlert with notification settings', () => {
  const myId = 'local-snowflake';
  const PLAIN = 'general chatter';
  const MENTION = 'hey <@local-snowflake>';

  type Level = MessageAlertInput['notification']['level'];
  type Row = [Level, boolean, 'plain' | 'mention', boolean, boolean];

  // level, muted, message, allChannels (sound preference), expected
  const matrix: Row[] = [
    ['all', false, 'plain', false, true],
    ['all', false, 'mention', false, true],
    ['all', false, 'plain', true, true],
    ['mentions', false, 'plain', false, false],
    ['mentions', false, 'mention', false, true],
    ['mentions', false, 'plain', true, true],
    ['nothing', false, 'plain', false, false],
    ['nothing', false, 'mention', false, false],
    ['nothing', false, 'plain', true, false],
    ['nothing', false, 'mention', true, false],
    ['all', true, 'plain', false, false],
    ['all', true, 'mention', false, false],
    ['mentions', true, 'mention', false, false],
    ['mentions', true, 'plain', true, false],
    ['nothing', true, 'mention', true, false],
  ];

  it.each(matrix)('space channel on %s, muted=%s, %s message, allChannels=%s → %s', (level, muted, kind, allChannels, expected) => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: kind === 'mention' ? MENTION : PLAIN,
        allChannels,
        notification: { level, muted },
      }),
    ).toBe(expected);
  });

  it.each([
    ['all', false],
    ['nothing', false],
    ['mentions', true],
    ['nothing', true],
  ] as const)('a DM alerts whatever the policy says (%s, muted=%s)', (level, muted) => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: true,
        content: PLAIN,
        allChannels: false,
        notification: { level, muted },
      }),
    ).toBe(true);
  });

  it('never alerts for the user\'s own message, even on all', () => {
    expect(
      isMessageAlert({
        authoredBySelf: true,
        myId,
        isDmChannel: false,
        content: MENTION,
        allChannels: true,
        notification: { level: 'all', muted: false },
      }),
    ).toBe(false);
  });

  it('alerts on all for an attachment-only message', () => {
    expect(
      isMessageAlert({
        authoredBySelf: false,
        myId,
        isDmChannel: false,
        content: null,
        allChannels: false,
        notification: { level: 'all', muted: false },
      }),
    ).toBe(true);
  });
});

describe('isAlertAllowed (Do Not Disturb gate)', () => {
  it.each(['message', 'incoming_call'] as const)('suppresses %s alerts while the user is on dnd', (kind) => {
    expect(isAlertAllowed(kind, 'dnd')).toBe(false);
  });

  it.each([
    ['message', 'online'],
    ['message', 'idle'],
    ['incoming_call', 'online'],
    ['incoming_call', 'idle'],
  ] as const)('allows %s alerts while the user is %s', (kind, status) => {
    expect(isAlertAllowed(kind, status)).toBe(true);
  });

  it('allows alerts while the status is not known yet (no user loaded)', () => {
    expect(isAlertAllowed('message', null)).toBe(true);
    expect(isAlertAllowed('message', undefined)).toBe(true);
  });
});


describe('mass mentions', () => {
  // The hosting instance stamps the mass mentions it let through; the text alone never alerts.
  const input: MessageAlertInput = { authoredBySelf: false, myId: 'me', myRoleIds: ['role'], isDmChannel: false,
    content: null, allChannels: false, notification: DEFAULT_POLICY };
  const everyone = { content: '@everyone', mentionEveryone: true, mentionRoleIds: [] };
  const role = { content: '<@&role>', mentionEveryone: false, mentionRoleIds: ['role'] };
  it('alerts for a stamped @everyone / @here and a stamped role the reader holds', () => {
    expect(isMessageAlert({ ...input, ...everyone })).toBe(true);
    expect(isMessageAlert({ ...input, ...role })).toBe(true);
  });
  it('does not alert for a stamped role the reader does not hold', () => {
    expect(isMessageAlert({ ...input, content: '<@&other>', mentionEveryone: false, mentionRoleIds: ['other'] })).toBe(false);
  });
  it('does not alert for mass mention text without stamps (an instance that does not check MENTION_EVERYONE)', () => {
    for (const content of ['@everyone', '@here', '<@&role>']) {
      expect(isMessageAlert({ ...input, content })).toBe(false);
    }
  });
  it('suppresses only the selected mass mention kinds, never direct mentions', () => {
    const notification = { ...DEFAULT_POLICY, suppressEveryone: true, suppressRoles: true };
    expect(isMessageAlert({ ...input, notification, content: '@everyone <@&role>', mentionEveryone: true, mentionRoleIds: ['role'] })).toBe(false);
    expect(isMessageAlert({ ...input, notification, content: '@everyone <@me>', mentionEveryone: true, mentionRoleIds: [] })).toBe(true);
    expect(isMessageAlert({ ...input, notification: { ...notification, suppressRoles: false }, ...role })).toBe(true);
    expect(isMessageAlert({ ...input, notification: { ...notification, suppressEveryone: false }, ...everyone })).toBe(true);
  });
  it('keeps mute, nothing, self, DM and all-message policies unchanged', () => {
    expect(isMessageAlert({ ...input, ...everyone, notification: { level: 'nothing', muted: false } })).toBe(false);
    expect(isMessageAlert({ ...input, ...everyone, notification: { level: 'mentions', muted: true } })).toBe(false);
    expect(isMessageAlert({ ...input, ...everyone, authoredBySelf: true })).toBe(false);
    expect(isMessageAlert({ ...input, ...everyone, isDmChannel: true, notification: { level: 'nothing', muted: true } })).toBe(true);
    expect(isMessageAlert({ ...input, ...everyone, notification: { level: 'all', muted: false, suppressEveryone: true } })).toBe(true);
  });
});

describe('messageMentions (the highlight and the alert share it)', () => {
  it('reports each way a message mentions the reader', () => {
    expect(messageMentions({ myId: 'me', myRoleIds: ['r'], content: '<@me> `<@me>`', mentionEveryone: true, mentionRoleIds: ['r'] }))
      .toEqual({ direct: true, everyone: true, role: true });
    expect(messageMentions({ myId: 'me', content: '`<@me>` @everyone' })).toEqual({ direct: false, everyone: false, role: false });
    expect(mentionsReader({ myId: undefined, content: '<@me>', mentionRoleIds: ['r'] })).toBe(false);
  });
});
