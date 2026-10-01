import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { usePendingMessageStore } from '../stores/pendingMessageStore';
import { useTransferStore } from '../stores/transferStore';
import { useComposerStore } from '../stores/composerStore';
import { disconnectInstance, disconnectAllRemote } from '../hooks/useWebSocket';

/** Persistence failure must also stop background work, not merely hide its UI. */
export function NativeSessionGuard() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const stop = () => {
      usePendingMessageStore.getState().resetSession();
      useTransferStore.getState().resetSession();
      useComposerStore.getState().resetSession();
      disconnectInstance('');
      disconnectAllRemote();
    };
    window.addEventListener('backspace:session-storage-error', stop);
    return () => window.removeEventListener('backspace:session-storage-error', stop);
  }, []);
  return null;
}
