import { useEffect } from 'react';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { App as NativeApp } from '@capacitor/app';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUIStore } from '../stores/uiStore';
import { useContextMenuStore } from '../stores/contextMenuStore';
import { dismissNativeOverlay } from './nativeBack';

/** Android owns edge-back; do not replay browser history's synthetic stack entries. */
export function NativeLifecycle() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed = false;
    let listener: PluginListenerHandle | undefined;
    const onBack = () => {
      const menu = useContextMenuStore.getState();
      if (menu.menu) {
        menu.close();
        return;
      }
      if (dismissNativeOverlay()) return;
      const ui = useUIStore.getState();
      if (ui.activeModal) {
        ui.closeModal();
        return;
      }
      if (ui.mobileStack.length) {
        ui.popMobileScreen();
        return;
      }
      if (location.pathname === '/register' || location.pathname.startsWith('/join/')) {
        navigate('/login', { replace: true });
        return;
      }
      // Keep foreground-only calls honest: minimizing is not a background-call guarantee.
      void NativeApp.minimizeApp().catch(console.error);
    };
    void NativeApp.addListener('backButton', onBack).then((handle) => {
      if (disposed) void handle.remove();
      else listener = handle;
    }).catch(console.error);
    return () => {
      disposed = true;
      if (listener) void listener.remove();
    };
  }, [navigate, location.pathname]);

  return null;
}
