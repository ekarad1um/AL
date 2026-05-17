import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
  bulkDeleteSlices,
  bulkPutSlices,
  deleteSlice as idbDeleteSlice,
  deleteSlicesForCategory,
  listSlicesForCategory,
  putSlice,
  sliceKey
} from '$lib/idb/slices';
import { getDB, sliceFilename, sliceIdFromFilename, STORE_SLICES } from '$lib/idb/db';
import type { SliceKey, SliceRecord } from '$lib/idb/db';
import {
  deleteWorkspaceSync,
  getWorkspaceSync,
  putWorkspaceSync
} from '$lib/idb/workspace-sync';
import { assets } from '$lib/api/endpoints';
import { enqueueDelete } from '$lib/api/delete-queue';
import { awaitJobTerminal } from '$lib/api/jobs';
import { isTransientUploadError, sleepAbortable, UploadPool, xhrPut } from '$lib/api/upload';
import { capFirst, errorCopy, isNotFound } from '$lib/utils/error-copy';
import type { AssetReceipt, Uuid } from '$lib/api/types';

// Per-target failure record returned from `deleteMany`.
export interface BulkSliceDeleteFailure {
  id: string;
  filename: string;
  error: string;
}

export interface BulkSliceDeleteOutcome {
  succeeded: number;
  failed: BulkSliceDeleteFailure[];
}

// Reactive cache over the IDB `slices` store, sliced per
// `(workspace_id, category_name)`.  Slices flow through the state
// machine `local → uploading → committed | failed` (see
// [idb/db.ts]).
//
// Content-addressed identity:
//   Slice id is the sha256 hex of the WAV bytes.  Filename is
//   derived (`<id>.wav`).  Two slices in different categories
//   with byte-identical content share an in-memory + IDB
//   cache row for spectrograms and blobs but live as
//   independent IDB rows in the slices store (composite key
//   `[workspace_id, category_name, id]`).  Within one category,
//   re-slicing identical audio deduplicates by IDB-overwrite.
//
// Three-tier sync hierarchy keyed by the workspace revision:
//
//   Tier 1 -- workspace-mount short-circuit.
//     `refreshForWorkspace` reads the persisted `workspace_sync`
//     row.  If `last_synced_revision_id === workspaceRevision`
//     AND not forced, the per-category index GETs are skipped
//     entirely -- the UI renders straight from IDB.
//
//   Tier 2 -- per-category index reconcile.
//     Triggered on workspace mount when the sync record is
//     absent / behind, on poller-detected revision advance, and
//     on explicit operator refresh.  Pure set difference of
//     filenames:
//       daemon-only  -> synthesise committed row.
//       local-committed missing on daemon -> drop (only when
//                                             the listing call
//                                             succeeded).
//       local non-committed -> preserve always.
//       common -> identical by construction (filename = sha256
//                 of bytes); no work.
//     Successful workspace-wide reconcile writes the sync
//     record.
//
//   Tier 3 -- lazy materialisation.
//     Bytes (`getSliceBlob`) and spectrograms
//     (`getSliceSpectrogramUrl`) read IDB first; both caches
//     are content-addressed (keyed by sha256) so they're valid
//     forever for a given hash.  See
//     [audio/slice-fetch.ts] + [audio/spectrogram.ts].
//
// Reactivity discipline mirrors the drafts + categories stores:
// SvelteMap is reactive on `.set` / `.delete`; values are NOT
// deeply reactive so every mutation replaces the slice with a
// fresh object.  Callers wrap `refresh()` in `untrack` to avoid
// the `$effect` reactive-loop trap documented in NOTES.md.

function key(workspaceId: Uuid, categoryName: string): string {
  return `${workspaceId} ${categoryName}`;
}

function flightKey(workspaceId: Uuid, categoryName: string, id: string): string {
  return `${workspaceId}/${categoryName}/${id}`;
}

function byCreatedAsc(a: SliceRecord, b: SliceRecord): number {
  if (a.created_at === b.created_at) return 0;
  return a.created_at < b.created_at ? -1 : 1;
}

