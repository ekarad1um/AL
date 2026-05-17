import { getDB, STORE_WORKSPACE_SYNC, type WorkspaceSyncRecord } from './db';

// Typed CRUD over the `workspace_sync` object store.  One row
// per workspace; tracks the daemon `workspace_revision.id` we
// last successfully reconciled all categories against.  The
// slices store reads this on workspace mount to short-circuit
// Tier 2 (per-category index reconcile) when the daemon's
// current revision matches.
//
// Writes happen at the END of a successful per-workspace
// reconcile (every category's index fetch resolved + diffed +
// persisted).  A partial-failure reconcile does NOT write,
// because a stale `last_synced_revision_id` is worse than a
// missing one -- a missing one re-triggers reconcile on the
// next mount and self-heals; a stale-but-confident one would
// skip the reconcile and leave drift.

export async function getWorkspaceSync(
  workspaceId: string
): Promise<WorkspaceSyncRecord | undefined> {
  const db = await getDB();
  return db.get(STORE_WORKSPACE_SYNC, workspaceId);
}

export async function putWorkspaceSync(record: WorkspaceSyncRecord): Promise<void> {
  const db = await getDB();
  await db.put(STORE_WORKSPACE_SYNC, record);
}

// Workspace-delete cleanup.  Single row so a delete is cheap;
// kept symmetric with the `*ForWorkspace` helpers on the other
// stores so the workspace-delete chain reads as one flat list.
export async function deleteWorkspaceSync(workspaceId: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_WORKSPACE_SYNC, workspaceId);
}
