export interface MediaTrackInfo {
  title: string;
  artist: string;
  album?: string;
  artUrl?: string;
  durationMs?: number;
  positionMs?: number;
  isPlaying: boolean;
  player: string;
  sourceUrl?: string;
}

export interface MediaActivity {
  type: 'listening';
  name: string;
  details?: string;
  state?: string;
  timestamps?: {
    start?: number;
    end?: number;
  };
  assets?: {
    largeImage?: string;
    largeText?: string;
    smallImage?: string;
    smallText?: string;
  };
  url?: string;
}
