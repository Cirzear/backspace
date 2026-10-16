import { execFile } from 'child_process';
import type { MediaTrackInfo } from './types';
import { parsePlayerWindowTitle } from './titleParser';
import type { MediaChangeCallback } from './darwinMedia';

interface PlayerDefinition {
  key: string;
  name: string;
}

const WIN32_PLAYERS: Record<string, PlayerDefinition> = {
  'cloudmusic.exe': { key: 'cloudmusic', name: '网易云音乐' },
  'qqmusic.exe': { key: 'qqmusic', name: 'QQ音乐' },
  'spotify.exe': { key: 'spotify', name: 'Spotify' },
  'yandexmusic.exe': { key: 'yandexmusic', name: 'Yandex Music' },
  'kugou.exe': { key: 'kugou', name: '酷狗音乐' },
  'kwmusic.exe': { key: 'kwmusic', name: '酷我音乐' },
  'foobar2000.exe': { key: 'foobar2000', name: 'foobar2000' },
  'aimp.exe': { key: 'aimp', name: 'AIMP' },
  'musicbee.exe': { key: 'musicbee', name: 'MusicBee' },
};

const POLL_INTERVAL_MS = 6_000;

let intervalId: NodeJS.Timeout | null = null;
let currentTrack: MediaTrackInfo | null = null;
let isPolling = false;
let activeCallback: MediaChangeCallback | null = null;

/**
 * Parses Windows tasklist CSV line:
 * "Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"
 */
export function parseTasklistCsvLine(line: string): { imageName: string; windowTitle: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('"')) return null;

  // Split by "," respecting quotes
  const parts = trimmed.slice(1, -1).split('","');
  if (parts.length < 9) return null;

  return {
    imageName: parts[0]?.toLowerCase() ?? '',
    windowTitle: parts[8] ?? '',
  };
}

export function parseWin32TasklistOutput(stdout: string): MediaTrackInfo | null {
  const lines = stdout.split('\n');

  for (const line of lines) {
    const parsed = parseTasklistCsvLine(line);
    if (!parsed) continue;

    const playerDef = WIN32_PLAYERS[parsed.imageName];
    if (!playerDef) continue;

    const track = parsePlayerWindowTitle(playerDef.key, parsed.windowTitle);
    if (track && track.title) {
      return {
        title: track.title,
        artist: track.artist,
        isPlaying: true,
        player: playerDef.name,
      };
    }
  }

  return null;
}

function pollWin32(): void {
  if (isPolling) return;
  isPolling = true;

  execFile('tasklist', ['/v', '/fo', 'csv', '/nh'], { maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
    isPolling = false;
    if (err || !stdout) return;

    const detected = parseWin32TasklistOutput(stdout);

    if (detected) {
      if (
        !currentTrack ||
        currentTrack.title !== detected.title ||
        currentTrack.artist !== detected.artist ||
        currentTrack.player !== detected.player
      ) {
        currentTrack = detected;
        activeCallback?.(currentTrack);
      }
    } else if (currentTrack !== null) {
      currentTrack = null;
      activeCallback?.(null);
    }
  });
}

export function startWin32Media(callback: MediaChangeCallback): void {
  activeCallback = callback;
  if (process.platform !== 'win32') return;

  pollWin32();
  intervalId = setInterval(pollWin32, POLL_INTERVAL_MS);
}

export function stopWin32Media(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  currentTrack = null;
  activeCallback = null;
}
