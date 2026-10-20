import React, { useEffect, useState } from 'react';
import type { Activity } from '@backspace/shared';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { replaceEmojiShortcodes } from '../../utils/emojiShortcodes';
import { AppIcon } from './AppIcon';

interface ProfileActivitiesProps {
  activities: Activity[];
  skipCustom?: boolean;
}

function formatElapsed(startMs: number, t: TFunction<any, any>): string {
  const elapsed = Date.now() - startMs;
  const minutes = Math.floor(elapsed / 60000);
  const hours = Math.floor(minutes / 60);
  const duration = hours > 0
    ? t('common:time.hoursMinutesShort', { hours, minutes: minutes % 60 })
    : t('common:time.minutesShort', { minutes });
  return t('common:time.elapsed', { duration });
}

export function formatPlayerName(player: string | undefined, t: TFunction<any, any>): string {
  if (!player) return '';
  const key = player.toLowerCase().replace(/[\s\-_.]+/g, '');
  if (key === 'cloudmusic' || key === '网易云音乐' || key === 'neteasecloudmusic') {
    return t('social:activity.players.cloudmusic', { defaultValue: 'NetEase Cloud Music' });
  }
  if (key === 'qqmusic' || key === 'qq音乐') {
    return t('social:activity.players.qqmusic', { defaultValue: 'QQ Music' });
  }
  if (key === 'kugou' || key === '酷狗音乐' || key === 'kugoumusic') {
    return t('social:activity.players.kugou', { defaultValue: 'KuGou' });
  }
  if (key === 'kuwo' || key === 'kwmusic' || key === '酷我音乐' || key === 'kuwomusic') {
    return t('social:activity.players.kuwo', { defaultValue: 'Kuwo' });
  }
  if (key === 'spotify') {
    return t('social:activity.players.spotify', { defaultValue: 'Spotify' });
  }
  if (key === 'applemusic' || key === 'apple') {
    return t('social:activity.players.applemusic', { defaultValue: 'Apple Music' });
  }
  if (key === 'yandexmusic' || key === 'яндексмузыка') {
    return t('social:activity.players.yandexmusic', { defaultValue: 'Yandex Music' });
  }
  return player;
}

