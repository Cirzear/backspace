import type { FederatedIdentity } from '@backspace/shared';
import { isMyIdentity } from '../stores/authStore';
import { dmCallCredentialsFrom, dmCallIds, dmCallRefFrom, dmCallRoomKey } from '../utils/dmCall';
import { turnCameraOnInDmCall } from '../utils/voiceActions';
import { useSpaceStore } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { buildCallUndeliverableToast } from '../utils/callUndeliverableToast';
import type { WebSocketEventHandlers } from './webSocketEvents';
import { activePeerOrigins } from './webSocketFederationEvents';

/**
 * Tear down local state for a DM call that ended, was rejected, or became
 * terminally undeliverable. Clears the call UI/federation state, and tears
 * down the LiveKit session **only when the active voice connection still
 * belongs to the DM call**.
 *
 * The guard is load-bearing: `disconnectFn()` tears down whatever LiveKit room
 * is currently active, regardless of which channel it is. Once the user has
 * joined a *space* voice channel, `currentVoiceChannelId` is set and the active
 * room is the space channel — NOT the DM call (the two are mutually exclusive;
 * `setCurrentVoiceChannel` clears `activeDmCall`). A stale `dm_call_ended` echo
 * must never disconnect that space connection.
 *
 * This is exactly what happens to the **last** participant to leave a DM call
 * for a space channel: their `voice_join` empties the server-side DM room, the
 * server broadcasts `dm_call_ended` back to every DM member (including them),
 * and an unguarded `disconnectFn()` would tear down the space room they just
 * connected to — stranding the UI on "Connecting…" until a manual rejoin.
 */
export function teardownDmCall(): void {
  const voice = useVoiceStore.getState();
  voice.setIncomingCall(null);
  voice.setOutgoingCall(null);
  voice.setActiveDmCall(null);
  // Never tear down a space voice connection in response to a DM-call signal.
  if (voice.disconnectFn && !voice.currentVoiceChannelId) voice.disconnectFn();
}

/**
 * Whether a `dm_call_ended` / `dm_call_rejected` is about the call this client
 * holds (ringing in, ringing out or joined). Every member of a DM hears that
 * its call ended, and a group decline is told to the decliner; neither may
 * tear down a different call the client is in. The event names the call by
 * the sending instance's DM id, by the conversation key, or both, and a slot
 * may hold either, so the DM ids are also compared through their keys.
 */
export function dmCallEventIsOurs(event: DmCallEventIds): boolean {
  const { incomingCall, outgoingCall, activeDmCall } = useVoiceStore.getState();
  // Each slot carries the ids of its own call, so an id a past ring left
  // behind can never make another call's event look like this one's.
  const held: string[] = [];
  if (incomingCall) held.push(...dmCallIds(incomingCall));
  if (outgoingCall) held.push(outgoingCall.dmChannelId);
  if (activeDmCall) held.push(...dmCallIds(activeDmCall));
  return dmCallEventNames(event, held);
}

type DmCallEventIds = { dmChannelId: string | null; federatedCallId?: string | null };

/**
 * Whether `event` names the call one slot holds under `held` (its DM id, its
 * key, or both). The event may name it by the sending instance's DM id, by
 * the conversation key, or both, so DM ids are also compared through their
 * keys.
 */
function dmCallEventNames(event: DmCallEventIds, held: readonly string[]): boolean {
  if (held.length === 0) return false;
  const { dmChannels } = useSpaceStore.getState();
  const keyOf = (dmChannelId: string): string | null => dmChannels.find(d => d.id === dmChannelId)?.federatedId ?? null;
  const named = new Set<string>();
  if (event.dmChannelId) {
    named.add(event.dmChannelId);
    const key = keyOf(event.dmChannelId);
    if (key) named.add(key);
  }
  if (event.federatedCallId) named.add(event.federatedCallId);

  for (const id of held) {
    if (named.has(id)) return true;
    const key = keyOf(id);
    if (key && named.has(key)) return true;
  }
  return false;
}

/**
 * Whether a `dm_call_accepted` stops this client's ring: it names the call
 * that is ringing, and the member who answered is the signed-in user (another
 * of their sessions), compared by federated identity. In a group call another
 * member's answer leaves the ring on, so this member can still answer. An
 * event from a server up to 1.9.0 does not say who answered and stops it, as
 * it always did.
 */
