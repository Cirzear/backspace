import { useTranslation } from 'react-i18next';
import { useChannelNotificationPolicy } from '../../hooks/useNotificationSettings';

/** A crossed-out bell. Shared by the indicator and the header bell's muted state. */
export function BellOffIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68c-.24.06-.47.14-.69.22L18 13.1V16zM5.41 3.35 4 4.76l2.81 2.81C6.29 8.57 6 9.73 6 11v5l-2 2v1h14.24l1.74 1.74 1.41-1.41L5.41 3.35z" />
    </svg>
  );
}

/**
 * Shown on a channel list row while the channel is muted, by its own mute or
 * its space's. Renders nothing otherwise, and disappears by itself when a
 * timed mute ends (the policy hook re-renders on the store's clock).
 */
export function ChannelMutedIndicator({ channelId, className }: { channelId: string; className?: string }) {
  const { t } = useTranslation(['spaces']);
  const policy = useChannelNotificationPolicy(channelId);
  if (!policy?.muted) return null;
  const label = t('spaces:notifications.mutedIndicator');
  return (
    <span role="img" aria-label={label} title={label} className={`flex-shrink-0 inline-flex ${className ?? ''}`}>
      <BellOffIcon size={14} />
    </span>
  );
}