function formatSeconds(totalSeconds: number): string {
  const m = Math.floor(Math.max(0, totalSeconds) / 60);
  const s = Math.floor(Math.max(0, totalSeconds) % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function MusicProgress({ start, end }: { start: number; end: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const total = Math.max(1, end - start);
  const elapsed = Math.min(total, Math.max(0, now - start));
  const percent = Math.min(100, Math.max(0, (elapsed / total) * 100));

  return (
    <div className="mt-2.5">
      <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-accent-sky rounded-full transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-txt-tertiary mt-1 font-mono">
        <span>{formatSeconds(elapsed / 1000)}</span>
        <span>{formatSeconds(total / 1000)}</span>
      </div>
    </div>
  );
}

function MusicCard({ activity }: { activity: Activity }) {
  const { t } = useTranslation(['social', 'common']);
  const player = formatPlayerName(activity.assets?.smallText, t);
  const hasCover = !!activity.assets?.largeImage && activity.assets.largeImage.startsWith('https://');

  return (
    <div className="rounded-lg p-3 bg-accent-sky/[0.08] border border-accent-sky/20 mb-2.5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-accent-sky">
          <span>🎵</span>
          <span>{t('social:activity.types.listening', { defaultValue: 'Listening to Music' })}</span>
        </div>
        {player && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-sky/20 text-accent-sky font-medium">
            {player}
          </span>
        )}
      </div>

      <div className="flex gap-3 items-center">
        {hasCover ? (
          <img
            src={activity.assets!.largeImage}
            alt=""
            className="w-12 h-12 rounded object-cover flex-shrink-0 shadow-sm"
          />
        ) : (
          <div className="w-12 h-12 rounded bg-accent-sky/20 flex items-center justify-center text-accent-sky flex-shrink-0 shadow-sm">
            <AppIcon name={activity.assets?.smallText || activity.name} type="listening" size={24} fallbackEmoji="🎵" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-txt-primary truncate" title={activity.name}>
            {activity.name}
          </div>
          {activity.details && (
            <div className="text-[12px] text-txt-secondary truncate" title={activity.details}>
              {activity.details}
            </div>
          )}
          {activity.state && (
            <div className="text-[11px] text-txt-tertiary truncate" title={activity.state}>
              {activity.state}
            </div>
          )}
        </div>
      </div>

      {activity.timestamps?.start && activity.timestamps?.end && (
        <MusicProgress start={activity.timestamps.start} end={activity.timestamps.end} />
      )}

      {activity.timestamps?.start && !activity.timestamps?.end && (
        <div className="text-[10px] text-txt-tertiary mt-2">
          {formatElapsed(activity.timestamps.start, t)}
        </div>
      )}

      {activity.url && (
        <a
          href={activity.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-accent-sky hover:underline mt-2 font-medium"
        >
          <span>{t('social:activity.openTrack', { defaultValue: 'Open Track' })}</span>
          <span>↗</span>
        </a>
      )}
    </div>
  );
}

function ProcessCard({
  activity,
  accentClass,
  headerText,
  icon,
}: {
  activity: Activity;
  accentClass: string;
  headerText: string;
  icon: string;
}) {
  const { t } = useTranslation(['social', 'common']);
  const hasCover = !!activity.assets?.largeImage && activity.assets.largeImage.startsWith('https://');

  return (
    <div className={`rounded-lg p-3 ${accentClass} mb-2.5`}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider mb-2">
        <span>{icon}</span>
        <span>{headerText}</span>
      </div>
      <div className="flex gap-2.5 items-center">
        {hasCover ? (
          <img
            src={activity.assets!.largeImage}
            alt=""
            className="w-10 h-10 rounded object-cover flex-shrink-0 shadow-sm"
          />
        ) : (
          <div className="w-9 h-9 rounded bg-white/10 flex items-center justify-center flex-shrink-0 shadow-sm">
            <AppIcon name={activity.name} type={activity.type} size={20} fallbackEmoji={icon} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-txt-primary truncate" title={activity.name}>
            {activity.name}
          </div>
          {activity.details && (
            <div className="text-[12px] text-txt-secondary truncate mt-0.5" title={activity.details}>
              {activity.details}
            </div>
          )}
          {activity.timestamps?.start && (
            <div className="text-[10px] text-txt-tertiary mt-1">
              {formatElapsed(activity.timestamps.start, t)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const ACTIVITY_PRIORITY: Record<string, number> = {
  streaming: 5,
  playing: 4,
  watching: 3,
  listening: 2,
  custom: 1,
};

export function ProfileActivities({ activities, skipCustom }: ProfileActivitiesProps) {
  const { t } = useTranslation(['social', 'common']);
  if (!activities || activities.length === 0) return null;

  const custom = !skipCustom ? activities.find((a) => a.type === 'custom') : null;
  const nonCustom = activities
    .filter((a) => a.type !== 'custom')
    .sort((a, b) => (ACTIVITY_PRIORITY[b.type] ?? 0) - (ACTIVITY_PRIORITY[a.type] ?? 0));

  return (
    <div className="mt-3">
      {custom && (
        <div className="text-[13px] text-txt-secondary italic mb-2">
          {replaceEmojiShortcodes(custom.name)}
        </div>
      )}

      {nonCustom.map((activity, index) => {
        const key = `${activity.type}-${activity.name}-${index}`;
        if (activity.type === 'listening') {
          return <MusicCard key={key} activity={activity} />;
        }
        if (activity.type === 'streaming') {
          return (
            <ProcessCard
              key={key}
              activity={activity}
              accentClass="bg-accent-rose/[0.08] border border-accent-rose/20 text-accent-rose"
              headerText={t('social:activity.types.streaming', { defaultValue: 'Streaming' })}
              icon="🔴"
            />
          );
        }
        if (activity.type === 'playing') {
          return (
            <ProcessCard
              key={key}
              activity={activity}
              accentClass="bg-accent-mint/[0.08] border border-accent-mint/20 text-accent-mint"
              headerText={t('social:activity.types.playing', { defaultValue: 'Playing a Game' })}
              icon="🎮"
            />
          );
        }
        if (activity.type === 'watching') {
          return (
            <ProcessCard
              key={key}
              activity={activity}
              accentClass="bg-accent-lavender/[0.08] border border-accent-lavender/20 text-accent-lavender"
              headerText={t('social:activity.types.watching', { defaultValue: 'Watching' })}
              icon="📺"
            />
          );
        }
        return null;
      })}
    </div>
  );
}
