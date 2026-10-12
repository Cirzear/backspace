import type { MessageWithUser } from '@backspace/shared';
import { parseChannelSystemEvent } from '@backspace/shared/src/channelSystemEvents';
import { useAuthStore, selectMyChosenStatus, getMyUserIdForOrigin } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { getChannelOrigin } from '../../stores/spaceStore';
import { getChannelNotificationPolicy } from '../../hooks/useNotificationSettings';

/** Plays the poke cue for a `channel_poke` row from `origin`, for a viewer of its channel. */
export function receiveChannelPoke(origin: string, message: MessageWithUser): void {
  const event = parseChannelSystemEvent(message.content);
  if (event?.event !== 'channel_poke') return;
  const channelId = useChatStore.getState().currentChannelId;
  const inChannel = channelId === message.channelId && getChannelOrigin(channelId) === origin;
  if (!inChannel) return;
  if (message.userId !== getMyUserIdForOrigin(origin)) {
    if (selectMyChosenStatus(useAuthStore.getState()) === 'dnd') return;
    const policy = getChannelNotificationPolicy(message.channelId);
    if (policy.muted || policy.level === 'nothing') return;
  }
  // The timeline already confirms the poke; only animate here, without a duplicate toast.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const avatars = document.querySelectorAll<HTMLElement>('[data-poke-user]');
  const avatar = Array.from(avatars).reverse().find(el => el.dataset.pokeUser === event.targetUserId);
  if (!avatar) return;
  avatar.animate([
    { transform: 'rotate(0deg)' }, { transform: 'rotate(-12deg) scale(0.94)' },
    { transform: 'rotate(10deg)' }, { transform: 'rotate(-6deg)' }, { transform: 'rotate(0deg)' },
  ], { duration: 550 });
  const finger = document.createElement('span');
  finger.textContent = '👈';
  finger.setAttribute('aria-hidden', 'true');
  finger.className = 'absolute -right-5 top-1 text-2xl pointer-events-none z-10';
  avatar.append(finger);
  const animation = finger.animate([{ transform: 'translateX(14px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1, offset: 0.4 }, { transform: 'translateX(14px)', opacity: 0 }], { duration: 650 });
  animation.onfinish = () => finger.remove();
}
