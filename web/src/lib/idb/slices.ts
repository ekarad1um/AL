import { getDB, STORE_SLICES, type SliceRecord } from './db';

// Typed CRUD over the `slices` object store.  Slices are keyed by
// `id` (uuid); the Slice action appends N rows per click, never
// replaces.  Two indexes power the reads:
//
//   `by-workspace`           -- workspace-delete cleanup (bulk drop).
//   `by-workspace-category`  -- per-category listing for SlicePane.
//
// Helpers are flat (no class) since they're stateless; the
// consumer awaits the shared `getDB()` promise.

function byCreatedAsc(a: SliceRecord, b: SliceRecord): number {
  if (a.created_at === b.created_at) return 0;
  return a.created_at < b.created_at ? -1 : 1;
}

// Per-category listing for the SlicePane.  Sorted by `created_at`
// ascending so the operator sees slices in the order they produced
// them; a future filter (B.5 quality flags) can layer on top.
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

export async function getSlice(id: string): Promise<SliceRecord | undefined> {
  const db = await getDB();
  return db.get(STORE_SLICES, id);
}

export async function putSlice(record: SliceRecord): Promise<void> {
  const db = await getDB();
  await db.put(STORE_SLICES, record);
}

// Bulk-put N slice records in a single transaction.  Used by
// `slices.refresh()` to persist the synthesised server-only rows
// produced by daemon category sync.  On cache-cleared / first-
// visit sessions a category with N committed slices on the
// daemon produces N synthetic rows -- the prior sequential
// `for ... await putSlice(synthetic)` loop opened N transactions
// (each ~3-5 ms on a typical IDB backend), so a 200-slice
// category cost ~600-1000 ms of IDB time during reconcile.  One
// transaction over N puts collapses that to a single round-trip
// + N writes inside the same tx, ~30-50 ms even at the worst-
// case cap.  Failures (e.g. quota exhaustion) reject the whole
// transaction -- the caller's catch swallows it, which is the
// same observable behaviour as the old per-record `.catch(()
// => undefined)` (a failed put left the in-memory list
// authoritative until the next refresh).
export async function bulkPutSlices(records: readonly SliceRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(STORE_SLICES, 'readwrite');
  // `tx.store.put` returns a promise that resolves on the put's
  // success event; awaiting each one in sequence is fine because
  // IDB serialises writes inside a single tx anyway -- the
  // benefit here is the shared transaction lifetime + commit,
  // not per-put parallelism (which IDB doesn't offer).  An
  // alternative `Promise.all(records.map(r => tx.store.put(r)))`
  // would work but reads less obviously; the sequential `for`
  // matches the original loop's shape and lets a transaction
  // abort propagate cleanly via `tx.done`.
  for (const record of records) {
    void tx.store.put(record);
  }
  await tx.done;
}

export async function deleteSlice(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_SLICES, id);
}

// Bulk delete every slice in `(workspace_id, category_name)`.
// Called when a category itself is deleted -- the slices on disk
// (server-side) are wiped via the daemon's DatasetDelete; this
// scrubs the local IDB cache in lock-step.  Single transaction so
// half-deletes don't surface to renderers reading the slice list.
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

// Bulk delete every slice belonging to a workspace.  Called from
// the workspace-delete cleanup path so an operator who creates
// then drops 100 workspaces doesn't accumulate orphan slice rows
// (each carrying a ~88 KB WAV blob) in IDB.
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
