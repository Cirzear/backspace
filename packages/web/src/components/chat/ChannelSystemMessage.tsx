import type { MessageWithUser, User } from '@backspace/shared';
import { parseChannelSystemEvent } from '@backspace/shared/src/channelSystemEvents';
import React from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useSpaceStore } from '../../stores/spaceStore';
import { spaceMemberName } from '../../utils/identity';
import { useCanonicalUserView } from '../../utils/userViewLookup';

interface ChannelSystemMessageProps {
  message: MessageWithUser;
}

/** Stands in for the roster row's user when the target is not in the roster; its name is never shown. */
const NO_USER = { id: '', username: '', createdAt: 0, isAdmin: false, replicatedInstances: [] } as unknown as User;

/**
 * Timeline row for a space channel system message (`channelSystemEvents.ts`).
 *
 * Supported events:
 * - channel_poke: displays poke notification between two members.
 * - member_join: displays welcome message when a user joins the space,
 *   supporting default localized copy or custom welcome template with {username} placeholder.
 */
export function ChannelSystemMessage({ message }: ChannelSystemMessageProps) {
  const { t } = useTranslation(['chat', 'dm']);
  const origin = useSpaceStore((s) => s.channelOriginMap.get(message.channelId) ?? '');
  const members = useSpaceStore((s) => s.members);
  const event = parseChannelSystemEvent(message.content);

  // message.userId and targetUserId are ids on the space's instance, the ids
  // its roster carries.
  const actorMember = members.find((m) => m.userId === message.userId);
  const targetMember = event && 'targetUserId' in event ? members.find((m) => m.userId === event.targetUserId) : undefined;
  const actorUser = useCanonicalUserView(message.user, origin);
  const targetUser = useCanonicalUserView(targetMember?.user ?? NO_USER, origin);

  if (event?.event === 'channel_poke') {
    const text = t('chat:poke.received', {
      actor: spaceMemberName(actorMember, actorUser),
      target: targetMember ? spaceMemberName(targetMember, targetUser) : event.targetDisplayName,
    });
    return (
      <div className="flex items-center justify-center py-1 px-4 select-none">
        <span className="text-xs text-txt-tertiary">{text}</span>
      </div>
    );
  }

  if (event?.event === 'member_join') {
    const name = actorMember ? spaceMemberName(actorMember, actorUser) : event.displayName;

    let content: React.ReactNode;
    if (event.customMessage) {
      if (event.customMessage.includes('{username}') || event.customMessage.includes('{user}')) {
        const parts = event.customMessage.split(/(\{username\}|\{user\})/g);
        content = (
          <span>
            {parts.map((part, i) =>
              part === '{username}' || part === '{user}' ? (
                <span key={i} className="font-semibold text-txt-primary">
                  {name}
                </span>
              ) : (
                <span key={i}>{part}</span>
              ),
            )}
          </span>
        );
      } else {
        content = (
          <span>
            <Trans
              t={t}
              i18nKey="chat:welcome.joined"
              values={{ name }}
              components={{
                name: <span className="font-semibold text-txt-primary" />,
              }}
            />{' '}
            — {event.customMessage}
          </span>
        );
      }
    } else {
      content = (
        <Trans
          t={t}
          i18nKey="chat:welcome.joined"
          values={{ name }}
          components={{
            name: <span className="font-semibold text-txt-primary" />,
          }}
        />
      );
    }

    return (
      <div className="flex items-center gap-2.5 py-1 px-4 select-none group">
        <div className="flex items-center justify-center w-5 h-5 rounded-full bg-accent-mint/15 text-accent-mint flex-shrink-0">
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
          </svg>
        </div>
        <div className="text-xs text-txt-secondary leading-normal">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center py-1 px-4 select-none">
      <span className="text-xs text-txt-tertiary">{t('dm:system.generic')}</span>
    </div>
  );
}
