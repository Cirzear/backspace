# Channel interactions and unread message badges

## Author menu

Right-clicking an author's avatar or name offers a mention. It appends a stable
`<@userId>` token to the current channel draft and focuses the composer; the
composer displays the resolved name with mention highlighting.

## Poke

Space channel hosts advertise `ready.supportsPoke`. The authenticated
`channel_poke` event requires VIEW_CHANNEL and SEND_MESSAGES for the sender,
and VIEW_CHANNEL for the target. Names are resolved on the host, not accepted
from the client. The existing per-user gateway rate limit also applies.

Only a server-confirmed broadcast produces the lightweight in-app cue and finger /
avatar animation. Pokes do not create message rows, unread counts, sounds, OS
notifications, or offline history. The current channel's viewers and the actor /
target see the cue. Recipient Do Not Disturb and space/channel suppression apply;
reduced-motion users receive text without animation. Rejections are visible.

This protocol is space-channel scoped. DM/S2S poke relay is not implemented;
the menu action is disabled in DMs and for hosts without the capability.

## Unread counts

`ready.unreadCounts` is an origin-scoped channel-to-message-count snapshot.
Only channels with VIEW_CHANNEL and READ_MESSAGE_HISTORY are counted. The query
counts existing messages with numeric snowflake IDs after the user's persisted
read cursor, excluding the user's own messages. Attachment-only messages count.

The host pushes `channel_unread_count` immediately after message creation /
deletion, channel changes, acknowledgement and mark-unread broadcasts on the same
ordered socket. Reconnect replaces that origin's snapshot. No client polling,
cache-length estimates or unread-channel counts are used.

Space badges sum visible unread channels, render 1–99 or 99+, and use gray instead of red when
the space is muted without clearing its underlying unread state. Older hosts keep
the existing unread dot; they cannot provide exact counts until upgraded.
