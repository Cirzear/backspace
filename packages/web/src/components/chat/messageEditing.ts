import type { MessageWithUser } from '@backspace/shared';
import { isMine, type SelfIdentity } from '../../utils/identity';
import { isStickerMessage } from '../../utils/stickerMessages';

/**
 * Finds the newest text message the current user can open in the inline editor.
 * System messages, attachment-only messages and stickers (whose content is a
 * token, not text) are skipped. If the newest own
 * message is still optimistic, wait for the server copy instead of unexpectedly
 * opening an older message. `origin` is the instance that issued the
 * channel's messages.
 */
export function findLastOwnEditableMessage(
  messages: readonly MessageWithUser[],
  origin: string,
  self: SelfIdentity | null,
): MessageWithUser | null {
  if (!self) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.type === 'system' || !isMine(message.user, origin, self)) continue;
    if (message.id.startsWith('temp_')) return null;
    if (message.content?.trim() && !isStickerMessage(message.content)) return message;
  }

  return null;
}
