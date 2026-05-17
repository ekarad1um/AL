import { getDB, STORE_SLICES, type SliceKey, type SliceRecord } from './db';

// Typed CRUD over the `slices` object store.
//
// Primary key: composite tuple `[workspace_id, category_name, id]`
// where `id` is the WAV bytes' sha256 hex.  Same content can
// coexist in two categories; the composite key keeps the rows
// disjoint while a same-(workspace,category) duplicate (operator
// re-records byte-identical audio) deduplicates by overwrite.
//
// Two indexes:
//   `by-workspace`           -- workspace-delete cleanup
//   `by-workspace-category`  -- per-category listing for SlicePane

function byCreatedAsc(a: SliceRecord, b: SliceRecord): number {
  if (a.created_at === b.created_at) return 0;
  return a.created_at < b.created_at ? -1 : 1;
}

// Tuple constructor centralised so the slices store doesn't
// repeat the destructuring at every callsite.
export function sliceKey(record: SliceRecord): SliceKey {
  return [record.workspace_id, record.category_name, record.id];
}

export async function listSlicesForCategory(
  workspaceId: string,
  categoryName: string
): Promise<SliceRecord[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex(
    STORE_SLICES,
    'by-workspace-category',
    IDBKeyRange.only([workspaceId, categoryName])
  );
  return rows.sort(byCreatedAsc);
}

export async function putSlice(record: SliceRecord): Promise<void> {
  const db = await getDB();
  await db.put(STORE_SLICES, record);
}

export async function bulkPutSlices(records: readonly SliceRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(STORE_SLICES, 'readwrite');
  // `Promise.all([...puts, tx.done])` is the idb-library
  // canonical pattern: it subscribes to every per-put promise
  // AND to `tx.done`, so a put that fails (which also aborts
  // the tx) surfaces as a Promise.all rejection without
  // leaving any per-op promise observably-unrejected.  The
  // earlier `void tx.store.put(...)` discarded each per-op
  // promise and emitted a browser unhandled-rejection warning
  // alongside `tx.done`'s rejection on every tx abort.
  await Promise.all([...records.map((r) => tx.store.put(r)), tx.done]);
}

export async function bulkDeleteSlices(keys: readonly SliceKey[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(STORE_SLICES, 'readwrite');
  await Promise.all([...keys.map((k) => tx.store.delete(k)), tx.done]);
}

export async function deleteSlice(
  workspaceId: string,
  categoryName: string,
  id: string
): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_SLICES, [workspaceId, categoryName, id]);
}

export async function deleteSlicesForCategory(
  workspaceId: string,
  categoryName: string
): Promise<number> {
  const db = await getDB();
  const tx = db.transaction(STORE_SLICES, 'readwrite');
  const index = tx.store.index('by-workspace-category');
  let deleted = 0;
  let cursor = await index.openCursor(IDBKeyRange.only([workspaceId, categoryName]));
  while (cursor) {
    await cursor.delete();
    deleted++;
    cursor = await cursor.continue();
  }
  await tx.done;
  return deleted;
}

export async function deleteSlicesForWorkspace(workspaceId: string): Promise<number> {
  const db = await getDB();
  const tx = db.transaction(STORE_SLICES, 'readwrite');
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
