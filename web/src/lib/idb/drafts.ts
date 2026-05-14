import { getDB, STORE_DRAFTS, type DraftRecord } from './db';

// Typed CRUD over the `drafts` object store.  Drafts are
// per-`(workspace_id, category_name)`, single-slot: there is at
// most one row per key, and a fresh `put` for the same key
// overwrites in place.  This matches the architecture spec's
// "Input Module retains only the most recent audio clip".
//
// Helpers are flat (no class); the consumer awaits the shared
// `getDB()` promise.

export async function getDraft(
  workspaceId: string,
  categoryName: string
): Promise<DraftRecord | undefined> {
  const db = await getDB();
  return db.get(STORE_DRAFTS, [workspaceId, categoryName]);
}

export async function putDraft(record: DraftRecord): Promise<void> {
  const db = await getDB();
  await db.put(STORE_DRAFTS, record);
}

export async function deleteDraft(workspaceId: string, categoryName: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_DRAFTS, [workspaceId, categoryName]);
}

// Bulk delete for a workspace.  Hooked into workspace deletion so
// IDB doesn't accumulate orphan drafts whose parent workspace is
// long gone -- the rows would be invisible (no UI reads them) but
// they'd consume origin quota indefinitely.  Single transaction so
// the writes commit atomically; cursor walks the `by-workspace`
// index keyed on the workspace id, deleting each match in place.
export async function deleteDraftsForWorkspace(workspaceId: string): Promise<number> {
  const db = await getDB();
  const tx = db.transaction(STORE_DRAFTS, 'readwrite');
  const index = tx.store.index('by-workspace');
  let deleted = 0;
  let cursor = await index.openCursor(IDBKeyRange.only(workspaceId));
  while (cursor) {
    await cursor.delete();
    deleted++;
    cursor = await cursor.continue();
  }
  await tx.done;
  return deleted;
}
