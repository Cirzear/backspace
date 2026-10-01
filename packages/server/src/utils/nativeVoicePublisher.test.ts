import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativePublisher, type NativePublisherOwner } from './nativeVoicePublisher.js';
import { getNativeVoiceSession, stopNativeVoiceSession } from '../ws/nativeVoiceSessions.js';

const sfu = vi.hoisted(() => ({ getParticipant: vi.fn(), removeParticipant: vi.fn(), updateParticipant: vi.fn() }));
vi.mock('livekit-server-sdk', async importOriginal => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>();
  return { ...actual, RoomServiceClient: class {
    getParticipant = sfu.getParticipant;
    removeParticipant = sfu.removeParticipant;
    updateParticipant = sfu.updateParticipant;
  } };
});
vi.mock('../config.js', () => ({ config: { livekit: { url: 'wss://voice.test/livekit', apiKey: 'test-key', apiSecret: 'test-secret-at-least-32-characters-long' } } }));

function claims(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
    sub: string; metadata: string; exp: number; nbf: number;
    video: { canPublishSources: string[]; canPublish: boolean; canSubscribe: boolean; canPublishData: boolean; canUpdateOwnMetadata: boolean };
  };
}
let ids: string[] = [];
const permissions = { canStream: true, canSpeak: true, canSubscribe: true };
const owner: NativePublisherOwner = {
  userId: 'native-owner', roomId: 'channel', roomName: 'channel', ownerIdentity: 'native-owner:alice',
  isCurrent: () => true, permissions: () => permissions,
};
beforeEach(() => {
  vi.clearAllMocks();
  sfu.getParticipant.mockResolvedValue({});
  sfu.removeParticipant.mockResolvedValue(undefined);
  sfu.updateParticipant.mockResolvedValue({});
  Object.assign(permissions, { canStream: true, canSpeak: true, canSubscribe: true });
});
afterEach(async () => {
  await Promise.all(ids.map(id => stopNativeVoiceSession(id)));
  ids = [];
});

describe('native publisher token pair', () => {
  it('issues distinct signed screen and microphone-only identities without replacing the Web owner', async () => {
    const result = await createNativePublisher(owner);
    ids.push(result.identity);
    const screen = claims(result.token);
    const voice = claims(result.voiceToken);
    expect(result.identity).toMatch(/^screen:/);
    expect(result.voiceIdentity).toMatch(/^native-voice:/);
    expect(screen.sub).not.toBe(owner.ownerIdentity);
    expect(screen.exp - screen.nbf).toBe(60);
    expect(screen.video).toMatchObject({ canPublishSources: ['screen_share', 'screen_share_audio'], canSubscribe: false, canPublishData: false, canUpdateOwnMetadata: false });
    expect(voice.video).toMatchObject({ canPublishSources: ['microphone'], canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false });
    expect(JSON.parse(screen.metadata)).toEqual({ purpose: 'screen-share', ownerIdentity: owner.ownerIdentity });
    expect(JSON.parse(voice.metadata)).toEqual({ purpose: 'native-voice', ownerIdentity: owner.ownerIdentity });
    expect(sfu.removeParticipant).not.toHaveBeenCalled();
    await stopNativeVoiceSession(result.identity);
    expect(sfu.removeParticipant).toHaveBeenCalledWith('channel', result.identity);
    expect(sfu.removeParticipant).toHaveBeenCalledWith('channel', result.voiceIdentity);
    expect(sfu.removeParticipant).not.toHaveBeenCalledWith('channel', owner.ownerIdentity);
  });
  it('keeps screen audio separate when the user cannot speak', async () => {
    permissions.canSpeak = false;
    const result = await createNativePublisher(owner);
    ids.push(result.identity);
    expect(claims(result.voiceToken).video).toMatchObject({ canPublish: false, canPublishSources: [] });
    expect(claims(result.token).video.canPublishSources).toContain('screen_share_audio');
  });
  it('refuses missing STREAM or an owner who has not actually joined LiveKit', async () => {
    permissions.canStream = false;
    await expect(createNativePublisher(owner)).rejects.toMatchObject({ statusCode: 403 });
    permissions.canStream = true;
    sfu.getParticipant.mockRejectedValue({ code: 'not_found' });
    await expect(createNativePublisher(owner)).rejects.toMatchObject({ statusCode: 403 });
  });
  it('does not return credentials when the voice session ends while checking the owner', async () => {
    let current = true;
    sfu.getParticipant.mockImplementation(async () => { current = false; return {}; });
    await expect(createNativePublisher({ ...owner, isCurrent: () => current })).rejects.toMatchObject({ statusCode: 403 });
  });
  it('replaces both previous helpers, never the Web identity, and revokes on STREAM loss', async () => {
    const first = await createNativePublisher(owner);
    ids.push(first.identity);
    const second = await createNativePublisher(owner);
    ids.push(second.identity);
    expect(second.identity).not.toBe(first.identity);
    expect(getNativeVoiceSession(first.identity)).toBeUndefined();
    permissions.canStream = false;
    await getNativeVoiceSession(second.identity)!.syncPermissions();
    expect(getNativeVoiceSession(second.identity)).toBeUndefined();
    expect(sfu.removeParticipant).toHaveBeenCalledTimes(4);
  });
  it('updates microphone and subscription permissions after moderator actions', async () => {
    const result = await createNativePublisher(owner);
    ids.push(result.identity);
    permissions.canSpeak = false;
    permissions.canSubscribe = false;
    await getNativeVoiceSession(result.identity)!.syncPermissions();
    expect(sfu.updateParticipant).toHaveBeenCalledWith('channel', result.voiceIdentity, {
      permission: expect.objectContaining({ canPublish: false, canSubscribe: false, canPublishSources: [] }),
    });
  });
  it('surfaces SFU cleanup failures rather than pretending the participants were removed', async () => {
    const result = await createNativePublisher(owner);
    ids.push(result.identity);
    sfu.removeParticipant.mockRejectedValue(new Error('SFU unavailable'));
    await expect(stopNativeVoiceSession(result.identity)).rejects.toThrow('SFU unavailable');
  });
});
