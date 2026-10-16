export interface ParsedTrack {
  title: string;
  artist: string;
}

const IDLE_TITLES: Record<string, string[]> = {
  cloudmusic: ['网易云音乐', 'netease cloud music'],
  qqmusic: ['qq音乐', 'qqmusic'],
  spotify: ['spotify', 'spotify free', 'spotify premium'],
  yandexmusic: ['яндекс музыка', 'yandex music', 'yandex.music'],
  kugou: ['酷狗音乐', 'kugou music', 'kugou'],
  kuwo: ['酷我音乐', 'kuwo music', 'kwmusic'],
  foobar2000: ['foobar2000'],
  aimp: ['aimp'],
  musicbee: ['musicbee'],
};

/**
 * Checks if a window title is simply the idle app name.
 */
export function isAppIdleTitle(appKey: string, rawTitle: string): boolean {
  const normalized = rawTitle.trim().toLowerCase();
  if (!normalized) return true;

  const idleList = IDLE_TITLES[appKey.toLowerCase()];
  if (idleList && idleList.some((idle) => normalized === idle)) {
    return true;
  }

  // Spotify idle title prefixes
  if (appKey.toLowerCase() === 'spotify') {
    if (normalized.startsWith('spotify free') || normalized.startsWith('spotify premium')) {
      return true;
    }
  }

  return false;
}

/**
 * Parses window title into track title and artist based on player conventions.
 */
export function parsePlayerWindowTitle(appKey: string, rawTitle: string): ParsedTrack | null {
  const key = appKey.toLowerCase();
  let title = rawTitle.trim();

  if (isAppIdleTitle(key, title)) {
    return null;
  }

  // Yandex Music suffix removal
  if (key === 'yandexmusic') {
    title = title.replace(/\s*-\s*Яндекс Музыка$/i, '')
      .replace(/\s*-\s*Yandex Music$/i, '')
      .trim();
  }

  // foobar2000 wrapper removal
  if (key === 'foobar2000') {
    title = title.replace(/^\[foobar2000\]\s*-\s*/i, '')
      .replace(/\s*\[foobar2000\]$/i, '')
      .trim();
  }

  // Format: "Artist - Title" (Spotify, KuGou, AIMP, MusicBee)
  if (key === 'spotify' || key === 'kugou' || key === 'aimp' || key === 'musicbee') {
    const separatorIdx = title.indexOf(' - ');
    if (separatorIdx > 0) {
      const artist = title.substring(0, separatorIdx).trim();
      const songTitle = title.substring(separatorIdx + 3).trim();
      if (artist && songTitle) {
        return { artist, title: songTitle };
      }
    }
    return { title, artist: '' };
  }

  // Format: "Title - Artist" (NetEase Cloud Music, QQ Music, Kuwo, Yandex Music)
  const separatorIdx = title.lastIndexOf(' - ');
  if (separatorIdx > 0) {
    const songTitle = title.substring(0, separatorIdx).trim();
    const artist = title.substring(separatorIdx + 3).trim();
    if (songTitle && artist) {
      return { title: songTitle, artist };
    }
  }

  return { title, artist: '' };
}
