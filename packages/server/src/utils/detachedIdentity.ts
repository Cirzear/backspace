import type Database from 'better-sqlite3';
import { canonicalizeHomeInstance } from './federationAuth.js';
import { reconcileDmChannelFederatedId, type DmReconcileResult } from './dmConversation.js';

/**
 * Detached accounts are homed here (federation.md, "Detached accounts are
 * homed here"; #310).
 *
 * A detached account (`federation_home_orphaned = 1`) lost its home: the home
 * instance was reset, and the domain now belongs to another incarnation that
 * cannot vouch for it. The account lives on as a local account of this
 * instance, so this instance is the only authority left for its identity, and
 * it presents the account to peers as one of its own users: its local id at
 * this instance's origin. It makes no claim of continuity with the former
 * identity, which only the former home could have vouched for.
 *
 * The row is rewritten into that shape rather than having the identity
 * computed when something is sent. `home_instance` and `home_user_id` are
 * what every outbound builder, every inbound lookup (`resolveRelayActor`'s
 * native branch, `localUserStandingOnPeer`, the S2S user lookups), the 1-on-1
 * key (`oneOnOneKey`) and the web client (`homeIdentityOf`) read as "the
 * identity this row stands for". With them cleared, all of these treat the
 * account as native, with no exception at any call site. The former identity
 * moves to `detached_home_instance` / `detached_home_user_id`, which only the
 * paths that need it read: `resolveRelayActor` (a reference to the former
 * identity still finds this row, so the hijack guards keep refusing the reset
 * domain), re-attach, and the reset-cleanup admin listing.
 */

/** What rewriting one account changed. */
export interface RehomeResult {
  userId: string;
  /** 1-on-1 rows re-keyed or merged because the account's identity changed; announce them after commit. */
  reconciled: DmReconcileResult[];
}

interface DetachedLegacyRow {
  id: string;
  home_instance: string;
  home_user_id: string | null;
}

/**
 * Home one detached account on this instance: move its former identity to the
 * `detached_home_*` columns, clear `home_instance` / `home_user_id`, give the
 * group DMs it owns this instance's owner identity, and re-key its 1-on-1 DMs
 * to the key of its new identity (`reconcileDmChannelFederatedId`).
 *
 * Applies only to a live row that is flagged detached and still carries a home
 * instance; anything else returns null and changes nothing, so it is
 * idempotent. `ourOrigin` is this instance's origin (`getOurOrigin()`), the
 * home the group DM owner identity is recorded under.
 *
 * Writes without a transaction of its own; callers run it inside one.
 */
export function rehomeDetachedAccount(
  rawDb: Database.Database,
  userId: string,
  ourOrigin: string,
): RehomeResult | null {
  const row = rawDb.prepare(`
    SELECT id, home_instance, home_user_id FROM users
    WHERE id = ? AND is_deleted = 0 AND federation_home_orphaned = 1 AND home_instance IS NOT NULL
  `).get(userId) as DetachedLegacyRow | undefined;
  if (!row) return null;

  rawDb.prepare(`
    UPDATE users
    SET detached_home_instance = home_instance,
        detached_home_user_id = home_user_id,
        home_instance = NULL,
        home_user_id = NULL
    WHERE id = ?
  `).run(row.id);

  // Groups the account owns and that carry an owner identity (minted when the
  // group first got a member homed elsewhere): the S2S authority key is the
  // owner's identity, which is now this instance's. Left on the former home,
  // the reset domain's new incarnation would pass the owner-home check for
  // them, and this instance's own events would name an owner it no longer
  // presents.
  const ownerHome = canonicalizeHomeInstance(ourOrigin);
  rawDb.prepare(`
    UPDATE dm_channels SET owner_home_user_id = ?, owner_home_instance = ?
    WHERE owner_id = ? AND owner_home_user_id IS NOT NULL
  `).run(row.id, ownerHome, row.id);

  // Every 1-on-1 key is derived from its members' identities, so the
  // account's 1-on-1 rows move to the key of the new one, merging where a row
  // already holds it. Groups (random keys) are a noop in the helper.
  const reconciled: DmReconcileResult[] = [];
  const oneOnOneRows = rawDb.prepare(`
    SELECT c.id FROM dm_channels c
    WHERE c.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM dm_members m WHERE m.dm_channel_id = c.id AND m.user_id = ?)
      AND (SELECT count(*) FROM dm_members m2 WHERE m2.dm_channel_id = c.id) = 2
  `).all(row.id) as Array<{ id: string }>;
  for (const { id } of oneOnOneRows) {
    // A merge earlier in this loop may have removed this row; reconcile
    // re-reads it and is a noop for a missing or settled row.
    const result = reconcileDmChannelFederatedId(rawDb, id);
    if (result.action !== 'noop') reconciled.push(result);
  }

  console.log(`[federation] Homed detached account ${row.id} here (former identity ${row.home_user_id ?? '-'}@${row.home_instance})`);
  return { userId: row.id, reconciled };
}

/**
 * Startup pass, run by `initDatabase` on every boot after the migrations:
 * homes every detached account still in the shape detaching wrote before
 * #310 (flagged, `home_instance` kept) through `rehomeDetachedAccount`, in one
 * transaction. `beforeChanges` runs once, before the first change, only when
 * there is something to rewrite (`initDatabase` takes a snapshot there).
 * Idempotent; a noop on a database with no such row. Returns the number of
 * accounts homed.
 */
export function rehomeDetachedAccountsOnBoot(
  rawDb: Database.Database,
  ourOrigin: string,
  options: { beforeChanges?: () => void } = {},
): number {
  const ids = (rawDb.prepare(`
    SELECT id FROM users
    WHERE is_deleted = 0 AND federation_home_orphaned = 1 AND home_instance IS NOT NULL
  `).all() as Array<{ id: string }>).map(r => r.id);
  if (ids.length === 0) return 0;
  options.beforeChanges?.();

  let homed = 0;
  rawDb.transaction(() => {
    for (const id of ids) {
      if (rehomeDetachedAccount(rawDb, id, ourOrigin)) homed++;
    }
  })();
  if (homed > 0) console.log(`[db] Detached accounts homed on this instance: ${homed}`);
  return homed;
}
