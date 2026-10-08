import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import {
  getApiBaseUrl, getHomeHost, getHomeHostname, getHomeOrigin,
  getSelectedMobileOrigin, getWebSocketUrl, setSelectedMobileOrigin, validateInstanceOrigin,
} from './instanceRuntime';
import { deliveringHost, isSelf, isFederationGlobeApplicable, userKey } from '../utils/identity';
import { resolveTusUrl, tusEndpoint } from '../utils/tusUrl';
import { parseInviteInput } from '../utils/inviteParser';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('instance runtime', () => {
  it('keeps browser origin, port, relative API and HTTP websocket behavior', () => {
    vi.stubGlobal('location', new URL('http://localhost:5173/channels'));
    setSelectedMobileOrigin('https://ignored.example');
    expect(getHomeOrigin()).toBe(window.location.origin);
    expect(getHomeHost()).toBe(window.location.host);
    expect(getHomeHostname()).toBe(window.location.hostname);
    expect(getApiBaseUrl()).toBe('/api');
    expect(getWebSocketUrl()).toBe('ws://localhost:5173/ws');
  });

  it('requires a selected native instance instead of silently using WebView localhost', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    expect(getSelectedMobileOrigin()).toBeNull();
    for (const getValue of [getHomeOrigin, getHomeHost, getHomeHostname, getApiBaseUrl, getWebSocketUrl]) {
      expect(() => getValue()).toThrow('Select a mobile instance');
    }
  });

  it('uses the selected HTTPS instance consistently, preserving its public port', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    setSelectedMobileOrigin(' https://HOME.example:8443/ ');
    expect(getSelectedMobileOrigin()).toBe('https://home.example:8443');
    expect(getHomeOrigin()).toBe('https://home.example:8443');
    expect(getHomeHost()).toBe('home.example:8443');
    expect(getHomeHostname()).toBe('home.example');
    expect(getApiBaseUrl()).toBe('https://home.example:8443/api');
    expect(getWebSocketUrl()).toBe('wss://home.example:8443/ws');
    expect(tusEndpoint('')).toBe('https://home.example:8443/api/files/');
    expect(resolveTusUrl('/api/files/upload-id', undefined)).toBe('https://home.example:8443/api/files/upload-id');
    expect(deliveringHost('')).toBe('home.example:8443');
    expect(userKey({ id: 'native-user' }, '')).toBe('home.example:native-user');
    expect(isSelf({ id: 'replica', username: 'alice', homeInstance: 'home.example:8443' }, { id: 'home', username: 'alice' })).toBe(true);
    expect(isFederationGlobeApplicable({ username: 'alice@home.example:8443' })).toBe(false);
    expect(isFederationGlobeApplicable({ username: 'alice@localhost' })).toBe(true);
    expect(parseInviteInput('https://home.example:8443/join/abc123')).toEqual({ code: 'abc123' });
    expect(parseInviteInput('abc123@home.example:8443')).toEqual({ code: 'abc123' });
  });

  it('keeps explicit remote routing independent of native selection', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    expect(getApiBaseUrl('https://remote.example:9443')).toBe('https://remote.example:9443/api');
    expect(getWebSocketUrl('https://remote.example:9443')).toBe('wss://remote.example:9443/ws');
    expect(getWebSocketUrl('http://localhost:3005')).toBe('ws://localhost:3005/ws');
    expect(tusEndpoint('https://remote.example:9443')).toBe('https://remote.example:9443/api/files/');
    expect(deliveringHost('https://remote.example:9443')).toBe('remote.example:9443');
  });

  it('revalidates stored selection and does not overwrite it on invalid input', () => {
    setSelectedMobileOrigin('https://home.example');
    expect(() => setSelectedMobileOrigin('http://home.example')).toThrow('HTTPS origin');
    expect(getSelectedMobileOrigin()).toBe('https://home.example');
    localStorage.setItem('backspace_mobile_origin', 'https://home.example/path');
    expect(() => getSelectedMobileOrigin()).toThrow('HTTPS origin');
  });

  it.each([
    '', 'home.example', '//home.example', 'http://home.example', 'ftp://home.example',
    'https://user:password@home.example', 'https://@home.example',
    'https://home.example/path', 'https://home.example/..', 'https://home.example//',
    'https://home.example?query=1', 'https://home.example?', 'https://home.example/#',
    'https://home.example/#fragment', 'https://home.example\\path', 'https:///home.example',
    'https://home.example:99999', 'https://ho\nme.example',
  ])('rejects non-origin instance address %j', (input) => {
    expect(() => validateInstanceOrigin(input)).toThrow('HTTPS origin');
  });
});
