import type { ChannelNotificationPolicy, UserStatus } from '@backspace/shared';
import { contentMentionsAny } from './mentionTokens';

/**
 * The rule that decides whether a freshly-arrived chat message alerts the user.
 * Pure; the caller answers who wrote it, which id is the user's in that
 * channel and what the channel's notification settings are (see
 * `messageAlertsUser` in utils/alerts.ts, which both outputs of the `message`
 * alert kind go through). Documented in docs/systems/sounds.md ("Which
 * messages alert").
 *
 * Rule:
 *   - Never for a message the user wrote (`authoredBySelf`).
 *   - Always for a DM. Notification settings belong to spaces and channels
 *     and do not reach DMs.
 *   - For a space channel, by its notification policy:
 *     - muted (its own mute or its space's): never, mentions included;
 *     - `nothing`: never, mentions included;
 *     - `all`: every message;
 *     - `mentions`: content with a `<@${myId}>` mention outside code (the
 *       shared scan in utils/mentionTokens.ts), where `myId` is the user's id
 *       on the instance that issued the channel. With `allChannels`, every
 *       message: only the in-app cue passes it, since the "Play sound for
 *       every message" preference is a sound setting and does not widen the
 *       OS notification. It widens `mentions` only, so it never overrides a
 *       channel the user set to `nothing` or muted.
 */
export interface MessageAlertInput {
  authoredBySelf: boolean;
  myId: string | undefined;
  isDmChannel: boolean;
  content: string | null;
  allChannels: boolean;
  /** The channel's resolved settings (`resolveChannelNotificationPolicy`); not read for a DM. */
  notification: Pick<ChannelNotificationPolicy, 'level' | 'muted'>;
}

export function isMessageAlert(input: MessageAlertInput): boolean {
  if (input.authoredBySelf) return false;
  if (input.isDmChannel) return true;
  if (input.notification.muted) return false;
  switch (input.notification.level) {
    case 'nothing':
      return false;
    case 'all':
      return true;
    case 'mentions':
      if (input.allChannels) return true;
      if (!input.content || !input.myId) return false;
      return contentMentionsAny(input.content, new Set([input.myId]));
  }
}

/**
 * Attention-seeking alerts the client can raise on its own. Each kind covers
 * both of its outputs: the in-app cue and the OS notification.
 *
 * - `message`: `message.ogg` and the new-message OS notification.
 * - `incoming_call`: the `call_ringing.ogg` loop and the "is calling you" OS
 *   notification.
 *
 * Cues that answer the user's own action (mute, deafen, camera, join/leave,
 * watch/stop watching, the outgoing `call_calling` loop) and the unread badge
 * are not alerts and never pass through this gate.
 */
export type AlertKind = 'message' | 'incoming_call';

/**
 * The Do Not Disturb rule, in one place. `selfStatus` is the user's chosen
 * status as `selectMyChosenStatus` reads it (activity-presence.md, "The
 * client's copy of the user's own status"), never another user's presence.
 *
 * Do Not Disturb suppresses every alert kind. An unknown status (no user
 * loaded yet) does not suppress: the gate only withholds what the user asked
 * to withhold.
 */
export function isAlertAllowed(kind: AlertKind, selfStatus: UserStatus | null | undefined): boolean {
  switch (kind) {
    case 'message':
    case 'incoming_call':
      return selfStatus !== 'dnd';
  }
}
