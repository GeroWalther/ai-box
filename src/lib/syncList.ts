// Shared shape for conflict-free list sync (documents, chat sessions). Each item
// is keyed by `id` and carries an `updatedAt` timestamp; deletes are tracked as
// tombstones so they aren't resurrected. The actual merge (last-writer-wins by
// updatedAt + tombstones) happens on the Mac in `store_merge_list`; this file just
// holds the types and a defensive parser for the stored payload.

export interface SyncItem {
  id: string;
  updatedAt?: number;
}

export interface SyncList<T> {
  items: T[];
  deleted: Record<string, number>;
}

/** Parse a stored payload string into {items, deleted}. Accepts the new object
 *  shape, a legacy bare array, or null/garbage (→ empty). */
export function parseSyncList<T extends SyncItem>(raw: string | null): SyncList<T> {
  if (!raw) return { items: [], deleted: {} };
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return { items: v as T[], deleted: {} };
    if (v && typeof v === "object") {
      return {
        items: Array.isArray(v.items) ? (v.items as T[]) : [],
        deleted:
          v.deleted && typeof v.deleted === "object"
            ? (v.deleted as Record<string, number>)
            : {},
      };
    }
  } catch {
    /* ignore corrupt payload */
  }
  return { items: [], deleted: {} };
}
