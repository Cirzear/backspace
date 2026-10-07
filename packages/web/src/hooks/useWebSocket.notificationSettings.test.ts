import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationSetting, User } from '@backspace/shared';

// jsdom has no AudioWorkletNode; the handler's imports reach the voice stack.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
      playSound: vi.fn(() => Promise.resolve(null)),
    }),
  },
}));

/** A socket the real handler talks to; the test plays the server through `deliver`. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.all.push(this); }
  send(): void {}
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  deliver(event: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(event) }); }
}

class InertWorker {
  onmessage: (() => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

vi.stubGlobal('WebSocket', FakeWebSocket);
vi.stubGlobal('Worker', InertWorker);
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:heartbeat', revokeObjectURL: () => {} }));

const { connectInstance, disconnectInstance } = await import('./useWebSocket');
const { useAuthStore } = await import('../stores/authStore');
const { notificationSettingKey, useNotificationSettingsStore } = await import('../stores/notificationSettingsStore');

const NOVA = 'https://nova.example';
const opened: string[] = [];

function socketFor(origin: string): FakeWebSocket {
  connectInstance(origin, `token-${origin || 'home'}`);
  opened.push(origin);
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return ws;
}

function readyFor(id: string): Record<string, unknown> {
  const readyUser = {
    id, username: id, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: 'home.example', homeUserId: 'me', replicatedInstances: [],
  } as unknown as User;
  return { type: 'ready', user: readyUser, spaces: [], dmChannels: [], readStates: [], activeCalls: [] };
}

const load = vi.fn(async (origin: string) => { void origin; });
let realLoad: (origin: string) => Promise<void>;

beforeEach(() => {
  FakeWebSocket.all = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  realLoad = useNotificationSettingsStore.getState().load;
  load.mockClear();
  useNotificationSettingsStore.setState({ load });
  useAuthStore.setState({ user: { id: 'me', status: 'online' } as User });
});

afterEach(() => {
  for (const origin of opened.splice(0)) disconnectInstance(origin);
  useNotificationSettingsStore.setState({ load: realLoad });
  useNotificationSettingsStore.getState().reset();
  useAuthStore.setState({ user: null, myRowIds: new Map() });
  vi.restoreAllMocks();
});

describe('notification settings over the socket', () => {
  it('loads an instance\'s settings when its ready arrives', () => {
    const nova = socketFor(NOVA);
    nova.deliver(readyFor('me-on-nova'));
    expect(load).toHaveBeenCalledWith(NOVA);
  });

  it('files a pushed setting under the origin of the socket that delivered it', () => {
    const nova = socketFor(NOVA);
    const setting: NotificationSetting = {
      spaceId: 'space-1', channelId: 'chan-1', level: 'nothing', muted: false, mutedUntil: null, updatedAt: 5,
    };
    nova.deliver({ type: 'notification_settings_updated', setting });
    const settings = useNotificationSettingsStore.getState().settings;
    expect(settings.get(notificationSettingKey(NOVA, { spaceId: 'space-1', channelId: 'chan-1' }))).toEqual(setting);
    expect(settings.get(notificationSettingKey('', { spaceId: 'space-1', channelId: 'chan-1' }))).toBeUndefined();
  });
});
