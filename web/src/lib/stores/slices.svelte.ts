import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
  bulkPutSlices,
  deleteSlice as idbDeleteSlice,
  deleteSlicesForCategory,
  listSlicesForCategory,
  putSlice
} from '$lib/idb/slices';
import { getDB, STORE_SLICES } from '$lib/idb/db';
import type { SliceRecord } from '$lib/idb/db';
import { revokeSliceSpectrograms } from '$lib/audio/spectrogram';
import { revokeSliceBlobs } from '$lib/audio/slice-fetch';
import { assets } from '$lib/api/endpoints';
import { enqueueDelete } from '$lib/api/delete-queue';
import { awaitJobTerminal } from '$lib/api/jobs';
import { isTransientUploadError, sleepAbortable, UploadPool, xhrPut } from '$lib/api/upload';
import { capFirst, errorCopy, isNotFound } from '$lib/utils/error-copy';
import type { AssetReceipt, Uuid } from '$lib/api/types';

// Per-target failure record returned from `deleteMany`.  Shape
// matches the workspaces store's `BulkDeleteFailure` so a future
// cross-module "delete outcome" surface can treat the two paths
// the same.
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
// [idb/db.ts]); the store owns persistence + upload pipeline +
// in-memory cache.  Reactivity discipline mirrors the drafts +
// categories stores: SvelteMap is reactive on `.set` / `.delete`;
// values are NOT deeply reactive so every mutation replaces the
// slice with a fresh object.  Callers wrap `refresh()` in
// `untrack` to avoid the `$effect` reactive-loop trap documented
// in NOTES.md §"$effect + refresh() reactive-loop trap".

function key(workspaceId: Uuid, categoryName: string): string {
  return `${workspaceId} ${categoryName}`;
}

// Mirror of [idb/slices.ts]'s comparator -- inlined so the bulk-
// refresh path can sort partitions without touching the IDB layer.
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

// Slice states that count as "pending" for the resume / banner
// surfaces.  `committed` is the only finished state.
const PENDING_STATES: ReadonlySet<SliceRecord['state']> = new Set(['local', 'uploading', 'failed']);

// Per-category sync status surfaced by the CategoryRow badge.
// Priority cascade (high → low): failed > uploading > pending >
// synced > empty.  `failed` wins because it's the only state that
// needs operator attention; others progress on their own.  `empty`
// hides the pill so an unused category doesn't shout a no-op
// status (the count chip already telegraphs the empty case).
export type CategorySyncStatus = 'empty' | 'synced' | 'pending' | 'uploading' | 'failed';

// Bounded-concurrency upload pool: 3 workers matches PLAN's
// default.  Daemon has no per-workspace cap, but the operator's
// network does and 60 simultaneous XHRs to one origin is rude.
const MAX_CONCURRENT_UPLOADS = 3;

// Transient-failure retry policy.  PUT is idempotent on the daemon
// side, so retrying with the same body is safe.  Exponential
// backoff with ±25 % jitter avoids synchronised retry storms when
// several in-flight slices hit the same daemon event.  4 attempts
// × 8 s cap puts the worst-case slot-hold at ~10-12 s before a
// slice gives up and the pool slot frees.
const UPLOAD_RETRY_ATTEMPTS = 4;
const UPLOAD_RETRY_BASE_MS = 500;
const UPLOAD_RETRY_MAX_MS = 8000;

// Concurrency cap for the proactive per-category index reconcile
// fired after the bulk IDB load and on poller-driven revision
// advance.  Same value as `MAX_CONCURRENT_UPLOADS`: per-category
// `listCategory` GETs are cheap (no fsync, no body) and the
// daemon's directory-listing path is single-threaded, so going
// past 3 doesn't meaningfully shorten wall-clock for typical
// workspaces (≤ 10 categories) -- it just risks bunching SD-card
// reads on the device's eMMC.  Worst-case wall-clock at 3 workers
// over 10 categories is ~150 ms (50 ms / GET on localhost),
// invisible to the operator's first-paint.
const MAX_CONCURRENT_INDEX_FETCHES = 3;

// Concurrency-limited fan-out.  Used by
// `reconcileIndexesForWorkspace` to spread per-category daemon
// listings across a few workers without serialising (slow when
// per-call latency is in the 30-100 ms range and a workspace has
// many categories) or blasting (rude to the daemon's single-
// threaded listing path and a waste of origin connection
// budget).  Best-effort: a per-task throw is caught here so
// sibling tasks finish regardless; the underlying `refresh()`
// already routes the failure onto the list's `error` field so
// the UI can surface it.
async function withConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      try {
        await fn(items[idx]);
      } catch {
        // Per-task failure already surfaces on the list's `error`
        // via `refresh()`'s catch block.  Swallowed here so a
        // single bad category doesn't strand the sibling workers
        // mid-batch.
      }
    }
  });
  await Promise.all(workers);
}

class SlicesStore {
  private lists = new SvelteMap<string, SliceList>();
  // Workspaces for which `refreshForWorkspace` has already walked
  // IDB.  Reactive so a CategoryList `$effect` can fan out badges
  // the moment the bulk load resolves.
  private workspacesLoaded = new SvelteSet<Uuid>();

