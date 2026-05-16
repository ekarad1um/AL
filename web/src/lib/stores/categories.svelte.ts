import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { assets } from '$lib/api/endpoints';
import { enqueueDelete } from '$lib/api/delete-queue';
import { awaitJobTerminal } from '$lib/api/jobs';
import { errorCopy } from '$lib/utils/error-copy';
import {
  deleteCategoryRecord,
  listCategoriesForWorkspace,
  putCategoryRecord
} from '$lib/idb/categories';
import { drafts } from '$lib/stores/drafts.svelte';
import { slices } from '$lib/stores/slices.svelte';
import { MANDATORY_BACKGROUND_NOISE, isMandatoryCategory } from '$lib/components/category/labels';
import { isNotFound } from '$lib/utils/error-copy';
import type { DatasetListing, Uuid } from '$lib/api/types';

// Reactive cache over the categories visible inside one workspace.
//
// Three sources merge into the single visible list:
//
//   1. Mandatory synthetic (`_background_noise_`): always present,
//      undeletable; lives in code, not in IDB.
//   2. Operator-added local categories: persisted to IDB
//      ([idb/categories.ts]).  Survives reload even if no slices
//      have been uploaded yet (the daemon wouldn't list an empty
//      directory).
//   3. Server-listed categories: directories that exist under
//      `<workspace>/datasets/` on the daemon.  Fetched lazily via
//      `assets.listDatasets`.
//
// Merge rule: dedupe by exact byte-equal name.  When a name appears
// in multiple sources, server > idb > mandatory for the `origin`
// field (purely informational; the UI doesn't distinguish today
// but B.6 may use `origin === 'idb'` to skip a server GET on
// expand).  Sort: mandatory first, then alphabetical.
//
// Per-workspace key (slice).  Reactivity discipline mirrors B.1's
// workspaces store: SvelteMap is reactive on `.set` / `.delete`,
// values are NOT deeply reactive -- every mutation replaces the
// slice with a fresh object reference.

export type CategoryOrigin = 'mandatory' | 'idb' | 'server';

export interface Category {
  name: string;
  origin: CategoryOrigin;
}

interface WorkspaceSlice {
  entries: Category[];
  // Single-expand UX: at most one category opens at a time.  Null
  // means "all collapsed".  Persisted only in memory (not IDB) --
  // expansion is a UI affordance, not durable state.
  expandedName: string | null;
  // Names currently undergoing an async DELETE on the daemon.  The
  // UI dims those rows + shows a "deleting" pill until the job's
  // SSE terminal lands.  `SvelteSet` keeps `slice.deleting.has(name)`
  // reactive against the cloned-replacement pattern used on the
  // surrounding slice.
  deleting: SvelteSet<string>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

const EMPTY_SLICE: Readonly<WorkspaceSlice> = Object.freeze({
  entries: [] as Category[],
  expandedName: null as string | null,
  deleting: new SvelteSet<string>(),
  loading: false,
  loaded: false,
  error: null as string | null
});

function sortCategories(entries: Category[]): Category[] {
  return entries.slice().sort((a, b) => {
    if (a.name === MANDATORY_BACKGROUND_NOISE) return -1;
    if (b.name === MANDATORY_BACKGROUND_NOISE) return 1;
    return a.name.localeCompare(b.name);
  });
}

function mergeSources(idbNames: string[], serverNames: string[]): Category[] {
  // Mandatory is always present; mark its origin explicitly so a
  // future B.6 check can short-circuit the server GET on the
  // mandatory row.
  // SvelteMap (not bare Map) because the file's `.svelte.ts`
  // extension makes the lint rule eager about reactive collections;
  // this Map is purely function-local but the rule doesn't have a
  // path-sensitivity model.
  const seen = new SvelteMap<string, Category>();
  seen.set(MANDATORY_BACKGROUND_NOISE, {
    name: MANDATORY_BACKGROUND_NOISE,
    origin: 'mandatory'
  });
  for (const name of idbNames) {
    if (!seen.has(name)) seen.set(name, { name, origin: 'idb' });
  }
  // Server wins on conflict -- a category that exists on disk is
  // canonical, regardless of whether IDB happens to know about it.
  for (const name of serverNames) {
    seen.set(name, {
      name,
      origin: name === MANDATORY_BACKGROUND_NOISE ? 'mandatory' : 'server'
    });
  }
  return sortCategories(Array.from(seen.values()));
}

class CategoriesStore {
  private slices = new SvelteMap<Uuid, WorkspaceSlice>();
  // Per-workspace stale set populated by the workspace poller on
  // revision advance.  Tracked separately from `slices` so the
  // CategoryList `$effect` can pick up the stale-bit alone
  // without re-firing on every internal `slices.set` write the
  // refresh / mutation paths make.
  private staleWorkspaces = new SvelteSet<Uuid>();

