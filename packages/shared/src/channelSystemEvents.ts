/**
 * The content of a space channel system message (`messages.type = 'system'`),
 * stored as JSON by the instance hosting the space.
 *
 * Supported events:
 * - channel_poke: an actor pokes another member (docs/systems/websocket.md)
 * - member_join: a member joins the space (invite code, public explore, or join request)
 *
 * Rules:
 * - The instance hosting the space writes the row; no client sends content
 *   for it, and it is never relayed to a peer.
 * - System messages cannot be edited.
 */
export type ChannelSystemEvent =
  | { event: 'channel_poke'; targetUserId: string; targetDisplayName: string }
  | { event: 'member_join'; userId: string; displayName: string; customMessage?: string | null };

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
  if (value.event === 'member_join') {
    const userId = text(value.userId);
    const displayName = text(value.displayName);
    if (!userId || !displayName) return null;
    const customMessage = typeof value.customMessage === 'string' && value.customMessage.length > 0 ? value.customMessage : null;
    return { event: 'member_join', userId, displayName, customMessage };
  }
  return null;
}
