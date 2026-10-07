import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { getSelectedMobileOrigin } from './platform/instanceRuntime';
import { initializeSessionStorage } from './platform/sessionStorage';
import { InstanceSelectionPage } from './mobile/InstanceSelectionPage';
import { StartupError } from './mobile/StartupError';
import i18n, { initI18n } from './i18n';
import './styles/globals.css';
import { initializeInterfaceScale } from './platform/interfaceScale';
import { waitForEmojiShortcodeNames } from './utils/emojiShortcodes';


class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null; showStack: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, showStack: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo.componentStack);
    // Renderer is alive enough to show the fallback UI — disarm the boot timer.
    // Without this, the timer fires 20s after a caught render error and
    // overrides the in-app error UI with native recovery, which is wrong.
    // Gated on VITE_FORCE_BOOT_STALL so the smoke harness can suppress both
    // ping paths simultaneously when testing the renderer-stalled recovery path.
    if (import.meta.env.VITE_FORCE_BOOT_STALL) return;
    if (typeof window.backspace?.rendererReady === 'function') {
      window.backspace.rendererReady();
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          height: 'calc(100*var(--app-vh))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0b0b10',
          color: '#efefef',
          flexDirection: 'column',
          gap: '16px',
          padding: '24px',
        }}>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold' }}>{i18n.t('common:crash.title')}</h1>
          <p style={{ color: '#a0a0aa', maxWidth: '480px', textAlign: 'center' }}>{this.state.error?.message}</p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              style={{
                padding: '8px 24px',
                backgroundColor: '#7c6cf6',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              {i18n.t('common:actions.tryAgain')}
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 24px',
                backgroundColor: 'transparent',
                color: '#a0a0aa',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              {i18n.t('common:crash.reload')}
            </button>
          </div>
          {this.state.error?.stack && (
            <details
              open={this.state.showStack}
              onToggle={(e) => this.setState({ showStack: (e.target as HTMLDetailsElement).open })}
              style={{ maxWidth: '600px', width: '100%', marginTop: '8px' }}
            >
              <summary style={{ color: '#a0a0aa', cursor: 'pointer', fontSize: '13px' }}>
                {i18n.t('common:crash.details')}
              </summary>
              <pre style={{
                marginTop: '8px',
                padding: '12px',
                backgroundColor: 'rgba(255,255,255,0.05)',
                borderRadius: '8px',
                fontSize: '11px',
                color: '#a0a0aa',
                overflow: 'auto',
                maxHeight: '200px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

const reactRoot = ReactDOM.createRoot(root);
let blocked = false;

function showStartupError(cause: unknown): void {
  blocked = true;
  const error = cause instanceof Error ? cause : new Error(String(cause));
  console.error('[bootstrap]', error);
  reactRoot.render(<StartupError error={error} />);
}

// Storage writes can fail after startup too. Unmount the app, never continue with
// an in-memory session that cannot be saved safely on this device.
window.addEventListener('backspace:session-storage-error', event => {
  showStartupError((event as CustomEvent<unknown>).detail);
});

const EMOJI_NAMES_MAX_WAIT_MS = 1000;

async function bootstrap(): Promise<void> {
  const stopInterfaceScale = initializeInterfaceScale();
  if (import.meta.hot) import.meta.hot.dispose(stopInterfaceScale);
  const i18nReady = initI18n()
    .catch((err) => { console.error('[i18n] Failed to initialise, rendering in English:', err); });
  await Promise.all([i18nReady, waitForEmojiShortcodeNames(EMOJI_NAMES_MAX_WAIT_MS)]);
  if (blocked) return;
  if (Capacitor.isNativePlatform()) {
    const origin = getSelectedMobileOrigin();
    if (!origin) {
      reactRoot.render(<React.StrictMode><InstanceSelectionPage /></React.StrictMode>);
      return;
    }
    await initializeSessionStorage(origin);
  }
  if (blocked) return;
  // Session-bound stores read storage at module evaluation. Import neither App
  // nor the pending-message graph until the chosen instance's storage is ready.
  const [{ App }, { startPendingMessageOrchestrator }] = await Promise.all([
    import('./App'), import('./stores/pendingMessageRehydrate'),
  ]);
  if (blocked) return;
  startPendingMessageOrchestrator();
  reactRoot.render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrowserRouter><App /></BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap().catch(showStartupError);
