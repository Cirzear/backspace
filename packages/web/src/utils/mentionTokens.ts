import { splitMentions } from '@backspace/shared/src/mentions';

/**
 * The client's readers of mention tokens in message content.
 *
 * The scan itself is `splitMentions` in `@backspace/shared/src/mentions`, the
 * one the server also uses to gate and stamp mass mentions: user tokens
 * (`<@id>`), role tokens (`<@&id>`) and `@everyone` / `@here`, each a mention
 * only outside code (fenced blocks and inline code spans stay text). Every
 * client reader goes through it, so the rendered message
 * (`MarkdownRenderer`), the reply preview (`InlineMessageText`), the mention
 * highlight (`Message`), the composer's labels (`composerMentions`) and the
 * alert rule (`notificationFilters`) agree on which tokens are mentions. The
 * server's relay rewrite of user tokens
 * (`server/src/utils/federationMentions.ts`) uses the same user-token
 * expression.
 */
export { splitMentions, type MentionPart } from '@backspace/shared/src/mentions';

/** Whether `content` mentions any of `userIds` with a `<@id>` token outside code. */
export function contentMentionsAny(content: string, userIds: ReadonlySet<string>): boolean {
  return splitMentions(content).some((part) => part.kind === 'user' && userIds.has(part.userId));
}
