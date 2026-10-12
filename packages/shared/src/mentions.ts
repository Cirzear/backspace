// ─── Mention Tokens ─────────────────────────────────────────────────────────
// Wire syntax of the mentions a space message can carry, and the one scan that
// reads it. The server (which decides whether a mass mention may be stored, and
// stamps the ones it stored) and the client (which renders the tokens, paints
// them in the composer and decides whether a message alerts) both read the text
// through `splitMentions`, so they agree on what is a mention.
//
//   <@userId>   one user
//   <@&roleId>  every member holding the role
//   @everyone   every member who can see the channel
//   @here       the same audience as @everyone. Backspace has no "online
//               only" audience at alert time; each recipient's own settings
//               decide.
//
// Tokens inside inline code or fenced code blocks are not mentions.
// docs/systems/permissions.md, "Mass mentions", holds the rules.

/**
 * Code spans (fenced, then inline), a role token, a user token, or
 * `@everyone` / `@here` standing on its own (not inside a word, an address or
 * `@@everyone`, and not followed by a word character or `-`). Code spans are
 * matched first so their contents stay text. A new instance per scan, since
 * the `g` flag makes a RegExp stateful.
 */
function mentionScanner(): RegExp {
  return /(```[\s\S]*?```|`[^`]+`)|<@&([a-zA-Z0-9_-]+)>|<@([a-zA-Z0-9_-]+)>|(?<![\w@])@(everyone|here)(?![\w-])/g;
}

export type MassMentionKeyword = 'everyone' | 'here';

export type MentionPart =
  | { kind: 'text'; text: string }
  | { kind: 'user'; userId: string; token: string }
  | { kind: 'role'; roleId: string; token: string }
  | { kind: 'everyone'; keyword: MassMentionKeyword; token: string };

/**
 * `content` cut into text and mention parts, in order. Code stays inside text
 * parts exactly as written, and adjacent text is joined, so a part list read
 * back with each part's `text` or `token` gives `content` again. Empty content
 * gives an empty list.
 */
export function splitMentions(content: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let pending = '';
  let textStart = 0;
  for (const match of content.matchAll(mentionScanner())) {
    if (match[1] !== undefined) continue;
    pending += content.slice(textStart, match.index);
    if (pending) parts.push({ kind: 'text', text: pending });
    pending = '';
    const token = match[0];
    if (match[2] !== undefined) parts.push({ kind: 'role', roleId: match[2], token });
    else if (match[3] !== undefined) parts.push({ kind: 'user', userId: match[3], token });
    else parts.push({ kind: 'everyone', keyword: match[4] as MassMentionKeyword, token });
    textStart = match.index + token.length;
  }
  pending += content.slice(textStart);
  if (pending) parts.push({ kind: 'text', text: pending });
  return parts;
}

export interface ParsedMentions {
  userIds: Set<string>;
  roleIds: Set<string>;
  /** `@everyone` or `@here` outside code. */
  everyone: boolean;
}

export function parseMentions(content: string | null | undefined): ParsedMentions {
  const result: ParsedMentions = { userIds: new Set(), roleIds: new Set(), everyone: false };
  if (!content) return result;
  for (const part of splitMentions(content)) {
    if (part.kind === 'user') result.userIds.add(part.userId);
    else if (part.kind === 'role') result.roleIds.add(part.roleId);
    else if (part.kind === 'everyone') result.everyone = true;
  }
  return result;
}

/** Whether content carries a mass mention (`@everyone`, `@here` or a role), the kind gated by MENTION_EVERYONE. */
export function hasMassMention(content: string | null | undefined): boolean {
  const parsed = parseMentions(content);
  return parsed.everyone || parsed.roleIds.size > 0;
}

/**
 * Whether an edit from `before` to `after` adds a mass mention: `@everyone` /
 * `@here` where there was none, or a role token the old text did not have.
 * An edit that keeps the mass mentions a message already had is not one, so a
 * member who lost MENTION_EVERYONE, or who wrote `@everyone` before the
 * permission existed, can still correct the rest of the text.
 */
export function addsMassMention(before: string | null | undefined, after: string | null | undefined): boolean {
  const old = parseMentions(before);
  const next = parseMentions(after);
  if (next.everyone && !old.everyone) return true;
  for (const roleId of next.roleIds) {
    if (!old.roleIds.has(roleId)) return true;
  }
  return false;
}

/**
 * The mass mention fields the instance hosting a space puts on each of its
 * channel messages (`Message.mentionEveryone`, `Message.mentionRoleIds`). The
 * instance stores a new mass mention only from an author who holds
 * MENTION_EVERYONE there, so the fields say the mention is one the space
 * allows. Clients alert on mass mentions only from these fields, never from
 * the text: a space on an instance that does not check the permission sends
 * no fields, and its `@everyone` stays text there.
 */
export function massMentionFields(content: string | null | undefined): { mentionEveryone: boolean; mentionRoleIds: string[] } {
  const parsed = parseMentions(content);
  return { mentionEveryone: parsed.everyone, mentionRoleIds: [...parsed.roleIds] };
}
