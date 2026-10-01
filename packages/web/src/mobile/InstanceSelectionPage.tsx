import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { setSelectedMobileOrigin } from '../platform/instanceRuntime';
import { probeMobileInstance } from './instanceProbe';

export function InstanceSelectionPage() {
  const { t } = useTranslation('mobile');
  const [address, setAddress] = useState('');
  const [verified, setVerified] = useState<Awaited<ReturnType<typeof probeMobileInstance>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setVerified(null);
    try {
      setVerified(await probeMobileInstance(address));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function confirm() {
    if (!verified) return;
    try {
      setSelectedMobileOrigin(verified.origin);
      // Never navigate the WebView to remote content: restart the local app shell.
      window.location.replace('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main className="min-h-screen bg-surface-base text-txt-primary flex items-center justify-center px-6 py-12">
      <section className="w-full max-w-md space-y-6">
        <h1 className="text-2xl font-semibold">{t('instance.title')}</h1>
        <p className="text-sm text-txt-secondary">{t('instance.description')}</p>
        <form onSubmit={check} className="space-y-4">
          <label className="block text-sm" htmlFor="instance-origin">{t('instance.address')}</label>
          <input id="instance-origin" type="url" required autoCapitalize="none" autoCorrect="off"
            spellCheck={false} autoComplete="url" disabled={busy} value={address}
            aria-describedby="instance-help" className="input-standard w-full px-4 py-3"
            onChange={event => { setAddress(event.target.value); setVerified(null); setError(null); }} />
          <p id="instance-help" className="text-sm text-txt-secondary">{t('instance.httpsHelp')}</p>
          <button type="submit" disabled={busy} className="w-full rounded-xl bg-accent-primary px-4 py-3 text-white disabled:opacity-50">
            {busy ? t('instance.checking') : t('instance.check')}
          </button>
        </form>
        {verified && <div className="space-y-3 rounded-xl bg-surface-channel p-4">
          <p className="font-medium break-words">{verified.info.name}</p>
          <p className="text-sm text-txt-secondary break-all">{verified.origin}</p>
          <button type="button" onClick={confirm} className="w-full rounded-xl bg-accent-primary px-4 py-3 text-white">{t('instance.confirm')}</button>
        </div>}
        {error && <div role="alert" className="text-sm text-accent-rose break-words"><p>{t('instance.connectionError')}</p><p>{error}</p></div>}
        <p className="text-xs text-txt-tertiary">{t('instance.sessionHelp')}</p>
      </section>
    </main>
  );
}
