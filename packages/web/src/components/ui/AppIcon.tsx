import React from 'react';

export interface AppIconProps {
  name?: string;
  type?: 'playing' | 'listening' | 'watching' | 'streaming' | 'custom' | string;
  size?: number;
  className?: string;
  fallbackEmoji?: string;
}

/**
 * Normalizes app name or player string to a known icon key.
 */
export function getAppIconKey(name?: string, type?: string): string {
  if (!name && !type) return 'default';
  const raw = (name || '').toLowerCase().replace(/[\s\-_.]+/g, '');

  // Music players
  if (raw.includes('cloudmusic') || raw.includes('网易云') || raw.includes('netease')) return 'cloudmusic';
  if (raw.includes('qqmusic') || raw.includes('qq音乐')) return 'qqmusic';
  if (raw.includes('kugou') || raw.includes('酷狗')) return 'kugou';
  if (raw.includes('kuwo') || raw.includes('kwmusic') || raw.includes('酷我')) return 'kuwo';
  if (raw.includes('spotify')) return 'spotify';
  if (raw.includes('applemusic') || raw === 'apple') return 'applemusic';
  if (raw.includes('yandex') || raw.includes('яндекс')) return 'yandexmusic';
  if (raw.includes('youtubemusic')) return 'youtubemusic';
  if (raw.includes('foobar')) return 'foobar2000';
  if (raw.includes('aimp')) return 'aimp';
  if (raw.includes('musicbee')) return 'musicbee';

  // Streaming & Live tools
  if (raw.includes('obs')) return 'obs';
  if (raw.includes('bilibili') || raw.includes('哔哩哔哩')) return 'bilibili';
  if (raw.includes('douyin') || raw.includes('抖音')) return 'douyin';
  if (raw.includes('douyu') || raw.includes('斗鱼')) return 'douyu';
  if (raw.includes('huya') || raw.includes('虎牙')) return 'huya';
  if (raw.includes('kuaishou') || raw.includes('快手')) return 'kuaishou';
  if (raw.includes('twitch')) return 'twitch';
  if (raw.includes('streamlabs')) return 'streamlabs';
  if (raw.includes('vtube')) return 'vtubestudio';

  // Video & Streaming platforms
  if (raw.includes('youtube')) return 'youtube';
  if (raw.includes('netflix')) return 'netflix';
  if (raw.includes('appletv')) return 'appletv';
  if (raw.includes('potplayer')) return 'potplayer';
  if (raw.includes('vlc')) return 'vlc';

  // Game launchers & platforms
  if (raw.includes('steam')) return 'steam';
  if (raw.includes('epicgames') || raw.includes('epic')) return 'epicgames';

  // Type-based fallbacks
  if (type === 'listening') return 'generic-music';
  if (type === 'playing') return 'generic-game';
  if (type === 'streaming') return 'generic-stream';
  if (type === 'watching') return 'generic-watch';

  return 'default';
}

