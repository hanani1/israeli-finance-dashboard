/**
 * Client-side ordering of the /chat conversation sidebar (card #67). Pure and
 * browser-safe (no Node imports). The server already sorts by updatedAt; this
 * keeps the list consistent when the page learns about a change before the
 * next list fetch (a new conversation, a follow-up, a finished answer).
 */
export interface ConversationListEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pending: boolean;
}

/** Most recently updated first; ties broken by id so the order is stable. */
export function sortConversations<T extends ConversationListEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    const byTime = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}

/**
 * Inserts or updates one conversation. The title is never changed once
 * known (it is the first question), and an older snapshot never overwrites a
 * newer one.
 */
export function upsertConversation<T extends ConversationListEntry>(entries: readonly T[], entry: T): T[] {
  const existing = entries.find((item) => item.id === entry.id);
  if (existing && Date.parse(existing.updatedAt) > Date.parse(entry.updatedAt)) return sortConversations(entries);
  const merged = existing ? { ...entry, title: existing.title } : entry;
  return sortConversations([...entries.filter((item) => item.id !== entry.id), merged]);
}
