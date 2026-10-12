/**
 * The content of a space channel system message (`messages.type = 'system'`),
 * stored as JSON by the instance hosting the space. The only one so far is a
 * poke; docs/systems/websocket.md, "Channel pokes", holds the rules.
 *
 * - The instance hosting the space writes the row; no client sends content
 *   for it, and it is never relayed to a peer.
 * - `targetUserId` is that instance's id for the member who was poked, the id
 *   its member list and messages carry.
 * - Names are snapshots taken when the row was written. A client names the
 *   people from the space's roster while they are in it, and falls back to
 *   the snapshot only for someone who is not.
 * - System messages cannot be edited.
 */
export type ChannelSystemEvent =
  | { event: 'channel_poke'; targetUserId: string; username: string; targetUsername: string };

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
    const username = text(value.username);
    const targetUsername = text(value.targetUsername);
    if (!targetUserId || !username || !targetUsername) return null;
    return { event: 'channel_poke', targetUserId, username, targetUsername };
  }
  return null;
}