interface SliceList {
  entries: SliceRecord[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

const EMPTY_LIST: Readonly<SliceList> = Object.freeze({
  entries: [] as SliceRecord[],
  loading: false,
  loaded: false,
  error: null as string | null
});

const PENDING_STATES: ReadonlySet<SliceRecord['state']> = new Set(['local', 'uploading', 'failed']);

export type CategorySyncStatus = 'empty' | 'synced' | 'pending' | 'uploading' | 'failed';

const MAX_CONCURRENT_UPLOADS = 3;
const UPLOAD_RETRY_ATTEMPTS = 4;
const UPLOAD_RETRY_BASE_MS = 500;
const UPLOAD_RETRY_MAX_MS = 8000;

const MAX_CONCURRENT_INDEX_FETCHES = 3;

async function withConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = Array.from<R | undefined>({ length: items.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results as R[];
}

// Construct a committed SliceRecord from a daemon listing
// entry the client hasn't seen locally.  Returns null for any
// filename that doesn't fit the strict `<sha256hex>.wav` shape
// (see `sliceIdFromFilename`) -- foreign-named files are
// silently skipped because their bytes wouldn't pass the
// content-addressed integrity check on download anyway.
function synthesiseServerSlice(
  workspaceId: Uuid,
  categoryName: string,
  filename: string,
  mtime: string
): SliceRecord | null {
  const id = sliceIdFromFilename(filename);
  if (id === null) return null;
  return {
    id,
    workspace_id: workspaceId,
    category_name: categoryName,
    blob: null,
    state: 'committed',
    created_at: mtime
  };
}

class SlicesStore {
  private lists = new SvelteMap<string, SliceList>();
  private workspacesLoaded = new SvelteSet<Uuid>();

  private uploadPool = new UploadPool(MAX_CONCURRENT_UPLOADS);
  // Keyed by `flightKey(ws, cat, id)`: two slices with the
  // same content hash in different (ws, cat) tuples are
  // distinct uploads.
  private inflightUploads = new SvelteMap<string, AbortController>();
  // `flightKey(ws, cat, id)` of slices mid-`delete()`.  Mirrors
  // the workspaces store's `deleting` set.  In-memory only --
  // tab close mid-batch is self-healing via the next mount's
  // reconcile pass.
  deletingIds = new SvelteSet<string>();
  // Highest daemon revision observed for the workspace, from
  // ANY source (upload receipts, poller, mount detail).
  // Monotonic upward.  Used by the UI's "live revision" chip
  // and by `reconcileWorkspace`'s post-success recursion to
  // detect "an advance landed during our sync, catch up
  // immediately instead of waiting for the next poll tick".
  private latestRevisions = new SvelteMap<Uuid, number>();
  // In-memory mirror of `workspace_sync.last_synced_revision_id`.
  // Populated on the first `refreshForWorkspace` read of the
  // IDB record; advanced on every successful
  // `putWorkspaceSync`.  The poller's "should I trigger a
  // reconcile?" gate compares against THIS, not
  // `latestRevisions` -- if a reconcile fails (or is blocked
  // re-entrantly), `lastSyncedRevisions` stays behind the
  // daemon, and the next poll re-triggers.  Using
  // `latestRevisions` for that gate would silently mask
  // failed reconciles because the poller itself bumps
  // `latestRevisions` to `incoming` on every advance.
  private lastSyncedRevisions = new SvelteMap<Uuid, number>();
  private mutationsInFlight = new SvelteMap<Uuid, number>();
  // Per-category stale set.  Poller stamps keys on detected
  // revision advance; the per-category refresh path clears
  // them on a successful reconcile.
  private staleKeys = new SvelteSet<string>();
  // Workspaces with an in-flight Tier 2 reconcile.  Re-entry
  // guard.
  private reconcilingWorkspaces = new Set<Uuid>();

  for(workspaceId: Uuid, categoryName: string): SliceList {
    return this.lists.get(key(workspaceId, categoryName)) ?? EMPTY_LIST;
  }

  countFor(workspaceId: Uuid, categoryName: string): number {
    return this.for(workspaceId, categoryName).entries.length;
  }

  syncStatusFor(workspaceId: Uuid, categoryName: string): CategorySyncStatus {
    const entries = this.for(workspaceId, categoryName).entries;
    if (entries.length === 0) return 'empty';
    let hasUploading = false;
    let hasLocal = false;
    for (const e of entries) {
      if (e.state === 'failed') return 'failed';
      if (e.state === 'uploading') hasUploading = true;
      else if (e.state === 'local') hasLocal = true;
    }
    if (hasUploading) return 'uploading';
    if (hasLocal) return 'pending';
    return 'synced';
  }

  latestRevisionFor(workspaceId: Uuid): number | null {
    return this.latestRevisions.get(workspaceId) ?? null;
  }

  setRevisionAtLeast(workspaceId: Uuid, revision: number): void {
    const prior = this.latestRevisions.get(workspaceId) ?? -1;
    if (revision > prior) this.latestRevisions.set(workspaceId, revision);
  }

  // Highest workspace revision this tab has fully reconciled
  // to (and persisted into `workspace_sync`).  The poller
  // compares against this -- not `latestRevisionFor` -- so a
  // failed or re-entry-blocked reconcile leaves the gate open
  // for the next tick to retry.
  lastSyncedRevisionFor(workspaceId: Uuid): number | null {
    return this.lastSyncedRevisions.get(workspaceId) ?? null;
  }

  private setLastSyncedAtLeast(workspaceId: Uuid, revision: number): void {
    const prior = this.lastSyncedRevisions.get(workspaceId) ?? -1;
    if (revision > prior) this.lastSyncedRevisions.set(workspaceId, revision);
  }

  private loadedCategoryNames(workspaceId: Uuid): string[] {
    const prefix = `${workspaceId} `;
    const names: string[] = [];
    for (const k of this.lists.keys()) {
      if (k.startsWith(prefix)) names.push(k.slice(prefix.length));
    }
    return names;
  }

  // ── In-flight mutation bracketing ────────────────────────────

  beginMutation(workspaceId: Uuid): void {
    this.mutationsInFlight.set(workspaceId, (this.mutationsInFlight.get(workspaceId) ?? 0) + 1);
  }

  endMutation(workspaceId: Uuid): void {
    const cur = this.mutationsInFlight.get(workspaceId) ?? 0;
    if (cur <= 1) this.mutationsInFlight.delete(workspaceId);
    else this.mutationsInFlight.set(workspaceId, cur - 1);
  }

  mutationsInFlightFor(workspaceId: Uuid): number {
    return this.mutationsInFlight.get(workspaceId) ?? 0;
  }

  // ── Staleness (workspace poller integration) ─────────────────

  isStale(workspaceId: Uuid, categoryName: string): boolean {
    return this.staleKeys.has(key(workspaceId, categoryName));
  }

  // True iff the slice is currently mid-`delete()`.  The
  // `flightKey` namespace matches the upload pipeline's so the
  // pane-side gates can read one consistent membership.
  isDeleting(workspaceId: Uuid, categoryName: string, id: string): boolean {
    return this.deletingIds.has(flightKey(workspaceId, categoryName, id));
  }

  // Poller-driven invalidation on detected revision advance.
  // Stamps the per-category stale flag for every loaded
  // category (so an expanded SlicePane re-fires its
  // per-category refresh on the tracked-stale dep) AND kicks
  // a background workspace-wide reconcile so collapsed-badge
  // counts + the persisted `workspace_sync` record converge
  // to `workspaceRevision`.
  markStaleForWorkspace(workspaceId: Uuid, workspaceRevision: number): void {
    const prefix = `${workspaceId} `;
    const names: string[] = [];
    for (const k of this.lists.keys()) {
      if (k.startsWith(prefix)) {
        this.staleKeys.add(k);
        names.push(k.slice(prefix.length));
      }
    }
    if (names.length > 0) {
      void this.reconcileWorkspace(workspaceId, names, workspaceRevision);
    }
  }

  pendingFor(workspaceId: Uuid): SliceRecord[] {
    const result: SliceRecord[] = [];
    const prefix = `${workspaceId} `;
    for (const [k, list] of this.lists) {
      if (!k.startsWith(prefix)) continue;
      for (const entry of list.entries) {
        if (PENDING_STATES.has(entry.state)) result.push(entry);
      }
    }
    return result;
  }

  // ── Tier 1: workspace-mount sync ─────────────────────────────

  async refreshForWorkspace(
    workspaceId: Uuid,
    categoryNames: string[],
    workspaceRevision: number,
    force = false
  ): Promise<void> {
    // Bulk IDB load.  Always runs (one indexed query; the
    // per-category lists are what every other surface reads
    // from).  Idempotent via `workspacesLoaded`.
    if (!this.workspacesLoaded.has(workspaceId)) {
      try {
        const db = await getDB();
        const rows = await db.getAllFromIndex(STORE_SLICES, 'by-workspace', workspaceId);
        const grouped = new SvelteMap<string, SliceRecord[]>();
        for (const name of categoryNames) grouped.set(name, []);
        for (const row of rows) {
          const list = grouped.get(row.category_name) ?? [];
          list.push(row);
          grouped.set(row.category_name, list);
        }
        for (const [name, entries] of grouped) {
          entries.sort(byCreatedAsc);
          const k = key(workspaceId, name);
          if (!this.lists.has(k)) {
            this.lists.set(k, {
              entries,
              loading: false,
              loaded: true,
              error: null
            });
          }
        }
        this.workspacesLoaded.add(workspaceId);
        this.resumePending(workspaceId);
      } catch (e) {
        console.warn('[slices] bulk refresh failed', e);
      }
    }

    // Seed the in-memory mirror from IDB on first sighting;
    // subsequent calls (CategoryList's effect re-fires on
    // every revision advance, plus refreshes after category
    // mutations) hit the cached value and skip the IDB
    // round-trip.  Cross-tab writes to `workspace_sync` won't
    // propagate into our mirror -- the failure mode is "we
    // over-reconcile", which is correct (just slightly
    // wasteful), not "we miss data".
    //
    // Re-read the mirror AFTER the IDB seed because a
    // concurrent `setLastSyncedAtLeast` may have landed
    // during our await window:
    //   * `reconcileWorkspace` from a parallel mount or a
    //     poller-driven markStale, on its success path.
    //   * `markCommitted`'s auto-advance (which can only
    //     fire once the mirror has been seeded by one of
    //     the paths above -- it needs a defined `priorSynced`
    //     to satisfy the `+1 === revisionId` check).
    // Using the local IDB-derived value would force an
    // unnecessary reconcile when our cumulative state is
    // already ahead.
    let synced = this.lastSyncedRevisions.get(workspaceId);
    if (synced === undefined) {
      const sync = await getWorkspaceSync(workspaceId).catch(() => undefined);
      if (sync !== undefined) {
        this.setLastSyncedAtLeast(workspaceId, sync.last_synced_revision_id);
      }
      synced = this.lastSyncedRevisions.get(workspaceId);
    }

    // Tier 1 short-circuit.  Skip the reconcile if we are AT
    // OR AHEAD of the caller's known revision.  `synced >
    // workspaceRevision` happens when `markCommitted`'s
    // auto-advance ran since the caller's last detail fetch
    // (poller refreshes detail every 2 s; the page's prop is
    // momentarily behind our auto-advanced mirror).  Skipping
    // the reconcile there is correct: our IDB has the
    // caller's claimed state plus our own commits.  External
    // changes that landed AFTER caller's snapshot will be
    // discovered by the next poller tick (which compares
    // against `lastSyncedRevisions`, not against
    // `workspaceRevision`).
    if (!force && synced !== undefined && synced >= workspaceRevision) {
      return;
    }

    if (categoryNames.length === 0) return;
    void this.reconcileWorkspace(workspaceId, categoryNames, workspaceRevision);
  }

  // ── Tier 2: workspace-scoped reconcile ───────────────────────

  async reconcileWorkspace(
    workspaceId: Uuid,
    categoryNames: readonly string[],
    workspaceRevision: number
  ): Promise<void> {
    if (this.reconcilingWorkspaces.has(workspaceId)) return;
    if (categoryNames.length === 0) return;
    this.reconcilingWorkspaces.add(workspaceId);
    let succeededAt: number | null = null;
    try {
      const outcomes = await withConcurrency(categoryNames, MAX_CONCURRENT_INDEX_FETCHES, (name) =>
        this.refresh(workspaceId, name, true).then(
          () => true,
          () => false
        )
      );
      const allSucceeded = outcomes.every((ok) => ok);
      const everyCategorySettled = categoryNames.every((name) => {
        const list = this.lists.get(key(workspaceId, name));
        return list?.loaded === true && list.error === null;
      });
      // Forget-race guard: if `forget(workspaceId)` ran during
      // the reconcile (workspace-delete chain), the workspace
      // is being wiped; resurrecting a sync row for it would
      // leave an orphan in IDB that a same-UUID re-create
      // would inherit.  `workspacesLoaded` is the
      // single-source-of-truth flag set by the bulk-load and
      // cleared by `forget`; the `workspacesLoaded.has` gate
      // closes the window cleanly.
      if (allSucceeded && everyCategorySettled && this.workspacesLoaded.has(workspaceId)) {
        // Persist the MAX of our reconcile's rev and the
        // current mirror.  Our reconcile verified the
        // workspace state at `workspaceRevision`; if
        // `markCommitted`'s auto-advance bumped mirror past
        // that during our per-category fan-out, mirror's
        // value is a stricter upper bound (covers our
        // reconcile's state PLUS our committed slice).
        // Writing `workspaceRevision` directly would regress
        // IDB past `markCommitted`'s fire-and-forget
        // `putWorkspaceSync`; that regression is recoverable
        // on next mount, but sidestepping it keeps the
        // steady-state cleaner.
        //
        // `setLastSyncedAtLeast` is monotonic and runs first
        // so mirror reflects `max(prior, workspaceRevision)`;
        // then `persistRev` reads the consolidated value.
        // The `??` fallback is defensive -- after the
        // setLastSyncedAtLeast call mirror is guaranteed to
        // be at least `workspaceRevision`.
        this.setLastSyncedAtLeast(workspaceId, workspaceRevision);
        const persistRev = this.lastSyncedRevisions.get(workspaceId) ?? workspaceRevision;
        await putWorkspaceSync({
          workspace_id: workspaceId,
          last_synced_revision_id: persistRev,
          last_synced_at: new Date().toISOString()
        }).catch(() => undefined);
        // Capture `succeededAt` AFTER the put-await so the
        // recursion check below reflects auto-advance bumps
        // that landed during our await.  Without this, a
        // local upload commit during reconcile would inflate
        // `latestRevisions` (from `setRevisionAtLeast` in
        // `runUpload`) past our pre-await `persistRev`,
        // triggering a recursion that re-fetches every
        // category listing -- even though the auto-advance
        // already covered the delta (mirror == latestRevisions
        // and the auto-advance fired its own
        // `putWorkspaceSync` to consolidate IDB).  Reading
        // the post-await mirror means succeededAt tracks the
        // consolidated synced state; the recursion only
        // fires for genuinely external advances that
        // bumped latestRevisions without a matching auto-
        // advance (the gap case).
        succeededAt = this.lastSyncedRevisions.get(workspaceId) ?? persistRev;
      }
    } finally {
      this.reconcilingWorkspaces.delete(workspaceId);
    }

    // Catch-up: if the daemon advanced past `workspaceRevision`
    // while we were syncing (e.g. another tab landed an upload
    // during our listing fan-out, or a poll tick blocked by the
    // in-flight guard above noted the advance), re-fire
    // immediately instead of waiting for the next poll tick.
    // Only enters on the success path -- a failed reconcile
    // self-heals via the poller's `incoming > synced` gate on
    // the next tick.  Uses the LIVE loaded-category set so a
    // freshly-added category between calls participates.
    if (succeededAt !== null) {
      const newest = this.latestRevisions.get(workspaceId);
      if (newest !== undefined && newest > succeededAt) {
        const live = this.loadedCategoryNames(workspaceId);
        if (live.length > 0) {
          void this.reconcileWorkspace(workspaceId, live, newest);
        }
      }
    }
  }

  // ── Per-category sync ────────────────────────────────────────
  //
  // Pure set-difference of filenames between local IDB and the
  // daemon listing:
  //
  //   committed local + filename in daemon listing
  //     -> no-op (identical by content-addressing).
  //   committed local + filename absent from daemon listing
  //     -> orphan; drop the row.  ONLY fires when the listing
  //        call succeeded -- a failing listing leaves the list
  //        as-is.
  //   local | uploading | failed
  //     -> preserved; these states have no daemon presence by
  //        definition.  `resumePending` re-queues them.
  //   daemon-only file
  //     -> synthesise a `committed` row.
  //
  // A 404 on the category dir is the empty case (operator
  // added the category but never uploaded a slice yet); other
  // errors surface on the list.
  async refresh(workspaceId: Uuid, categoryName: string, force = false): Promise<void> {
    const k = key(workspaceId, categoryName);
    const existing = this.lists.get(k);
    const stale = this.staleKeys.has(k);
    if (existing?.loaded && !force && !existing.error && !stale) return;
    if (existing?.loading && !force) return;

    // Snapshot the in-memory entries at refresh start.  Used at
    // the end to distinguish "was deleted during refresh" (in
    // start, not in current) from "was synthesised by refresh"
    // (not in start, not in current).  Without this, the
    // merge-on-finish step couldn't safely drop orphans the
    // operator deleted mid-await.
    const startEntries = existing?.entries ?? [];
    const startIds = new SvelteSet(startEntries.map((s) => s.id));

    this.lists.set(k, {
      ...EMPTY_LIST,
      entries: startEntries,
      loading: true,
      loaded: existing?.loaded ?? false
    });

    try {
      const [localRows, serverListing] = await Promise.all([
        listSlicesForCategory(workspaceId, categoryName),
        assets.listCategory(workspaceId, categoryName, { limit: 1000 }).catch((e: unknown) => {
          if (isNotFound(e)) {
            return { entries: [], total: 0, offset: 0, limit: 1000 };
          }
          throw e;
        })
      ]);

      // Forget-race guard: a workspace-delete may have cleared
      // this entry while we awaited the listing + IDB.
      if (!this.lists.has(k)) return;

      // Index daemon entries by filename.  Only `.wav` files
      // count; directory entries are noise.
      // SvelteMap (not bare Map) is the file-wide discipline
      // for the `.svelte.ts` lint rule.
      const serverFilenames = new SvelteMap<string, { name: string; mtime: string }>();
      for (const entry of serverListing.entries) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.wav')) continue;
        serverFilenames.set(entry.name, { name: entry.name, mtime: entry.mtime });
      }

      const kept: SliceRecord[] = [];
      const toPut: SliceRecord[] = [];
      const toDeleteKeys: SliceKey[] = [];

      // Walk local rows; classify by state + presence on the
      // daemon.  Locally-mutable states are always preserved;
      // committed rows are the only ones subject to the
      // daemon-as-master rule.
      //
      // `seenFilenames` tracks every kept row's filename so the
      // synthesise loop below doesn't add a second row for the
      // same content -- it's populated for BOTH branches:
      //   * committed-matched: prevents synthesising a redundant
      //     committed row (current behaviour).
      //   * non-committed: prevents synthesising a "committed"
      //     duplicate when the daemon already has the file under
      //     the same content hash (operator re-sliced identical
      //     content, OR another tab uploaded the same bytes
      //     while our local upload is still pending).  Without
      //     this, `kept` would carry two rows with the same id
      //     (one local, one committed-synthetic) and the merge
      //     step would push duplicates into `finalEntries` --
      //     producing duplicate-key warnings from Svelte's
      //     keyed `{#each}` and a flickering double-render.
      const seenFilenames = new SvelteSet<string>();
      for (const row of localRows) {
        if (row.state !== 'committed') {
          kept.push(row);
          seenFilenames.add(sliceFilename(row.id));
          continue;
        }
        const fname = sliceFilename(row.id);
        if (serverFilenames.has(fname)) {
          // Filename match = content identity by construction.
          kept.push(row);
          seenFilenames.add(fname);
        } else {
          // Orphan: remote-deleted by another client.
          toDeleteKeys.push(sliceKey(row));
        }
      }

      // Synthesise rows for daemon entries absent from IDB.
      for (const [filename, remote] of serverFilenames) {
        if (seenFilenames.has(filename)) continue;
        const synthetic = synthesiseServerSlice(workspaceId, categoryName, filename, remote.mtime);
        if (synthetic !== null) {
          kept.push(synthetic);
          toPut.push(synthetic);
        }
      }

      if (toPut.length > 0) {
        await bulkPutSlices(toPut).catch(() => undefined);
      }
      if (toDeleteKeys.length > 0) {
        await bulkDeleteSlices(toDeleteKeys).catch(() => undefined);
      }

      // Forget-race guard #2: re-check after the IDB writes.
      if (!this.lists.has(k)) return;

      // Merge `kept` with the current in-memory state to absorb
      // mutations (append / delete / state transitions) that
      // landed during our await window.  Without this, a
      // newly-appended slice (state='local') gets overwritten
      // out of in-memory; a row whose upload completed mid-
      // refresh has its committed state reverted to the IDB-
      // snapshot state.
      //
      // For each row in `kept`:
      //   * was in startIds but not in current -> deleted during
      //     refresh (operator delete); drop.
      //   * is in current with a different state -> use current's
      //     row (state-change mid-refresh, e.g. local -> committed
      //     from an upload receipt).
      //   * otherwise -> use kept's row.
      // For each row in current not in `kept`:
      //   * non-committed (local / uploading / failed) -> appended
      //     during refresh; preserve.
      //   * committed AND not in startIds -> appended-AND-committed
      //     during refresh window.  Our localRows snapshot was
      //     taken before the append, and the daemon listing was
      //     fetched before the PUT propagated, so `kept` includes
      //     it from neither side.  But `currentEntries` has the
      //     authoritative committed state -- preserve.  Without
      //     this clause, an operator who slices + the upload
      //     completes while a poll-driven reconcile is in flight
      //     would briefly see their new card vanish from the UI
      //     (it's still in IDB, but invisible until the next
      //     refresh trigger picks it back up).
      //   * committed AND in startIds -> true orphan (was
      //     committed at refresh start, daemon listing now says
      //     it's gone, no concurrent local mutation explains it).
      //     Drop.  The "committed-at-start, transitioned through
      //     local-state-during-refresh, listing missed PUT"
      //     scenario is logically impossible: markCommitted fires
      //     only after PUT completes, which by then propagates
      //     to listings.
      const currentList = this.lists.get(k);
      const currentEntries = currentList?.entries ?? [];
      const currentById = new SvelteMap<string, SliceRecord>();
      for (const entry of currentEntries) currentById.set(entry.id, entry);

      const finalEntries: SliceRecord[] = [];
      const finalIds = new SvelteSet<string>();
      for (const row of kept) {
        const inCurrent = currentById.get(row.id);
        if (inCurrent === undefined) {
          if (startIds.has(row.id)) {
            // Was in our memory at start, gone now ->
            // deleted during refresh.  Drop.
            continue;
          }
          // Not in start, not in current -> new (synthesised
          // or refreshed from IDB).  Use kept's row.
          finalEntries.push(row);
        } else {
          // In current -> prefer current's version (its state
          // reflects any mid-refresh mutation).
          finalEntries.push(inCurrent);
        }
        finalIds.add(row.id);
      }
      for (const entry of currentEntries) {
        if (finalIds.has(entry.id)) continue;
        // Preserve if non-committed (locally-tracked, no daemon
        // presence) OR if committed-but-not-in-startIds
        // (appended-and-committed during refresh -- listing
        // missed the PUT propagation).  Skip committed-and-in-
        // startIds entries: those are true orphans the daemon
        // confirmed are gone.
        if (entry.state !== 'committed' || !startIds.has(entry.id)) {
          finalEntries.push(entry);
        }
      }

      finalEntries.sort(byCreatedAsc);
      this.lists.set(k, {
        entries: finalEntries,
        loading: false,
        loaded: true,
        error: null
      });
      this.staleKeys.delete(k);
    } catch (e) {
      if (!this.lists.has(k)) return;
      // Preserve whatever current in-memory state is -- mutations
      // (appends, deletes, state changes) that landed during the
      // failed refresh should NOT be reverted to the pre-refresh
      // snapshot.  Just flip the loading flag and stamp the
      // error.
      const current = this.lists.get(k);
      if (!current) return;
      this.lists.set(k, {
        ...current,
        loading: false,
        error: errorCopy(e)
      });
      throw e;
    }
  }

  // ── Upload pipeline ──────────────────────────────────────────
  //
  // The `AbortController` is created at ENQUEUE time (not when
  // the pool actually dispatches `runUpload`) so a `delete()`
  // that lands while our task is still queued can abort it
  // before it slips into the pool slot and PUTs bytes to a
  // slice the operator just removed.  Without this, the queued
  // window between `enqueueUpload` and `runUpload`'s first
  // line is a race (delete found `inflightUploads.get(fk)`
  // empty -> no abort handle -> queued task slipped through).
  //
  // The same eager controller also closes a back-to-back-enqueue
  // dedup race: two synchronous enqueues for the same `fk`
  // would otherwise both pass the `inflightUploads.has(fk)`
  // gate (since the entry was only set inside `runUpload`,
  // after the pool slot acquired).

  enqueueUpload(record: Pick<SliceRecord, 'workspace_id' | 'category_name' | 'id'>): Promise<void> {
    const fk = flightKey(record.workspace_id, record.category_name, record.id);
    if (this.inflightUploads.has(fk)) {
      return Promise.resolve();
    }
    const controller = new AbortController();
    this.inflightUploads.set(fk, controller);
    return this.uploadPool.submit(async () => {
      try {
        await this.runUpload(record.workspace_id, record.category_name, record.id, controller);
      } finally {
        // Identity-checked cleanup.  A `delete()` that aborted
        // OUR controller also removed our map entry; a
        // subsequent enqueue (e.g. operator re-added the slice
        // via re-slicing identical audio) may have repopulated
        // it with a different controller.  Clear only when we
        // are still the registered owner -- otherwise we would
        // clobber the successor's entry.
        if (this.inflightUploads.get(fk) === controller) {
          this.inflightUploads.delete(fk);
        }
      }
    });
  }

  resumePending(workspaceId: Uuid): void {
    for (const slice of this.pendingFor(workspaceId)) {
      void this.enqueueUpload(slice);
    }
  }

  private async runUpload(
    workspaceId: Uuid,
    categoryName: string,
    id: string,
    controller: AbortController
  ): Promise<void> {
    // Aborted before we got a pool slot (delete fired while
    // queued).  Bail before touching any slice state.  Read
    // through a local so TS's control-flow narrowing of
    // `signal.aborted` past this point doesn't flag the
    // catch-branch re-read as "always-falsy" (the underlying
    // value flips asynchronously, but TS models it as a
    // single-shot narrow).
    const initiallyAborted: boolean = controller.signal.aborted;
    if (initiallyAborted) return;
    const slice = this.findSlice(workspaceId, categoryName, id);
    if (!slice) return;
    if (!slice.blob || slice.blob.size === 0) {
      await this.markFailed(slice, 'No local bytes to upload.');
      return;
    }
    this.beginMutation(workspaceId);

    try {
      await this.markUploading(slice);

      const url = assets.slicePutPath(workspaceId, categoryName, sliceFilename(id));
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= UPLOAD_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          this.setProgress(workspaceId, categoryName, id, 0);
          const wait = Math.min(
            UPLOAD_RETRY_BASE_MS * Math.pow(2, attempt - 2),
            UPLOAD_RETRY_MAX_MS
          );
          const jittered = wait * (0.75 + Math.random() * 0.5);
          try {
            await sleepAbortable(jittered, controller.signal);
          } catch {
            return;
          }
        }
        try {
          const receipt = await xhrPut<AssetReceipt>({
            url,
            body: slice.blob,
            contentType: 'audio/wav',
            onProgress: (loaded, total) => {
              if (total > 0) this.setProgress(workspaceId, categoryName, id, loaded / total);
            },
            signal: controller.signal
          });
          this.setRevisionAtLeast(workspaceId, receipt.workspace_revision_id);
          if (receipt.sha256 !== id) {
            // Content-addressed receipt verification.  If the
            // daemon's hash differs from our pre-computed id,
            // bytes were corrupted in transport (or our
            // pre-compute disagreed with the daemon's algo --
            // both should not happen).  Treat as upload
            // failure; operator can retry.
            lastError = new Error(
              `Daemon receipt sha256 (${receipt.sha256}) did not match slice id (${id}).`
            );
            break;
          }
          await this.markCommitted(slice, receipt.workspace_revision_id);
          return;
        } catch (e) {
          if (controller.signal.aborted) return;
          lastError = e;
          if (!isTransientUploadError(e)) break;
        }
      }

      await this.markFailed(slice, errorCopy(lastError));
    } finally {
      this.endMutation(workspaceId);
    }
  }