  // Upload pool caps concurrent XHRs; per-slice abort controllers
  // let `delete()` cancel an in-flight upload mid-stream.
  private uploadPool = new UploadPool(MAX_CONCURRENT_UPLOADS);
  private inflightUploads = new SvelteMap<string, AbortController>();
  // Slice ids currently mid-`delete()`.  Mirrors the workspaces
  // store's `deleting` set; SlicePane / SliceCard gate every
  // operator action on this membership (no replay clicks, no
  // batch picking up draining rows, no menu over a tombstone).
  // Pure in-memory: a tab close mid-batch is self-healing via
  // `refresh`'s daemon-as-master orphan reconciliation.
  deletingIds = new SvelteSet<string>();
  // Latest revision id observed for the workspace from ANY source
  // -- upload receipts, the workspace detail page's initial load,
  // and the workspace poller's periodic GET.  Monotonic upward
  // because the daemon's `WorkspaceRevision` is monotonic upward;
  // every writer funnels through `setRevisionAtLeast` so the
  // invariant is enforced in one place.  Consumers: the detail
  // page's "live" revision chip; the poller's "did revision
  // advance" comparison.
  private latestRevisions = new SvelteMap<Uuid, number>();
  // Per-workspace count of in-flight mutations: slice uploads
  // (`runUpload`), slice deletes hitting the daemon (`delete`),
  // remote category deletes (`categories.delete`), and workspace
  // deletes (`workspaces.runDelete`).  The poller reads this via
  // `mutationsInFlightFor` and defers its revision check when
  // > 0, so an external advance is never compared against an
  // unsettled local store -- one reconciliation tick after the
  // counter drains catches up.  `SvelteMap` for consistency with
  // the other counters in this store + the file's `.svelte.ts`
  // lint rule; the poller itself reads non-reactively (it lives
  // outside Svelte's tracking domain), so the reactive surface
  // is just a side-effect of the convention, not load-bearing.
  private mutationsInFlight = new SvelteMap<Uuid, number>();
  // Per-category stale set.  Keys mirror `lists` (`${ws} ${cat}`).
  // A workspace poller adds keys on revision advance; `refresh`
  // clears them on a successful reconcile.  Kept as a separate
  // `SvelteSet` (not a field on `SliceList`) so callers can
  // track *just* staleness as a reactive dep without picking up
  // the surrounding list's intermediate `loading: true` writes
  // -- the existing reactive-loop trap documented in NOTES.md
  // bit us once already and we don't want a per-category effect
  // to re-fire on every `markUploading` patch the upload pipeline
  // makes against the same key.
  private staleKeys = new SvelteSet<string>();
  // Workspaces with a `reconcileIndexesForWorkspace` task in
  // flight.  In-flight guard: a second trigger (a poller-driven
  // stale advance landing while the first reconcile is still
  // draining) is a no-op.  Without this, two visible-tab edits
  // to the same workspace would have the second tab's poller
  // fire a new reconcile every 2 s even while the previous one
  // was still in flight, amplifying GET traffic without benefit.
  // Bare `Set` because no reactive consumer reads this state
  // (it's purely an internal coordination flag).
  private reconcilingWorkspaces = new Set<Uuid>();

  for(workspaceId: Uuid, categoryName: string): SliceList {
    return this.lists.get(key(workspaceId, categoryName)) ?? EMPTY_LIST;
  }

  // Convenience derived for the quantity badge in CategoryRow.
  // Reads `entries.length` from the per-category list; returns 0
  // when the list isn't loaded yet (the operator sees the badge
  // populate as soon as the bulk load resolves -- no flashing
  // "—" placeholder needed).
  countFor(workspaceId: Uuid, categoryName: string): number {
    return this.for(workspaceId, categoryName).entries.length;
  }

