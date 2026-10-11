# Composer mention display

The draft keeps the wire format: a mention is a `<@id>` token, and that is what is saved per channel, sent and counted against the length limit. The textarea shows each token whose id the channel knows as `@name`, painted by a mirror behind a transparent native textarea (`MentionTextarea`), so composition, selection, paste and the placeholder stay native.

- Tokens are cut by the shared scan in `utils/mentionTokens.ts`, so a token inside code stays text, as it does in the sent message. Only `<@id>` is a mention; there are no role or everyone mentions on the wire, and the composer paints none.
- A token is named through `useChannelUserResolver` (`utils/channelUser.ts`), the same roster and user view `MentionBadge` reads. A DM's tokens are read in its origin's id space, the signed-in user included. An id the channel does not know is shown as written.
- An edit or selection that touches a shown mention replaces the whole token, so no partial id is left behind. Typed or pasted `@name` text is text, not a mention; mentions are made with the picker.
- Enter during an IME composition neither sends nor picks a suggestion.
- The desktop picker is anchored at the typed `@` (a marker in the mirror) and re-measures it after every render (`useFloatingPosition`'s `followAnchor`).

Editing a sent message uses its own textarea in `Message.tsx`, which still shows the raw tokens.
