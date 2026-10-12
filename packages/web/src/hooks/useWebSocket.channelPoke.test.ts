import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, ChannelCategory, MessageWithUser, ServerEvent, User } from '@backspace/shared';

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

/** The heartbeat runs in a Worker (jsdom has none); an inert one keeps it quiet. */
class InertWorker {
  onmessage: (() => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

vi.stubGlobal('WebSocket', FakeWebSocket);
vi.stubGlobal('Worker', InertWorker);
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:heartbeat', revokeObjectURL: () => {} }));

const { connectInstance, disconnectInstance } = await import('./useWebSocket');
const { useSpaceStore } = await import('../stores/spaceStore');
const { useAuthStore } = await import('../stores/authStore');
const { useChatStore } = await import('../stores/chatStore');
const { useChannelPokeStore } = await import('../stores/channelPokeStore');

const NOVA = 'https://nova.example';
const SPACE = 'space-nova';
const opened: string[] = [];

function channel(id: string, fields: Partial<Channel> = {}): Channel {
  return {
    id,
    spaceId: SPACE,
    name: id,
    type: 'text',
    topic: null,
    position: 0,
    categoryId: null,
    createdAt: 1,
    myPermissions: '1',
    ...fields,
  };
}

function me(id: string): User {
  return {
    id,
    username: id,
    displayName: null,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 1,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  } as User;
}

function ready(channels: Channel[], categories: ChannelCategory[] = [], fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'ready',
    user: me('me-on-nova'),
    spaces: [{
      id: SPACE,
      name: 'Nova space',
      icon: null,
      ownerId: 'owner',
      inviteCode: 'x',
      visibility: 'private',
      createdAt: 1,
      channels,
      categories,
      members: [],
      myPermissions: '1',
    }],
    dmChannels: [],
    folders: [],
    spaceLayout: null,
    layoutUpdatedAt: null,
    voiceStates: {},
    voiceChannelElapsedSeconds: {},
    voiceUserStates: {},
    spaceVoiceStates: {},
    readStates: [],
    activeCalls: [],
    userActivities: {},
    rejectedPeerOrigins: [],
    awaitingApprovalPeerOrigins: [],
    activePeerOrigins: [],
    pendingApprovalCount: 0,
    ...fields,
  } satisfies Partial<Record<keyof Extract<ServerEvent, { type: 'ready' }> | 'type', unknown>>;
}

function socketFor(origin: string): FakeWebSocket {
  connectInstance(origin, `token-${origin || 'home'}`);
  opened.push(origin);
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return ws;
}

function pokeRow(id: string): MessageWithUser {
  return {
    id, channelId: 'c1', userId: 'actor-on-nova', type: 'system', replyToId: null, editedAt: null, createdAt: 1,
    content: JSON.stringify({ event: 'channel_poke', targetUserId: 'me-on-nova', targetDisplayName: 'Me' }),
    mentionEveryone: false, mentionRoleIds: [],
    user: { ...me('actor-on-nova'), displayName: 'Actor' }, attachments: [], embeds: [], reactions: [],
  };
}

beforeEach(() => {
  FakeWebSocket.all = [];
  useSpaceStore.getState().reset();
  useChannelPokeStore.getState().reset();
  useChatStore.setState({ messages: new Map(), detachedChannels: new Map(), realtimeMessageEvents: [], unreadChannels: new Set(), currentChannelId: null });
  useAuthStore.setState({ user: me('me'), trueHomeStatus: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const origin of opened.splice(0)) disconnectInstance(origin);
  useAuthStore.setState({ user: null, trueHomeStatus: null });
  vi.restoreAllMocks();
});

describe('the poke capability of an instance', () => {
  it('is on for an instance whose ready says so and off for one that does not', () => {
    const nova = socketFor(NOVA);
    nova.deliver(ready([channel('c1')], [], { supportsPoke: true }));
    const older = socketFor('https://older.example');
    older.deliver(ready([channel('c2')]));
    expect(useChannelPokeStore.getState().hosts).toEqual({ [NOVA]: true, 'https://older.example': false });
  });
});

describe('a channel_poke event', () => {
  it('adds the stored row to its channel without an alert or an unread dot', () => {
    const nova = socketFor(NOVA);
    nova.deliver(ready([channel('c1')], [], { supportsPoke: true }));
    nova.deliver({ type: 'channel_poke', message: pokeRow('900') });
    nova.deliver({ type: 'channel_poke', message: pokeRow('900') });
    const chat = useChatStore.getState();
    expect(chat.messages.get('c1')?.map(m => m.id)).toEqual(['900']);
    expect(chat.realtimeMessageEvents).toEqual([]);
    expect(chat.unreadChannels.has('c1')).toBe(false);
  });
});
