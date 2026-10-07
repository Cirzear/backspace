import type { Channel, MemberWithUser } from '@backspace/shared';

export type RosterChange =
  | { kind: 'join'; member: MemberWithUser }
  | { kind: 'leave'; userId: string };

let detailRequestCount = 0;
/** spaceId → the newest `loadSpaceDetail` started for it. */
export const newestDetailRequests = new Map<string, { seq: number; result: Promise<Channel[] | null> }>();

/** spaceId → the change logs of the loads in flight for it (one per load). */
export const inFlightRosterLogs = new Map<string, Set<RosterChange[]>>();

export function nextDetailRequestSeq(): number {
  return ++detailRequestCount;
}

export function recordRosterChange(spaceId: string, change: RosterChange): void {
  const logs = inFlightRosterLogs.get(spaceId);
  if (!logs) return;
  for (const log of logs) log.push(change);
}

/** A change replayed onto a fetched roster: a join never replaces a fetched row. */
export function replayRosterChange(members: MemberWithUser[], change: RosterChange): MemberWithUser[] {
  if (change.kind === 'join' && members.some(m => m.userId === change.member.userId)) return members;
  return applyRosterChange(members, change);
}

export function applyRosterChange(members: MemberWithUser[], change: RosterChange): MemberWithUser[] {
  if (change.kind === 'join') {
    return [...members.filter(m => m.userId !== change.member.userId), change.member];
  }
  return members.filter(m => m.userId !== change.userId);
}
