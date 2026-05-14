import { SvelteSet } from 'svelte/reactivity';
import { workspaces as workspacesApi } from '$lib/api/endpoints';
import { awaitJobTerminal } from '$lib/api/jobs';
import { enqueueDelete } from '$lib/api/delete-queue';
import { deleteCategoriesForWorkspace } from '$lib/idb/categories';
import { deleteDraftsForWorkspace } from '$lib/idb/drafts';
import { deleteSlicesForWorkspace } from '$lib/idb/slices';
import { drafts as draftsStore } from '$lib/stores/drafts.svelte';
import { slices as slicesStore } from '$lib/stores/slices.svelte';
import { capFirst, errorCopy } from '$lib/utils/error-copy';
import type {
  WorkspaceCreateReq,
  WorkspaceListEntry,
  WorkspaceMutationResp,
  WorkspacePatchReq,
  Uuid
} from '$lib/api/types';

// Converter workspaces are auto-named `converter-<uuid8>` by the
// Converter Tab wizard.  The Workspace Tab filters them out by this
// prefix because the daemon's `GET /workspace` list response omits
// the `tags` field, so we cannot match `tags.includes('__converter__')`
// at this layer (see web/docs/PLAN.md commentary).  The `__converter__`
// tag is still set on creation -- it's the canonical source-of-truth
// at detail / mutation level; the prefix here is purely a list-render
// hint that avoids an N+1 detail fetch.
export const CONVERTER_NAME_PREFIX = 'converter-';

// Operator-facing cap on the number of workspaces a single
// installation can carry.  16 is loose enough to cover the typical
// "one workspace per category + a few experiments" scenario, tight
// enough to keep the list scrollable + readable.  The daemon has
// no such cap; this is purely a UI guideline.  Going past it would
// signal a workflow problem (operator hoarding stale workspaces);
// the UI nudges them to delete first.
export const MAX_WORKSPACES = 16;

function isConverter(entry: WorkspaceListEntry): boolean {
  return entry.name.startsWith(CONVERTER_NAME_PREFIX);
}

// Sort newest-first by created_at.  RFC3339 timestamps sort
// lexicographically the same as chronologically, so a string compare
// is correct without parsing.  The daemon's `list_workspaces` is
// insertion-ordered, which is not what an operator wants in a UI.
function byCreatedDesc(a: WorkspaceListEntry, b: WorkspaceListEntry): number {
  if (a.created_at === b.created_at) return 0;
  return a.created_at < b.created_at ? 1 : -1;
}

// Per-target failure record returned from `deleteSelected`.  Each
// failure carries the workspace it was trying to delete plus a
// localized message so the calling dialog can surface them inline.
export interface BulkDeleteFailure {
  id: Uuid;
  name: string;
  error: string;
}

export interface BulkDeleteOutcome {
  succeeded: number;
  failed: BulkDeleteFailure[];
}

class WorkspacesStore {
  // Unfiltered list as last received from the daemon (already sorted
  // newest-first).  Two $derived views below split it for the two
  // tabs.  Keeping the raw set lets the Converter Tab read the same
  // store without duplicating fetches.
  all = $state<WorkspaceListEntry[]>([]);
  // Workspace ids with an in-flight `DELETE` job.  The list UI dims
  // the card and shows a "deleting…" badge while the id is here.
  // `SvelteSet` is reactive on mutation, so callers just `.add()` /
  // `.delete()` instead of replacing the reference.
  deleting = new SvelteSet<Uuid>();
  // Operator-driven selection for batch actions on the list view.
  // `selectedEntries` re-derives from `all`, so ids deleted in
  // another tab silently drop on the next refresh tick.
  selected = new SvelteSet<Uuid>();
  // Explicit list-page interaction mode.  Default `normal` -- the
  // operator browses + opens workspaces.  `selecting` -- the
  // operator is curating a batch: checkboxes are visible, card-
  // body clicks toggle selection instead of navigating, and the
  // sticky toolbar surfaces the count + bulk actions.  Lives on
  // the store (not the page) because the right-click menu also
  // needs to read / mutate it, and a singleton mode is simpler
  // than threading it through props.
  mode = $state<'normal' | 'selecting'>('normal');
  loading = $state(false);
  // False until `refresh()` has resolved at least once.  Distinguishes
  // "first paint, no data yet" from "we asked, the list really is empty"
  // so the UI can show a Spinner vs. an EmptyState.
  loaded = $state(false);
  // Last refresh error, surfaced inline (e.g. on a "Daemon unavailable"
  // banner).  Per-mutation errors surface inline in each dialog --
  // a global toast surface arrives in Slice E.
  error = $state<string | null>(null);