  // ── Slice-record mutations + IDB persistence ─────────────────

  private findSlice(workspaceId: Uuid, categoryName: string, id: string): SliceRecord | undefined {
    const list = this.lists.get(key(workspaceId, categoryName));
    if (!list) return undefined;
    return list.entries.find((s) => s.id === id);
  }

  private patchInMemory(
    workspaceId: Uuid,
    categoryName: string,
    id: string,
    transform: (s: SliceRecord) => SliceRecord
  ): SliceRecord | undefined {
    const k = key(workspaceId, categoryName);
    const list = this.lists.get(k);
    if (!list) return undefined;
    const idx = list.entries.findIndex((s) => s.id === id);
    if (idx < 0) return undefined;
    const next = transform(list.entries[idx]);
    const entries = list.entries.slice();
    entries[idx] = next;
    this.lists.set(k, { ...list, entries });
    return next;
  }

  private async markUploading(slice: SliceRecord): Promise<void> {
    const next = this.patchInMemory(slice.workspace_id, slice.category_name, slice.id, (s) => ({
      ...s,
      state: 'uploading',
      upload_progress: 0,
      last_error: undefined
    }));
    if (next) await putSlice(next).catch(() => undefined);
  }

  private setProgress(
    workspaceId: Uuid,
    categoryName: string,
    id: string,
    progress: number
  ): void {
    this.patchInMemory(workspaceId, categoryName, id, (s) => ({
      ...s,
      upload_progress: progress
    }));
  }