  // Read-only view.  Returns a stable frozen empty slice (not
  // undefined) so consumers can render without null guards; the
  // unloaded-vs-empty distinction lives on `loaded`.
  for(workspaceId: Uuid): WorkspaceSlice {
    return this.slices.get(workspaceId) ?? EMPTY_SLICE;
  }

  // Reactive query for the CategoryList effect.  Cheap; the
  // effect tracks this alone and runs refresh inside `untrack`.
  isStale(workspaceId: Uuid): boolean {
    return this.staleWorkspaces.has(workspaceId);
  }

  // Called by the workspace poller on revision advance.  Adds the
  // workspace to the stale set; CategoryList's effect re-fires
  // and a fresh /assets/datasets walk follows.  No-op if not
  // currently loaded -- a category list that was never loaded
  // can't be stale (there is nothing to invalidate).
  markStale(workspaceId: Uuid): void {
    if (this.slices.has(workspaceId)) this.staleWorkspaces.add(workspaceId);
  }

  // Fetch + merge IDB and server categories for `workspaceId`.
  // Short-circuits on already-loaded slices (mutations update the
  // slice directly so a re-read isn't needed) and on in-flight
  // refreshes.  `force` re-fetches regardless.
  //
  // The in-flight guard is correctness, not just perf: see
  // NOTES.md §"$effect + refresh() reactive-loop trap".  In short,
  // `$effect` tracks the synchronous `this.slices.get(...)` read
  // and the loading-flag write below invalidates it -- without the
  // guard the effect re-enters until Svelte's depth fuse trips.
  // Call sites pair this with `untrack(() => refresh(id))` as
  // belt-and-suspenders.
  async refresh(workspaceId: Uuid, force = false): Promise<void> {
    const existing = this.slices.get(workspaceId);
    const stale = this.staleWorkspaces.has(workspaceId);
    // Same shape as the slices store's short-circuit: skip on
    // loaded + error-free + not-stale; bypass on `force`; defer
    // re-entry while a refresh is in flight (the documented
    // reactive-loop guard).
    if (existing?.loaded && !force && !existing.error && !stale) return;
    if (existing?.loading && !force) return;

    // Optimistic loading slice: keep prior `entries` so the list
    // doesn't blink to empty mid-fetch; flip the `loading` flag for
    // any visible spinner.
    this.slices.set(workspaceId, {
      ...EMPTY_SLICE,
      entries: existing?.entries ?? [],
      expandedName: existing?.expandedName ?? null,
      deleting: existing?.deleting ?? new SvelteSet<string>(),
      loading: true,
      loaded: existing?.loaded ?? false
    });

    try {
      // Fan out IDB + server in parallel.  Both are read-only; no
      // ordering dependency.  `assets.listDatasets` returns 404 on
      // a fresh workspace because the daemon doesn't lay down the
      // `datasets/` directory at workspace-create time (it
      // materialises on the first slice upload).  Treat 404 as
      // "no server-side categories yet" so the mandatory +
      // operator-added rows still surface; any *other* error
      // propagates as before.
      const emptyListing: DatasetListing = {
        entries: [],
        total: 0,
        offset: 0,
        limit: 1000
      };
      const [idbRows, serverListing] = await Promise.all([
        listCategoriesForWorkspace(workspaceId),
        assets.listDatasets(workspaceId, { limit: 1000 }).catch((e: unknown) => {
          if (isNotFound(e)) return emptyListing;
          throw e;
        })
      ]);
      const idbNames = idbRows.map((r) => r.name);
      // Only directory entries are categories.  The daemon's
      // dataset tree is dirs all the way (no top-level files), but
      // filter defensively so a future stray file (e.g. an
      // operator-mode .DS_Store) doesn't render as a category.
      // The wire token is `"directory"` per the daemon's
      // `EntryKind` serde rename -- see [api/types.ts] for the
      // history of the earlier `"dir"` mistake.
      const serverNames = serverListing.entries
        .filter((e) => e.kind === 'directory')
        .map((e) => e.name);

      // Forget-race guard: `forget(workspaceId)` may have cleared
      // this entry during the Promise.all above (workspace-delete
      // chain).  If so, leave the Map empty rather than recreating
      // an entry for a workspace that no longer exists.  Mirrors
      // the same pattern in `slices.svelte.ts::refresh`.
      if (!this.slices.has(workspaceId)) return;
      this.slices.set(workspaceId, {
        ...EMPTY_SLICE,
        entries: mergeSources(idbNames, serverNames),
        expandedName: existing?.expandedName ?? null,
        deleting: existing?.deleting ?? new SvelteSet<string>(),
        loading: false,
        loaded: true,
        error: null
      });
      // Reconcile succeeded -- drop the stale mark.  Settles
      // CategoryList's tracked `isStale` dep so its re-fire on
      // this clear short-circuits on the next refresh entry.
      this.staleWorkspaces.delete(workspaceId);
    } catch (e) {
      // Same forget-race guard as the success path.
      if (!this.slices.has(workspaceId)) return;
      this.slices.set(workspaceId, {
        ...EMPTY_SLICE,
        entries: existing?.entries ?? mergeSources([], []),
        expandedName: existing?.expandedName ?? null,
        deleting: existing?.deleting ?? new SvelteSet<string>(),
        loading: false,
        loaded: existing?.loaded ?? true,
        error: errorCopy(e)
      });
    }
  }

