import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useChannelActivityStore, type PokeNotice as Notice } from '../../stores/channelActivityStore';
import { useSpaceStore } from '../../stores/spaceStore';

export function PokeNotices({ notices }: { notices: Notice[] | undefined }) {
  const { t } = useTranslation('chat');
  return <>{notices?.map(notice => <div key={notice.id} data-poke-notice
    className="px-5 py-2 text-center text-[12px] leading-5 text-txt-tertiary break-words">
    {t('poke.received', { actor: notice.username, target: notice.targetUsername })}
  </div>)}</>;
}

/** Keep ephemeral events between messages, without manufacturing message IDs/read cursors. */
export function usePokeTimeline({ channelId, messages, detached }: {
  channelId: string;
  messages: { id: string; createdAt: number }[];
  detached: boolean;
}) {
  const pokes = useChannelActivityStore(s => s.pokes);
  const origin = useSpaceStore(s => s.channelOriginMap.get(channelId) ?? '');
  return useMemo(() => {
    const before = new Map<string, Notice[]>();
    const tail: Notice[] = [];
    for (const notice of pokes) {
      if (notice.origin !== origin || notice.channelId !== channelId) continue;
      // Do not insert current-session events into an older, detached history window.
      const firstMessage = messages[0];
      if (detached && firstMessage && notice.createdAt < firstMessage.createdAt) continue;
      const next = messages.find(message => message.createdAt > notice.createdAt);
      if (!next) {
        if (!detached) tail.push(notice);
        continue;
      }
      before.set(next.id, [...(before.get(next.id) ?? []), notice]);
    }
    return { before, tail };
  }, [pokes, origin, channelId, messages, detached]);
}
