import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getActiveRoom } from '../hooks/useLiveKit';
import { usePortalContainer } from '../hooks/usePortalContainer';
import { useScreenShareSetupStore } from '../stores/screenShareSetupStore';
import { Modal } from '../components/ui/Modal';
import { StreamQualityControls } from '../components/voice/StreamQualityControls';
import { startNativeScreenShare, stopNativeScreenShare } from './nativeScreenShare';
import { isNativeScreenShareCancellation } from './nativeScreenSharePlugin';
import { describeNativeScreenShareError } from './nativeScreenShareErrors';

export function NativeScreenShareSetup() {
  const { t } = useTranslation(['voice', 'common']);
  const isOpen = useScreenShareSetupStore((state) => state.isOpen);
  const close = useScreenShareSetupStore((state) => state.close);
  const portal = usePortalContainer();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);

  useEffect(() => { if (isOpen) setError(null); }, [isOpen]);
  useEffect(() => () => {
    generation.current++;
    void stopNativeScreenShare().catch((failure: unknown) => console.error('[NativeScreenShareSetup]', failure));
  }, []);

  const handleClose = async () => {
    generation.current++;
    try {
      if (starting) await stopNativeScreenShare();
      close();
    } catch (failure) {
      console.error('[NativeScreenShareSetup]', failure);
      setError(failure);
    } finally {
      setStarting(false);
    }
  };

  const start = async () => {
    const room = getActiveRoom();
    if (!room) { setError('failed'); return; }
    const attempt = ++generation.current;
    setStarting(true);
    setError(null);
    try {
      await startNativeScreenShare(room);
      if (attempt === generation.current) close();
    } catch (failure) {
      if (attempt !== generation.current) return;
      if (!isNativeScreenShareCancellation(failure)) console.error('[NativeScreenShareSetup]', failure);
      setError(failure);
    } finally {
      if (attempt === generation.current) setStarting(false);
    }
  };

  return createPortal(
    <Modal isOpen={isOpen} onClose={() => { void handleClose(); }} title={t('voice:screenPicker.title')} mobileStyle="sheet">
      <p className="text-sm text-txt-secondary mb-4">{t('voice:nativeScreenShare.consent')}</p>
      <fieldset disabled={starting} className="min-w-0 disabled:opacity-60">
        <StreamQualityControls />
      </fieldset>
      {error !== null && <p role="alert" className="mt-3 text-sm text-accent-rose">
        {describeNativeScreenShareError(error)}
      </p>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="px-4 py-2 rounded-full text-txt-secondary hover:bg-interactive-hover" onClick={() => { void handleClose(); }}>
          {t('common:actions.cancel')}
        </button>
        <button disabled={starting} className="px-4 py-2 rounded-full bg-accent-primary text-white disabled:opacity-50" onClick={() => { void start(); }}>
          {starting ? t('voice:nativeScreenShare.starting') : t('voice:screenPicker.start')}
        </button>
      </div>
    </Modal>, portal,
  );
}