  // Add a category.  Validates against the existing entries; the
  // caller is responsible for AssetPath shape validation via
  // `validateCategoryName` (this method only checks uniqueness so a
  // duplicate-name error has a single source of truth).
  //
  // The new row lands in IDB so it survives reload even with no
  // slices uploaded; the merge logic on next refresh keeps it
  // visible.  If/when the operator uploads slices and the daemon
  // starts listing the directory, the merge still works (server
  // wins on conflict).
  async create(workspaceId: Uuid, name: string): Promise<void> {
    const existing = this.slices.get(workspaceId);
    if (existing?.entries.some((c) => c.name === name)) {
      throw new Error('A category with this name already exists.');
    }
    await putCategoryRecord({
      workspace_id: workspaceId,
      name,
      created_at: new Date().toISOString()
    });
    // Forget-race guard: `forget(workspaceId)` may have cleared
    // this entry during the IDB write above (cross-tab workspace
    // delete).  Bail rather than recreate an entry from the
    // pre-await `existing` snapshot for a workspace that no
    // longer exists in-memory.  The IDB row written above is
    // wiped by `deleteCategoriesForWorkspace` later in the
    // workspace-delete chain.
    if (!this.slices.has(workspaceId)) return;
    const newCat: Category = { name, origin: 'idb' };
    const entries = sortCategories([...(existing?.entries ?? []), newCat]);
    this.slices.set(workspaceId, {
      ...EMPTY_SLICE,
      entries,
      expandedName: existing?.expandedName ?? null,
      deleting: existing?.deleting ?? new SvelteSet<string>(),
      loaded: true,
      loading: false,
      error: null
    });
  }