  private async markCommitted(slice: SliceRecord, revisionId: number): Promise<void> {
    const next = this.patchInMemory(slice.workspace_id, slice.category_name, slice.id, (s) => ({
      ...s,
      state: 'committed',
      blob: null,
      upload_progress: undefined,
      last_error: undefined,
      workspace_revision_id: revisionId
    }));
    if (next) await putSlice(next).catch(() => undefined);

    // Auto-advance the persisted sync record ONLY if our
    // upload's receipt rev is exactly one past where we were
    // synced.  In that case our upload is provably the only
    // workspace mutation between (synced) and (revisionId);
    // no external advance happened in the gap; we can claim
    // "synced to revisionId" without risking missing data.
    //
    // The strict `+1` check is intentionally pessimistic --
    // a multi-tab race where another client interleaved an
    // upload would leave a gap (receipts arrive out of
    // monotonic order, or daemon-rev numbers skip), the
    // check fails, and we fall back to the poller's
    // `incoming > synced` gate to drive a reconcile.
    //
    // Without this optimisation, every local upload commit
    // triggers a Tier 2 reconcile on the next poll tick
    // (synced = N stays behind incoming = N+1 from our own
    // PUT) -- N category-listing GETs of pure wasted
    // bandwidth, since we already KNOW our upload was the
    // only delta.
    //
    // Fire-and-forget the IDB write: IDB serialises writes
    // on the same connection so back-to-back batch commits
    // produce monotonic last-write-wins on the row; if a
    // write hasn't flushed when the tab closes, next session
    // re-reads the older value and re-reconciles (self-
    // healing).
    const wsId = slice.workspace_id;
    const priorSynced = this.lastSyncedRevisions.get(wsId) ?? -1;
    if (priorSynced + 1 === revisionId) {
      this.setLastSyncedAtLeast(wsId, revisionId);
      void putWorkspaceSync({
        workspace_id: wsId,
        last_synced_revision_id: revisionId,
        last_synced_at: new Date().toISOString()
      }).catch(() => undefined);
    }
  }