export function acceptStopsRing(event: DmCallEventIds & { answeredBy?: FederatedIdentity }): boolean {
  const { incomingCall } = useVoiceStore.getState();
  if (!incomingCall || !dmCallEventNames(event, dmCallIds(incomingCall))) return false;
  return !event.answeredBy || isMyIdentity(event.answeredBy);
}

export const callEvents = {
  dm_call_incoming: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    // The ring's ids, origin and credentials live on the incoming slot
    // alone, set in one set() (one ringtone trigger). A call the client is
    // in keeps its own. The origin is the WS that delivered this event, not
    // event.callOrigin (the host): accept and decline go through this
    // connected server, which relays them to the host; the host's URL
    // would route through a multi-instance WS that may not be connected.
    {
      const ref = dmCallRefFrom({ dmChannelId: event.dmChannelId ?? null, federatedCallId: event.federatedCallId }, origin);
      if (!ref) return;
      useVoiceStore.setState({
        incomingCall: {
          ...ref,
          callerId: event.callerId,
          callerName: event.callerName,
          livekit: dmCallCredentialsFrom(event.livekitUrl, event.livekitToken),
        },
      });
    }
    return;
      },
  dm_call_accepted: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    // Every member of a DM hears each accept, late joins of a group call
    // included. Only the call this client holds changes state: a member
    // calling another DM, or sitting in a voice channel, stays where it is.
    if (!dmCallEventIsOurs(event)) return;
    const { setIncomingCall, setOutgoingCall, outgoingCall, activeDmCall, setActiveDmCall, connectFn } = useVoiceStore.getState();
    // The ring stops only when this user answered, on another session. The
    // calling tone stops on any answer to the call this session placed.
    if (acceptStopsRing(event)) setIncomingCall(null);
    const answersOutgoing = !!outgoingCall && dmCallEventNames(event, [outgoingCall.dmChannelId]);
    if (answersOutgoing) setOutgoingCall(null);

    // Only the caller enters the call here: its session is the only one
    // with `outgoingCall`, and it connects below. A client that accepted or
    // joined set `activeDmCall` in the click already. Any other session of
    // the same user (the call was answered on another device) stays out:
    // being LiveKit-connected says nothing about this call, since that
    // session may be sitting in a voice channel.
    // A call already held keeps the id it is held by. The event may name it
    // by another instance's DM id (a client that hears both the host and its
    // home), and the hang-up must go out under the held id.
    if (!activeDmCall && outgoingCall && answersOutgoing) {
      const call = { dmChannelId: outgoingCall.dmChannelId, federatedCallId: null, callOrigin: null, livekit: null };
      setActiveDmCall(call);
      // The caller connects to the DM room. `connect()` de-dupes an
      // already-connected same room, so this is not gated on
      // `!isLiveKitConnected`: a caller sitting in a space voice channel is
      // LiveKit-connected, and gating on it would strand them there.
      if (connectFn) {
        const roomKey = dmCallRoomKey(call);
        connectFn(roomKey, true)
          .then(() => (outgoingCall.withCamera ? turnCameraOnInDmCall(roomKey) : undefined))
          .catch((err: unknown) => {
            console.error('[WS] DM call connect failed:', err);
          });
      }
    }
    return;
      },
  dm_call_rejected: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    if (dmCallEventIsOurs(event)) teardownDmCall();
  },
  dm_call_ended: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    // The call is over: nobody is in it any more, whatever leave events an
    // older server did not send.
    if (event.dmChannelId) useVoiceStore.getState().setVoiceUsers(event.dmChannelId, []);
    if (dmCallEventIsOurs(event)) teardownDmCall();
  },
  dm_call_undeliverable: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;

    const { addToast } = useUIStore.getState();

    if (event.terminal) {
      // Tear down local outbound call state — mirrors dm_call_ended.
      teardownDmCall();
    }

    const msg = buildCallUndeliverableToast(event.failures, event.terminal, event.phase);
    addToast(msg, event.terminal ? 'warning' : 'info', 8_000);
  },
} satisfies WebSocketEventHandlers;
