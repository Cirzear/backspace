import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { NotificationSettingsControls } from './NotificationSettingsControls';

/**
 * The notification settings dialog (`.glass-modal` through `Modal`), for a
 * whole space or for one channel. Opened from the space context menu, and on
 * mobile from the channel menu, where there is no header bell.
 *
 * `origin` is the instance that hosts the space.
 */
export type NotificationSettingsModalTarget =
  | { kind: 'space'; origin: string; spaceId: string; spaceName: string }
  | { kind: 'channel'; origin: string; spaceId: string; channelId: string; channelName: string };

interface NotificationSettingsModalProps {
  target: NotificationSettingsModalTarget;
  onClose: () => void;
}

export function NotificationSettingsModal({ target, onClose }: NotificationSettingsModalProps) {
  const { t } = useTranslation(['spaces']);
  const title = target.kind === 'space'
    ? t('spaces:notifications.spaceTitle', { space: target.spaceName })
    : t('spaces:notifications.channelTitle', { channel: target.channelName });

  return (
    <Modal isOpen onClose={onClose} title={title} maxWidth="max-w-sm" mobileStyle="sheet">
      <NotificationSettingsControls
        origin={target.origin}
        spaceId={target.spaceId}
        channelId={target.kind === 'channel' ? target.channelId : null}
      />
    </Modal>
  );
}
