import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * Content that is not a sticker token. A sticker message's content is one
 * `sticker:<asset URL>` value (`stickerUrl` in packages/shared/src/stickers.ts);
 * it is not text anyone wrote, so a text search must not match the words
 * in its URL ("https", "api", "stickers", the host). The GLOB is the
 * token's shape; anything that only starts with "sticker:" is still text.
 */
export function notStickerContent(column: SQLiteColumn): SQL {
  return sql`(${column} IS NULL OR ${column} NOT GLOB 'sticker:http*://*/api/stickers/assets/*.webp')`;
}
