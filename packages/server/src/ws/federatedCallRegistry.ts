import type { ServerEvent } from '@backspace/shared';
import type { FederatedCallEntry } from './voiceRoomTypes.js';

/** In-memory registry for federated calls where this instance is NOT the host. */
export class FederatedCallRegistry {
  private federatedCalls: Map<string, FederatedCallEntry> = new Map();
  private federatedCallTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private federatedCallLeaveHook: ((userId: string) => void) | null = null;

  setFederatedCallLeaveHook(fn: (userId: string) => void): void {
    this.federatedCallLeaveHook = fn;
  }

  leaveFederatedCall(userId: string): void {
    this.federatedCallLeaveHook?.(userId);
  }

  getJoinedFederatedCall(userId: string): FederatedCallEntry | undefined {
    for (const entry of this.federatedCalls.values()) {
      if (entry.joinedUserIds.includes(userId)) return entry;
    }
    return undefined;
  }

  createFederatedCall(
    entry: FederatedCallEntry,
    sendToUser: (uid: string, event: ServerEvent) => void,
    onClear?: (federatedId: string) => void,
  ): void {
    if (onClear) onClear(entry.federatedId);
    this.clearFederatedCall(entry.federatedId, () => {}, new Map());
    this.federatedCalls.set(entry.federatedId, entry);

    const timeout = setTimeout(() => {
      this.federatedCallTimeouts.delete(entry.federatedId);
      const call = this.federatedCalls.get(entry.federatedId);
      if (call && call.state === 'ringing') {
        this.federatedCalls.delete(entry.federatedId);
        const endEvent: ServerEvent = {
          type: 'dm_call_ended',
          dmChannelId: call.dmChannelId,
          federatedCallId: call.federatedId,
        };
        for (const uid of call.ringedUserIds) {
          sendToUser(uid, endEvent);
        }
      }
    }, 60_000);
    this.federatedCallTimeouts.set(entry.federatedId, timeout);
  }

  getFederatedCall(federatedId: string): FederatedCallEntry | undefined {
    return this.federatedCalls.get(federatedId);
  }

  getFederatedCallByDmChannel(dmChannelId: string): FederatedCallEntry | undefined {
    for (const entry of this.federatedCalls.values()) {
      if (entry.dmChannelId === dmChannelId) return entry;
    }
    return undefined;
  }

  activateFederatedCall(federatedId: string): boolean {
    const call = this.federatedCalls.get(federatedId);
    if (!call || call.state !== 'ringing') return false;
    call.state = 'active';
    const timeout = this.federatedCallTimeouts.get(federatedId);
    if (timeout) {
      clearTimeout(timeout);
      this.federatedCallTimeouts.delete(federatedId);
    }
    return true;
  }

  clearFederatedCall(
    federatedId: string,
    clearVoiceWs: (userId: string) => void,
    userToRoom: Map<string, string>,
  ): void {
    for (const userId of this.federatedCalls.get(federatedId)?.joinedUserIds ?? []) {
      if (!userToRoom.has(userId)) clearVoiceWs(userId);
    }
    this.federatedCalls.delete(federatedId);
    const timeout = this.federatedCallTimeouts.get(federatedId);
    if (timeout) {
      clearTimeout(timeout);
      this.federatedCallTimeouts.delete(federatedId);
    }
  }

  evictFederatedCallsForHost(
    peerOrigin: string,
    ctx: { reason: 'peer_transient_failure' | 'peer_rejected'; peerLabel?: string },
    sendToUser: (uid: string, event: ServerEvent) => void,
    clearVoiceWs: (userId: string) => void,
    userToRoom: Map<string, string>,
    onClear?: (federatedId: string) => void,
  ): number {
    const matches: FederatedCallEntry[] = [];
    for (const entry of this.federatedCalls.values()) {
      if (entry.federatedCallHost === peerOrigin) matches.push(entry);
    }
    if (matches.length === 0) return 0;

    let evicted = 0;
    for (const entry of matches) {
      if (!this.federatedCalls.has(entry.federatedId)) continue;

      const event: ServerEvent = {
        type: 'dm_call_undeliverable',
        dmChannelId: entry.dmChannelId,
        federatedCallId: entry.federatedId,
        terminal: true,
        phase: 'host_unreachable',
        failures: [{
          reason: ctx.reason,
          peerOrigin,
          peerLabel: ctx.peerLabel,
        }],
      };

      for (const uid of entry.ringedUserIds) {
        sendToUser(uid, event);
      }

      if (onClear) onClear(entry.federatedId);
      this.clearFederatedCall(entry.federatedId, clearVoiceWs, userToRoom);
      evicted += 1;
    }

    return evicted;
  }

  lateBindFederatedCall(federatedId: string, dmChannelId: string): void {
    const call = this.federatedCalls.get(federatedId);
    if (call && call.dmChannelId === null) {
      call.dmChannelId = dmChannelId;
    }
  }

  getAllFederatedCalls(): Map<string, FederatedCallEntry> {
    return this.federatedCalls;
  }
}
