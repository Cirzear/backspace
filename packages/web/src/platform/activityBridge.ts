import type { Activity } from '@backspace/shared';
import { useActivityStore } from '../stores/activityStore';

let unsubscribe: (() => void) | null = null;

export function initActivityBridge(): void {
  if (unsubscribe) return; // already initialized
  if (!window.backspace?.onActivityDetected) return; // not Electron

  // Subscribe to future activity changes from main process
  if (window.backspace.onActivitiesDetected) {
    unsubscribe = window.backspace.onActivitiesDetected((activities) => {
      const list = Array.isArray(activities) ? (activities as Activity[]) : [];
      useActivityStore.getState().pushActivities(list);
    });

    window.backspace.getCurrentActivities?.().then((activities: unknown) => {
      if (Array.isArray(activities)) {
        useActivityStore.getState().pushActivities(activities as Activity[]);
      }
    }).catch(() => {});
  } else {
    unsubscribe = window.backspace.onActivityDetected((activity) => {
      if (Array.isArray(activity)) {
        useActivityStore.getState().pushActivities(activity as Activity[]);
      } else if (activity) {
        useActivityStore.getState().pushActivities([activity as Activity]);
      } else {
        useActivityStore.getState().pushActivities([]);
      }
    });

    window.backspace.getCurrentActivity?.().then((activity: unknown) => {
      if (Array.isArray(activity)) {
        useActivityStore.getState().pushActivities(activity as Activity[]);
      } else if (activity) {
        useActivityStore.getState().pushActivities([activity as Activity]);
      }
    }).catch(() => {});
  }
}

export function teardownActivityBridge(): void {
  unsubscribe?.();
  unsubscribe = null;
}
