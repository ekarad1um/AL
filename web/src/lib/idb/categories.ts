import { getDB, STORE_CATEGORIES, type CategoryRecord } from './db';

// Typed CRUD over the `categories` IDB object store.  Helpers stay
// flat (no class) because they're stateless; the consumer awaits
// the shared `getDB()` promise.
//
// The store holds operator-added categories that haven't been
// materialised on the daemon yet (no slice has been uploaded, so
// the directory doesn't exist server-side).  Once a slice uploads
// and the daemon's `GET /assets/datasets` lists the directory, the
// IDB row becomes redundant -- but we keep it as a passive copy
// (the categories store dedups by name when merging IDB + server
// sources, so no UI duplication).  An optional GC pass can remove
// redundant rows; deferred until measurement proves it matters.

function byCreatedDesc(a: CategoryRecord, b: CategoryRecord): number {
  if (a.created_at === b.created_at) return 0;
  return a.created_at < b.created_at ? 1 : -1;
}

export async function listCategoriesForWorkspace(workspaceId: string): Promise<CategoryRecord[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex(STORE_CATEGORIES, 'by-workspace', workspaceId);
  return rows.sort(byCreatedDesc);
}

export async function putCategoryRecord(entry: CategoryRecord): Promise<void> {
  const db = await getDB();
  await db.put(STORE_CATEGORIES, entry);
}

export async function deleteCategoryRecord(workspaceId: string, name: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_CATEGORIES, [workspaceId, name]);
}

// Bulk delete used when the operator removes a workspace -- IDB
// categories for that workspace must go away too so a future
// workspace with the same id (unlikely but possible) doesn't
// inherit stale rows.  Single transaction so the writes commit
// atomically.
export async function deleteCategoriesForWorkspace(workspaceId: string): Promise<number> {
  const db = await getDB();
  const tx = db.transaction(STORE_CATEGORIES, 'readwrite');
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
