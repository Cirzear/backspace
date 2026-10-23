import { execFile } from 'child_process';
import type { MediaTrackInfo } from './types';
import { parsePlayerWindowTitle } from './titleParser';
import type { MediaChangeCallback } from './darwinMedia';

interface PlayerDefinition {
  key: string;
  name: string;
}

// Tasklist fallback only checks legacy desktop music players that do not support WinRT SMTC.
// Modern players (NetEase Cloud Music, QQ Music, Spotify) natively register in Windows SMTC
// and MUST NOT be polled via tasklist, because their Win32 window titles do not update when paused.
const WIN32_LEGACY_PLAYERS: Record<string, PlayerDefinition> = {
  'foobar2000.exe': { key: 'foobar2000', name: 'foobar2000' },
  'aimp.exe': { key: 'aimp', name: 'AIMP' },
  'musicbee.exe': { key: 'musicbee', name: 'MusicBee' },
};

const POLL_INTERVAL_MS = 2_000;

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

    const playerDef = WIN32_LEGACY_PLAYERS[parsed.imageName];
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

/**
 * Decodes buffer from Windows CLI output (tasklist, etc.).
 * Windows consoles default to OEM code pages (e.g. CP936/GBK on Simplified Chinese).
 * Tries UTF-8 first, then falls back to GB18030 to prevent mojibake.
 */
export function decodeWin32Output(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

export function resolvePlayerFromAppId(appId: string): string {
  const lower = appId.toLowerCase();
  if (lower.includes('cloudmusic') || lower.includes('netease')) return 'NetEase Cloud Music';
  if (lower.includes('qqmusic')) return 'QQ Music';
  if (lower.includes('spotify')) return 'Spotify';
  if (lower.includes('applemusic') || lower.includes('music.ui')) return 'Apple Music';
  if (lower.includes('kugou')) return 'KuGou';
  if (lower.includes('kuwo') || lower.includes('kwmusic')) return 'Kuwo';
  if (lower.includes('yandex')) return 'Yandex Music';
  if (lower.includes('foobar')) return 'foobar2000';
  if (lower.includes('aimp')) return 'AIMP';
  if (lower.includes('musicbee')) return 'MusicBee';
  if (lower.includes('chrome')) return 'Chrome';
  if (lower.includes('msedge')) return 'Edge';
  if (lower.includes('firefox')) return 'Firefox';
  return appId || 'Music';
}

export interface SmtcParsedResult {
  status: 'playing' | 'paused' | 'idle' | 'no_sessions';
  player?: string;
  title?: string;
  artist?: string;
}

export function parseSmtcOutput(output: string): SmtcParsedResult {
  const line = output.trim();
  if (line.startsWith('PLAYING|')) {
    const parts = line.split('|');
    const appId = parts[1] || '';
    const title = parts[2] || '';
    const artist = parts[3] || '';
    return {
      status: 'playing',
      player: resolvePlayerFromAppId(appId),
      title: title.trim(),
      artist: artist.trim(),
    };
  }
  if (line.startsWith('PAUSED')) {
    return { status: 'paused' };
  }
  if (line.startsWith('NO_SESSIONS')) {
    return { status: 'no_sessions' };
  }
  return { status: 'idle' };
}

/**
 * Windows Runtime GlobalSystemMediaTransportControlsSessionManager powershell script.
 * Compatible with both Windows PowerShell 5.1 (.NET Framework) and PowerShell 7+ (.NET Core).
 * Uses System.Runtime.WindowsRuntime AsTask reflection for async WinRT operations.
 *
 * Inspects all media sessions in the system:
 * - If any session has PlaybackStatus == 4 (Playing), outputs PLAYING|<AppId>|<Title>|<Artist>
 * - If media sessions exist but none are playing (paused / stopped), outputs PAUSED
 * - If no media sessions exist at all, outputs NO_SESSIONS
 */
export const SMTC_SCRIPT =
  `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
  `try { ` +
    `[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null; ` +
    `[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null; ` +
    `Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue; ` +
    `$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { ` +
      `$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' ` +
    `})[0]; ` +
    `function Await-WinRT($op, $type) { ` +
      `if (-not $op) { return $null; } ` +
      `try { return $op.GetAwaiter().GetResult(); } catch { ` +
        `$m = $asTask.MakeGenericMethod($type); ` +
        `$netTask = $m.Invoke($null, @($op)); ` +
        `$netTask.Wait(3000) | Out-Null; ` +
        `return $netTask.Result; ` +
      `} ` +
    `}; ` +
    `$mgr = Await-WinRT ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]); ` +
    `if (-not $mgr) { Write-Output 'NO_SESSIONS'; exit; }; ` +
    `$sessions = $mgr.GetSessions(); ` +
    `if ($sessions.Count -eq 0) { Write-Output 'NO_SESSIONS'; exit; }; ` +
    `$playing = $null; ` +
    `foreach ($s in $sessions) { ` +
      `try { if ($s.GetPlaybackInfo().PlaybackStatus.value__ -eq 4) { $playing = $s; break; } } catch {} ` +
    `}; ` +
    `if ($playing) { ` +
      `$props = Await-WinRT ($playing.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]); ` +
      `if ($props -and $props.Title) { ` +
        `Write-Output ('PLAYING|' + $playing.SourceAppUserModelId + '|' + $props.Title + '|' + $props.Artist); ` +
      `} else { Write-Output 'PAUSED'; } ` +
    `} else { Write-Output 'PAUSED'; } ` +
  `} catch { Write-Output ('ERROR|' + $_.Exception.Message); }`;

function pollSmtc(callback: (handled: boolean, track: MediaTrackInfo | null) => void): void {
  execFile(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SMTC_SCRIPT],
    { maxBuffer: 1024 * 1024, timeout: 4000, windowsHide: true },
    (err, stdout) => {
      if (err || !stdout) {
        callback(false, null);
        return;
      }
      const raw = stdout.toString().trim();
      if (raw.startsWith('ERROR|')) {
        callback(false, null);
        return;
      }
      const parsed = parseSmtcOutput(raw);
      if (parsed.status === 'playing' && parsed.title) {
        callback(true, {
          title: parsed.title,
          artist: parsed.artist || '',
          isPlaying: true,
          player: parsed.player || 'Music',
        });
      } else if (parsed.status === 'paused' || parsed.status === 'idle') {
        // SMTC is authoritative: no session is playing.
        // Handled = true: strictly block tasklist fallback so paused window titles don't resurface!
        callback(true, null);
      } else {
        // NO_SESSIONS: fallback to tasklist for legacy non-SMTC players (foobar2000, AIMP, etc.)
        callback(false, null);
      }
    },
  );
}

function applyDetectedTrack(detected: MediaTrackInfo | null): void {
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
}

function pollWin32(): void {
  if (isPolling) return;
  isPolling = true;

  pollSmtc((handled, smtcTrack) => {
    if (handled) {
      isPolling = false;
      applyDetectedTrack(smtcTrack);
      return;
    }

    // Fallback to tasklist only for legacy non-SMTC players (foobar2000, AIMP, etc.)
    execFile(
      'tasklist',
      ['/v', '/fo', 'csv', '/nh'],
      { maxBuffer: 2 * 1024 * 1024, encoding: 'buffer', windowsHide: true },
      (err, stdout) => {
        isPolling = false;
        if (err || !stdout) {
          applyDetectedTrack(null);
          return;
        }

        const rawString = typeof stdout === 'string' ? stdout : decodeWin32Output(stdout);
        const detected = parseWin32TasklistOutput(rawString);
        applyDetectedTrack(detected);
      },
    );
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
