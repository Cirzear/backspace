import { Capacitor } from '@capacitor/core';

const MOBILE_ORIGIN_KEY = 'backspace_mobile_origin';

/** Instance selection is a trust boundary: never turn a typo into another URL. */
export function validateInstanceOrigin(input: string): string {
  const value = input.trim();
  const invalid = () => new Error('Instance address must be a complete HTTPS origin without credentials, path, query, or fragment.');
  // Check the original spelling too: URL normalizes dot paths and empty ?/#.
  if (!/^https:\/\/[^/?#\\\s]+\/?$/i.test(value)) throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' || url.username || url.password || value.includes('@') || url.pathname !== '/' || url.search || url.hash) {
    throw invalid();
  }
  return url.origin;
}

export function getSelectedMobileOrigin(): string | null {
  const stored = localStorage.getItem(MOBILE_ORIGIN_KEY);
  return stored === null ? null : validateInstanceOrigin(stored);
}

export function setSelectedMobileOrigin(origin: string): void {
  localStorage.setItem(MOBILE_ORIGIN_KEY, validateInstanceOrigin(origin));
}

/** Only the signed-out instance picker may discard this device's selection. */
export function clearSelectedMobileOrigin(): void {
  localStorage.removeItem(MOBILE_ORIGIN_KEY);
}

/** The WebView's localhost is an asset origin, never a federated identity. */
export function getHomeOrigin(): string {
  if (!Capacitor.isNativePlatform()) return window.location.origin;
  const origin = getSelectedMobileOrigin();
  if (origin === null) throw new Error('Select a mobile instance before loading the application.');
  return origin;
}

export function getHomeHost(): string {
  return Capacitor.isNativePlatform() ? new URL(getHomeOrigin()).host : window.location.host;
}

export function getHomeHostname(): string {
  return Capacitor.isNativePlatform() ? new URL(getHomeOrigin()).hostname : window.location.hostname;
}

/** Keep the empty routing sentinel; only transport URLs expand it to home. */
export function getApiBaseUrl(origin = ''): string {
  const base = origin || (Capacitor.isNativePlatform() ? getHomeOrigin() : '');
  return `${base}/api`;
}

export function getWebSocketUrl(origin = ''): string {
  const url = new URL(origin || getHomeOrigin());
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/ws`;
}

const MEDIA_ORIGIN_KEY = 'backspace_media_origin';
let inMemoryMediaOrigin: string | null | undefined = undefined;

/**
 * The dedicated origin for home media/uploads (images, videos, files), if configured.
 * Cached in memory and persisted in localStorage so reloads apply immediately.
 */
export function getHomeMediaOrigin(): string | null {
  if (inMemoryMediaOrigin !== undefined) {
    return inMemoryMediaOrigin;
  }
  try {
    const stored = localStorage.getItem(MEDIA_ORIGIN_KEY);
    if (stored) {
      inMemoryMediaOrigin = stored;
      return stored;
    }
  } catch {}

  const buildEnv = (import.meta as unknown as { env?: { VITE_MEDIA_URL?: string } }).env?.VITE_MEDIA_URL;
  if (buildEnv && buildEnv.trim()) {
    const trimmed = buildEnv.trim().replace(/\/+$/, '');
    inMemoryMediaOrigin = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return inMemoryMediaOrigin;
  }

  inMemoryMediaOrigin = null;
  return null;
}

export function setHomeMediaOrigin(origin: string | null | undefined): void {
  const normalized = origin && origin.trim() ? origin.trim().replace(/\/+$/, '') : null;
  const value = normalized
    ? (/^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`)
    : null;
  inMemoryMediaOrigin = value;
  try {
    if (value) {
      localStorage.setItem(MEDIA_ORIGIN_KEY, value);
    } else {
      localStorage.removeItem(MEDIA_ORIGIN_KEY);
    }
  } catch {}
}

export function clearHomeMediaOrigin(): void {
  setHomeMediaOrigin(null);
}

/** Test-only helper to reset media origin memory and storage cache. */
export function __resetHomeMediaOriginForTests(): void {
  inMemoryMediaOrigin = undefined;
  try {
    localStorage.removeItem(MEDIA_ORIGIN_KEY);
  } catch {}
}