  private async markFailed(slice: SliceRecord, error: string): Promise<void> {
    const next = this.patchInMemory(slice.workspace_id, slice.category_name, slice.id, (s) => ({
      ...s,
      state: 'failed',
      upload_progress: undefined,
      last_error: error
    }));
    if (next) await putSlice(next).catch(() => undefined);
  }

  // Append a slice.  IDB's composite key means re-slicing
  // byte-identical audio in the same (workspace, category)
  // overwrites the prior row -- the caller (`InputPane`) reads
  // the post-put list length to surface a "duplicates
  // collapsed" hint.
  async append(record: SliceRecord): Promise<void> {
    await putSlice(record);
    const k = key(record.workspace_id, record.category_name);
    const existing = this.lists.get(k);
    const baseEntries = existing?.entries ?? [];
    // Replace if an entry with this id already exists, else
    // append.  Tail-insert preserves `created_at` ascending
    // order (IDB query mirrors it).
    const replaceIdx = baseEntries.findIndex((s) => s.id === record.id);
    let entries: SliceRecord[];
    if (replaceIdx >= 0) {
      entries = baseEntries.slice();
      entries[replaceIdx] = record;
    } else {
      entries = [...baseEntries, record];
    }
    this.lists.set(k, {
      ...EMPTY_LIST,
      entries,
      loaded: true,
      loading: false,
      error: null
    });
  }

