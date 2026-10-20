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

/** The class sets of one artwork size: the wrapper, the large image, the badge and a lone image. */
interface ArtworkSize {
  wrapper: string;
  large: string;
  badge: string;
  single: string;
}

const POPOUT_ART: ArtworkSize = {
  wrapper: 'relative shrink-0 w-[60px] h-[60px]',
  large: 'w-[60px] h-[60px] rounded-[10px] object-cover bg-white/[0.04]',
  badge: 'absolute -bottom-1.5 -right-1.5 w-[22px] h-[22px] rounded-full object-cover bg-[#13131a] ring-2 ring-[rgba(20,20,26,0.85)]',
  single: 'w-[60px] h-[60px] rounded-[10px] object-cover bg-white/[0.04]',
};

interface ActivityArtworkProps {
  largeImage: string | null;
  smallImage: string | null;
  largeAlt: string;
  smallAlt?: string;
  size: ArtworkSize;
}

/**
 * The art of an activity: the large image with the small one as a corner badge.
 * It owns the load state of both images, so the frame never stays behind empty:
 * an image that fails to load is dropped, and a badge left without its large
 * image is promoted to the full-size image. With nothing left to show it
 * renders nothing at all.
 */
function ActivityArtwork({ largeImage, smallImage, largeAlt, smallAlt, size }: ActivityArtworkProps) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const markFailed = (src: string) => setFailed((prev) => new Set(prev).add(src));

  const large = largeImage && !failed.has(largeImage) ? largeImage : null;
  const small = smallImage && !failed.has(smallImage) ? smallImage : null;
  if (!large && !small) return null;

  return (
    <div className={size.wrapper}>
      {large && (
        <img src={large} alt={largeAlt} title={largeAlt} className={size.large} onError={() => markFailed(large)} loading="lazy" />
      )}
      {small && (
        <img
          src={small}
          alt={smallAlt ?? ''}
          title={smallAlt}
          className={large ? size.badge : size.single}
          onError={() => markFailed(small)}
          loading="lazy"
        />
      )}
    </div>
  );
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

/** How many more games the user is playing besides the one shown. */
export function otherGamesCount(activities: Activity[], primary: Activity): number {
  if (primary.type !== 'playing') return 0;
  return activities.filter((activity) => activity.type === 'playing' && activity !== primary).length;
}

function otherGameNames(activities: Activity[], primary: Activity): string {
  return activities.filter((activity) => activity.type === 'playing' && activity !== primary).map((activity) => activity.name).join(', ');
}

/** Returns whether an activity should get the glass card row treatment */
export function hasRichActivity(activities: Activity[]): boolean {
  const primary = getPrimaryActivity(activities);
  return !!primary && primary.type !== 'custom';
}

/**
 * Renders the activity as a list row: app name (with "+N" when the user is
 * playing more games), details/state lines and a live elapsed/countdown time
 * line. No art: lists stay text-only, the profile popout shows the artwork.
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

  const timeText = activityTimeText(primary.timestamps ?? {}, now, t, formatDuration);
  const moreGames = otherGamesCount(activities, primary);

  // Rich activity — text only: name (+N more games), details/state and time
  // (card wrapper is on the parent row). Art belongs to the profile view.
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1 min-w-0 text-[11px] leading-[1.3] text-txt-secondary">
          <span className="truncate">{primary.name}</span>
          {moreGames > 0 && (
            <span className="shrink-0 text-txt-tertiary tabular-nums" title={otherGameNames(activities, primary)}>+{moreGames}</span>
          )}
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
      <ActivityArtwork
        largeImage={largeImage}
        smallImage={smallImage}
        largeAlt={assets?.largeText || headline}
        smallAlt={assets?.smallText}
        size={POPOUT_ART}
      />
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
