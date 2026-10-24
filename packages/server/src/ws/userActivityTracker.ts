import type { Activity } from '@backspace/shared';
import { projectActivityPlayback } from './presenceEvent.js';

/** Tracks ephemeral user activities, user show activity preferences, and live status cache. */
export class UserActivityTracker {
  private userActivities = new Map<string, Activity[]>();
  private activityObservedAt = new Map<string, number>();
  private userShowActivity = new Map<string, boolean>();
  private userStatuses = new Map<string, string>();
  private lastActivityUpdate = new Map<string, number>();

  setUserActivities(userId: string, activities: Activity[]): void {
    if (activities.length === 0) {
      this.userActivities.delete(userId);
      this.activityObservedAt.delete(userId);
    } else {
      this.userActivities.set(userId, activities);
      this.activityObservedAt.set(userId, Date.now());
    }
  }

  getUserActivities(userId: string): Activity[] {
    const activities = this.userActivities.get(userId) ?? [];
    const observedAt = this.activityObservedAt.get(userId);
    if (observedAt === undefined) return activities;
    return projectActivityPlayback(activities, Math.max(0, Date.now() - observedAt));
  }

  clearUserActivities(userId: string): void {
    this.userActivities.delete(userId);
    this.activityObservedAt.delete(userId);
  }

  setUserShowActivity(userId: string, show: boolean): void {
    this.userShowActivity.set(userId, show);
  }

  getUserShowActivity(userId: string): boolean {
    return this.userShowActivity.get(userId) ?? true;
  }

  setUserStatus(userId: string, status: string): void {
    this.userStatuses.set(userId, status);
  }

  getUserStatus(userId: string): string {
    return this.userStatuses.get(userId) ?? 'offline';
  }

  /**
   * Removing an already-published activity is accepted even inside the normal
   * update window. Without this exception a pause immediately after a track
   * change is dropped and the old "listening" state remains on other clients.
   */
  checkActivityRateLimit(userId: string, removingPublishedActivities = false): boolean {
    const now = Date.now();
    const last = this.lastActivityUpdate.get(userId) ?? 0;
    if (!removingPublishedActivities && now - last < 3000) return false;
    this.lastActivityUpdate.set(userId, now);
    return true;
  }

  clearUser(userId: string): void {
    this.userActivities.delete(userId);
    this.activityObservedAt.delete(userId);
    this.userShowActivity.delete(userId);
    this.userStatuses.delete(userId);
    this.lastActivityUpdate.delete(userId);
  }
}
