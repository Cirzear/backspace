import { describe, expect, it } from 'vitest';
import { describeNativeScreenShareError } from './nativeScreenShareErrors';

describe('native screen share errors', () => {
  it('maps cancellation, permission and API-level failures rather than native English', () => {
    expect(describeNativeScreenShareError({ code: 'SCREEN_SHARE_CANCELLED', message: 'native text' })).toContain('cancelled');
    expect(describeNativeScreenShareError({ code: 'SCREEN_SHARE_AUDIO_PERMISSION_DENIED' })).toContain('Microphone permission');
    expect(describeNativeScreenShareError('SCREEN_SHARE_AUDIO_UNSUPPORTED')).toContain('Android 10');
    expect(describeNativeScreenShareError('SCREEN_SHARE_START_TIMEOUT')).toContain('timed out');
  });

  it('does not expose unexpected raw native messages or tokens', () => {
    const text = describeNativeScreenShareError({ code: 'UNEXPECTED', message: 'secret-jwt' });
    expect(text).not.toContain('secret-jwt');
    expect(text).toContain('Screen sharing failed');
  });
});
