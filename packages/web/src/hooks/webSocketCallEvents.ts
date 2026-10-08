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
  voice.clearFederatedCallData();
  useVoiceStore.setState({ federatedCallId: null, callOrigin: null });
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
export function dmCallEventIsOurs(event: { dmChannelId: string | null; federatedCallId?: string | null }): boolean {
  const { incomingCall, outgoingCall, activeDmCall, federatedCallId } = useVoiceStore.getState();
  const slots = [incomingCall, outgoingCall, activeDmCall].filter(slot => slot !== null);
  // `federatedCallId` names the call a slot holds. With every slot empty it
  // is only what a ring that stopped without a join left behind.
  if (slots.length === 0) return false;
  const held = new Set<string>();
  for (const slot of slots) {
    if (slot.dmChannelId) held.add(slot.dmChannelId);
  }
  if (federatedCallId) held.add(federatedCallId);

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

export const callEvents = {
  dm_call_incoming: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    // Batch ALL call state into a single set() to prevent:
    // 1. Ringtone multiplication (multiple subscription triggers from separate set() calls)
    // 2. Stale callOrigin/federatedCallId from previous calls (always overwritten)
    // callOrigin = the WS origin that delivered this event, NOT event.callOrigin (the host).
    // Routing accept/reject through this WS ensures the message reaches a connected server,
    // which then relays to the host via S2S HTTP. Using event.callOrigin (the host URL)
    // would route through the multi-instance WS, which may not be connected.
    useVoiceStore.setState({
      incomingCall: {
        dmChannelId: event.dmChannelId ?? null,
        callerId: event.callerId,
        callerName: event.callerName,
      },
      federatedCallToken: event.livekitToken ?? null,
      federatedCallUrl: event.livekitUrl ?? null,
      federatedCallId: event.federatedCallId ?? null,
      callOrigin: origin,
    });
  },
  dm_call_accepted: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    // Every member of a DM hears each accept, late joins of a group call
    // included. Only the call this client holds changes state: a member
    // calling another DM, or sitting in a voice channel, stays where it is.
    if (!dmCallEventIsOurs(event)) return;
    const { setIncomingCall, setOutgoingCall, outgoingCall, activeDmCall, setActiveDmCall, connectFn, isLiveKitConnected, clearFederatedCallData } = useVoiceStore.getState();
    const wasOutgoingCall = !!outgoingCall;
    setIncomingCall(null);
    setOutgoingCall(null);

    // Only enter active call state if:
    // - We're the caller (wasOutgoingCall) → will connect via connectFn below
    // - We already connected to LiveKit (clicked accept in handleAccept)
    // Other instances of the same user must NOT enter call state: they'd show
    // "Connecting..." forever with no actual LiveKit connection.
    // The id is the one this client holds the call by. The event may name
    // it by another instance's DM id (a client that hears both the host and
    // its home), and the hang-up must go out under the held id.
    const callDmId = activeDmCall?.dmChannelId
      ?? outgoingCall?.dmChannelId
      ?? (event.dmChannelId || event.federatedCallId || '');
    if (!activeDmCall && (wasOutgoingCall || isLiveKitConnected)) {
      setActiveDmCall({ dmChannelId: callDmId });
    }
    // Someone else answered a call that rang here, and this client is not
    // in it: what the ring left (`federatedCallId`, `callOrigin`) names no
    // call this client holds, so it goes.
    if (!useVoiceStore.getState().activeDmCall) {
      clearFederatedCallData();
      useVoiceStore.setState({ federatedCallId: null, callOrigin: null });
    }
    // The caller connects to the DM room. `wasOutgoingCall` alone identifies
    // the caller session (other sessions/tabs never set outgoingCall), and
    // `connect()` de-dupes an already-connected same room — so we must NOT
    // also gate on `!isLiveKitConnected`: a caller who is currently sitting in
    // a space voice channel is LiveKit-connected, and gating on it would skip
    // the DM connect entirely, stranding them in the space channel.
    if (connectFn && wasOutgoingCall && callDmId) {
      connectFn(callDmId, true).catch((err: unknown) => {
        console.error('[WS] DM call connect failed:', err);
      });
    }
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
