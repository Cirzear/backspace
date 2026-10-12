import { splitMentions } from '../../utils/mentionTokens';

/** One run of the draft, as stored (`wire`) and as shown (`text`), with where each starts. */
interface ComposerPart {
  wire: string;
  text: string;
  /**
   * A `<@id>` or `<@&id>` token shown by name: one unit for the caret and for
   * edits. Unknown ids are shown as written and are not mentions here.
   */
  mention: boolean;
  /** Painted as a mention: a `mention` part, or `@everyone` / `@here`, which stay ordinary text to edit. */
  painted: boolean;
  start: number;
  wireStart: number;
}

/**
 * The composer's draft as the textarea shows it, and the offset maps between
 * that text and the stored draft.
 *
 * The draft keeps the wire format: a mention is a `<@id>` or `<@&id>` token,
 * cut out by the shared scan (`utils/mentionTokens.ts`), so a token inside
 * code stays text here just as it does in the sent message. A token whose id
 * `nameOf` (a user) or `roleNameOf` (a role) knows is shown as `@name`; any
 * other token is shown as written. `@everyone` and `@here` are painted where
 * the sent message shows them as mentions.
 *
 * @param nameOf The shown name of the user a token's id names in this channel,
 *   or null when the channel does not know the id.
 * @param roleNameOf The shown name of the role a token's id names in the
 *   channel's space, or null when there is none (a DM, an unknown id).
 */
export function composerMentions(
  value: string,
  nameOf: (userId: string) => string | null,
  roleNameOf: (roleId: string) => string | null = () => null,
) {
  const parts: ComposerPart[] = [];
  let wireEnd = 0;
  let displayEnd = 0;
  const append = (wire: string, text: string, mention: boolean, painted = mention): void => {
    parts.push({ wire, text, mention, painted, start: displayEnd, wireStart: wireEnd });
    wireEnd += wire.length;
    displayEnd += text.length;
  };
  for (const part of splitMentions(value)) {
    if (part.kind === 'text') {
      append(part.text, part.text, false);
      continue;
    }
    if (part.kind === 'everyone') {
      append(part.token, part.token, false, true);
      continue;
    }
    const name = part.kind === 'user' ? nameOf(part.userId) : roleNameOf(part.roleId);
    if (name === null) append(part.token, part.token, false);
    else append(part.token, '@' + name, true);
  }
  const text = parts.map((p) => p.text).join('');

  /**
   * The draft offset of shown offset `position`. A position inside a shown
   * mention maps to the token's start, or with `end` to its end, so a range
   * that touches a mention covers the whole token.
   */
  const toWire = (position: number, end = false): number => {
    const part = parts.find((p) => position >= p.start && position < p.start + p.text.length);
    if (!part) return value.length;
    const offset = position - part.start;
    if (!part.mention || offset === 0) return part.wireStart + offset;
    return end ? part.wireStart + part.wire.length : part.wireStart;
  };

  /** The shown offset of draft offset `position`; inside a token, the shown mention's start. */
  const toDisplay = (position: number): number => {
    const part = parts.find((p) => position >= p.wireStart && position < p.wireStart + p.wire.length);
    if (!part) return text.length;
    return part.start + (part.mention ? 0 : position - part.wireStart);
  };

  /**
   * The draft after shown range `start..end` is replaced by `text`. A range
   * that touches a mention replaces its whole token, so an edit never leaves
   * part of an id behind. `wireCursor` is the draft offset just after the
   * inserted text.
   */
  const replace = (change: { start: number; end: number; text: string }): { value: string; wireCursor: number } => {
    const start = toWire(change.start);
    const end = toWire(change.end, true);
    return { value: value.slice(0, start) + change.text + value.slice(end), wireCursor: start + change.text.length };
  };

  /**
   * The draft after the textarea's text became `next` with the caret at
   * `cursor`. The edit is the span between the common prefix (never past the
   * caret) and the common suffix, so typing, deleting, pasting and replacing a
   * selection all come down to one `replace`.
   */
  const update = (next: string, cursor = next.length): { value: string; wireCursor: number } => {
    let start = 0;
    while (start < text.length && start < cursor && start < next.length && text[start] === next[start]) start++;
    let end = text.length;
    let nextEnd = next.length;
    while (end > start && nextEnd > start && text[end - 1] === next[nextEnd - 1]) {
      end--;
      nextEnd--;
    }
    return replace({ start, end, text: next.slice(start, nextEnd) });
  };

  return { parts, text, toWire, toDisplay, replace, update };
}

export type ComposerMentions = ReturnType<typeof composerMentions>;
