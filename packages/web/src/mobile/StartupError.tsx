import { useTranslation } from 'react-i18next';

export function StartupError({ error }: { error: Error }) {
  const { t } = useTranslation('mobile');
  return <main className="min-h-screen bg-surface-base text-txt-primary flex items-center justify-center p-6">
    <section role="alert" className="w-full max-w-md space-y-4">
      <h1 className="text-xl font-semibold">{t('startup.title')}</h1>
      <p className="text-sm text-txt-secondary">{t('startup.description')}</p>
      <p className="text-sm text-accent-rose break-words">{error.message}</p>
      <button type="button" onClick={() => window.location.reload()} className="rounded-xl bg-accent-primary px-4 py-3 text-white">{t('startup.reload')}</button>
    </section>
  </main>;
}
