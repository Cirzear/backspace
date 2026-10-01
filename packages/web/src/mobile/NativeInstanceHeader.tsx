import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../stores/authStore';
import { clearSelectedMobileOrigin, getSelectedMobileOrigin } from '../platform/instanceRuntime';
import { flushSessionStorage, getSessionItem } from '../platform/sessionStorage';

export function NativeInstanceHeader() {
  const { t } = useTranslation('mobile');
  const token = useAuthStore(state => state.token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const origin = getSelectedMobileOrigin();
  if (token || !origin) return null;

  async function changeInstance() {
    setBusy(true);
    try {
      // Logout writes must reach secure storage before discarding the selected origin.
      await flushSessionStorage();
      if (useAuthStore.getState().token || getSessionItem('backspace_token')) {
        throw new Error(t('instance.logoutRequired'));
      }
      clearSelectedMobileOrigin();
      window.location.replace('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return <aside className="glass-strip fixed inset-x-0 top-0 z-50 px-4 pb-3 pt-[max(0.75rem,var(--safe-top))] text-sm text-txt-primary">
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate">{t('instance.selected', { host: new URL(origin).host })}</span>
      <button type="button" disabled={busy} onClick={changeInstance} className="shrink-0 rounded-lg px-3 py-2 text-accent-primary hover:bg-white/5 disabled:opacity-50">{t('instance.change')}</button>
    </div>
    {error && <p role="alert" className="text-accent-rose break-words">{error}</p>}
  </aside>;
}