  // Aggregate sync status for the per-category pill.  Short-circuits
  // on `failed` (the top of the priority cascade); otherwise picks
  // the highest of uploading > pending > synced after a single pass.
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
    // Entries non-empty with nothing failed/uploading/local left:
    // every remaining row is `committed`.
    return 'synced';
  }

  // Highest revision id known to this tab for `workspaceId` from
  // ANY source -- upload receipts, the workspace detail page's
  // initial GET, and the workspace poller's periodic GET -- or
  // `null` if the workspace has never been observed in this
  // session.  Writers funnel through `setRevisionAtLeast`; the
  // monotonic invariant means a stale reader (e.g. a delayed
  // poll response) cannot regress the value.  Consumers: the
  // detail page's "live" revision chip + the poller's "did the
  // daemon advance past what we know" comparison.
  latestRevisionFor(workspaceId: Uuid): number | null {
    return this.latestRevisions.get(workspaceId) ?? null;
  }

  // Monotonic-up revision setter.  All revision writers (upload
  // receipts, poller, page-detail loads) go through here so the
  // invariant lives in one place; a stale receipt or a delayed
  // poll response that arrives with an older value is a no-op
  // rather than a regression.
  setRevisionAtLeast(workspaceId: Uuid, revision: number): void {
    const prior = this.latestRevisions.get(workspaceId) ?? -1;
    if (revision > prior) this.latestRevisions.set(workspaceId, revision);
  }

  // ── In-flight mutation bracketing ────────────────────────────
  //
  // Public so the categories store can bracket its remote
  // DELETE; slices-internal mutations (upload, single-row delete)
  // bracket themselves below.  The poller reads
  // `mutationsInFlightFor` and defers a revision check when it
  // is > 0, matching the design's "sync after the local changes
  // are done" rule.

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
  //
  // The workspace detail page's poller compares its remembered
  // revision against `GET /workspace/{id}` every ~2 s; on advance,
  // it calls `markStaleForWorkspace(id)`.  The flag is per-
  // category so the SlicePane's `$effect` can re-fire only when
  // its own key flips -- a tracked read on `isStale(ws, cat)`
  // and an untracked refresh inside the effect compose into
  // "lazy revalidation on expand AND on detected advance for the
  // currently expanded category" without dragging the bulk badge
  // path into the dependency graph.

  isStale(workspaceId: Uuid, categoryName: string): boolean {
    return this.staleKeys.has(key(workspaceId, categoryName));
  }

  // Mark every currently-loaded category in `workspaceId` as
  // stale AND kick off a proactive per-category reconcile against
  // the daemon.  Categories not yet in `lists` are skipped because
  // their first `refresh` (on operator expand) always fetches
  // fresh anyway -- there is no cache to invalidate.
  //
  // The proactive reconcile is what makes the collapsed-row badge
  // counts converge after another tab / external CLI advances the
  // workspace revision.  Without it, the SlicePane `$effect`'s
  // tracked `isStale` read would only re-refresh the currently-
  // expanded category, and every other category's badge would
  // stay at the previous count until the operator manually
  // expanded it.  The in-flight guard inside
  // `reconcileIndexesForWorkspace` means a burst of poll ticks
  // (e.g. a sibling tab streaming uploads) amplifies into at most
  // one in-flight reconcile per workspace.
  markStaleForWorkspace(workspaceId: Uuid): void {
    const prefix = `${workspaceId} `;
    const names: string[] = [];
    for (const k of this.lists.keys()) {
      if (k.startsWith(prefix)) {
        this.staleKeys.add(k);
        names.push(k.slice(prefix.length));
      }
    }
    if (names.length > 0) {
      void this.reconcileIndexesForWorkspace(workspaceId, names);
    }
  }

  // Iterate every per-workspace pending slice (any state in
  // PENDING_STATES).  Used by the resume-uploads banner to count
  // "what's left" + by `resumePending` to actually re-queue them.
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

  // Bulk-load every slice for `workspaceId` and partition into the
  // per-category map -- one IDB query covers every collapsed-row
  // badge instead of an expand-each round-trip.  Empty categories
  // also flip to `loaded: true` so the SlicePane's `!loaded`
  // spinner doesn't flash on first expand of slice-less rows.
  // Idempotent via `workspacesLoaded`; `forget()` clears the entry
  // on workspace delete.
  //
  // Every bulk-loaded key is also stamped stale: the bulk read is
  // IDB-only, so per-category `refresh` (which fetches the daemon
  // listing + reconciles orphans + synthesises server-only rows)
  // MUST run on first expand for the daemon to be the master of
  // committed state.  Without the stale stamp the per-category
  // `refresh` would short-circuit on `loaded && !error`, and a
  // cache-wipe-and-return session would never see server-only
  // slices -- they'd be invisible until the operator forced a
  // refresh, defeating the lazy-fetch design.  After the first
  // expand reconciles, `refresh` clears stale and subsequent
  // collapse / expand cycles short-circuit on the cached entries.
  async refreshForWorkspace(
    workspaceId: Uuid,
    categoryNames: string[],
    force = false
  ): Promise<void> {
    if (this.workspacesLoaded.has(workspaceId) && !force) return;
    try {
      const db = await getDB();
      const rows = await db.getAllFromIndex(STORE_SLICES, 'by-workspace', workspaceId);
      // Partition.  Initialise every passed-in category to an
      // empty list so even slice-less categories transition to
      // `loaded: true`.  Slices whose `category_name` isn't in the
      // input list (orphans of a server-deleted category whose IDB
      // rows linger) still get bucketed so the operator can act
      // on them later.  `SvelteMap` over bare `Map`: the file's
      // `.svelte.ts` extension makes the lint rule eager about
      // reactive collections; this Map is purely function-local
      // but the rule lacks a path-sensitivity model.
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
        this.lists.set(k, {
          entries,
          loading: false,
          loaded: true,
          error: null
        });
        // Stamp stale so the per-category `refresh` proceeds on
        // first expand (see the block comment above for the
        // cache-wipe / cross-tab rationale).
        this.staleKeys.add(k);
      }
      this.workspacesLoaded.add(workspaceId);
      // Auto-resume any cross-reload pending uploads now that the
      // bulk-load has populated the in-memory state.  Co-located
      // here (rather than chained in the caller) so it fires
      // exactly once per first-load and not on every reactive
      // re-trigger of the calling effect.  The pool dedupes
      // against in-flight ids so a freshly-sliced batch already
      // queued by `InputPane.performSlice` isn't double-queued.
      this.resumePending(workspaceId);
    } catch (e) {
      // Don't mark the workspace loaded on failure -- the next
      // mount can retry.  Per-category refreshes still work
      // (they'll do their own IDB query and fail or succeed
      // independently).
      console.warn('[slices] bulk refresh failed', e);
    }
    // Proactively reconcile every category's index against the
    // daemon, capped at `MAX_CONCURRENT_INDEX_FETCHES` workers.
    // The bulk IDB load above surfaces badge counts from local
    // state (zero on cache-cleared / first-visit sessions);
    // without this follow-up the operator would have to expand
    // every category to see its actual slice count.  Fire-and-
    // forget: callers are reactive `$effect`s that don't await,
    // and the per-category lists transition to daemon-truth
    // incrementally as each `refresh()` resolves.  Slice BLOBS
    // remain lazy (operator-on-expand) -- only the per-category
    // index reconciles here, so workspaces with thousands of
    // slices don't pull megabytes of WAV bytes at first mount.
    //
    // Runs even if the bulk IDB load above threw: the per-
    // category `refresh()` does its own IDB read + daemon GET
    // and is resilient to a missing in-memory partition.
    void this.reconcileIndexesForWorkspace(workspaceId, categoryNames);
  }

  // Concurrency-capped per-category index sync against the
  // daemon listing.  Each per-category call routes through the
  // same `refresh()` path that an operator-driven expand would
  // hit, so the reconciliation rules (daemon-as-master for
  // committed state, orphan GC, synthesised server-only rows)
  // apply uniformly regardless of trigger.
  //
  // Triggered from two places:
  //   1. After the bulk IDB load in `refreshForWorkspace` -- so
  //      first-mount + cache-cleared sessions see daemon-truth
  //      badge counts without operator-driven expansion.
  //   2. From `markStaleForWorkspace` on poller-detected
  //      revision advance -- so collapsed categories' badge
  //      counts converge after another tab / external CLI
  //      writes to the workspace.
  //
  // Re-entrant-safe: a second call while a previous reconcile
  // is in flight is a no-op.  The poller fires `markStale*`
  // every 2 s when visible, so without the in-flight gate a
  // sparse-revision-advance burst (e.g. another tab streaming
  // uploads) would pile up redundant reconciles.  The flag
  // bounds amplification to "one reconcile in flight per
  // workspace, period."
  async reconcileIndexesForWorkspace(
    workspaceId: Uuid,
    categoryNames: readonly string[]
  ): Promise<void> {
    if (this.reconcilingWorkspaces.has(workspaceId)) return;
    if (categoryNames.length === 0) return;
    this.reconcilingWorkspaces.add(workspaceId);
    try {
      await withConcurrency(categoryNames, MAX_CONCURRENT_INDEX_FETCHES, (name) =>
        this.refresh(workspaceId, name)
      );
    } finally {
      this.reconcilingWorkspaces.delete(workspaceId);
    }
  }

  // Per-category sync.  Reads local IDB + the daemon's category
  // listing in parallel and reconciles with the daemon as master
  // for `committed` state:
  //   - daemon-only file → synthesise a `committed` row (bytes
  //     lazy-fetch via `getSliceBlob`).  Covers cross-tab uploads
  //     and re-syncs after IDB-quota GC.
  //   - local `committed` + daemon has it → preserve.
  //   - local `committed` + daemon missing → ORPHAN: GC the row
  //     and revoke its caches.  Most commonly: a previous session's
  //     batch-delete closed the tab between the daemon's terminal
  //     and `idbDeleteSlice`.
  //   - local `local` / `uploading` / `failed` → preserve.  These
  //     have no daemon presence by definition; `resumePending`
  //     re-queues them.
  // A 404 on the category dir is the empty case; other errors
  // surface on the list.
  async refresh(workspaceId: Uuid, categoryName: string, force = false): Promise<void> {
    const k = key(workspaceId, categoryName);
    const existing = this.lists.get(k);
    const stale = this.staleKeys.has(k);
    // Cache short-circuit.  Skip when the slice is loaded, error-
    // free, AND not flagged stale by the poller.  A `force=true`
    // caller bypasses every gate (used by the workspace-delete
    // cleanup path, never by routine reads).  Stale is cleared at
    // the end of the success branch below, so the second effect
    // pass triggered by that clear still short-circuits here.
    if (existing?.loaded && !force && !existing.error && !stale) return;
    if (existing?.loading && !force) return;

    this.lists.set(k, {
      ...EMPTY_LIST,
      entries: existing?.entries ?? [],
      loading: true,
      loaded: existing?.loaded ?? false
    });

    try {
      const [localRows, serverListing] = await Promise.all([
        listSlicesForCategory(workspaceId, categoryName),
        assets.listCategory(workspaceId, categoryName, { limit: 1000 }).catch((e: unknown) => {
          // A missing `datasets/<class>/` directory is the empty
          // case -- happens any time the operator added the
          // category but hasn't uploaded a slice yet.  Treat
          // 404 as an empty listing; let other errors propagate
          // so the slice list shows them.
          if (isNotFound(e)) {
            return { entries: [], total: 0, offset: 0, limit: 1000 };
          }
          throw e;
        })
      ]);

      // Forget-race guard (early).  The Promise.all above is the
      // longest await in this method (network listing + IDB
      // round-trip) and therefore the widest window for a
      // workspace-delete-driven `forget(workspaceId)` to land.
      // Bailing here skips the synthesised-rows `bulkPutSlices`
      // write below, which would otherwise commit IDB rows for a
      // workspace whose IDB is concurrently being wiped by
      // `deleteSlicesForWorkspace` -- leaving orphan rows that
      // linger across the workspace's lifetime.  A second,
      // matching guard lives just before the final `lists.set`
      // below to catch a forget that lands during the IDB-write
      // phase.
      if (!this.lists.has(k)) return;

      // `SvelteSet` / `SvelteMap` even though these are purely
      // function-local: the file's `.svelte.ts` extension makes
      // the `svelte/prefer-svelte-reactivity` lint rule eager
      // about reactive collections, and it doesn't have a path-
      // sensitivity model.  Same precedent as the `grouped` map
      // in `refreshForWorkspace` above.
      const serverFilenames = new SvelteSet<string>();
      for (const entry of serverListing.entries) {
        if (entry.kind === 'file' && entry.name.endsWith('.wav')) {
          serverFilenames.add(entry.name);
        }
      }

      // Split local rows into kept + orphans.  An orphan is a
      // local row whose `state` says it's been committed to the
      // daemon but the daemon's listing doesn't include the
      // file -- daemon-as-master wins, so the row is dropped.
      const kept: SliceRecord[] = [];
      const orphans: SliceRecord[] = [];
      const keptByFilename = new SvelteMap<string, SliceRecord>();
      for (const row of localRows) {
        if (row.state === 'committed' && !serverFilenames.has(row.filename)) {
          orphans.push(row);
        } else {
          kept.push(row);
          keptByFilename.set(row.filename, row);
        }
      }

      // Synthesise rows for daemon-only files.  Deterministic id
      // (`srv:<ws>:<cat>:<filename>`) keeps the row stable across
      // re-syncs so the IDB write idempotently overwrites.
      //
      // Batch every synthesised record into ONE IDB transaction
      // via `bulkPutSlices` instead of opening N independent
      // transactions in sequence -- on a cache-cleared session
      // with a 200-slice category that's a 200-tx-per-category
      // hit (~600-1000 ms) collapsing to one 30-50 ms tx.  The
      // batch is gathered synchronously here so the orphan-GC
      // step below can still run in parallel with it.
      const synthesised: SliceRecord[] = [];
      for (const entry of serverListing.entries) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.wav')) continue;
        if (keptByFilename.has(entry.name)) continue;
        const synthetic: SliceRecord = {
          id: `srv:${workspaceId}:${categoryName}:${entry.name}`,
          workspace_id: workspaceId,
          category_name: categoryName,
          filename: entry.name,
          blob: null,
          state: 'committed',
          created_at: entry.mtime
        };
        synthesised.push(synthetic);
        kept.push(synthetic);
      }
      if (synthesised.length > 0) {
        // Best-effort: a failed transaction (typically IDB quota)
        // leaves the in-memory list authoritative until the next
        // refresh.  Matches the old per-record `.catch` swallow.
        await bulkPutSlices(synthesised).catch(() => undefined);
      }

      // GC orphans.  IDB deletes parallelise (disjoint keys);
      // failures are swallowed because `kept` already excludes
      // orphans from the in-memory list -- a stuck IDB row is
      // harmless until the next refresh retries.
      if (orphans.length > 0) {
        const orphanIds = orphans.map((o) => o.id);
        await Promise.all(orphans.map((o) => idbDeleteSlice(o.id).catch(() => undefined)));
        revokeSliceSpectrograms(orphanIds);
        revokeSliceBlobs(orphanIds);
      }

      kept.sort(byCreatedAsc);
      // Forget-race guard: `forget(workspaceId)` may have cleared
      // this entry while we were awaiting the listing / IDB / orphan
      // deletes above.  If so, leave the Map empty rather than
      // recreating an entry for a workspace that no longer exists --
      // a leaked entry outlives the workspace deletion and would
      // shadow a same-id re-create (rare via local seed data, per
      // the matching guard for `mutationsInFlight` in `forget`).
      if (!this.lists.has(k)) return;
      this.lists.set(k, {
        entries: kept,
        loading: false,
        loaded: true,
        error: null
      });
      // Reconcile against the daemon succeeded -- clear the stale
      // mark so the SlicePane's effect stops re-firing.  Order
      // matters: the `lists.set` above is untracked by the per-
      // category effect (it tracks `isStale` only) and the
      // `staleKeys.delete` here is the single notification that
      // settles the dependency graph.
      this.staleKeys.delete(k);
    } catch (e) {
      // Same guard as the success path -- a forget mid-await
      // shouldn't be papered over with a stale error entry.
      if (!this.lists.has(k)) return;
      this.lists.set(k, {
        entries: existing?.entries ?? [],
        loading: false,
        loaded: existing?.loaded ?? true,
        error: errorCopy(e)
      });
    }
  }

  // ── Upload pipeline ──────────────────────────────────────────
  //
  // Local slices flow through `uploadPool` (capped at
  // `MAX_CONCURRENT_UPLOADS`).  Each task drives the slice through
  // `local → uploading → committed | failed`; XHR progress events
  // patch the in-memory record so SliceCards render the progress
  // ring without an IDB round-trip per byte.

  // Enqueue an upload by slice id.  Idempotent: a re-entry for an
  // already-uploading slice is a no-op (the abort controller is
  // the source of truth).  Returned promise resolves on commit
  // (or rejects on failure / cancel) so callers can chain.
  enqueueUpload(sliceId: string): Promise<void> {
    if (this.inflightUploads.has(sliceId)) {
      return Promise.resolve();
    }
    return this.uploadPool.submit(() => this.runUpload(sliceId));
  }

  // Re-queue every pending slice in a workspace -- the cross-reload
  // recovery path.  `enqueueUpload` dedupes against in-flight ids
  // so re-firing this for a batch already draining the pool is a
  // no-op.  Daemon PUT is idempotent (same body -> same final
  // state) so a previous session's `uploading` row is safe to
  // re-attempt.
  resumePending(workspaceId: Uuid): void {
    for (const slice of this.pendingFor(workspaceId)) {
      void this.enqueueUpload(slice.id);
    }
  }

  private async runUpload(sliceId: string): Promise<void> {
    const slice = this.findSliceById(sliceId);
    if (!slice) return; // deleted before the upload could start
    if (!slice.blob || slice.blob.size === 0) {
      // Defensive: should not happen for local / failed slices.
      // Mark failed so the operator sees the stall instead of a
      // silent no-op.
      await this.markFailed(slice, 'No local bytes to upload.');
      return;
    }

    const controller = new AbortController();
    this.inflightUploads.set(sliceId, controller);
    // Bracket the entire upload as one in-flight mutation against
    // the workspace so the poller defers its revision check while
    // any of our PUTs are racing the daemon's revision counter.
    // The bracket is on the workspace (not the slice) because the
    // revision lives at workspace granularity; a batch of 10
    // slices counts as 10 mutations and the poller waits until
    // all are settled.
    this.beginMutation(slice.workspace_id);

    try {
      await this.markUploading(slice);

      const url = assets.slicePutPath(slice.workspace_id, slice.category_name, slice.filename);
      // Retry loop.  Slice stays `uploading` across attempts (no
      // per-attempt IDB rewrite).  Backoff runs INSIDE the pool
      // slot so a transient-failing slice doesn't oscillate
      // between attempting and queued -- worst case ~10-12 s held
      // before final failure, still a small fraction of any
      // real-world batch's drain time.
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= UPLOAD_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          // Reset visible progress so the eye reads "new attempt"
          // rather than a stale partial byte; memory-only so no
          // IDB write.
          this.setProgress(sliceId, 0);
          const wait = Math.min(
            UPLOAD_RETRY_BASE_MS * Math.pow(2, attempt - 2),
            UPLOAD_RETRY_MAX_MS
          );
          // ±25 % jitter so concurrent slot failures don't re-fire
          // on the same daemon event.
          const jittered = wait * (0.75 + Math.random() * 0.5);
          try {
            await sleepAbortable(jittered, controller.signal);
          } catch {
            // Aborted by delete / forget / clearForCategory.  No
            // state-machine update -- caller already cleaned up.
            return;
          }
        }
        try {
          const receipt = await xhrPut<AssetReceipt>({
            url,
            body: slice.blob,
            contentType: 'audio/wav',
            onProgress: (loaded, total) => {
              if (total > 0) this.setProgress(sliceId, loaded / total);
            },
            signal: controller.signal
          });
          // Funnel into the single monotonic-up writer.  The
          // workspace detail's "live" revision chip + the
          // poller's "did revision advance" gate both read from
          // the same map; routing every writer through one
          // setter keeps the invariant in one place.
          this.setRevisionAtLeast(slice.workspace_id, receipt.workspace_revision_id);
          await this.markCommitted(slice, receipt.workspace_revision_id);
          return;
        } catch (e) {
          if (controller.signal.aborted) {
            // Cancelled mid-transfer.  Same shape as the abort-
            // during-backoff branch above.
            return;
          }
          lastError = e;
          if (!isTransientUploadError(e)) {
            // Permanent failure (4xx other than 429: bad
            // request, not-found, conflict, etc.).  No point in
            // burning more attempts -- bail out and let the
            // operator decide.
            break;
          }
          // Transient -- fall through to the next loop iteration
          // (or out of the loop if we've exhausted attempts).
        }
      }

      await this.markFailed(slice, errorCopy(lastError));
    } finally {
      this.inflightUploads.delete(sliceId);
      this.endMutation(slice.workspace_id);
    }
  }

  // ── Slice-record mutations + IDB persistence ─────────────────

  // Locate a slice by id across every per-workspace+category
  // list.  O(N) over the entire cache; fine for our scale (low
  // hundreds of slices per session).
  private findSliceById(sliceId: string): SliceRecord | undefined {
    for (const list of this.lists.values()) {
      for (const entry of list.entries) {
        if (entry.id === sliceId) return entry;
      }
    }
    return undefined;
  }

  // Replace an in-memory slice with a transformed copy.  Writes
  // a fresh `entries` array so SvelteMap notifies subscribers.
  // Returns the next record so callers can chain (e.g. persist
  // to IDB).
  private patchInMemory(
    sliceId: string,
    transform: (s: SliceRecord) => SliceRecord
  ): SliceRecord | undefined {
    for (const [k, list] of this.lists) {
      const idx = list.entries.findIndex((s) => s.id === sliceId);
      if (idx < 0) continue;
      const next = transform(list.entries[idx]);
      const entries = list.entries.slice();
      entries[idx] = next;
      this.lists.set(k, { ...list, entries });
      return next;
    }
    return undefined;
  }

  private async markUploading(slice: SliceRecord): Promise<void> {
    const next = this.patchInMemory(slice.id, (s) => ({
      ...s,
      state: 'uploading',
      upload_progress: 0,
      last_error: undefined
    }));
    if (next) await putSlice(next).catch(() => undefined);
  }

  private setProgress(sliceId: string, progress: number): void {
    // Memory-only -- IDB-writing every progress tick would
    // thrash the IDB transaction log.  The SliceCard reads from
    // memory so the ring still animates smoothly.
    this.patchInMemory(sliceId, (s) => ({ ...s, upload_progress: progress }));
  }

  private async markCommitted(slice: SliceRecord, revisionId: number): Promise<void> {
    // Drop the blob to free origin quota; the daemon now holds
    // the canonical copy.  In-memory record carries `blob: null`
    // too so subsequent renders / plays go through
    // `getSliceBlob`'s lazy-fetch path.
    const next = this.patchInMemory(slice.id, (s) => ({
      ...s,
      state: 'committed',
      blob: null,
      upload_progress: undefined,
      last_error: undefined,
      workspace_revision_id: revisionId
    }));
    if (next) await putSlice(next).catch(() => undefined);
  }

  private async markFailed(slice: SliceRecord, error: string): Promise<void> {
    const next = this.patchInMemory(slice.id, (s) => ({
      ...s,
      state: 'failed',
      upload_progress: undefined,
      last_error: error
    }));
    if (next) await putSlice(next).catch(() => undefined);
  }

  // Append a fresh slice.  The Slice action calls this N times per
  // click; each call appends one row (no batching) so a partial
  // failure (e.g. IDB quota) leaves the prior slices visible.
  //
  // Dedupe by id before tail-inserting: if `refreshForWorkspace` (or
  // a per-category `refresh`) ran concurrently, its IDB walk would
  // have seen our `putSlice` commit and folded the row into the
  // refreshed list -- so a naive append would duplicate it.  The
  // check is O(N) in entries length; entries.length is bounded by
  // MAX_SLICES_PER_CATEGORY so the cost is trivial.
  async append(record: SliceRecord): Promise<void> {
    await putSlice(record);
    const k = key(record.workspace_id, record.category_name);
    const existing = this.lists.get(k);
    const baseEntries = existing?.entries ?? [];
    const entries = baseEntries.some((s) => s.id === record.id)
      ? baseEntries
      : [...baseEntries, record];
    // Tail insert preserves `created_at` ascending order (IDB query
    // sorts the same way; the cache mirrors it).
    this.lists.set(k, {
      ...EMPTY_LIST,
      entries,
      loaded: true,
      loading: false,
      error: null
    });
  }

  // Remove a single slice.  Three paths fan out:
  //   1. In-flight upload: abort the XHR.  The runUpload's
  //      `signal.aborted` branch skips the state-machine update
  //      so we don't write `failed` over the row we're about to
  //      delete.
  //   2. `committed` row with a `workspace_revision_id`: the
  //      file exists on the daemon; fire `DELETE
  //      /assets/datasets/<class>/<filename>` through the
  //      global delete queue + await its SSE terminal.
  //   3. `local` / `uploading` (post-abort) / `failed`: no
  //      daemon-side presence; just drop the IDB row + caches.
  //
  // All three revoke spectrogram + blob caches in lock-step so
  // the browser GCs the underlying canvas + WAV bytes the moment
  // the row disappears from the grid.
  async delete(record: SliceRecord): Promise<void> {
    // Idempotency guard: a re-entrant `delete()` (keyboard Enter on
    // a focused button, double-fire from a stale queue) is a no-op.
    // The pane-side `deletingIds` gates are the primary defence;
    // this is the store-side belt-and-braces.
    if (this.deletingIds.has(record.id)) return;
    // Mark up front so every consumer (card gray-out, selection
    // mutators, batch filter) sees the row as off-limits before
    // any async work fires.  `finally` clears unconditionally so
    // a one-off failure never strands the card in a tombstone.
    this.deletingIds.add(record.id);
    // Only a committed row's delete advances the daemon's
    // revision (the others are pure-local cleanup).  Capture the
    // flag up front so the finally bracket is symmetric across
    // every early-return path.
    const remoteDelete = record.state === 'committed';
    if (remoteDelete) this.beginMutation(record.workspace_id);
    try {
      const controller = this.inflightUploads.get(record.id);
      if (controller) {
        controller.abort();
        this.inflightUploads.delete(record.id);
      }
      if (remoteDelete) {
        try {
          await enqueueDelete(() => this.runRemoteDelete(record));
        } catch (e) {
          // Re-throw and skip local cleanup: the daemon still has
          // the file, and dropping the IDB row would just have the
          // next refresh re-synthesise it -- a sync fight.  Operator
          // sees the row back in its prior state and can retry.
          console.warn('[slices] remote delete failed', e);
          throw e;
        }
      }
      await idbDeleteSlice(record.id);
      revokeSliceSpectrograms([record.id]);
      revokeSliceBlobs([record.id]);
      const k = key(record.workspace_id, record.category_name);
      const existing = this.lists.get(k);
      if (!existing) return;
      this.lists.set(k, {
        ...existing,
        entries: existing.entries.filter((s) => s.id !== record.id)
      });
    } finally {
      this.deletingIds.delete(record.id);
      if (remoteDelete) this.endMutation(record.workspace_id);
    }
  }

  // Bulk-delete a snapshot of slice records.  Fans out to
  // `delete()` per record so the same 3-path branch (in-flight
  // abort / committed DELETE / local IDB cleanup) runs untouched.
  // Committed slices serialise through `enqueueDelete` (daemon
  // `max_delete_jobs = 1`); local-only deletes parallelise on
  // disjoint IDB keys.  Failures are captured per-target so the
  // caller can surface them and retry survivors -- SlicePane
  // re-selects failed ids; the workspaces store does the same.
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
          failed.push({ id: record.id, filename: record.filename, error: message });
        }
      })
    );
    return { succeeded, failed };
  }

  // Run the daemon-side DELETE + await its async job terminal.
  // Same SSE-terminal contract as the workspace + category delete
  // paths -- consistent across the delete family.
  private async runRemoteDelete(slice: SliceRecord): Promise<void> {
    const ack = await assets.deleteSlice(slice.workspace_id, slice.category_name, slice.filename);
    await awaitJobTerminal(ack.job_id);
  }

  // Bulk-drop every slice for a `(workspace_id, category_name)`
  // pair.  Called from the categories-store delete path so a
  // category removal scrubs the slice list in lock-step with the
  // category row.  Aborts every in-flight upload for the
  // category first (no point in racing the daemon's category
  // wipe), then revokes the caches.
  //
  // The daemon-side DELETE is already wired by the categories
  // store (it issues `DELETE /assets/datasets/<class>` for
  // server-side categories); this helper only handles the local
  // IDB + cache cleanup.
  async clearForCategory(workspaceId: Uuid, categoryName: string): Promise<void> {
    const existing = this.lists.get(key(workspaceId, categoryName));
    if (existing && existing.entries.length > 0) {
      for (const slice of existing.entries) {
        const controller = this.inflightUploads.get(slice.id);
        if (controller) {
          controller.abort();
          this.inflightUploads.delete(slice.id);
        }
      }
      const ids = existing.entries.map((s) => s.id);
      revokeSliceSpectrograms(ids);
      revokeSliceBlobs(ids);
    }
    await deleteSlicesForCategory(workspaceId, categoryName);
    const k = key(workspaceId, categoryName);
    this.lists.set(k, {
      ...EMPTY_LIST,
      loaded: true
    });
    // Just wiped the category locally; any prior stale mark from
    // a poller advance is now moot -- a refresh would just walk
    // an empty IDB partition + (404 → empty) daemon listing.
    this.staleKeys.delete(k);
  }

  // Drop in-memory cache entries for a workspace.  Pairs with
  // `deleteSlicesForWorkspace` in the workspace-delete cleanup:
  // the IDB rows go away on disk, and these in-memory keys (which
  // would point at dead state) get forgotten too.  Aborts every
  // in-flight upload for the affected scope; revokes spectrogram
  // + blob caches so the browser GCs both image and WAV bytes.
  forget(workspaceId: Uuid, categoryName?: string): void {
    const drop = (k: string): void => {
      const list = this.lists.get(k);
      if (list && list.entries.length > 0) {
        const ids = list.entries.map((s) => s.id);
        for (const id of ids) {
          const controller = this.inflightUploads.get(id);
          if (controller) {
            controller.abort();
            this.inflightUploads.delete(id);
          }
        }
        revokeSliceSpectrograms(ids);
        revokeSliceBlobs(ids);
      }
      this.lists.delete(k);
      this.staleKeys.delete(k);
    };
    if (categoryName !== undefined) {
      drop(key(workspaceId, categoryName));
      return;
    }
    const prefix = `${workspaceId} `;
    for (const k of Array.from(this.lists.keys())) {
      if (k.startsWith(prefix)) drop(k);
    }
    this.workspacesLoaded.delete(workspaceId);
    this.latestRevisions.delete(workspaceId);
    // Defensive: drop any residual mutation count.  Real flows
    // can't leak here (uploads + deletes bracket via `finally`),
    // but a workspace-delete that fires while a slice upload was
    // mid-stream would still see this counter > 0 -- without the
    // explicit clear, the next workspace using the same id (rare
    // but not impossible via local seed data) would inherit a
    // stale gate that pauses its poller indefinitely.
    this.mutationsInFlight.delete(workspaceId);
    // Mirror cleanup for the reconcile in-flight flag.  A
    // workspace-delete observed mid-reconcile would otherwise
    // leave the flag set indefinitely (the reconcile's per-
    // category `refresh()` short-circuits as soon as `forget`
    // clears the lists, so the flag's `finally` does fire
    // eventually -- but the explicit clear here removes any
    // observability hazard for a same-id re-create).
    this.reconcilingWorkspaces.delete(workspaceId);
  }
}

export const slices = new SlicesStore();
