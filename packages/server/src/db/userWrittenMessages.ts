import { eq, type SQL } from 'drizzle-orm';
import { messages } from './schema.js';

/**
 * The space channel messages members wrote (`messages.type = 'user'`), as
 * opposed to the system rows the hosting instance writes, of which a poke is
 * the only one so far. A system row is passive: it does not count as unread
 * or move a channel's last message id (so it never makes a channel unread),
 * it does not match a search, and nobody can reply to it (websocket.md,
 * "Channel pokes"). Every one of those queries takes this condition, so they
 * cannot disagree about what a system row is.
 *
 * DM system messages are a different table and count like any other DM
 * message.
 */
export function userWrittenMessages(): SQL {
  return eq(messages.type, 'user');
}
