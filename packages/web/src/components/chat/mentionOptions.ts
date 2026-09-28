import type { MemberWithUser, Role } from '@backspace/shared';

export type MentionOption =
  | { kind: 'user'; token: string; member: MemberWithUser }
  | { kind: 'mass'; token: string; label: string; color?: string };

/** One candidate list drives both keyboard selection and the visible popover. */
export function mentionOptions(input: { query: string; members: MemberWithUser[]; roles: Role[]; canMentionMass: boolean }): MentionOption[] {
  const query = input.query.toLowerCase();
  const mass: MentionOption[] = input.canMentionMass ? [
    ...['everyone', 'here'].filter(name => name.includes(query)).map(name => ({ kind: 'mass' as const, token: '@' + name, label: '@' + name })),
    ...input.roles.filter(role => !role.isEveryone && role.name.toLowerCase().includes(query))
      .map(role => ({ kind: 'mass' as const, token: '<@&' + role.id + '>', label: '@' + role.name.replace(/^@/, ''), color: role.color })),
  ] : [];
  const users: MentionOption[] = input.members.filter(member =>
    (member.user.displayName ?? member.user.username).toLowerCase().includes(query) || member.user.username.toLowerCase().includes(query),
  ).map(member => ({ kind: 'user', token: '<@' + member.userId + '>', member }));
  return [...mass, ...users].slice(0, 8);
}
