import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  pickProcName,
  readProcessInfos,
  readProcessInfoByPid,
  parseProcessList,
  matchesProcessName,
  findMatchingGame,
  detectActivity,
  parseGameEntry,
  validateDictionaryObject,
  loadDictionaryFile,
  loadBestDictionary,
  startActivityDetection,
  stopActivityDetection,
  getCurrentActivity,
  applyIpcActivity,
  resolveIpcGameName,
  __testSetScanActivity,
  type SourceDetector,
} from './activityDetector';
import type { IpcActivityPush, IpcActivityPayload } from './richPresenceIpc';

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-userdata' },
}));

// The suite runs with cwd = packages/desktop (vitest config dir)
const cwdSeed = path.join(process.cwd(), 'resources', 'games.json');
const seedPath = fs.existsSync(cwdSeed)
  ? cwdSeed
  : path.join(process.cwd(), 'packages', 'desktop', 'resources', 'games.json');

// ─── Fake /proc helpers ─────────────────────────────────────────────────────

interface FakeProc {
  pid: number;
  /** Symlink target for /proc/<pid>/exe; 'REGULAR' = a plain file (readlink fails); undefined = absent */
  exe?: string | 'REGULAR';
  /** NUL-separated argv tokens */
  cmdline?: string[];
  comm?: string;
}

