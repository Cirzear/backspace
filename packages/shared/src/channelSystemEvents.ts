/**
 * The content of a space channel system message (`messages.type = 'system'`),
 * stored as JSON by the instance hosting the space. The only one so far is a
 * poke; docs/systems/websocket.md, "Channel pokes", holds the rules.
 *
 * - The instance hosting the space writes the row; no client sends content
 *   for it, and it is never relayed to a peer.
 * - The actor is the row's author (`userId`), named like any author. The
 *   target is `targetUserId`, that instance's id for the member who was poked,
 *   the id its member list and messages carry.
 * - `targetDisplayName` is a snapshot of the target's name in the space when
 *   the row was written (their nickname, else their account name). A client
 *   names the target from the space's roster while they are in it, as every
 *   other surface of the space does, and uses the snapshot only for someone
 *   who is no longer there.
 * - System messages cannot be edited.
 */
export type ChannelSystemEvent =
  | { event: 'channel_poke'; targetUserId: string; targetDisplayName: string };

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The stored content of a channel system message. */
export function channelSystemContent(event: ChannelSystemEvent): string {
  return JSON.stringify(event);
}

/**
 * The event a channel system message's content holds, or null for content
 * this version does not know: not JSON, an unknown event, or a missing field.
 * Only the event's own fields are kept.
 */
export function parseChannelSystemEvent(content: string | null | undefined): ChannelSystemEvent | null {
  if (!content) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isFields(value)) return null;
  if (value.event === 'channel_poke') {
    const targetUserId = text(value.targetUserId);
    const targetDisplayName = text(value.targetDisplayName);
    if (!targetUserId || !targetDisplayName) return null;
    return { event: 'channel_poke', targetUserId, targetDisplayName };
  }
  return null;
}
