import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type NativeScreenShareState = 'starting' | 'started' | 'stopped' | 'error';
export interface NativeAudioState { micMuted: boolean; deafened: boolean }

interface NativeScreenShareStart extends NativeAudioState {
  url: string;
  token: string;
  voiceToken: string;
  identity: string;
  wsUrl: string;
  wsToken: string;
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  shareAudio: boolean;
}

interface ScreenSharePlugin {
  start(options: NativeScreenShareStart): Promise<{ state: 'started' }>;
  stop(): Promise<{ state: NativeScreenShareState }>;
  getState(): Promise<{ state: NativeScreenShareState }>;
  updateAudioState(options: NativeAudioState): Promise<void>;
  addListener(event: 'screenShareState', listener: (event: {
    state: NativeScreenShareState; error?: string;
  }) => void): Promise<PluginListenerHandle>;
}

export const BackspaceScreenShare = registerPlugin<ScreenSharePlugin>('BackspaceScreenShare');
export const isNativeScreenShare = (): boolean => Capacitor.getPlatform() === 'android';

export function isNativeScreenShareCancellation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'SCREEN_SHARE_CANCELLED';
}
