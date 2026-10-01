import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getUploadUrl, normalizeUserAssets, resolveAssetUrl } from './assetUrls';

const runtime = vi.hoisted(() => ({ native: false }));
vi.mock('../platform/instanceRuntime', () => ({
  getApiBaseUrl: (origin = '') => `${origin || (runtime.native ? 'https://home.test' : '')}/api`,
}));

beforeEach(() => { runtime.native = false; });

describe('getUploadUrl', () => {
  it('preserves web home filenames in normalization and resolves them for rendering', () => {
    expect(resolveAssetUrl('avatar.png', '')).toBe('avatar.png');
    expect(getUploadUrl('avatar.png')).toBe('/api/uploads/avatar.png');
    expect(getUploadUrl('/api/uploads/avatar.png')).toBe('/api/uploads/avatar.png');
  });

  it('resolves native home bare names and upload paths against the selected server', () => {
    runtime.native = true;
    expect(getUploadUrl('avatar.png')).toBe('https://home.test/api/uploads/avatar.png');
    expect(getUploadUrl('/api/uploads/avatar.png')).toBe('https://home.test/api/uploads/avatar.png');
    expect(resolveAssetUrl('avatar.png', '')).toBe('avatar.png');
  });

  it('preserves remote URLs and uses explicit remote origins for relative uploads', () => {
    runtime.native = true;
    const remote = 'https://remote.test/api/uploads/a.png';
    expect(getUploadUrl(remote)).toBe(remote);
    expect(getUploadUrl('a.png', 'https://remote.test')).toBe(remote);
    expect(getUploadUrl('/api/uploads/a.png', 'https://remote.test')).toBe(remote);
    expect(resolveAssetUrl('/api/uploads/a.png', 'https://remote.test')).toBe(remote);
  });

  it.each(['/icons/app.svg', '/sounds/message.mp3', '/assets/logo.svg', 'blob:https://home.test/preview', 'data:image/png;base64,AAAA'])(
    'keeps static assets and previews unchanged: %s', asset => {
      runtime.native = true;
      expect(getUploadUrl(asset, 'https://remote.test')).toBe(asset);
    },
  );

  it.each(['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'java\nscript:alert(1)', 'file:///private/image.png', 'vbscript:msgbox(1)', '//remote.test/a.png'])(
    'rejects unsafe or ambiguous URLs: %s', asset => {
      expect(() => getUploadUrl(asset)).toThrow();
    },
  );
});

describe('normalizeUserAssets identity contract', () => {
  it('never turns a home user into a federated identity on native', () => {
    runtime.native = true;
    const user = { id: '1', username: 'alice', avatar: 'a.png', banner: 'b.png', homeInstance: null, homeUserId: null };
    const original = { ...user };
    expect(normalizeUserAssets(user, '')).toBe(user);
    expect(user).toEqual(original);
    expect(getUploadUrl(user.avatar)).toBe('https://home.test/api/uploads/a.png');
  });

  it('continues qualifying users native to remote instances', () => {
    const user = { id: '1', username: 'alice', avatar: 'a.png' };
    expect(normalizeUserAssets(user, 'https://remote.test')).toEqual({
      id: '1', username: 'alice@remote.test', avatar: 'https://remote.test/api/uploads/a.png',
      homeInstance: 'remote.test', homeUserId: '1',
    });
  });
});
