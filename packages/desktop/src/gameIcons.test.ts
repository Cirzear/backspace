import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findGameIcon,
  getGameIcon,
  warmGameIcon,
  warmGameIconForIpc,
  sniffImageMime,
  parseDesktopEntry,
  __testResetGameIconCache,
  type GameIconTarget,
} from './gameIcons';

// Minimal images: the extractor only sniffs magic bytes; the server is the
// party that decodes and re-encodes.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('rest-of-a-png'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest-of-a-jpg')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBP'), Buffer.from('VP8 data')]);
const NOT_AN_IMAGE = Buffer.from('just text, no image magic at all');

let home: string;

function write(file: string, bytes: Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function target(overrides: Partial<GameIconTarget> = {}): GameIconTarget {
  return { id: 'some-game', name: 'Some Game', exe: null, cmdline: '', ...overrides };
}

beforeEach(() => {
  __testResetGameIconCache();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'game-icons-test-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('sniffImageMime', () => {
  it('recognizes the three accepted formats and nothing else', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
    expect(sniffImageMime(NOT_AN_IMAGE)).toBeNull();
    expect(sniffImageMime(Buffer.alloc(4))).toBeNull();
  });
});

describe('parseDesktopEntry', () => {
  it('reads Exec, Name and Icon from the desktop section only', () => {
    const entry = parseDesktopEntry([
      '[Desktop Entry]',
      'Type=Application',
      'Name=My Game',
      'Exec=/opt/mygame/run.sh --flag',
      'Icon=mygame',
      '',
      '[Desktop Action Play]',
      'Icon=should-not-win',
    ].join('\n'));
    expect(entry).toEqual({ exec: '/opt/mygame/run.sh --flag', name: 'My Game', icon: 'mygame' });
  });

  it('returns null without an Icon', () => {
    expect(parseDesktopEntry('[Desktop Entry]\nName=x\nExec=y\n')).toBeNull();
  });
});

describe('findGameIcon', () => {
  it('reads the Steam library cache by app id', async () => {
    write(path.join(home, '.local', 'share', 'Steam', 'appcache', 'librarycache', '1234_icon.jpg'), JPEG);
    const icon = await findGameIcon(target({ id: 'steam-1234' }), home);
    expect(icon?.mime).toBe('image/jpeg');
  });

  it('falls back to Steam cover art when the grid icon is missing', async () => {
    write(path.join(home, '.local', 'share', 'Steam', 'appcache', 'librarycache', '1234', 'library_600x900.jpg'), JPEG);
    const icon = await findGameIcon(target({ id: 'steam-1234' }), home);
    expect(icon?.mime).toBe('image/jpeg');
  });

  it('reads a GOG install directory icon', async () => {
    const gameDir = path.join(home, 'GOG Games', 'Beneath A Steel Sky');
    write(path.join(gameDir, 'goggame-1207658924.info'), Buffer.from('{"name":"Beneath A Steel Sky","gameId":"1207658924"}'));
    write(path.join(gameDir, 'support', 'icon.png'), PNG);
    const icon = await findGameIcon(target({ id: 'gog-1207658924' }), home);
    expect(icon?.mime).toBe('image/png');
  });

  it('finds the .DirIcon at an AppImage mount root, two levels above the binary', async () => {
    // osu!lazer's AppImage mounts with the binary at <mount>/usr/bin/osu!
    const mount = path.join(home, '.mount_osuABCD');
    write(path.join(mount, 'usr', 'bin', 'osu!'), Buffer.from('elf binary'));
    write(path.join(mount, '.DirIcon'), PNG);
    const icon = await findGameIcon(target({ name: 'osu!', exe: path.join(mount, 'usr', 'bin', 'osu!') }), home);
    expect(icon?.mime).toBe('image/png');
  });

  it('resolves a .desktop entry by executable and looks its icon up in hicolor', async () => {
    write(path.join(home, '.local', 'share', 'applications', 'mygame.desktop'), Buffer.from([
      '[Desktop Entry]',
      'Type=Application',
      'Name=My Game',
      'Exec=/opt/mygame/bin/mygame',
      'Icon=mygame',
    ].join('\n')));
    write(path.join(home, '.local', 'share', 'icons', 'hicolor', '128x128', 'apps', 'mygame.png'), PNG);
    const icon = await findGameIcon(target({ name: 'My Game', exe: '/opt/mygame/bin/mygame' }), home);
    expect(icon?.mime).toBe('image/png');
  });

  it('matches a .desktop entry by display name and takes its absolute icon path', async () => {
    const iconFile = write(path.join(home, 'named-game', 'icon.png'), PNG);
    write(path.join(home, '.local', 'share', 'applications', 'named.desktop'), Buffer.from([
      '[Desktop Entry]',
      'Type=Application',
      'Name=My Game',
      'Exec=/somewhere/bin/mygame',
      `Icon=${iconFile}`,
    ].join('\n')));
    const icon = await findGameIcon(target({ name: 'my game' }), home);
    expect(icon?.mime).toBe('image/png');
  });

  it('returns null when nothing matches', async () => {
    expect(await findGameIcon(target({ name: 'Nothing' }), home)).toBeNull();
  });

  it('skips files that are not accepted images', async () => {
    write(path.join(home, '.local', 'share', 'Steam', 'appcache', 'librarycache', '1234_icon.jpg'), NOT_AN_IMAGE);
    expect(await findGameIcon(target({ id: 'steam-1234' }), home)).toBeNull();
  });
});

describe('warm cache', () => {
  it('warms by scan target and serves the icon by game name', async () => {
    write(path.join(home, '.local', 'share', 'Steam', 'appcache', 'librarycache', '1234_icon.jpg'), JPEG);
    await warmGameIcon(target({ id: 'steam-1234', name: 'My Steam Game' }), home);
    expect(getGameIcon('My Steam Game')?.mime).toBe('image/jpeg');
    // Second warm of the same name is a no-op that keeps the cached icon
    await warmGameIcon(target({ id: 'steam-9999', name: 'My Steam Game' }), home);
    expect(getGameIcon('My Steam Game')?.mime).toBe('image/jpeg');
  });

  it('remembers a miss instead of rescanning every poll', async () => {
    await warmGameIcon(target({ name: 'Ghost Game' }), home);
    expect(getGameIcon('Ghost Game')).toBeNull();
  });

  it('warms for an IPC push through the /proc exe of the pushing pid', async () => {
    // This test process's own pid: its exe is a binary with no icons around,
    // proving the /proc path runs and caches the miss without throwing.
    await warmGameIconForIpc('Ghost IPC Game', process.pid, '/proc');
    expect(getGameIcon('Ghost IPC Game')).toBeNull();
  });

  it('tolerates a dead pid', async () => {
    await warmGameIconForIpc('Dead Pid Game', 999_999_999, '/proc');
    expect(getGameIcon('Dead Pid Game')).toBeNull();
  });
});