  // Operator-facing list (Workspace tab).  Drops converter-prefixed
  // names.  Workspaces with a delete job in flight stay in the list
  // with a "deleting…" affordance until the job lands -- the card
  // reads `deleting.has(id)` to render that state.  Premature
  // removal would make the operator feel the click "worked"
  // instantly, then surprise them on failure-driven re-appearance.
  entries = $derived(this.all.filter((w) => !isConverter(w)));

  // Converter-only list (Converter tab in Slice D).
  converterEntries = $derived(this.all.filter(isConverter));

  // Currently-selected entries, intersected with the live list so a
  // workspace deleted out from under us silently drops from the set
  // on the next refresh tick (we never have to manually prune).
  selectedEntries = $derived(this.all.filter((w) => this.selected.has(w.id)));

  async refresh(): Promise<void> {
    this.loading = true;
    try {
      const list = await workspacesApi.list();
      // Defensive copy + sort.  The API helper returns a fresh array
      // already, but sorting in place would be a $state-violation in
      // strict mode and the explicit slice makes that obvious.
      this.all = list.slice().sort(byCreatedDesc);
      this.error = null;
    } catch (e) {
      this.error = errorCopy(e);
    } finally {
      this.loading = false;
      this.loaded = true;
    }
  }

  // Re-throws so the create dialog can show an inline error banner.
  // Optimistic insert lets the operator see the new card immediately
  // without waiting for the next list refresh; `tags` is stripped
  // because the list entry shape doesn't carry them.
  async create(req: WorkspaceCreateReq): Promise<WorkspaceMutationResp> {
    const resp = await workspacesApi.create(req);
    const entry: WorkspaceListEntry = {
      id: resp.id,
      name: resp.name,
      created_at: resp.created_at
    };
    this.all = [entry, ...this.all.filter((w) => w.id !== entry.id)].sort(byCreatedDesc);
    return resp;
  }

  // Used by both rename and tag edits, flowing through `PATCH
  // /workspace/{id}`.  `created_at` doesn't change on patch so sort
  // order stays stable.  Re-throws so callers can surface inline.
  async patch(id: Uuid, req: WorkspacePatchReq): Promise<WorkspaceMutationResp> {
    const resp = await workspacesApi.patch(id, req);
    this.all = this.all.map((w) =>
      w.id === id ? { id: resp.id, name: resp.name, created_at: resp.created_at } : w
    );
    return resp;
  }

  // Workspace deletes flow through the global `enqueueDelete` queue
  // ([api/delete-queue.ts]) so they serialise with the daemon's
  // single delete-family slot (`max_delete_jobs = 1`).  The queue
  // covers `WorkspaceDelete` + `DatasetDelete` + `ConverterDelete`
  // + `*LogsDelete`, so categories / slices in B.2+ share the same
  // chain without a separate local queue.

  // Public single-item delete.  Awaits the full lifecycle (queue ->
  // DELETE ack -> SSE terminal) so the caller knows whether the
  // workspace is actually gone.  Throws on any failure path.
  async delete(id: Uuid): Promise<void> {
    await enqueueDelete(() => this.runDelete(id));
  }

