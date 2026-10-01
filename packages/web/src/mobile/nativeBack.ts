import { Capacitor } from '@capacitor/core';

const dismissHandlers: Array<() => void> = [];

/** Native back dismisses the newest modal before touching the navigation stack. */
export function registerNativeDismiss(handler: () => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  dismissHandlers.push(handler);
  return () => {
    const index = dismissHandlers.lastIndexOf(handler);
    if (index !== -1) dismissHandlers.splice(index, 1);
  };
}

export function dismissNativeOverlay(): boolean {
  const handler = dismissHandlers.at(-1);
  if (!handler) return false;
  handler();
  return true;
}
