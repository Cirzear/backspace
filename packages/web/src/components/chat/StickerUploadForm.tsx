import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_STICKER_BYTES, type PersonalSticker } from '@backspace/shared/src/stickers';
import { uploadSticker } from './stickerUpload';

interface StickerUploadFormProps {
  onAdded: (sticker: PersonalSticker) => void;
  onCancel: () => void;
}

/** The original image stays local until confirmation; animated previews are never flattened onto a canvas. */
export function StickerUploadForm({ onAdded, onCancel }: StickerUploadFormProps) {
  const { t } = useTranslation('chat');
  const inputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const chooseRef = useRef<HTMLButtonElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [name, setName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [imageReady, setImageReady] = useState(false);
  const active = useRef(true);
  const submitting = useRef(false);

  useEffect(() => {
    active.current = true;
    chooseRef.current?.focus();
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const choose = (files: File[]) => {
    if (busy) return;
    setDragging(false);
    setError('');
    if (files.length !== 1) { setError(t('stickers.singleImage')); return; }
    const next = files[0]!;
    if (!next.size || next.size > MAX_STICKER_BYTES) { setError(t('stickers.invalidSize')); return; }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(next.type)) { setError(t('stickers.invalidType')); return; }
    setImageReady(false);
    setFile(next);
    setName(next.name.replace(/\.[^.]+$/, '').slice(0, 100));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!file || !name.trim() || !imageReady || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const item = await uploadSticker(file, name.trim());
      if (active.current) onAdded(item);
    } catch (err) {
      if (active.current) setError((err as Error).message);
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  };

  return (
    <form onSubmit={event => void submit(event)} className="flex min-h-0 flex-1 flex-col"
      onPaste={event => {
        if (!event.clipboardData.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        choose(Array.from(event.clipboardData.files));
      }}>
      <div className="flex items-center justify-between border-b border-border-soft px-4 py-3">
        <h3 className="text-sm font-semibold">{t('stickers.upload')}</h3>
        <button type="button" disabled={busy} onClick={onCancel} className="sticker-icon-button"
          aria-label={t('stickers.cancel')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4 space-y-3">
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
          disabled={busy} aria-label={t('stickers.chooseImage')} onChange={event => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length) choose(files);
          }} />
        <button ref={chooseRef} type="button" disabled={busy} onClick={() => inputRef.current?.click()}
          aria-label={file ? t('stickers.replace') : t('stickers.chooseImage')}
          onDragOver={event => { event.preventDefault(); event.stopPropagation(); if (!busy) setDragging(true); }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
          onDrop={event => { event.preventDefault(); event.stopPropagation(); choose(Array.from(event.dataTransfer.files)); }}
          className={`sticker-dropzone ${dragging ? 'sticker-dropzone-active' : ''} ${file ? 'sticker-checkerboard' : ''}`}>
          {preview ? <img key={preview} src={preview} alt={t('stickers.preview')} className="h-36 w-full object-contain"
            onLoad={() => setImageReady(true)} onError={() => { setImageReady(false); setError(t('stickers.invalidImage')); }} />
            : <>
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="5" /><path d="m3 16 5-5 5 5 3-3 5 5" /><circle cx="15.5" cy="8.5" r="1.5" />
                </svg>
              </span>
              <span className="text-sm font-medium">{t('stickers.dropImage')}</span>
              <span className="text-xs text-txt-tertiary">{t('stickers.pasteHint')}</span>
            </>}
        </button>
        {file ? <div className="flex items-center justify-between gap-3 text-xs text-txt-tertiary">
          <span className="truncate" title={file.name}>{file.name}</span>
          <button type="button" disabled={busy} className="shrink-0 text-txt-link hover:underline" onClick={() => inputRef.current?.click()}>{t('stickers.replace')}</button>
        </div> : <p className="text-center text-[11px] text-txt-tertiary">{t('stickers.limits')}</p>}
        {file && <div>
          <label htmlFor={nameId} className="mb-1.5 block text-xs font-medium text-txt-secondary">{t('stickers.name')}</label>
          <input id={nameId} value={name} disabled={busy} maxLength={100} onChange={event => setName(event.target.value)}
            className="input-search w-full" placeholder={t('stickers.name')} />
        </div>}
        {error && <p role="alert" className="rounded-lg bg-accent-rose/10 px-3 py-2 text-xs text-txt-danger">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-soft px-4 py-3">
        <button type="button" disabled={busy} onClick={onCancel} className="sticker-secondary-button">{t('stickers.cancel')}</button>
        <button type="submit" disabled={!file || !imageReady || !name.trim() || busy} className="sticker-primary-button">
          {busy && <span className="sticker-spinner" aria-hidden="true" />}
          <span role={busy ? 'status' : undefined}>{t(busy ? 'stickers.uploading' : 'stickers.save')}</span>
        </button>
      </div>
    </form>
  );
}
