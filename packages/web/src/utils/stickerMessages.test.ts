import { describe, expect, it } from 'vitest';
import { isStickerMessage, messageTextForPreview } from './stickerMessages';

const token = `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;

describe('sticker message text', () => {
  it('recognises only a content that is one whole sticker token', () => {
    expect(isStickerMessage(token)).toBe(true);
    expect(isStickerMessage(`${token} `)).toBe(false);
    expect(isStickerMessage(`look ${token}`)).toBe(false);
    expect(isStickerMessage(null)).toBe(false);
  });

  it('gives one-line surfaces a label for a sticker and the text for anything else', () => {
    expect(messageTextForPreview(token)).toBe('Sticker');
    expect(messageTextForPreview('hello')).toBe('hello');
  });
});