export function AppIcon({ name, type, size = 16, className = '', fallbackEmoji }: AppIconProps) {
  const key = getAppIconKey(name, type);

  switch (key) {
    case 'cloudmusic':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#EC4141">
          <path d="M13.046 9.388a3.919 3.919 0 0 0-.66.19c-.809.312-1.447.991-1.666 1.775a2.269 2.269 0 0 0-.074.81c.048.546.333 1.05.764 1.35a1.483 1.483 0 0 0 2.01-.286c.406-.531.355-1.183.24-1.636-.098-.387-.22-.816-.345-1.249a64.76 64.76 0 0 1-.269-.954zm-.82 10.07c-3.984 0-7.224-3.24-7.224-7.223 0-.98.226-3.02 1.884-4.822A7.188 7.188 0 0 1 9.502 5.6a.792.792 0 1 1 .587 1.472 5.619 5.619 0 0 0-2.795 2.462 5.538 5.538 0 0 0-.707 2.7 5.645 5.645 0 0 0 5.638 5.638c1.844 0 3.627-.953 4.542-2.428 1.042-1.68.772-3.931-.627-5.238a3.299 3.299 0 0 0-1.437-.777c.172.589.334 1.18.494 1.772.284 1.12.1 2.181-.519 2.989-.39.51-.956.888-1.592 1.064a3.038 3.038 0 0 1-2.58-.44 3.45 3.45 0 0 1-1.44-2.514c-.04-.467.002-.93.128-1.376.35-1.256 1.356-2.339 2.622-2.826a5.5 5.5 0 0 1 .823-.246l-.134-.505c-.37-1.371.25-2.579 1.547-3.007.329-.109.68-.145 1.025-.105.792.09 1.476.592 1.709 1.023.258.507-.096 1.153-.706 1.153a.788.788 0 0 1-.54-.213c-.088-.08-.163-.174-.259-.247a.825.825 0 0 0-.632-.166.807.807 0 0 0-.634.551c-.056.191-.031.406.02.595.07.256.159.597.217.82 1.11.098 2.162.54 2.97 1.296 1.974 1.844 2.35 4.886.892 7.233-1.197 1.93-3.509 3.177-5.889 3.177zM0 12c0 6.627 5.373 12 12 12s12-5.373 12-12S18.627 0 12 0 0 5.373 0 12Z" />
        </svg>
      );

    case 'spotify':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#1ED760">
          <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.02.6-1.14 4.32-1.32 9.78-.66 13.56 1.68.42.3.6.84.3 1.26zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.3c-.6.18-1.2-.18-1.38-.78-.18-.6.18-1.2.78-1.38 4.2-1.26 11.4-1.02 15.66 1.5.54.3.72 1.02.42 1.56-.3.54-1.02.72-1.56.42z" />
        </svg>
      );

    case 'applemusic':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#FA233B">
          <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm4.846 6.36v7.354c0 1.954-1.637 2.87-3.084 2.87-1.448 0-2.624-.916-2.624-2.87 0-1.954 1.176-2.87 2.624-2.87.575 0 1.082.164 1.503.45V7.954l-5.692 1.29v6.52c0 1.954-1.638 2.87-3.085 2.87-1.447 0-2.624-.916-2.624-2.87 0-1.954 1.177-2.87 2.624-2.87.576 0 1.083.164 1.504.45V7.477c0-.705.517-1.312 1.21-1.469l7.067-1.602c.421-.096.862.067 1.127.412.266.345.45.748.45 1.042z" />
        </svg>
      );

    case 'qqmusic':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#31C27C">
          <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm1 14.93V18h-2v-3.07a3.5 3.5 0 1 1 2 2zM12 6c2.76 0 5 2.24 5 5h-2c0-1.66-1.34-3-3-3s-3 1.34-3 3H7c0-2.76 2.24-5 5-5z" />
        </svg>
      );

    case 'kugou':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#00A2FF">
          <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm-1 5h3v4.5l3.5-3.5h3.5l-4.5 4.5 4.5 5.5h-3.5L14 13.5V17h-3V7z" />
        </svg>
      );

    case 'kuwo':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#FFB703">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 4h2.5v5.2l3.2-3.2H20l-4.2 4.2 4.4 5.8h-3.4L13.5 14v4H11V6z" />
        </svg>
      );

    case 'yandexmusic':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#FFCC00">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 5.5l1.8 4.2 4.5.4-3.4 3 1 4.4-3.9-2.4-3.9 2.4 1-4.4-3.4-3 4.5-.4z" fill="#000000" />
        </svg>
      );

    case 'obs':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#E0E0E6">
          <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 3c4.97 0 9 4.03 9 9s-4.03 9-9 9-9-4.03-9-9 4.03-9 9-9zm0 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z" />
        </svg>
      );

    case 'bilibili':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#00AEEC">
          <path d="M18.526 2.055c1.504.912 2.448 2.554 2.464 4.336V18.1c-.016 1.782-.96 3.424-2.464 4.336-1.503.913-3.38 1.002-4.965.234l-2.072 1.554c-.58.435-1.385.435-1.966 0l-2.071-1.554c-1.585.768-3.462.679-4.965-.234C1.989 21.524 1.045 19.882 1.03 18.1V6.391c.016-1.782.96-3.424 2.464-4.336C4.997 1.143 6.874 1.054 8.46 1.822L10.53.268c.58-.435 1.385-.435 1.966 0l2.072 1.554c1.585-.768 3.462-.679 4.965.234zM7.25 8.5c-.828 0-1.5.672-1.5 1.5v2c0 .828.672 1.5 1.5 1.5s1.5-.672 1.5-1.5v-2c0-.828-.672-1.5-1.5-1.5zm9.5 0c-.828 0-1.5.672-1.5 1.5v2c0 .828.672 1.5 1.5 1.5s1.5-.672 1.5-1.5v-2c0-.828-.672-1.5-1.5-1.5z" />
        </svg>
      );

    case 'steam':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#66C0F4">
          <path d="M12 0C5.373 0 0 5.373 0 12c0 5.552 3.8 10.204 8.938 11.458-.135-.91-.122-1.923.315-2.75 1.131-2.147 3.42-3.608 6.04-3.608.318 0 .633.025.945.074l3.784-5.592v-.41c0-3.414-2.776-6.19-6.19-6.19-3.414 0-6.19 2.776-6.19 6.19 0 .42.043.829.124 1.226L3.924 14.3C3.33 13.21 3 11.954 3 10.615 3 5.856 6.856 2 11.615 2c4.76 0 8.615 3.856 8.615 8.615 0 2.373-.974 4.521-2.548 6.079l-4.106 6.067C19.782 21.579 24 17.26 24 12 24 5.373 18.627 0 12 0zm-4.385 15.615a3.615 3.615 0 1 0 0 7.23 3.615 3.615 0 0 0 0-7.23z" />
        </svg>
      );

    case 'douyin':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#FE2C55">
          <path d="M16.6 5.82s.51.5 0 0A4.278 4.278 0 0 1 15.54 3h-3.09v12.4a2.592 2.592 0 0 1-2.59 2.5 2.59 2.59 0 0 1-2.59-2.59 2.59 2.59 0 0 1 2.59-2.59c.31 0 .61.05.88.15V9.6a5.674 5.674 0 0 0-.88-.07C6.63 9.53 4.3 11.87 4.3 14.71c0 2.87 2.33 5.2 5.16 5.2 2.84 0 5.17-2.33 5.17-5.2V8.52c1.46 1.05 3.26 1.67 5.2 1.67V7.1a5.36 5.36 0 0 1-3.23-1.28z" />
        </svg>
      );

    case 'douyu':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#FF5D23">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14.5l-4-2.5 4-2.5v5zm3-5l-7 4.5V7.5l7 4.5z" />
        </svg>
      );

    case 'huya':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#FF8E00">
          <circle cx="12" cy="12" r="10" />
          <path d="M7 14l2-4h6l2 4-5 3-5-3z" fill="#FFFFFF" />
        </svg>
      );

    case 'kuaishou':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#FF4A00">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm4-7a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
        </svg>
      );

    case 'youtube':
    case 'youtubemusic':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#FF0000">
          <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
        </svg>
      );

    case 'netflix':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#E50914">
          <path d="M4 2v20h3.5l5.5-12.5V22H17V2h-3.5L8 14.5V2H4z" />
        </svg>
      );

    case 'twitch':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="#9146FF">
          <path d="M2.149 0L.537 4.119v16.836h5.731V24h3.224l3.045-3.045h4.657l6.269-6.269V0H2.149zm19.164 13.612l-3.582 3.582H12l-3.045 3.045v-3.045H4.119V2.149h17.194v11.463zm-3.582-7.343v6.269h-2.149V6.269h2.149zm-5.731 0v6.269H9.851V6.269h2.149z" />
        </svg>
      );

    // Fallback categories
    case 'generic-music':
      return fallbackEmoji ? <span>{fallbackEmoji}</span> : <span>🎵</span>;
    case 'generic-game':
      return fallbackEmoji ? <span>{fallbackEmoji}</span> : <span>🎮</span>;
    case 'generic-stream':
      return fallbackEmoji ? <span>{fallbackEmoji}</span> : <span>🔴</span>;
    case 'generic-watch':
      return fallbackEmoji ? <span>{fallbackEmoji}</span> : <span>📺</span>;

    default:
      if (fallbackEmoji) return <span>{fallbackEmoji}</span>;
      return null;
  }
}
