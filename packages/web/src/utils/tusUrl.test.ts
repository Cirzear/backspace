import { describe, it, expect } from 'vitest';
import { resolveTusUrl, tusEndpoint } from './tusUrl';
import { setHomeMediaOrigin, clearHomeMediaOrigin } from '../platform/instanceRuntime';

describe('resolveTusUrl', () => {
  it('resolves a relative Location against the home origin when no origin is given', () => {
    // jsdom serves the test page from http://localhost:3000
    expect(resolveTusUrl('/api/files/abc', undefined)).toBe('http://localhost:3000/api/files/abc');
    expect(resolveTusUrl('/api/files/abc', '')).toBe('http://localhost:3000/api/files/abc');
  });

  it('resolves a relative Location against a remote origin', () => {
    expect(resolveTusUrl('/api/files/abc', 'https://orbit.example')).toBe('https://orbit.example/api/files/abc');
    expect(resolveTusUrl('/api/files/abc', 'https://orbit.example/')).toBe('https://orbit.example/api/files/abc');
  });

  it('resolves against dedicated media origin when configured', () => {
    setHomeMediaOrigin('https://media.cirzear.cn');
    expect(resolveTusUrl('/api/files/abc', undefined)).toBe('https://media.cirzear.cn/api/files/abc');
    expect(resolveTusUrl('/api/files/abc', '')).toBe('https://media.cirzear.cn/api/files/abc');
    // Remote origin still respected
    expect(resolveTusUrl('/api/files/abc', 'https://orbit.example')).toBe('https://orbit.example/api/files/abc');
    clearHomeMediaOrigin();
  });

  it('keeps the port the client actually used', () => {
    expect(resolveTusUrl('/api/files/abc', 'https://chat.example.com:1443')).toBe('https://chat.example.com:1443/api/files/abc');
  });

  it('leaves an absolute Location untouched', () => {
    expect(resolveTusUrl('https://chat.example.com:1443/api/files/abc', undefined)).toBe('https://chat.example.com:1443/api/files/abc');
    expect(resolveTusUrl('https://orbit.example/api/files/abc', 'https://nova.example')).toBe('https://orbit.example/api/files/abc');
  });
});

describe('tusEndpoint', () => {
  it('is absolute for the home instance', () => {
    expect(tusEndpoint(undefined)).toBe('http://localhost:3000/api/files/');
    expect(tusEndpoint('')).toBe('http://localhost:3000/api/files/');
  });

  it('targets dedicated media origin when configured', () => {
    setHomeMediaOrigin('https://media.cirzear.cn');
    expect(tusEndpoint(undefined)).toBe('https://media.cirzear.cn/api/files/');
    expect(tusEndpoint('')).toBe('https://media.cirzear.cn/api/files/');
    // Remote origin still respected
    expect(tusEndpoint('https://orbit.example')).toBe('https://orbit.example/api/files/');
    clearHomeMediaOrigin();
  });
});