  async delete(record: SliceRecord): Promise<void> {
    const fk = flightKey(record.workspace_id, record.category_name, record.id);
    if (this.deletingIds.has(fk)) return;
    this.deletingIds.add(fk);
    const remoteDelete = record.state === 'committed';
    if (remoteDelete) this.beginMutation(record.workspace_id);
    try {
      const controller = this.inflightUploads.get(fk);
      if (controller) {
        controller.abort();
        this.inflightUploads.delete(fk);
      }
      if (remoteDelete) {
        try {
          await enqueueDelete(() => this.runRemoteDelete(record));
        } catch (e) {
          console.warn('[slices] remote delete failed', e);
          throw e;
        }
      }
      await idbDeleteSlice(record.workspace_id, record.category_name, record.id);
      // No cache eviction: spectrogram + blob caches are
      // content-addressed (keyed by sha256); another slice
      // anywhere with the same content may still rely on the
      // entry.  Content-addressed caches accumulate; `resetDB`
      // is the single reset point.
      const k = key(record.workspace_id, record.category_name);
      const existing = this.lists.get(k);
      if (!existing) return;
      this.lists.set(k, {
        ...existing,
        entries: existing.entries.filter((s) => s.id !== record.id)
      });
    } finally {
      this.deletingIds.delete(fk);
      if (remoteDelete) this.endMutation(record.workspace_id);
    }
  }

