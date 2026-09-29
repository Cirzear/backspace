import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { stickerUrl } from '@backspace/shared/src/stickers';
import { api } from '../../api/client';
import { uploadSticker, readStickerImage } from './stickerUpload';

/** Only local assets are collectible. No server-side remote fetch or cross-instance copying. */
export function SaveStickerButton({ source, name }: { source: string; name: string }) {
  const { t } = useTranslation('chat');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const sticker = stickerUrl(source);
  let url: URL;
  try { url = new URL(sticker ?? source, window.location.origin); }
  catch { return null; }
  const local = url.origin === window.location.origin;
  const upload = /^\/api\/uploads\/[^/]+$/.test(url.pathname) && !url.search && !url.hash;
  if (!sticker && (!local || !upload)) return null;

  const save = async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      if (sticker) {
        await api.stickers.collect({ id: url.pathname.split('/').pop()!.replace('.webp', ''), token: source });
      } else {
        const response = await fetch(url.href);
        await uploadSticker(await readStickerImage(response), name);
      }
      setSaved(true);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return <div className="text-xs mt-1">
    <button type="button" className="text-txt-link hover:underline" disabled={busy}
      onClick={() => void save()}>{t('stickers.save')}</button>
    {saved && <span role="status" className="ml-2 text-txt-tertiary">{t('stickers.saved')}</span>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
  </div>;
}
