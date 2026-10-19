import { describe, expect, it } from 'vitest';
import { sanitizeTrackUrl } from './trackUrl';
import { isAppIdleTitle, parsePlayerWindowTitle } from './titleParser';
import { convertTrackToActivity } from './index';
import { parseTasklistCsvLine, parseWin32TasklistOutput, decodeWin32Output } from './win32Media';
import { parseMprisMetadata, getPlayerDisplayName } from './linuxMpris';

describe('Media Detector - Canonical Track URLs', () => {
  it('normalizes Spotify URI to open.spotify.com URL', () => {
    expect(sanitizeTrackUrl('spotify:track:4cOdK2wGLETKBW3PvgPWqT')).toBe(
      'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
    );
  });

  it('strips tracking query parameters from Spotify URLs', () => {
    expect(
      sanitizeTrackUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc123xyz'),
    ).toBe('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
  });

  it('preserves NetEase song id', () => {
    expect(sanitizeTrackUrl('https://music.163.com/#/song?id=186016&userid=999')).toBe(
      'https://music.163.com/#/song?id=186016',
    );
  });

  it('preserves Apple Music track param i', () => {
    expect(
      sanitizeTrackUrl('https://music.apple.com/us/album/easy-on-me/1590035691?i=1590036033&extra=123'),
    ).toBe('https://music.apple.com/us/album/easy-on-me/1590035691?i=1590036033');
  });

  it('preserves YouTube Music video parameter v', () => {
    expect(
      sanitizeTrackUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&si=abc'),
    ).toBe('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('rejects general non-music URLs', () => {
    expect(sanitizeTrackUrl('https://github.com/TheZwiss/backspace')).toBeUndefined();
    expect(sanitizeTrackUrl('https://google.com')).toBeUndefined();
  });
});

describe('Media Detector - Window Title Parser', () => {
  it('detects idle status for players', () => {
    expect(isAppIdleTitle('cloudmusic', '网易云音乐')).toBe(true);
    expect(isAppIdleTitle('cloudmusic', '桌面歌词')).toBe(true);
    expect(isAppIdleTitle('qqmusic', 'QQ音乐')).toBe(true);
    expect(isAppIdleTitle('qqmusic', '桌面歌词')).toBe(true);
    expect(isAppIdleTitle('kugou', '桌面歌词')).toBe(true);
    expect(isAppIdleTitle('spotify', 'Spotify Free')).toBe(true);
    expect(isAppIdleTitle('spotify', 'Spotify Premium')).toBe(true);
    expect(isAppIdleTitle('yandexmusic', 'Яндекс Музыка')).toBe(true);
    expect(isAppIdleTitle('cloudmusic', 'N/A')).toBe(true);
    expect(isAppIdleTitle('cloudmusic', '暂缺')).toBe(true);
    expect(isAppIdleTitle('qqmusic', 'QQ音乐，听我想听的歌')).toBe(true);
  });

  it('supports dash variants (em-dash, en-dash, fullwidth dash)', () => {
    expect(parsePlayerWindowTitle('cloudmusic', '告白气球 – 周杰伦')).toEqual({
      title: '告白气球',
      artist: '周杰伦',
    });
    expect(parsePlayerWindowTitle('cloudmusic', '青花瓷 — 周杰伦')).toEqual({
      title: '青花瓷',
      artist: '周杰伦',
    });
    expect(parsePlayerWindowTitle('cloudmusic', '稻香 － 周杰伦')).toEqual({
      title: '稻香',
      artist: '周杰伦',
    });
    expect(parsePlayerWindowTitle('spotify', 'Taylor Swift — Blank Space')).toEqual({
      artist: 'Taylor Swift',
      title: 'Blank Space',
    });
  });

  it('parses NetEase Cloud Music title and artist (and strips player prefix if present)', () => {
    const res = parsePlayerWindowTitle('cloudmusic', '海阔天空 - Beyond');
    expect(res).toEqual({ title: '海阔天空', artist: 'Beyond' });

    const prefixed = parsePlayerWindowTitle('cloudmusic', '网易云音乐 - 晴天 - 周杰伦');
    expect(prefixed).toEqual({ title: '晴天', artist: '周杰伦' });
  });

  it('parses QQ Music title and artist', () => {
    const res = parsePlayerWindowTitle('qqmusic', '晴天 - 周杰伦');
    expect(res).toEqual({ title: '晴天', artist: '周杰伦' });
  });

  it('parses Spotify "Artist - Title" format', () => {
    const res = parsePlayerWindowTitle('spotify', 'Adele - Easy On Me');
    expect(res).toEqual({ artist: 'Adele', title: 'Easy On Me' });
  });

  it('parses Yandex Music and removes app suffix', () => {
    const res = parsePlayerWindowTitle('yandexmusic', 'Группа крови - Кино - Яндекс Музыка');
    expect(res).toEqual({ title: 'Группа крови', artist: 'Кино' });
  });

  it('parses KuGou Music format', () => {
    const res = parsePlayerWindowTitle('kugou', '周深 - 大鱼');
    expect(res).toEqual({ artist: '周深', title: '大鱼' });
  });

  it('returns null on idle app windows', () => {
    expect(parsePlayerWindowTitle('cloudmusic', '网易云音乐')).toBeNull();
    expect(parsePlayerWindowTitle('spotify', 'Spotify')).toBeNull();
  });
});

describe('Media Detector - Win32 Tasklist Parser', () => {
  it('parses tasklist CSV row with quotes', () => {
    const line = '"cloudmusic.exe","1234","Console","1","50,000 K","Unknown","User","0:01:23","海阔天空 - Beyond"';
    expect(parseTasklistCsvLine(line)).toEqual({
      imageName: 'cloudmusic.exe',
      windowTitle: '海阔天空 - Beyond',
    });
  });

  it('extracts track from tasklist output and ignores child processes with N/A or 暂缺', () => {
    const stdout = [
      '"explorer.exe","100","Console","1","10 K","Running","User","0:00:01","Desktop"',
      '"cloudmusic.exe","101","Console","1","20 K","Running","User","0:00:01","N/A"',
      '"cloudmusic.exe","102","Console","1","15 K","Running","User","0:00:01","暂缺"',
      '"cloudmusic.exe","103","Console","1","10 K","Running","User","0:00:01","桌面歌词"',
      '"cloudmusic.exe","200","Console","1","50 K","Running","User","0:00:10","海阔天空 - Beyond"',
    ].join('\n');

    const result = parseWin32TasklistOutput(stdout);
    expect(result).toEqual({
      title: '海阔天空',
      artist: 'Beyond',
      isPlaying: true,
      player: 'NetEase Cloud Music',
    });
  });

  it('correctly decodes GBK/CP936 bytes to prevent Chinese mojibake', () => {
    // "海阔天空" in GBK hex: ba a3 c0 ab cc ec bf d5
    const gbkBytes = Buffer.concat([
      Buffer.from('"cloudmusic.exe","123","Console","1","50 K","Running","User","0:01:23","'),
      Buffer.from('baa3c0abccecbfd5', 'hex'),
      Buffer.from(' - Beyond"'),
    ]);
    const decoded = decodeWin32Output(gbkBytes);
    expect(decoded).toContain('海阔天空 - Beyond');
    const parsed = parseWin32TasklistOutput(decoded);
    expect(parsed?.title).toBe('海阔天空');
    expect(parsed?.artist).toBe('Beyond');
  });
});

describe('Media Detector - Linux MPRIS Parser', () => {
  it('formats player display names', () => {
    expect(getPlayerDisplayName('org.mpris.MediaPlayer2.spotify')).toBe('Spotify');
    expect(getPlayerDisplayName('org.mpris.MediaPlayer2.netease-cloud-music')).toBe('网易云音乐');
    expect(getPlayerDisplayName('org.mpris.MediaPlayer2.qqmusic')).toBe('QQ音乐');
  });

  it('parses MPRIS metadata dictionary', () => {
    const metadata = {
      'xesam:title': { value: 'Bohemian Rhapsody' },
      'xesam:artist': { value: ['Queen'] },
      'xesam:album': { value: 'A Night at the Opera' },
      'mpris:length': { value: 354000000 }, // 354 seconds in microseconds
      'mpris:artUrl': { value: 'https://i.scdn.co/image/ab67616d0000b273ce4f0f67' },
      'xesam:url': { value: 'https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J' },
    };

    const track = parseMprisMetadata(metadata, 'Spotify');
    expect(track).toEqual({
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      album: 'A Night at the Opera',
      artUrl: 'https://i.scdn.co/image/ab67616d0000b273ce4f0f67',
      durationMs: 354000,
      isPlaying: true,
      player: 'Spotify',
      sourceUrl: 'https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J',
    });
  });
});

describe('Media Detector - Activity Conversion', () => {
  it('converts MediaTrackInfo to listening Activity with duration and timestamps', () => {
    const now = Date.now();
    const track = {
      title: '光辉岁月',
      artist: 'Beyond',
      album: '命运派对',
      durationMs: 300000, // 5 min
      positionMs: 60000,  // 1 min in
      isPlaying: true,
      player: '网易云音乐',
      sourceUrl: 'https://music.163.com/#/song?id=347230',
    };

    const activity = convertTrackToActivity(track);
    expect(activity).not.toBeNull();
    expect(activity?.type).toBe('listening');
    expect(activity?.name).toBe('光辉岁月');
    expect(activity?.details).toBe('Beyond');
    expect(activity?.state).toBe('命运派对');
    expect(activity?.assets?.smallText).toBe('网易云音乐');
    expect(activity?.url).toBe('https://music.163.com/#/song?id=347230');

    // Timestamps check: start should be roughly now - 60s, end should be start + 300s
    expect(activity?.timestamps?.start).toBeCloseTo(now - 60000, -2);
    expect(activity?.timestamps?.end).toBeCloseTo(now - 60000 + 300000, -2);
  });
});
