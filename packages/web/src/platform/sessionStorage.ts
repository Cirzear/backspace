import { Capacitor, registerPlugin } from '@capacitor/core';

interface BackspaceSessionPlugin {
  read(): Promise<{ value: string | null }>;
  write(options: { value: string }): Promise<void>;
  clear(): Promise<void>;
}

interface SessionDocument {
  version: 1;
  origins: Record<string, Record<string, string>>;
}

const nativeSession = registerPlugin<BackspaceSessionPlugin>('BackspaceSession');
const credentialKey = /^backspace_(?:token|instances(?:_.+)?)$/;
let document: SessionDocument = { version: 1, origins: {} };
let activeOrigin: string | null = null;
let initialization: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
let failure: Error | null = null;

function assertKey(key: string): void {
  if (!credentialKey.test(key)) throw new Error(`Unsupported session storage key: ${key}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOrigin(origin: string): void {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
    throw new Error('Session storage requires a canonical HTTP(S) origin');
  }
}

function parseDocument(value: string): SessionDocument {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.origins) || Object.keys(parsed).length !== 2) {
    throw new Error('Invalid native session storage schema');
  }
  for (const [origin, items] of Object.entries(parsed.origins)) {
    assertOrigin(origin);
    if (!isRecord(items)) throw new Error('Invalid native session storage origin entries');
    for (const [key, item] of Object.entries(items)) {
      assertKey(key);
      if (typeof item !== 'string') throw new Error('Invalid native session storage credential');
    }
  }
  return parsed as unknown as SessionDocument;
}

function reportFailure(cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  if (!failure) {
    failure = error;
    console.error('[sessionStorage] Native credential persistence failed', error);
    window.dispatchEvent(new CustomEvent('backspace:session-storage-error', { detail: error }));
  }
  return failure;
}

/** Must finish before importing App/stores: their initial state reads credentials synchronously. */
export async function initializeSessionStorage(origin: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  assertOrigin(origin);
  if (failure) throw failure;
  if (initialization) await initialization;
  if (activeOrigin !== null) {
    await flushSessionStorage();
    activeOrigin = origin;
    return;
  }
  initialization = (async () => {
    try {
      const { value } = await nativeSession.read();
      document = value === null ? { version: 1, origins: {} } : parseDocument(value);
      activeOrigin = origin;
    } catch (cause) {
      // Corrupt ciphertext/JSON is not an empty session and must never be overwritten.
      throw reportFailure(cause);
    }
  })();
  await initialization;
}

function currentItems(): Record<string, string> {
  if (failure) throw failure;
  if (activeOrigin === null) throw new Error('Native session storage has not been initialized');
  return document.origins[activeOrigin] ?? {};
}

function persistItems(items: Record<string, string>): void {
  const origins = { ...document.origins, [activeOrigin!]: items };
  if (Object.keys(items).length === 0) delete origins[activeOrigin!];
  document = { version: 1, origins };
  // Capture each mutation now, not when the queued operation starts. A rejected
  // queue stays rejected: subsequent writes cannot overwrite a failed session.
  const value = JSON.stringify(document);
  const empty = Object.keys(origins).length === 0;
  writes = writes.then(() => empty ? nativeSession.clear() : nativeSession.write({ value }));
  // Attach an observer for synchronous callers (logout, interceptors); retain the
  // rejected promise so explicit flush callers receive the original failure too.
  void writes.catch(reportFailure);
}

export function getSessionItem(key: string): string | null {
  assertKey(key);
  if (!Capacitor.isNativePlatform()) return localStorage.getItem(key);
  return currentItems()[key] ?? null;
}

export function setSessionItem(key: string, value: string): void {
  assertKey(key);
  if (!Capacitor.isNativePlatform()) {
    localStorage.setItem(key, value);
    return;
  }
  persistItems({ ...currentItems(), [key]: value });
}

export function removeSessionItem(key: string): void {
  assertKey(key);
  if (!Capacitor.isNativePlatform()) {
    localStorage.removeItem(key);
    return;
  }
  const items = { ...currentItems() };
  delete items[key];
  persistItems(items);
}

/** Await credential durability before a successful async login or a page reload. */
export async function flushSessionStorage(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (failure) throw failure;
  // Include writes appended while an earlier bridge operation was in flight.
  let pending: Promise<void>;
  do {
    pending = writes;
    await pending;
  } while (pending !== writes);
}
