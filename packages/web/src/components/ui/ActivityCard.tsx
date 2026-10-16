import type { Activity } from '@backspace/shared';
import { getPrimaryActivity } from '@backspace/shared/src/activities.js';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { replaceEmojiShortcodes, useEmojiShortcodeNames } from '../../utils/emojiShortcodes';

interface ActivityCardProps {
  activities: Activity[];
  fallbackCustomStatus?: string | null;
}

function formatElapsed(startMs: number, t: TFunction<'common'>): string {
  const elapsed = Date.now() - startMs;
  const minutes = Math.floor(elapsed / 60000);
  const hours = Math.floor(minutes / 60);
  const duration = hours > 0
    ? t('time.hoursMinutesShort', { hours, minutes: minutes % 60 })
    : t('time.minutesShort', { minutes });
  return t('time.elapsed', { duration });
}

/** Returns the accent border color class for an activity type */
export function getActivityAccentClass(type: Activity['type']): string {
  switch (type) {
    case 'playing': return 'border-l-accent-mint';
    case 'listening': return 'border-l-accent-sky';
    case 'watching': return 'border-l-accent-lavender';
    case 'streaming': return 'border-l-accent-rose';
    default: return '';
  }
}

/** Returns whether an activity should get the glass card row treatment */
export function hasRichActivity(activities: Activity[]): boolean {
  const primary = getPrimaryActivity(activities);
  return !!primary && primary.type !== 'custom';
}

/**
 * Renders activity details (app name + elapsed time, or music info, or dual status).
 * The glass card wrapper is applied by the parent row container.
 */
export function ActivityCard({ activities, fallbackCustomStatus }: ActivityCardProps) {
  useEmojiShortcodeNames();
  const { t } = useTranslation('common');

  const music = activities.find((a) => a.type === 'listening');
  const processActivity =
    activities.find((a) => a.type === 'streaming') ||
    activities.find((a) => a.type === 'playing') ||
    activities.find((a) => a.type === 'watching');
  const custom = activities.find((a) => a.type === 'custom');

  // No process or music activity
  if (!processActivity && !music) {
    const rawStatus = custom?.name || fallbackCustomStatus;
    if (rawStatus) {
      const statusText = replaceEmojiShortcodes(rawStatus);
      return <div className="text-[11px] leading-[1.3] text-txt-tertiary truncate" title={statusText}>{statusText}</div>;
    }
    return null;
  }

  // Dual activity: Gaming/Streaming + Music
  if (processActivity && music) {
    const musicLine = `${music.name}${music.details ? ` · ${music.details}` : ''}`;
    return (
      <>
        <div className="text-[11px] leading-[1.3] text-txt-secondary truncate" title={processActivity.name}>
          {processActivity.name}
        </div>
        <div
          className="text-[10px] leading-[1.3] text-accent-sky truncate flex items-center gap-1"
          title={musicLine}
        >
          <span className="text-[9px]">🎵</span>
          <span className="truncate">{musicLine}</span>
        </div>
      </>
    );
  }

  // Music only
  if (music) {
    const musicLine = `${music.name}${music.details ? ` · ${music.details}` : ''}`;
    return (
      <>
        <div className="text-[11px] leading-[1.3] text-txt-secondary truncate flex items-center gap-1" title={musicLine}>
          <span className="text-accent-sky text-[10px]">🎵</span>
          <span className="truncate">{musicLine}</span>
        </div>
        {music.timestamps?.start ? (
          <div className="text-[10px] leading-[1.3] text-txt-tertiary">
            {formatElapsed(music.timestamps.start, t)}
          </div>
        ) : music.assets?.smallText ? (
          <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate">
            {music.assets.smallText}
          </div>
        ) : null}
      </>
    );
  }

  // Process only (Playing / Streaming / Watching)
  return (
    <>
      <div className="text-[11px] leading-[1.3] text-txt-secondary truncate" title={processActivity!.name}>
        {processActivity!.name}
      </div>
      {processActivity!.timestamps?.start && (
        <div className="text-[10px] leading-[1.3] text-txt-tertiary">
          {formatElapsed(processActivity!.timestamps.start, t)}
        </div>
      )}
    </>
  );
}