  private async runDelete(id: Uuid): Promise<void> {
    // Bracket the entire deletion (ack-stage + drain) as one
    // workspace mutation so the detail page's poller defers its
    // revision check until we're settled.  The daemon renames the
    // workspace tree under the per-workspace mutex BEFORE the 202
    // ack returns, so without this bracket the poller could fire
    // a 404 between our `workspacesApi.delete` ack and the
    // dialog's success flow -- flashing an EmptyState behind the
    // still-open dialog.  `slicesStore.forget(id)` on the success
    // path also clears the counter, so the outer `endMutation`
    // becomes a defensive no-op in that branch.
    slicesStore.beginMutation(id);
    try {
      const ack = await workspacesApi.delete(id);
      this.deleting.add(id);
      try {
        await awaitJobTerminal(ack.job_id);
        // Terminal succeeded: drop from list + selection, then GC the
        // per-workspace IDB rows (categories + drafts + slices) so a
        // long session doesn't accumulate orphan blobs (slices alone
        // are ~88 KB each).  IDB failures here are housekeeping --
        // swallowed because the daemon-side delete is the load-
        // bearing one and a stale local row reaches no UI surface.
        this.all = this.all.filter((w) => w.id !== id);
        this.selected.delete(id);
        draftsStore.forget(id);
        slicesStore.forget(id);
        await Promise.all([
          deleteCategoriesForWorkspace(id).catch(() => 0),
          deleteDraftsForWorkspace(id).catch(() => 0),
          deleteSlicesForWorkspace(id).catch(() => 0)
        ]);
      } catch (e) {
        // Terminal failure leaves the workspace on disk -- refresh
        // so the list reflects truth.  Re-throw for the queue caller.
        void this.refresh();
        throw e;
      } finally {
        this.deleting.delete(id);
      }
    } finally {
      slicesStore.endMutation(id);
    }
  }

  // Selection helpers ------------------------------------------------

  toggleSelect(id: Uuid): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
  }

  // Select every operator-visible entry not already in `deleting`
  // (deleting entries are on the way out).  Converter-prefixed
  // entries are excluded via `this.entries` so a Workspace-tab
  // "Select all" never accidentally bulk-deletes converter
  // workspaces hidden from view.
  selectAllVisible(): void {
    for (const w of this.entries) {
      if (!this.deleting.has(w.id)) this.selected.add(w.id);
    }
  }

  clearSelection(): void {
    this.selected.clear();
  }

  // Mode transitions ------------------------------------------------

  enterSelecting(): void {
    if (this.mode !== 'selecting') this.mode = 'selecting';
  }

  exitSelecting(): void {
    if (this.mode !== 'normal') {
      this.mode = 'normal';
      // Selection state is meaningless once the operator leaves
      // selecting mode -- a fresh entry should start from empty
      // rather than inheriting whatever was checked last time.
      this.clearSelection();
    }
  }

  // Bulk delete -----------------------------------------------------

  // Fires DELETE for every workspace in `targets` (defaults to the
  // current selection).  Clears the selection eagerly so the
  // operator can't double-fire by clicking the bulk button twice.
  // Returns the per-target outcome; failures re-enter the selection
  // so the operator can retry from the toolbar without hunting them.
  async deleteSelected(
    targets: WorkspaceListEntry[] = this.selectedEntries.slice()
  ): Promise<BulkDeleteOutcome> {
    this.clearSelection();

    const failed: BulkDeleteFailure[] = [];
    let succeeded = 0;
    // Enqueue them all -- the internal queue serializes so each one
    // waits for the daemon's previous WorkspaceDelete to terminate
    // before its own DELETE fires.  We just need to await the
    // terminals and tally the outcomes.
    await Promise.all(
      targets.map(async (entry) => {
        try {
          await enqueueDelete(() => this.runDelete(entry.id));
          succeeded++;
        } catch (e) {
          const message =
            e instanceof Error && e.message ? capFirst(e.message, 'Delete failed.') : errorCopy(e);
          failed.push({ id: entry.id, name: entry.name, error: message });
        }
      })
    );

    for (const f of failed) this.selected.add(f.id);

    return { succeeded, failed };
  }
}

export const workspaces = new WorkspacesStore();
