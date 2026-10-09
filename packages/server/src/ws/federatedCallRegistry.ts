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
      if (call?.state === 'active') {
        this.dropFederatedCallIfIdle(entry.federatedId);
        return;
      }
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
    // Keep the ring window open so other local members may still answer.
    call.state = 'active';
    return true;
  }

  /**
   * `userId` is no longer in the call hosted on a peer (`joinedUserIds`): they
   * hung up, or left it without hanging up. The record goes once it can no
   * longer matter (`dropFederatedCallIfIdle`).
   */
  leaveFederatedCallEntry(federatedId: string, userId: string): void {
    const entry = this.federatedCalls.get(federatedId);
    if (!entry) return;
    entry.joinedUserIds = entry.joinedUserIds.filter(id => id !== userId);
    this.dropFederatedCallIfIdle(federatedId);
  }

  /**
   * Drop the record of a call hosted on a peer that can no longer matter: it
   * was answered, nobody here is in it, and its ring window has closed, so no
   * member here can still answer it. Without this, a record whose final end
   * from the host never came (a lost relay, or a host up to 1.8.0 that ends
   * some calls without telling its peers) stayed until a restart. Silent:
   * nobody here holds the call, and a member in it through another instance
   * must not be told it ended.
   */
  dropFederatedCallIfIdle(federatedId: string): void {
    const entry = this.federatedCalls.get(federatedId);
    if (!entry || entry.state !== 'active' || entry.joinedUserIds.length > 0) return;
    if (this.federatedCallTimeouts.has(federatedId)) return;
    // An idle entry has no joined sessions to clear or notify.
    this.federatedCalls.delete(federatedId);
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