  async deleteMany(targets: SliceRecord[]): Promise<BulkSliceDeleteOutcome> {
    const failed: BulkSliceDeleteFailure[] = [];
    let succeeded = 0;
    await Promise.all(
      targets.map(async (record) => {
        try {
          await this.delete(record);
          succeeded++;
        } catch (e) {
          const message =
            e instanceof Error && e.message ? capFirst(e.message, 'Delete failed.') : errorCopy(e);
          failed.push({ id: record.id, filename: sliceFilename(record.id), error: message });
        }
      })
    );
    return { succeeded, failed };
  }

  private async runRemoteDelete(slice: SliceRecord): Promise<void> {
    const ack = await assets.deleteSlice(
      slice.workspace_id,
      slice.category_name,
      sliceFilename(slice.id)
    );
    await awaitJobTerminal(ack.job_id);
  }

  async clearForCategory(workspaceId: Uuid, categoryName: string): Promise<void> {
    const existing = this.lists.get(key(workspaceId, categoryName));
    if (existing && existing.entries.length > 0) {
      for (const slice of existing.entries) {
        const fk = flightKey(workspaceId, categoryName, slice.id);
        const controller = this.inflightUploads.get(fk);
        if (controller) {
          controller.abort();
          this.inflightUploads.delete(fk);
        }
      }
    }
    await deleteSlicesForCategory(workspaceId, categoryName);
    const k = key(workspaceId, categoryName);
    this.lists.set(k, {
      ...EMPTY_LIST,
      loaded: true
    });
    this.staleKeys.delete(k);
  }

