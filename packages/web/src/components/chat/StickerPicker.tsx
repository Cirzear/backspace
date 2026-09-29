import { uploadSticker } from './stickerUpload';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { stickerUrl, type PersonalSticker } from '@backspace/shared/src/stickers';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';

export function StickerPicker({ onSelect }: { onSelect: (token: string) => void }) {
  const { t } = useTranslation('chat');
  const userId = useAuthStore(s => s.user?.id);
  const [items, setItems] = useState<PersonalSticker[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setItems([]);
    setLoading(true);
    setError('');
    api.stickers.list().then(rows => { if (active) setItems(rows); })
      .catch((err: Error) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const item = await uploadSticker(file, file.name);
      setItems(rows => [item, ...rows.filter(row => row.id !== item.id)]);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      await api.stickers.remove(id);
      setItems(rows => rows.filter(row => row.id !== id));
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="w-[352px] max-w-full h-full min-h-0 flex flex-col p-3 text-txt-primary" onKeyDown={event => event.stopPropagation()}>
      <label className="block text-sm mb-2">
        {t('stickers.upload')}
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy || loading}
          className="block w-full text-xs mt-2" aria-label={t('stickers.upload')}
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void upload(file);
          }} />
      </label>
      <p className="text-xs text-txt-tertiary mb-2">{t('stickers.limits')}</p>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {(busy || loading) && <p role="status">{t('stickers.loading')}</p>}
      {!loading && !error && items.length === 0 && <p className="text-sm">{t('stickers.empty')}</p>}
      <div className="grid grid-cols-4 gap-2 min-h-0 overflow-y-auto max-h-[260px]">
        {items.map(item => (
          <div key={item.id} className="rounded bg-interactive-hover p-1">
            <button type="button" disabled={busy} onClick={() => onSelect(item.token)} title={item.name}
              aria-label={item.name} className="w-full h-16">
              <img src={stickerUrl(item.token)!} alt={item.name} className="w-full h-full object-contain" loading="lazy" />
            </button>
            <button type="button" disabled={busy} className="text-xs w-full text-txt-tertiary"
              onClick={() => void remove(item.id)}>{t('stickers.remove')}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