function makeFakeProc(entries: FakeProc[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
  for (const e of entries) {
    const dir = path.join(root, String(e.pid));
    fs.mkdirSync(dir);
    if (e.exe === 'REGULAR') {
      fs.writeFileSync(path.join(dir, 'exe'), 'not-a-symlink');
    } else if (e.exe !== undefined) {
      // Symlink targets need not exist for readlink
      fs.symlinkSync(e.exe, path.join(dir, 'exe'));
    }
    if (e.cmdline) {
      fs.writeFileSync(path.join(dir, 'cmdline'), e.cmdline.join('\0') + '\0');
    }
    if (e.comm) {
      fs.writeFileSync(path.join(dir, 'comm'), e.comm + '\n');
    }
  }
  // Noise that exists in real /proc
  fs.mkdirSync(path.join(root, 'self'));
  fs.mkdirSync(path.join(root, 'sys'));
  fs.writeFileSync(path.join(root, 'stat'), 'cpu 1 2 3 4');
  return root;
}

// ─── pickProcName ───────────────────────────────────────────────────────────

describe('pickProcName', () => {
  it('prefers the exe symlink basename, wine paths included', () => {
    expect(pickProcName('/home/u/.wine/drive_c/Program Files/osu!/osu!.exe', [], null)).toBe('osu!.exe');
    expect(pickProcName('/usr/games/cs2', [], null)).toBe('cs2');
  });

  it('keeps the full name for AppImage-mounted binaries', () => {
    expect(pickProcName('/tmp/.mount_superTuxKXYZ/usr/bin/supertux2', [], null)).toBe('supertux2');
  });

  it('falls back to the first cmdline token basename when exe is unreadable', () => {
    expect(pickProcName(null, ['/usr/bin/python3', '-m', 'http.server'], null)).toBe('python3');
  });

  it('falls back to comm (possibly kernel-truncated) as a last resort', () => {
    expect(pickProcName(null, [], 'minecraft-launc')).toBe('minecraft-launc');
  });

  it('returns null when nothing is available (pure kernel thread)', () => {
    expect(pickProcName(null, [], null)).toBeNull();
  });
});

// ─── matchesProcessName ─────────────────────────────────────────────────────

describe('matchesProcessName', () => {
  const cs2 = { id: 'cs2', name: 'Counter-Strike 2', processes: ['cs2.exe', 'cs2'] };

  it('matches process names case-insensitively', () => {
    expect(matchesProcessName(cs2, 'CS2.exe', '')).toBe(true);
    expect(matchesProcessName(cs2, 'cs2', '')).toBe(true);
    expect(matchesProcessName(cs2, 'CS2', '')).toBe(true);
  });

  it('does not match unrelated names', () => {
    expect(matchesProcessName(cs2, 'csgo', '')).toBe(false);
    expect(matchesProcessName(cs2, 'cs2_beta', '')).toBe(false);
  });

  it('matches long dictionary names against kernel-truncated 15-char comm values', () => {
    const launcher = { id: 'l', name: 'L', processes: ['minecraft-launcher'] };
    expect(matchesProcessName(launcher, 'minecraft-launc', '')).toBe(true); // 15 chars
  });

  it('does not apply the truncation rule to shorter or divergent names', () => {
    const launcher = { id: 'l', name: 'L', processes: ['minecraft-launcher'] };
    expect(matchesProcessName(launcher, 'minecraft-laun', '')).toBe(false); // 14 chars
    expect(matchesProcessName(launcher, 'minecraft-launx', '')).toBe(false); // wrong 16th... wrong tail
    expect(matchesProcessName(launcher, 'minecraft-launc2', '')).toBe(false); // 16 chars, not truncated
  });

  it('requires exact match for dictionary names of 15 chars or fewer', () => {
    const short = { id: 's', name: 'S', processes: ['supertuxkart'] }; // 12 chars
    expect(matchesProcessName(short, 'supertuxkart', '')).toBe(true);
    expect(matchesProcessName(short, 'supertuxkar', '')).toBe(false);
  });

  it('matches cmdline patterns case-insensitively in the joined command line', () => {
    const mc = {
      id: 'minecraft',
      name: 'Minecraft',
      processes: [],
      cmdlinePatterns: ['net.fabricmc.loader.impl.launch.knot.knotclient'],
    };
    const cmdline = '/usr/lib/jvm/java-21/bin/java -Xmx2G -cp mods:libraries net.fabricmc.loader.impl.launch.knot.KnotClient --username herobrine';
    expect(matchesProcessName(mc, 'java', cmdline)).toBe(true);
  });

  it('matches an entry with empty processes through its patterns alone', () => {
    const mc = { id: 'minecraft', name: 'Minecraft', processes: [], cmdlinePatterns: ['net.minecraft.client.main.main'] };
    expect(matchesProcessName(mc, 'java', '/usr/bin/java net.minecraft.client.main.Main --version 1.21')).toBe(true);
    expect(matchesProcessName(mc, 'java', '/usr/bin/java -jar server.jar nogui')).toBe(false);
  });

  it('does not flag Minecraft servers or unrelated java processes', () => {
    const mc = { id: 'minecraft', name: 'Minecraft', processes: [], cmdlinePatterns: ['net.minecraft.client.main.main', '--launchtarget forgeclient'] };
    expect(matchesProcessName(mc, 'java', 'java -Xmx4G net.minecraft.server.Main nogui')).toBe(false);
    expect(matchesProcessName(mc, 'java', 'java --launchTarget forgeserver nogui')).toBe(false);
    expect(matchesProcessName(mc, 'java', 'java -jar modrinth-app.jar')).toBe(false);
    expect(matchesProcessName(mc, 'code', '/usr/share/code/code --type=renderer')).toBe(false);
  });
});

// ─── parseProcessList ───────────────────────────────────────────────────────

describe('parseProcessList', () => {
  it('parses Windows tasklist CSV output', () => {
    const out = '"cs2.exe","1234","Console","1","1,234 K"\n"explorer.exe","99","Console","1","56 K"\n';
    expect(parseProcessList(out, 'win32')).toEqual(new Set(['cs2.exe', 'explorer.exe']));
  });

  it('skips junk lines in tasklist output', () => {
    expect(parseProcessList('INFO: no tasks\n\n"obs64.exe","7","Console","1","2 K"\n', 'win32'))
      .toEqual(new Set(['obs64.exe']));
  });

  it('parses Linux ps output and skips the header', () => {
    const out = 'COMMAND\nsystemd\n  minecraft-launc\nPlasma\n';
    expect(parseProcessList(out, 'linux')).toEqual(new Set(['systemd', 'minecraft-launc', 'plasma']));
  });

  it('parses macOS ps -c output and skips the COMM header', () => {
    const out = 'COMM\nWindowServer\nOBS\n';
    expect(parseProcessList(out, 'darwin')).toEqual(new Set(['windowserver', 'obs']));
  });
});

// ─── readProcessInfos (fake /proc) ──────────────────────────────────────────

describe('readProcessInfos', () => {
  it('reads pid, name, cmdline and the full exe path for regular processes', () => {
    const root = makeFakeProc([
      { pid: 42, exe: '/usr/games/cs2', cmdline: ['/usr/games/cs2', '-novid'], comm: 'cs2' },
    ]);
    const infos = readProcessInfos(root);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toEqual({ pid: 42, name: 'cs2', cmdline: '/usr/games/cs2 -novid', exe: '/usr/games/cs2' });
  });

  it('resolves wine processes to the .exe basename and keeps the prefix path', () => {
    const root = makeFakeProc([
      { pid: 7, exe: '/home/u/.wine/drive_c/Program Files/osu!/osu!.exe', cmdline: ['C:\\\\Program Files\\\\osu!\\\\osu!.exe'], comm: 'osu!.exe' },
    ]);
    const infos = readProcessInfos(root);
    expect(infos[0]?.name).toBe('osu!.exe');
    expect(infos[0]?.exe).toBe('/home/u/.wine/drive_c/Program Files/osu!/osu!.exe');
  });

  it('falls back to comm when the exe symlink is unreadable and cmdline is empty', () => {
    const root = makeFakeProc([
      { pid: 9, exe: 'REGULAR', comm: 'minecraft-launc' },
    ]);
    const infos = readProcessInfos(root);
    expect(infos[0]?.name).toBe('minecraft-launc');
    expect(infos[0]?.cmdline).toBe('');
  });

  it('skips kernel threads with no name sources', () => {
    const root = makeFakeProc([
      { pid: 2, comm: 'kthreadd' }, // exe absent, cmdline absent → comm present though
      { pid: 3 }, // nothing at all
    ]);
    const infos = readProcessInfos(root);
    // pid 2 has comm → name kthreadd; pid 3 has nothing → skipped
    expect(infos.map((i) => i.pid)).toEqual([2]);
  });

  it('ignores exe targets marked (deleted)', () => {
    const root = makeFakeProc([
      { pid: 5, exe: '/tmp/AppRun (deleted)', cmdline: [], comm: 'app' },
    ]);
    const infos = readProcessInfos(root);
    expect(infos[0]?.name).toBe('app'); // comm wins because exe is ignored
  });

  it('ignores non-numeric /proc entries', () => {
    const root = makeFakeProc([{ pid: 11, exe: '/usr/bin/obs', comm: 'obs' }]);
    const infos = readProcessInfos(root);
    expect(infos.map((i) => i.pid)).toEqual([11]);
  });

  it('survives a missing /proc root', () => {
    expect(readProcessInfos(path.join(os.tmpdir(), 'definitely-not-here-12345'))).toEqual([]);
  });
});

describe('readProcessInfoByPid', () => {
  it('reads a single pid', () => {
    const root = makeFakeProc([
      { pid: 42, exe: '/usr/games/cs2', cmdline: ['/usr/games/cs2'], comm: 'cs2' },
    ]);
    expect(readProcessInfoByPid(42, root)).toEqual({ pid: 42, name: 'cs2', cmdline: '/usr/games/cs2', exe: '/usr/games/cs2' });
    expect(readProcessInfoByPid(999, root)).toBeNull();
  });
});

// ─── findMatchingGame and priority ──────────────────────────────────────────

describe('findMatchingGame', () => {
  const dict = [
    { id: 'cs2', name: 'Counter-Strike 2', processes: ['cs2.exe', 'cs2'] },
    { id: 'minecraft', name: 'Minecraft', processes: [], cmdlinePatterns: ['net.minecraft.client.main.main'] },
    { id: 'minecraft-launcher', name: 'Minecraft Launcher', processes: ['minecraft-launcher', 'prismlauncher'] },
  ];

  it('returns the first dictionary entry matched by any process', () => {
    const infos = [{ pid: 1, name: 'obs', cmdline: '', exe: null }, { pid: 2, name: 'cs2', cmdline: '', exe: null }];
    expect(findMatchingGame(infos, dict)?.id).toBe('cs2');
  });

  it('prefers the game over the launcher when both run (dictionary order)', () => {
    const infos = [
      { pid: 1, name: 'prismlauncher', cmdline: 'prismlauncher', exe: null },
      { pid: 2, name: 'java', cmdline: '/usr/bin/java net.minecraft.client.main.Main --username x', exe: null },
    ];
    expect(findMatchingGame(infos, dict)?.id).toBe('minecraft');
  });

  it('detects the launcher alone via the truncated comm', () => {
    const infos = [{ pid: 1, name: 'minecraft-launc', cmdline: 'minecraft-launcher', exe: null }];
    expect(findMatchingGame(infos, dict)?.id).toBe('minecraft-launcher');
  });

  it('returns null when nothing matches', () => {
    const infos = [{ pid: 1, name: 'systemd', cmdline: '/sbin/init', exe: null }];
    expect(findMatchingGame(infos, dict)).toBeNull();
  });
});

// ─── detectActivity: dictionary vs sources ──────────────────────────────────

describe('detectActivity', () => {
  const dict = [
    { id: 'tf2', name: 'Team Fortress 2', processes: ['tf2_linux', 'tf2_osx', 'tf_win64.exe'] },
  ];

  const steamSource: SourceDetector = (info) =>
    info.exe?.includes('/steamapps/common/')
      ? { id: 'steam-424242', name: 'Dictionaryless Steam Game', type: 'playing' }
      : null;

  it('prefers the dictionary over a source when both match', () => {
    const infos = [{ pid: 1, name: 'tf2_linux', cmdline: '', exe: '/x/steamapps/common/Team Fortress 2/hl2_linux' }];
    const match = detectActivity(infos, dict, [steamSource]);
    expect(match).toEqual({ id: 'tf2', name: 'Team Fortress 2', type: 'playing' });
  });

  it('falls through to sources for games the dictionary does not list', () => {
    const infos = [{ pid: 1, name: 'sonic-bin', cmdline: '', exe: '/x/steamapps/common/Sonic/sonic-bin' }];
    const match = detectActivity(infos, dict, [steamSource]);
    expect(match).toEqual({ id: 'steam-424242', name: 'Dictionaryless Steam Game', type: 'playing' });
  });

  it('tries sources in registration order and keeps the first claim', () => {
    const infos = [{ pid: 1, name: 'unknown', cmdline: '', exe: '/games/somewhere/game' }];
    const first: SourceDetector = () => ({ id: 'source-a', name: 'A', type: 'playing' });
    const second: SourceDetector = () => ({ id: 'source-b', name: 'B', type: 'playing' });
    expect(detectActivity(infos, dict, [first, second])?.id).toBe('source-a');
  });

  it('returns null when neither dictionary nor sources match', () => {
    const infos = [{ pid: 1, name: 'systemd', cmdline: '/sbin/init', exe: '/sbin/init' }];
    expect(detectActivity(infos, dict, [steamSource])).toBeNull();
  });
});

// ─── Seed dictionary contract ───────────────────────────────────────────────

describe('bundled seed dictionary (games.json v3)', () => {
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as { version: number; games: unknown[] };

  it('is versioned as v3', () => {
    expect(seed.version).toBe(3);
  });

  it('contains osu! for both wine and native lazer', () => {
    const osu = seed.games.find((g) => (g as { id: string }).id === 'osu') as { processes: string[] };
    expect(osu).toBeDefined();
    expect(osu.processes).toContain('osu!.exe');
    expect(osu.processes).toContain('osu!');
  });

  it('matches Minecraft by launcher-agnostic cmdline patterns', () => {
    const mc = seed.games.find((g) => (g as { id: string }).id === 'minecraft') as {
      processes: string[]; cmdlinePatterns?: string[];
    };
    expect(mc).toBeDefined();
    expect(mc.cmdlinePatterns?.length).toBeGreaterThanOrEqual(8);
    expect(mc.processes).not.toContain('java');
    expect(mc.processes).not.toContain('minecraft-launcher'); // moved to its own entry
  });

  it('lists the launcher entry after the game entry', () => {
    const ids = seed.games.map((g) => (g as { id: string }).id);
    expect(ids.indexOf('minecraft')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('minecraft-launcher')).toBeGreaterThan(ids.indexOf('minecraft'));
  });

  it('has unique ids and only parse-valid entries', () => {
    const ids = seed.games.map((g) => (g as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of seed.games) {
      expect(parseGameEntry(entry)).not.toBeNull();
    }
  });

  it('still detects the OBS regression case from the seed', () => {
    const obs = seed.games.find((g) => (g as { id: string }).id === 'obs') as { processes: string[] };
    expect(obs.processes).toContain('obs');
  });

  it('carries the native Linux titles without dedicated servers', () => {
    const ids = seed.games.map((g) => (g as { id: string }).id);
    for (const id of ['wesnoth', 'luanti', 'openmw', '0ad', 'supertuxkart', 'hl2', 'warzone2100', 'teeworlds', 'endless-sky', 'mindustry', 'xonotic']) {
      expect(ids).toContain(id);
    }
    const all = seed.games.flatMap((g) => (g as { processes: string[] }).processes);
    for (const server of ['wesnothd', 'minetestserver', 'luantiserver', 'teeworlds_srv']) {
      expect(all).not.toContain(server);
    }
  });
});

// ─── Dictionary parsing and loading ─────────────────────────────────────────

describe('parseGameEntry', () => {
  it('rejects entries with no processes and no patterns', () => {
    expect(parseGameEntry({ id: 'x', name: 'X', processes: [] })).toBeNull();
  });

  it('rejects empty pattern strings and non-string processes', () => {
    expect(parseGameEntry({ id: 'x', name: 'X', processes: [], cmdlinePatterns: [''] })).toBeNull();
    expect(parseGameEntry({ id: 'x', name: 'X', processes: ['ok', 5] })).toBeNull();
  });

  it('defaults type to playing and keeps valid types', () => {
    expect(parseGameEntry({ id: 'x', name: 'X', processes: ['a'] })?.type).toBe('playing');
    expect(parseGameEntry({ id: 'x', name: 'X', processes: ['a'], type: 'watching' })?.type).toBe('watching');
    expect(parseGameEntry({ id: 'x', name: 'X', processes: ['a'], type: 'bogus' })?.type).toBe('playing');
  });
});

describe('validateDictionaryObject', () => {
  it('accepts the versioned format', () => {
    const v = validateDictionaryObject({ version: 7, games: [{ id: 'a', name: 'A', processes: ['a'] }] });
    expect(v?.version).toBe(7);
    expect(v?.entries).toHaveLength(1);
  });

  it('accepts the legacy bare array as version 0', () => {
    const v = validateDictionaryObject([{ id: 'a', name: 'A', processes: ['a'] }]);
    expect(v?.version).toBe(0);
  });

  it('rejects empty or malformed dictionaries', () => {
    expect(validateDictionaryObject({ version: 1, games: [] })).toBeNull();
    expect(validateDictionaryObject({ version: 1 })).toBeNull();
    expect(validateDictionaryObject('nope')).toBeNull();
    expect(validateDictionaryObject([{ id: 'a', name: 'A', processes: [] }])).toBeNull();
  });
});

describe('loadBestDictionary', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dict-test-'));
  const write = (p: string, content: string) => fs.writeFileSync(p, content);

  it('prefers a newer seed and promotes it into the cache', () => {
    const dir = tmp();
    const cache = path.join(dir, 'cache.json');
    const seed = path.join(dir, 'seed.json');
    write(cache, JSON.stringify({ version: 1, games: [{ id: 'old', name: 'Old', processes: ['old'] }] }));
    write(seed, JSON.stringify({ version: 2, games: [{ id: 'new', name: 'New', processes: ['new'] }] }));

    const best = loadBestDictionary(cache, seed);
    expect(best?.version).toBe(2);
    expect(best?.entries[0]?.id).toBe('new');
    // Promotion: cache now holds the seed content
    expect(loadDictionaryFile(cache)?.version).toBe(2);
  });

  it('keeps a newer cache over an older seed', () => {
    const dir = tmp();
    const cache = path.join(dir, 'cache.json');
    const seed = path.join(dir, 'seed.json');
    write(cache, JSON.stringify({ version: 5, games: [{ id: 'cached', name: 'Cached', processes: ['c'] }] }));
    write(seed, JSON.stringify({ version: 2, games: [{ id: 'seeded', name: 'Seeded', processes: ['s'] }] }));

    const best = loadBestDictionary(cache, seed);
    expect(best?.version).toBe(5);
    expect(best?.entries[0]?.id).toBe('cached');
    // Seed must not clobber the newer cache
    expect(loadDictionaryFile(cache)?.entries[0]?.id).toBe('cached');
  });

  it('falls back to the seed when the cache is corrupt', () => {
    const dir = tmp();
    const cache = path.join(dir, 'cache.json');
    const seed = path.join(dir, 'seed.json');
    write(cache, '{ this is not json');
    write(seed, JSON.stringify({ version: 3, games: [{ id: 'seed', name: 'Seed', processes: ['s'] }] }));

    const best = loadBestDictionary(cache, seed);
    expect(best?.version).toBe(3);
  });

  it('returns null when both sources are unusable', () => {
    const dir = tmp();
    expect(loadBestDictionary(path.join(dir, 'missing-a'), path.join(dir, 'missing-b'))).toBeNull();
  });
});

// ─── IPC overlay over process detection ────────────────────────────────────

describe('IPC activity overlay', () => {
  const emitted: Array<{ name?: string; details?: string } | null> = [];

  // One shared detection session: loads the real seed dictionary and
  // registers the emit callback. The poll interval never fires mid-test.
  beforeAll(() => {
    startActivityDetection((activity) => emitted.push(activity));
  });
  afterAll(() => {
    stopActivityDetection();
  });
  afterEach(() => {
    applyIpcActivity(null);
    __testSetScanActivity(null);
  });

  const push = (over: Partial<IpcActivityPush> = {}) =>
    applyIpcActivity({
      clientId: '1216669957799018608',
      pid: null,
      activity: { type: 'playing', details: 'Idle', state: 'In menu' },
      ...over,
    });

  it('overlays an IPC push over the scan-detected game immediately', () => {
    __testSetScanActivity({ type: 'playing', name: 'osu!', timestamps: { start: 1 } });
    const before = emitted.length;
    push({ activity: { type: 'playing', details: 'Playing [Big Black]', state: 'by Blue Stahli' } });
    expect(emitted.length).toBe(before + 1);
    expect(getCurrentActivity()).toMatchObject({ type: 'playing', details: 'Playing [Big Black]' });
  });

  it('falls back to the scan game when the push clears', () => {
    __testSetScanActivity({ type: 'playing', name: 'osu!', timestamps: { start: 1 } });
    push();
    applyIpcActivity(null);
    expect(getCurrentActivity()).toMatchObject({ name: 'osu!' });
  });

  it('emits null when the overlay clears and no scan game remains', () => {
    push();
    applyIpcActivity(null);
    expect(getCurrentActivity()).toBeNull();
  });

  it('emits only when the effective activity changed', () => {
    __testSetScanActivity({ type: 'playing', name: 'osu!' });
    const before = emitted.length;
    // Re-setting an identical scan activity must not re-emit
    __testSetScanActivity({ type: 'playing', name: 'osu!' });
    expect(emitted.length).toBe(before);
  });

  it('shows a map switch immediately, not on the next poll', () => {
    push({ activity: { type: 'playing', details: 'map A' } });
    const before = emitted.length;
    push({ activity: { type: 'playing', details: 'map B' } });
    expect(emitted.length).toBe(before + 1);
    expect(getCurrentActivity()).toMatchObject({ details: 'map B' });
  });

  it('names unnamed pushes through the known-client map', () => {
    push({ activity: { type: 'playing', details: 'Idle' }, pid: null, clientId: '1216669957799018608' });
    expect(getCurrentActivity()).toMatchObject({ name: 'osu!lazer', details: 'Idle' });
  });

  it('keeps the push-provided name when present', () => {
    push({ activity: { type: 'playing', name: 'Custom Name' } as IpcActivityPayload });
    expect(getCurrentActivity()).toMatchObject({ name: 'Custom Name' });
  });

  it('passes art and timestamps through to the Activity', () => {
    push({
      activity: {
        type: 'playing',
        timestamps: { start: 1700000000, end: 1700000300 },
        assets: {
          largeImage: 'https://cdn.discordapp.com/app-assets/1216669957799018608/osu_logo_lazer.png',
          largeText: 'osu!',
          smallImage: 'https://example.com/rank.png',
          smallText: 'SS',
        },
      },
    });
    const a = getCurrentActivity();
    expect(a?.timestamps).toEqual({ start: 1700000000, end: 1700000300 });
    expect(a?.assets?.largeImage).toContain('osu_logo_lazer.png');
    expect(a?.assets?.smallText).toBe('SS');
  });

  it('resolves game names for a pid through the dictionary', () => {
    const root = makeFakeProc([
      {
        pid: 42,
        exe: '/usr/lib/jvm/java-21/bin/java',
        cmdline: ['/usr/bin/java', '-Xmx2G', 'net.minecraft.client.main.Main'],
        comm: 'java',
      },
    ]);
    expect(resolveIpcGameName(42, root)).toBe('Minecraft');
    expect(resolveIpcGameName(null, root)).toBeNull();
    expect(resolveIpcGameName(999, root)).toBeNull();
  });

  it('reports a scan game exit that happened under an active overlay', () => {
    __testSetScanActivity({ type: 'playing', name: 'Minecraft' });
    push({ activity: { type: 'playing', details: 'deep in a map' } });
    // Game exits while the overlay is live
    __testSetScanActivity(null);
    expect(getCurrentActivity()).toMatchObject({ details: 'deep in a map' });
    // Overlay clears afterwards — nothing is left
    applyIpcActivity(null);
    expect(getCurrentActivity()).toBeNull();
  });
});
