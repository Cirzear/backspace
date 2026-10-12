import { isVisibleSingleLine } from './constants.js';

/** Namespaced values reuse message/reaction transport without colliding with native emoji. */
export const STICKER_PREFIX = 'sticker:';
export const MAX_STICKER_BYTES = 5 * 1024 * 1024;
/** Longest collection name, after trimming. */
export const MAX_STICKER_NAME_LENGTH = 100;
/** Most stickers one account keeps in its collection. */
export const MAX_PERSONAL_STICKERS = 200;
/** Most images one upload form sends; the per-account upload rate allows a full batch in one minute. */
export const MAX_STICKER_BATCH = 20;
/** Uploads one account may send per minute. */
export const STICKER_UPLOADS_PER_MINUTE = 30;
export const STICKER_ID_PATTERN = /^[a-f0-9]{64}$/;

/**
 * The form a collection name is stored in, or `undefined` when the value is
 * not one. A name is trimmed and refused when it trims to nothing, is longer
 * than MAX_STICKER_NAME_LENGTH, or fails the rule nicknames follow (control
 * characters, line breaks, bidirectional controls, nothing visible). The
 * server applies it on upload, collect and rename; the rename dialog applies
 * it before sending.
 */
export function normalizeStickerName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_STICKER_NAME_LENGTH) return undefined;
  return isVisibleSingleLine(trimmed) ? trimmed : undefined;
}

export interface PersonalSticker {
  id: string;
  name: string;
  token: string;
}

/**
 * Only canonical HTTP image endpoints are renderable, never markup or data URLs.
 * WHATWG URL is available in both supported Node and browser runtimes.
 */
export function stickerUrl(value: string): string | null {
  if (!value.startsWith(STICKER_PREFIX)) return null;
  const candidate = value.slice(STICKER_PREFIX.length);
  try {
    const url = new URL(candidate);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.search || url.hash || !/^\/api\/stickers\/assets\/[a-f0-9]{64}\.webp$/.test(url.pathname)) return null;
    return url.href === candidate ? candidate : null;
  } catch {
    return null;
  }
}

/** The asset id (SHA-256 of the stored WebP) a sticker token names, or null when the value is not a sticker. */
export function stickerIdOf(value: string): string | null {
  const url = stickerUrl(value);
  if (!url) return null;
  return /\/api\/stickers\/assets\/([a-f0-9]{64})\.webp$/.exec(url)?.[1] ?? null;
}
