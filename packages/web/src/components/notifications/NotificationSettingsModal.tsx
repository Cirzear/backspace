import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MUTED_FOREVER, type NotificationLevel } from '@backspace/shared';
import { Modal } from '../ui/Modal';
import { describeError } from '../../i18n/errors';
import { emptyNotificationSetting, notificationKey, useNotificationStore, type NotificationTarget } from '../../stores/notificationStore';

function NotificationForm({ target }: { target: NotificationTarget }) {
  const { t } = useTranslation('spaces');
  const [initial] = useState(() => useNotificationStore.getState().settings[notificationKey(target)] ?? emptyNotificationSetting);
  const [level, setLevel] = useState<NotificationLevel | null>(initial.level);
  const [mute, setMute] = useState((initial.mutedUntil ?? 0) > Date.now() ? 'existing' : 'off');
  const [suppressEveryone, setEveryone] = useState(initial.suppressEveryone);
  const [suppressRoles, setRoles] = useState(initial.suppressRoles);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setSaving(true);
    setError('');
    const durations: Record<string, number> = { minutes15: 15 * 60_000, hour1: 60 * 60_000, hours8: 8 * 60 * 60_000 };
    let mutedUntil = initial.mutedUntil;
    if (mute === 'off') mutedUntil = null;
    if (mute === 'forever') mutedUntil = MUTED_FOREVER;
    if (durations[mute]) mutedUntil = Date.now() + durations[mute]!;
    try {
      await useNotificationStore.getState().save(target, { level, mutedUntil, suppressEveryone, suppressRoles });
      useNotificationStore.getState().open(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };
  return <form className="space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}>
    <p className="text-sm text-txt-secondary">{t('notifications.description')}</p>
    <fieldset disabled={saving} className="space-y-4">
      <label className="block">{t('notifications.level')}
        <select className="block w-full mt-2 bg-surface-elevated rounded p-2" value={level ?? 'inherit'} onChange={e => setLevel(e.target.value === 'inherit' ? null : e.target.value as NotificationLevel)}>
          {(['inherit', 'all', 'mentions', 'nothing'] as const).map(value => <option key={value} value={value}>{t(`notifications.${value}`)}</option>)}
        </select>
      </label>
      <label className="block">{t('notifications.mute')}
        <select className="block w-full mt-2 bg-surface-elevated rounded p-2" value={mute} onChange={e => setMute(e.target.value)}>
          {(['existing', 'off', 'minutes15', 'hour1', 'hours8', 'forever'] as const).map(value => <option key={value} value={value}>{t(`notifications.${value}`)}</option>)}
        </select>
      </label>
      {target.targetType === 'space' && <>
        <label className="flex gap-2"><input type="checkbox" checked={suppressEveryone} onChange={e => setEveryone(e.target.checked)} />{t('notifications.suppressEveryone')}</label>
        <label className="flex gap-2"><input type="checkbox" checked={suppressRoles} onChange={e => setRoles(e.target.checked)} />{t('notifications.suppressRoles')}</label>
      </>}
      {error && <p role="alert" className="text-accent-rose">{error}</p>}
      <button type="submit" className="w-full p-2 rounded bg-accent-primary text-white">{t(saving ? 'notifications.saving' : 'notifications.save')}</button>
    </fieldset>
  </form>;
}

export function NotificationSettingsModal() {
  const target = useNotificationStore(s => s.editing);
  const { t } = useTranslation('spaces');
  if (!target) return null;
  return <Modal isOpen onClose={() => useNotificationStore.getState().open(null)} title={t('notifications.title')}>
    <NotificationForm key={notificationKey(target)} target={target} />
  </Modal>;
}
