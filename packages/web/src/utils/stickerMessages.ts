import { stickerUrl } from '@backspace/shared/src/stickers';
import i18n from '../i18n';

/**
 * Whether a message's content is a sticker: the whole content is one
 * `sticker:<asset URL>` token (see docs/systems/uploads.md, "Personal
 * stickers"). The timeline row draws the image; every other surface that
 * shows a message as text reads `messageTextForPreview`, so none of them
 * shows the token itself.
 */
export function isStickerMessage(content: string | null | undefined): boolean {
  return !!content && stickerUrl(content) !== null;
}

/**
 * The text a one-line surface shows for a message's content: a sidebar
 * preview, a reply quote, a search result, a desktop notification. A sticker
 * is the word "Sticker" in the reader's language; any other content is
 * returned as it is.
 */
export function messageTextForPreview(content: string): string {
  return isStickerMessage(content) ? i18n.t('chat:stickers.sticker') : content;
}
