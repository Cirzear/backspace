/**
 * Keeps every shown native notification reachable until it is done with.
 *
 * Electron's `Notification` is a JavaScript object over a native toast. When
 * nothing in JavaScript references it any more, the garbage collector may
 * free it while the toast is still on screen; on Windows its click handler
 * then never runs, so clicking the toast does nothing (#394). Holding each
 * one here until it is clicked, closed or fails keeps the handler alive for
 * as long as the toast can be clicked.
 *
 * Windows does not promise a `close` event (a toast that times out into the
 * Action Center may never send one), so the set is also bounded: past
 * `limit`, the oldest notification is released. The bound only matters for
 * a long session with many unanswered toasts, and the ones it lets go are
 * the oldest in the Action Center.
 */

/** The part of Electron's `Notification` this module uses. */
export interface RetainableNotification {
  once(event: 'click', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  once(event: 'failed', listener: () => void): unknown;
}

/** How many unanswered notifications are kept at most. */
export const DEFAULT_RETAINED_NOTIFICATION_LIMIT = 100;

export class NotificationRetainer<T extends RetainableNotification> {
  /** Insertion-ordered, so the first entry is the oldest. */
  private readonly retained = new Set<T>();

  constructor(private readonly limit: number = DEFAULT_RETAINED_NOTIFICATION_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`NotificationRetainer limit must be a positive integer, got ${limit}`);
    }
  }

  /**
   * Holds `notification` until its first `click`, `close` or `failed`.
   * Call before `show()`, so an event that fires at once is not missed.
   */
  retain(notification: T): void {
    if (this.retained.has(notification)) return;
    const release = (): void => {
      this.retained.delete(notification);
    };
    notification.once('click', release);
    notification.once('close', release);
    notification.once('failed', release);
    this.retained.add(notification);
    while (this.retained.size > this.limit) {
      const oldest = this.retained.values().next().value;
      if (oldest === undefined) break;
      this.retained.delete(oldest);
    }
  }

  /** How many notifications are held now. */
  get size(): number {
    return this.retained.size;
  }

  has(notification: T): boolean {
    return this.retained.has(notification);
  }
}