  forget(workspaceId: Uuid, categoryName?: string): void {
    const drop = (k: string, name: string): void => {
      const list = this.lists.get(k);
      if (list && list.entries.length > 0) {
        for (const slice of list.entries) {
          const fk = flightKey(workspaceId, name, slice.id);
          const controller = this.inflightUploads.get(fk);
          if (controller) {
            controller.abort();
            this.inflightUploads.delete(fk);
          }
        }
      }
      this.lists.delete(k);
      this.staleKeys.delete(k);
    };
    if (categoryName !== undefined) {
      drop(key(workspaceId, categoryName), categoryName);
      return;
    }
    const prefix = `${workspaceId} `;
    for (const k of Array.from(this.lists.keys())) {
      if (k.startsWith(prefix)) {
        const name = k.slice(prefix.length);
        drop(k, name);
      }
    }
    this.workspacesLoaded.delete(workspaceId);
    this.latestRevisions.delete(workspaceId);
    // Drop the in-memory mirror too -- a re-created workspace
    // with the same UUID (rare but possible via local seed
    // data) would otherwise inherit the prior workspace's
    // synced-revision claim, which would Tier-1-short-circuit
    // an incoming reconcile against the empty new workspace.
    this.lastSyncedRevisions.delete(workspaceId);
    this.mutationsInFlight.delete(workspaceId);
    this.reconcilingWorkspaces.delete(workspaceId);
    // Persisted sync record is GC'd by the workspace-delete
    // chain in [stores/workspaces.svelte.ts] too; firing here
    // covers a forget-without-delete (e.g. a test teardown).
    void deleteWorkspaceSync(workspaceId).catch(() => undefined);
  }
}

export const slices = new SlicesStore();
