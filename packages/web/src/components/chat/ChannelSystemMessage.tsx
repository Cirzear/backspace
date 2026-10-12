import type { MessageWithUser, User } from '@backspace/shared';
import { parseChannelSystemEvent } from '@backspace/shared/src/channelSystemEvents';
import { useTranslation } from 'react-i18next';
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
 * The people it names are named the way the rest of the space names them,
 * through `spaceMemberName` on the space's roster, so a member with a
 * nickname has one name on the screen. The target's stored name is used only
 * when the target is not in the roster. Content this version does not know
 * renders the generic label, never the content.
 */
export function ChannelSystemMessage({ message }: ChannelSystemMessageProps) {
  const { t } = useTranslation(['chat', 'dm']);
  const origin = useSpaceStore((s) => s.channelOriginMap.get(message.channelId) ?? '');
  const members = useSpaceStore((s) => s.members);
  const event = parseChannelSystemEvent(message.content);

  // message.userId and targetUserId are ids on the space's instance, the ids
  // its roster carries.
  const actorMember = members.find((m) => m.userId === message.userId);
  const targetMember = event ? members.find((m) => m.userId === event.targetUserId) : undefined;
  const actorUser = useCanonicalUserView(message.user, origin);
  const targetUser = useCanonicalUserView(targetMember?.user ?? NO_USER, origin);

  let text: string;
  if (event?.event === 'channel_poke') {
    text = t('chat:poke.received', {
      actor: spaceMemberName(actorMember, actorUser),
      target: targetMember ? spaceMemberName(targetMember, targetUser) : event.targetDisplayName,
    });
  } else {
    text = t('dm:system.generic');
  }

  return (
    <div className="flex items-center justify-center py-1 px-4 select-none">
      <span className="text-xs text-txt-tertiary">{text}</span>
    </div>
  );
}
