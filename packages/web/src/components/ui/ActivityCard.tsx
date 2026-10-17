import type { Activity } from '@backspace/shared';
import { getPrimaryActivity } from '@backspace/shared/src/activities.js';
import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { replaceEmojiShortcodes, useEmojiShortcodeNames } from '../../utils/emojiShortcodes';
import { useFormatters } from '../../i18n/formatters';

interface ActivityCardProps {
  activities: Activity[];
  fallbackCustomStatus?: string | null;
}

/**
 * Only remote http(s) art is ever rendered. Activity data comes from other
 * users (or the local IPC push), so anything that is not a plain web URL —
 * data:/javascript:/relative paths — is dropped rather than trusted.
 */
export function isRenderableActivityImage(url: string | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** A ticking "now", re-rendering every second while `active`. */
function useNowTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/**
 * The activity time line: a countdown while the activity has a future end
 * ("2:14 left"), otherwise the elapsed time since start. Durations go
 * through the i18n formatters so digits follow the selected locale.
 */
export function activityTimeText(
  timestamps: { start?: number; end?: number },
  now: number,
  t: TFunction<'common'>,
  formatDuration: (elapsedSeconds: number) => string,
): string | null {
  const { start, end } = timestamps;
  if (typeof end === 'number' && end > now) {
    return t('time.left', { duration: formatDuration((end - now) / 1000) });
  }
  if (typeof start === 'number' && start <= now) {
    return t('time.elapsed', { duration: formatDuration((now - start) / 1000) });
  }
  return null;
}

/** Activity art with a title tooltip that disappears when the image fails. */
function ActivityArt({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={src} alt={alt ?? ''} title={alt} className={className} onError={() => setFailed(true)} loading="lazy" />;
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
 * Renders the rich activity: art (large image with a small badge), app name,
 * details/state lines and a live elapsed/countdown time line.
 * The glass card wrapper is applied by the parent row container.
 */
export function ActivityCard({ activities, fallbackCustomStatus }: ActivityCardProps) {
  useEmojiShortcodeNames();
  const { t } = useTranslation('common');
  const { formatDuration } = useFormatters();
  const primary = getPrimaryActivity(activities);

  // Hooks stay above the early returns below (Rules of Hooks)
  const hasTimer = !!primary && primary.type !== 'custom' &&
    (typeof primary.timestamps?.start === 'number' || typeof primary.timestamps?.end === 'number');
  const now = useNowTick(hasTimer);

  if (!primary) {
    if (fallbackCustomStatus) {
      return <div className="text-[11px] leading-[1.3] text-txt-tertiary truncate">{replaceEmojiShortcodes(fallbackCustomStatus)}</div>;
    }
    return null;
  }

  // Custom status — plain text, no card treatment
  if (primary.type === 'custom') {
    return <div className="text-[11px] leading-[1.3] text-txt-tertiary truncate">{replaceEmojiShortcodes(primary.name)}</div>;
  }

  const assets = primary.assets;
  const largeImage = isRenderableActivityImage(assets?.largeImage) ? assets.largeImage : null;
  const smallImage = isRenderableActivityImage(assets?.smallImage) ? assets.smallImage : null;
  const timeText = activityTimeText(primary.timestamps ?? {}, now, t, formatDuration);

  // Rich activity — art, name, details/state and time (card wrapper is on the parent row)
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {(largeImage || smallImage) && (
        <div className="relative shrink-0 w-9 h-9">
          {largeImage && (
            <ActivityArt
              src={largeImage}
              alt={assets?.largeText || primary.name}
              className="w-9 h-9 rounded-md object-cover"
            />
          )}
          {smallImage && (
            <ActivityArt
              src={smallImage}
              alt={assets?.smallText}
              className={largeImage
                ? 'absolute -bottom-1 -right-1 w-4 h-4 rounded-full object-cover ring-2 ring-white'
                : 'w-9 h-9 rounded-md object-cover'}
            />
          )}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] leading-[1.3] text-txt-secondary truncate">
          {primary.name}
        </div>
        {primary.details && (
          <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate">
            {replaceEmojiShortcodes(primary.details)}
          </div>
        )}
        {primary.state && (
          <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate">
            {replaceEmojiShortcodes(primary.state)}
          </div>
        )}
        {timeText && (
          <div className="text-[10px] leading-[1.3] text-txt-tertiary tabular-nums">
            {timeText}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The profile popout's activity card: the full rich presence view. Shows the
 * headline, the details/state lines, a live elapsed/countdown time line and
 * the asset images — the large image with the small badge overlay — when the
 * push carried them. Art is rendered only for remote http(s) URLs and each
 * image hides itself when it fails to load, matching the row treatment.
 */
export function ActivityDetailCard({ activities }: { activities: Activity[] }) {
  useEmojiShortcodeNames();
  const { t } = useTranslation('common');
  const { formatDuration } = useFormatters();
  const primary = getPrimaryActivity(activities);

  // Hooks stay above the early returns below (Rules of Hooks)
  const hasTimer = !!primary && primary.type !== 'custom' &&
    (typeof primary.timestamps?.start === 'number' || typeof primary.timestamps?.end === 'number');
  const now = useNowTick(hasTimer);

  if (!primary || primary.type === 'custom') return null;

  // The RPC wire format has no app name, so a push can arrive without one;
  // its details then stand in as the headline.
  const headline = primary.name || primary.details;
  if (!headline) return null;

  const assets = primary.assets;
  const largeImage = isRenderableActivityImage(assets?.largeImage) ? assets.largeImage : null;
  const smallImage = isRenderableActivityImage(assets?.smallImage) ? assets.smallImage : null;
  const timeText = activityTimeText(primary.timestamps ?? {}, now, t, formatDuration);

  return (
    <div className="flex gap-3 items-start">
      {(largeImage || smallImage) && (
        <div className="relative shrink-0 w-[60px] h-[60px]">
          {largeImage && (
            <ActivityArt
              src={largeImage}
              alt={assets?.largeText || headline}
              className="w-[60px] h-[60px] rounded-[10px] object-cover bg-white/[0.04]"
            />
          )}
          {smallImage && (
            <ActivityArt
              src={smallImage}
              alt={assets?.smallText}
              className={largeImage
                ? 'absolute -bottom-1.5 -right-1.5 w-[22px] h-[22px] rounded-full object-cover bg-[#13131a] ring-2 ring-[rgba(20,20,26,0.85)]'
                : 'w-[60px] h-[60px] rounded-[10px] object-cover bg-white/[0.04]'}
            />
          )}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium leading-[1.3] text-txt-primary truncate">
          {replaceEmojiShortcodes(headline)}
        </div>
        {primary.details && primary.name && (
          <div className="text-[12px] leading-[1.3] text-txt-secondary truncate">
            {replaceEmojiShortcodes(primary.details)}
          </div>
        )}
        {primary.state && (
          <div className="text-[12px] leading-[1.3] text-txt-secondary truncate">
            {replaceEmojiShortcodes(primary.state)}
          </div>
        )}
        {timeText && (
          <div className="text-[11px] leading-[1.3] text-txt-tertiary tabular-nums">
            {timeText}
          </div>
        )}
      </div>
    </div>
  );
}
