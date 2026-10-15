import { MassMentionBadge } from './MassMentionBadge';
import { MentionBadge } from './MentionBadge';
import { replaceEmojiShortcodesInMarkdownSource, useEmojiShortcodeNames } from '../../utils/emojiShortcodes';
import { splitMentions } from '../../utils/mentionTokens';
import { isStickerMessage, messageTextForPreview } from '../../utils/stickerMessages';

interface InlineMessageTextProps {
  content: string;
  /** The channel the text was written in; its mentions resolve there (see `MentionBadge`). */
  channelId: string | null;
}

/**
 * One line of message text without Markdown, as a reply preview shows it:
 * user, role, `@everyone` and `@here` tokens outside code become
 * non-interactive badges (the preview itself is the jump control; the scan is
 * the one the full message uses, see utils/mentionTokens.ts), `:shortcode:`
 * text becomes emoji (not inside code, and not where a colon is escaped as
 * `\:`), and everything else is plain text. A sticker is its label
 * (`messageTextForPreview`).
 */
export function InlineMessageText({ content, channelId }: InlineMessageTextProps) {
  useEmojiShortcodeNames();
  if (isStickerMessage(content)) return <>{messageTextForPreview(content)}</>;
  return (
    <>
      {splitMentions(content).map((part, i) => {
        switch (part.kind) {
          case 'user': return <MentionBadge key={i} userId={part.userId} channelId={channelId} interactive={false} />;
          case 'role': return <MassMentionBadge key={i} roleId={part.roleId} channelId={channelId} />;
          case 'everyone': return <MassMentionBadge key={i} keyword={part.keyword} channelId={channelId} />;
          case 'text': return replaceEmojiShortcodesInMarkdownSource(part.text);
        }
      })}
    </>
  );
}
