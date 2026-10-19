/**
 * Game icon uploads: the desktop client extracts an icon for a detected game
 * from the player's own machine (Steam's library cache, Flatpak exports, GOG
 * and AppImage directories, .desktop entries) and uploads it to the user's
 * own instance, so an activity can carry an icon URL nothing third-party
 * hosts. Mirrors the personal sticker limits in shape.
 */

/** Most bytes one game icon upload may carry (before the server re-encodes). */
export const MAX_GAME_ICON_BYTES = 512 * 1024;
/** Longest edge of the stored icon; the largest UI surface showing it is far smaller. */
export const GAME_ICON_DIMENSION = 256;
/** Distinct icons one account may keep. A session plays far fewer games. */
export const MAX_GAME_ICONS_PER_USER = 128;
/** Uploads one account may send per minute; icon uploads are rare and batched never. */
export const GAME_ICON_UPLOADS_PER_MINUTE = 10;
export const GAME_ICON_ID_PATTERN = /^[a-f0-9]{64}$/;

export interface GameIconUpload {
  id: string;
  url: string;
}
