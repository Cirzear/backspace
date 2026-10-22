/**
 * Canonical music URL filter and normalizer.
 * Strips tracking parameters (like Spotify 'si') and browser addresses,
 * keeping only canonical track links for allowed music services.
 */
export function sanitizeTrackUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl || typeof rawUrl !== 'string') return undefined;

  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;

  // Spotify URI: spotify:track:{id}
  const spotifyUriMatch = trimmed.match(/^spotify:track:([a-zA-Z0-9]+)$/);
  if (spotifyUriMatch?.[1]) {
    return `https://open.spotify.com/track/${spotifyUriMatch[1]}`;
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    // Spotify: open.spotify.com/track/{id}
    if (host.includes('spotify.com')) {
      const match = pathname.match(/^\/track\/([a-zA-Z0-9]+)/);
      if (match?.[1]) {
        return `https://open.spotify.com/track/${match[1]}`;
      }
    }

    // Apple Music: music.apple.com/{country}/album/{slug}/{id}?i={trackId}
    if (host.includes('apple.com')) {
      const trackId = parsed.searchParams.get('i');
      if (trackId) {
        return `https://${host}${pathname}?i=${trackId}`;
      }
      return `https://${host}${pathname}`;
    }

    // YouTube Music: music.youtube.com/watch?v={id}
    if (host === 'music.youtube.com') {
      const v = parsed.searchParams.get('v');
      if (v) {
        return `https://music.youtube.com/watch?v=${v}`;
      }
    }

    // NetEase Cloud Music: music.163.com/#/song?id={id} or /song?id={id}
    if (host.includes('163.com')) {
      let id = parsed.searchParams.get('id');
      if (!id && parsed.hash) {
        const hashMatch = parsed.hash.match(/[?&]id=([0-9]+)/);
        if (hashMatch?.[1]) {
          id = hashMatch[1];
        }
      }
      if (id) {
        return `https://music.163.com/#/song?id=${id}`;
      }
    }

    // QQ Music: y.qq.com/n/ryqq/songDetail/{id}
    if (host.includes('qq.com')) {
      return `https://${host}${pathname}`;
    }

    // Yandex Music: music.yandex.ru/album/{albumId}/track/{trackId} or music.yandex.com/...
    if (host.includes('yandex.')) {
      return `https://${host}${pathname}`;
    }

    // TIDAL: tidal.com/track/{id} or tidal.com/browse/track/{id}
    if (host.includes('tidal.com')) {
      const match = pathname.match(/\/(?:browse\/)?track\/([0-9]+)/);
      if (match?.[1]) {
        return `https://tidal.com/track/${match[1]}`;
      }
    }

    // Deezer: deezer.com/track/{id}
    if (host.includes('deezer.com')) {
      const match = pathname.match(/\/track\/([0-9]+)/);
      if (match?.[1]) {
        return `https://www.deezer.com/track/${match[1]}`;
      }
    }

    // Bandcamp: {artist}.bandcamp.com/track/{slug}
    if (host.includes('bandcamp.com') && pathname.startsWith('/track/')) {
      return `https://${host}${pathname}`;
    }

    // SoundCloud: soundcloud.com/{user}/{track}
    if (host.includes('soundcloud.com')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return `https://soundcloud.com/${parts[0]}/${parts[1]}`;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}