  // Delete a category.  Three paths:
  //
  // 1. Mandatory: rejected.  The UI gates this too; defence in depth.
  // 2. IDB-only (no slices on disk yet): drop the IDB row.  No
  //    daemon round-trip needed.
  // 3. Server-side (`origin === 'server'`): fire `DELETE /assets/
  //    datasets/<class>` through the global delete queue, await SSE
  //    terminal, then drop both server and IDB representations.
  async delete(workspaceId: Uuid, name: string): Promise<void> {
    if (isMandatoryCategory(name)) {
      throw new Error('Background Noise is required and cannot be deleted.');
    }
    const slice = this.slices.get(workspaceId);
    const target = slice?.entries.find((c) => c.name === name);
    if (!slice || !target) throw new Error('Category not found.');

    if (target.origin === 'idb') {
      await deleteCategoryRecord(workspaceId, name);
      // Drop any in-progress draft + any locally-produced slices
      // so they don't outlive their category and become orphans
      // in IDB.  IDB-only categories can only ever have draft +
      // local slices (no upload by definition), so this is
      // mandatory cleanup, not optional.
      await drafts.clear(workspaceId, name).catch(() => undefined);
      await slices.clearForCategory(workspaceId, name).catch(() => undefined);
      // Forget-race guard: re-read the slice after the awaits
      // above.  If `forget(workspaceId)` cleared this workspace
      // (cross-tab workspace delete), `fresh` is undefined --
      // bail rather than recreate the entry from the stale
      // `slice` capture.  The server-side path below uses the
      // same `fresh && set` pattern; this branch was the lone
      // outlier.
      const fresh = this.slices.get(workspaceId);
      if (!fresh) return;
      this.slices.set(workspaceId, {
        ...fresh,
        entries: fresh.entries.filter((c) => c.name !== name),
        expandedName: fresh.expandedName === name ? null : fresh.expandedName
      });
      return;
    }

    // Server-side delete.  Mark `deleting`, run through the global
    // queue, then clean up on success.  On failure leave the row
    // visible and rethrow so the caller's banner surfaces.
    const startingDeleting = new SvelteSet(slice.deleting);
    startingDeleting.add(name);
    this.slices.set(workspaceId, { ...slice, deleting: startingDeleting });
    // Bracket the daemon-side delete so the workspace poller
    // defers its revision check while the DELETE job is in flight.
    // The slices store owns the in-flight counter (the upload
    // pipeline brackets there) so the poller has one source of
    // truth across slice + category mutations.
    slices.beginMutation(workspaceId);

    try {
      await enqueueDelete(() => this.runRemoteDelete(workspaceId, name));
      // Drop the IDB shadow too if it happens to exist (operator
      // added locally, then uploaded slices, then deleted).
      await deleteCategoryRecord(workspaceId, name).catch(() => undefined);
      // Drop the per-category draft + slices for the same reason
      // -- the category folder is gone server-side, and its IDB
      // shadow would be inaccessible from any UI surface anyway.
      await drafts.clear(workspaceId, name).catch(() => undefined);
      await slices.clearForCategory(workspaceId, name).catch(() => undefined);
      const fresh = this.slices.get(workspaceId);
      if (fresh) {
        const deleting = new SvelteSet(fresh.deleting);
        deleting.delete(name);
        this.slices.set(workspaceId, {
          ...fresh,
          entries: fresh.entries.filter((c) => c.name !== name),
          expandedName: fresh.expandedName === name ? null : fresh.expandedName,
          deleting
        });
      }
    } catch (e) {
      const fresh = this.slices.get(workspaceId);
      if (fresh) {
        const deleting = new SvelteSet(fresh.deleting);
        deleting.delete(name);
        this.slices.set(workspaceId, { ...fresh, deleting });
      }
      throw e;
    } finally {
      slices.endMutation(workspaceId);
    }
  }

  private async runRemoteDelete(workspaceId: Uuid, name: string): Promise<void> {
    const ack = await assets.deleteCategory(workspaceId, name);
    await awaitJobTerminal(ack.job_id);
  }

  // Single-expand UX: clicking another row collapses any prior
  // expansion.  Passing the currently-expanded name closes it.
  toggleExpand(workspaceId: Uuid, name: string): void {
    const slice = this.slices.get(workspaceId);
    if (!slice) return;
    const next = slice.expandedName === name ? null : name;
    this.slices.set(workspaceId, { ...slice, expandedName: next });
  }

  // Explicit collapse.  Used by the AddCategory flow after a fresh
  // category is created -- we'd rather drop the operator into the
  // new (collapsed) row than auto-expand and surprise them.
  collapseAll(workspaceId: Uuid): void {
    const slice = this.slices.get(workspaceId);
    if (!slice) return;
    if (slice.expandedName !== null) {
      this.slices.set(workspaceId, { ...slice, expandedName: null });
    }
  }

  // Drop all per-workspace state.  Called from the workspace-delete
  // chain in [stores/workspaces.svelte.ts] alongside the matching
  // `forget` calls on the drafts / slices / training stores so a
  // long session doesn't accumulate orphan SvelteMap entries for
  // deleted workspaces.  No IDB cleanup here -- that's the
  // `deleteCategoriesForWorkspace` step the chain awaits next.
  // The `refresh` forget-race guards above prevent a concurrent
  // in-flight refresh from re-creating this entry post-clear.
  forget(workspaceId: Uuid): void {
    this.slices.delete(workspaceId);
    this.staleWorkspaces.delete(workspaceId);
  }
}

export const categories = new CategoriesStore();
