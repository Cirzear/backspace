import i18n from '../i18n';
import { HttpError } from '../api/client';
import { describeError } from '../i18n/errors';

/** Native error codes are stable; never surface platform English or token-bearing exceptions. */
export function describeNativeScreenShareError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 404 && !error.code) return i18n.t('voice:nativeScreenShare.errors.serverUnavailable');
    return describeError(error);
  }
  const code = typeof error === 'string' ? error
    : typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  const key = errorKey(typeof code === 'string' ? code : '');
  return i18n.t(key);
}

const ERROR_KEYS = {
  SCREEN_SHARE_CANCELLED: 'voice:nativeScreenShare.cancelled',
  SCREEN_SHARE_BUSY: 'voice:nativeScreenShare.errors.busy',
  SCREEN_SHARE_INVALID_OPTIONS: 'voice:nativeScreenShare.errors.invalidOptions',
  SCREEN_SHARE_AUDIO_PERMISSION_DENIED: 'voice:nativeScreenShare.errors.audioPermission',
  SCREEN_SHARE_CONSENT_FAILED: 'voice:nativeScreenShare.errors.consent',
  SCREEN_SHARE_SERVICE_FAILED: 'voice:nativeScreenShare.errors.service',
  SCREEN_SHARE_START_TIMEOUT: 'voice:nativeScreenShare.errors.timeout',
  SCREEN_SHARE_AUDIO_UPDATE_FAILED: 'voice:nativeScreenShare.errors.audioUpdate',
  SCREEN_SHARE_AUDIO_CAPTURE_FAILED: 'voice:nativeScreenShare.errors.audioCapture',
  SCREEN_SHARE_AUDIO_FORMAT_FAILED: 'voice:nativeScreenShare.errors.audioCapture',
  SCREEN_SHARE_AUDIO_UNSUPPORTED: 'voice:nativeScreenShare.audioNote',
  SCREEN_SHARE_VOICE_PLAYBACK_FAILED: 'voice:nativeScreenShare.errors.connection',
  SCREEN_SHARE_RELEASE_FAILED: 'voice:nativeScreenShare.errors.release',
  SCREEN_SHARE_DISCONNECTED: 'voice:nativeScreenShare.errors.connection',
  SCREEN_SHARE_VOICE_SESSION_FAILED: 'voice:nativeScreenShare.errors.connection',
  SCREEN_SHARE_VOICE_SESSION_CLOSED: 'voice:nativeScreenShare.errors.connection',
  SCREEN_SHARE_VOICE_SESSION_REJECTED: 'voice:nativeScreenShare.errors.connection',
  SCREEN_SHARE_VOICE_SESSION_ENDED: 'voice:nativeScreenShare.errors.connection',
  SCREEN_SHARE_VOICE_SUBSCRIPTION_FAILED: 'voice:nativeScreenShare.errors.connection',
  SCREEN_SHARE_START_FAILED: 'voice:nativeScreenShare.failed',
} as const;

function errorKey(code: string): (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS] {
  return Object.hasOwn(ERROR_KEYS, code)
    ? ERROR_KEYS[code as keyof typeof ERROR_KEYS]
    : 'voice:nativeScreenShare.failed';
}
