import type { Activity } from '@backspace/shared';

/** Tracks ephemeral user activities, user show activity preferences, and live status cache. */
export class UserActivityTracker {
  private userActivities = new Map<string, Activity[]>();
  private userShowActivity = new Map<string, boolean>();
  private userStatuses = new Map<string, string>();
  private lastActivityUpdate = new Map<string, number>();

  setUserActivities(userId: string, activities: Activity[]): void {
    if (activities.length === 0) {
      this.userActivities.delete(userId);
    } else {
      this.userActivities.set(userId, activities);
    }
  }

  getUserActivities(userId: string): Activity[] {
    return this.userActivities.get(userId) ?? [];
  }

  clearUserActivities(userId: string): void {
    this.userActivities.delete(userId);
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

  checkActivityRateLimit(userId: string): boolean {
    const now = Date.now();
    const last = this.lastActivityUpdate.get(userId) ?? 0;
    if (now - last < 3000) return false;
    this.lastActivityUpdate.set(userId, now);
    return true;
  }

  clearUser(userId: string): void {
    this.userActivities.delete(userId);
    this.userShowActivity.delete(userId);
    this.userStatuses.delete(userId);
    this.lastActivityUpdate.delete(userId);
  }
}
