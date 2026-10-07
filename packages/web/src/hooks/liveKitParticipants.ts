import { Track, type Participant, type Room } from 'livekit-client';
import type { User } from '@backspace/shared';
import { useVoiceStore } from '../stores/voiceStore';
import { myRowForOrigin, useAuthStore } from '../stores/authStore';
import { getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { homeIdentityOf } from '../utils/identity';
import type { StreamRepublishTracker } from '../utils/streamRepublish';

export interface ParticipantInfo {
  identity: string;
  userId: string;
  username: string;
  homeUserId: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isLocal: boolean;
  /** Publication routing uses helper identities; UI and preferences keep the owner identity. */
  screenPublisherIdentity?: string;
  voicePublisherIdentity?: string;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
  screenAudioTrack: MediaStreamTrack | null;
  lkVideoTrack: Track | null;
  lkScreenTrack: Track | null;
  cachedUser: User | null;
}

export interface UserTile {
  kind: 'user';
  key: string;
  participant: ParticipantInfo;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  lkVideoTrack: Track | null;
}

export interface StreamTile {
  kind: 'stream';
  key: string;
  participant: ParticipantInfo;
  screenTrack: MediaStreamTrack | null;
  screenAudioTrack: MediaStreamTrack | null;
  lkScreenTrack: Track | null;
}

export type GridTile = UserTile | StreamTile;

export function deriveGridTiles(participants: ParticipantInfo[]): GridTile[] {
  const tiles: GridTile[] = [];
  for (const p of participants) {
    const hasLiveVideo = p.isCameraOn && p.videoTrack?.readyState === 'live';
    tiles.push({
      kind: 'user',
      key: p.identity,
      participant: p,
      videoTrack: hasLiveVideo ? p.videoTrack : null,
      audioTrack: p.audioTrack,
      lkVideoTrack: hasLiveVideo ? p.lkVideoTrack : null,
    });
    if (p.isScreenSharing) {
      tiles.push({
        kind: 'stream',
        key: `${p.identity}:stream`,
        participant: p,
        screenTrack: p.screenTrack,
        screenAudioTrack: p.screenAudioTrack,
        lkScreenTrack: p.lkScreenTrack,
      });
    }
  }
  return tiles;
}

interface NativeHelper {
  purpose: 'screen-share' | 'native-voice';
  ownerIdentity: string;
}

/** Only token-authored, immutable metadata may attribute a publication to another user. */
export function getNativeHelper(p: Pick<Participant, 'identity' | 'metadata' | 'permissions'>): NativeHelper | null {
  if (!p.metadata || p.permissions?.canUpdateMetadata !== false) return null;
  let metadata: unknown;
  try { metadata = JSON.parse(p.metadata); } catch { return null; }
  if (!metadata || typeof metadata !== 'object') return null;
  const candidate = metadata as Record<string, unknown>;
  if (candidate.purpose !== 'screen-share' && candidate.purpose !== 'native-voice') return null;
  if (typeof candidate.ownerIdentity !== 'string' || !candidate.ownerIdentity || candidate.ownerIdentity === p.identity) return null;
  return { purpose: candidate.purpose, ownerIdentity: candidate.ownerIdentity };
}

export function getParticipantOwnerIdentity(p: Participant): string {
  return getNativeHelper(p)?.ownerIdentity ?? p.identity;
}

export function parseIdentity(identity: string): { userId: string; username: string } {
  const parts = identity.split(':');
  return { userId: parts[0] ?? identity, username: parts[1] ?? identity };
}

/** Resolve the room's owner identity through DM membership, even after its tile has gone. */
export function resolveParticipantUserId(identity: string): string {
  const rawId = parseIdentity(identity).userId;
  const activeDmCall = useVoiceStore.getState().activeDmCall;
  if (!activeDmCall) return rawId;
  const dmChannel = useSpaceStore.getState().dmChannels.find(d => d.id === activeDmCall.dmChannelId);
  const origin = getChannelOrigin(activeDmCall.dmChannelId);
  const match = dmChannel?.members.find(m => m.id === rawId || homeIdentityOf(m, origin)?.userId === rawId);
  return match?.id ?? rawId;
}

function publicationFor(p: Participant, source: Track.Source) {
  return [...p.trackPublications.values()].find(pub => pub.source === source);
}

function activeTrack(room: Room, p: Participant, source: Track.Source): Track | null {
  const pub = publicationFor(p, source);
  if (!pub || pub.isMuted || (p !== room.localParticipant && !pub.isSubscribed)) return null;
  const track = pub.track;
  return track?.mediaStreamTrack?.readyState === 'live' ? track : null;
}

function participantState(p: Participant, userId: string, isLocal: boolean) {
  const vs = useVoiceStore.getState();
  if (!isLocal) {
    const status = vs.voiceUserStates.get(userId);
    return {
      isMuted: status?.isMuted ?? !p.isMicrophoneEnabled,
      isDeafened: status?.isDeafened ?? vs.deafenedUserIds.has(userId),
    };
  }
  const channelId = vs.currentVoiceChannelId;
  const localId = channelId ? getMyUserIdForOrigin(getChannelOrigin(channelId)) : undefined;
  const spaceId = channelId ? useSpaceStore.getState().channelToSpaceMap.get(channelId) : null;
  const key = spaceId && localId ? `${spaceId}:${localId}` : '';
  return {
    isMuted: vs.isMuted || vs.spaceMutedUserIds.has(key) || vs.permissionMutedUserIds.has(key),
    isDeafened: vs.isDeafened || vs.spaceDeafenedUserIds.has(key),
  };
}

/** A room owner is the sole roster entry; helpers are media sources, never participants in the UI. */
export function collectParticipants(room: Room, republish: StreamRepublishTracker | null): ParticipantInfo[] {
  const vs = useVoiceStore.getState();
  const previous = new Map(vs.participants.map(p => [p.identity, p.cachedUser]));
  const owners: Participant[] = [];
  const helpers = new Map<string, Partial<Record<NativeHelper['purpose'], Participant>>>();
  for (const p of [room.localParticipant, ...room.remoteParticipants.values()]) {
    if (!p.identity) continue;
    const helper = getNativeHelper(p);
    if (!helper) { owners.push(p); continue; }
    const group = helpers.get(helper.ownerIdentity) ?? {};
    group[helper.purpose] = p;
    helpers.set(helper.ownerIdentity, group);
  }

  return owners.map(owner => {
    const isLocal = owner === room.localParticipant;
    const group = helpers.get(owner.identity);
    const screen = group?.['screen-share'] ?? owner;
    const voice = group?.['native-voice'] ?? owner;
    const userId = resolveParticipantUserId(owner.identity);
    const member = useSpaceStore.getState().members.find(m => m.userId === userId);
    const callChannelId = vs.currentVoiceChannelId ?? vs.activeDmCall?.dmChannelId ?? null;
    const localUser = myRowForOrigin(callChannelId ? getChannelOrigin(callChannelId) : '');
    const cachedUser = member?.user as User | undefined
      ?? (isLocal ? localUser : previous.get(owner.identity)) ?? null;
    const state = participantState(voice, userId, isLocal);
    const cameraTrack = owner.isCameraEnabled ? activeTrack(room, owner, Track.Source.Camera) : null;
    const screenTrack = activeTrack(room, screen, Track.Source.ScreenShare);
    const audioTrack = activeTrack(room, voice, Track.Source.Microphone);
    return {
      identity: owner.identity, userId, username: parseIdentity(owner.identity).username,
      homeUserId: cachedUser?.homeUserId ?? null, cachedUser, ...state, isLocal,
      screenPublisherIdentity: screen.identity, voicePublisherIdentity: voice.identity,
      isCameraOn: !!publicationFor(owner, Track.Source.Camera) && owner.isCameraEnabled,
      isScreenSharing: !!publicationFor(screen, Track.Source.ScreenShare) || (republish?.isBridging(screen.identity) ?? false),
      // In the handoff interval, do not leak the Web mic clone as the native source.
      audioTrack: isLocal && vs.nativeVoiceActive && voice === owner ? null : audioTrack?.mediaStreamTrack ?? null,
      videoTrack: cameraTrack?.mediaStreamTrack ?? null,
      screenTrack: screenTrack?.mediaStreamTrack ?? null,
      screenAudioTrack: activeTrack(room, screen, Track.Source.ScreenShareAudio)?.mediaStreamTrack ?? null,
      lkVideoTrack: cameraTrack, lkScreenTrack: screenTrack,
    };
  });
}

/** Analyse a local native MIC under the owner key without ever marking its UI card remote. */
export function speakingParticipants(participants: ParticipantInfo[]): ParticipantInfo[] {
  const nativeActive = useVoiceStore.getState().nativeVoiceActive;
  return participants.map(p => {
    if (!p.isLocal || (!nativeActive && p.voicePublisherIdentity === p.identity)) return p;
    return { ...p, isLocal: false, audioTrack: p.isMuted || p.isDeafened ? null : p.audioTrack };
  });
}

/** Subscribe only allowed helper sources, and never retain media for an absent owner. */
export function syncRemoteSubscriptions(room: Room): void {
  const state = useVoiceStore.getState();
  const localScreen = state.participants.find(p => p.isLocal && p.isScreenSharing && p.screenPublisherIdentity !== p.identity);
  if (localScreen && !state.watchingStreams.has(localScreen.userId)) state.watchStream(localScreen.userId);
  const watching = useVoiceStore.getState().watchingStreams;
  const listed = new Map(state.participants.map(p => [p.identity, p]));
  for (const remote of room.remoteParticipants.values()) {
    const helper = getNativeHelper(remote);
    const owner = listed.get(helper?.ownerIdentity ?? remote.identity);
    for (const pub of remote.trackPublications.values()) {
      const isScreen = pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio;
      const permitted = !helper || (helper.purpose === 'screen-share' ? isScreen : pub.source === Track.Source.Microphone);
      let subscribed = !!owner && permitted;
      if (isScreen) subscribed &&= !!owner && watching.has(owner.userId);
      if (pub.source === Track.Source.Camera) subscribed &&= !!owner && !state.unwatchedCameras.has(owner.userId);
      // Own native screen audio is loopback. It must never enter our receive/playback graph.
      if (owner?.isLocal && pub.source === Track.Source.ScreenShareAudio) subscribed = false;
      if (pub.source === Track.Source.Microphone) subscribed &&= owner?.voicePublisherIdentity === remote.identity;
      if (pub.isSubscribed !== subscribed) pub.setSubscribed(subscribed);
    }
  }
}
