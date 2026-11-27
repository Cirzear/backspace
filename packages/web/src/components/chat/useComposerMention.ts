import { useEffect } from 'react';
import type { RefObject } from 'react';
import { useComposerStore } from '../../stores/composerStore';
import { appendMention } from './composerMentions';

/**
 * Mentions added to a channel's composer from outside it (the message author
 * menu). The draft is the composer store's; this module only asks the mounted
 * composer of that channel to take focus once the draft holds the mention.
 */
const focusRequests = new EventTarget();
const FOCUS_REQUEST = 'focus';

/**
 * Add a mention of `userId` to the end of `channelId`'s draft and focus that
 * channel's composer with the caret after it. `userId` is the user's id on the
 * channel's origin, as the mention picker inserts it.
 */
export function insertComposerMention(channelId: string, userId: string): void {
  const store = useComposerStore.getState();
  store.setDraft(channelId, appendMention(store.get(channelId).draftText, userId));
  focusRequests.dispatchEvent(new CustomEvent<string>(FOCUS_REQUEST, { detail: channelId }));
}

/**
 * The composer side of `insertComposerMention`: focus `textareaRef` when a
 * mention was added to `channelId`, with the caret at the end of the text.
 *
 * Focus is taken at once, inside the click that chose the menu item, so a
 * phone opens its keyboard. The caret is placed on the next frame, once the
 * textarea shows the new draft (`@name`, shorter than the stored token).
 */
export function useComposerMention(channelId: string, textareaRef: RefObject<HTMLTextAreaElement>): void {
  useEffect(() => {
    let frame = 0;
    const onRequest = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail !== channelId) return;
      textareaRef.current?.focus();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      });
    };
    focusRequests.addEventListener(FOCUS_REQUEST, onRequest);
    return () => {
      focusRequests.removeEventListener(FOCUS_REQUEST, onRequest);
      cancelAnimationFrame(frame);
    };
  }, [channelId, textareaRef]);
}
