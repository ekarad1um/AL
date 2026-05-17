import { workspaces as wsApi } from '$lib/api/endpoints';
import { categories } from '$lib/stores/categories.svelte';
import { slices } from '$lib/stores/slices.svelte';
import { isNotFound } from '$lib/utils/error-copy';
import type { Uuid, WorkspaceDetail } from '$lib/api/types';

// Per-workspace revision poller.  Lives on the workspace detail
// page lifecycle: `start(detail, opts)` on mount, `stop()` on
// destroy or route swap.  Ticks every `intervalMs` (default
// 2_000 ms), each tick fires `GET /workspace/{id}` and compares
// the returned `workspace_revision.id` against the slices store's
// last-known value.  An advance flips per-category `stale` bits
// on the slices store and a single workspace-wide bit on the
// categories store; lazy refresh on expand picks them up (the
// design's "if the user didn't expand the category, assume it
// already synced" trade-off).
//
// Three gates short-circuit a tick without ever calling the
// daemon:
//   1. `document.hidden` -- background tabs don't burn round-
//      trips on stale data.  `visibilitychange` resumes by
//      firing an immediate tick on regain.
//   2. `slices.mutationsInFlightFor(id) > 0` -- the operator is
//      actively uploading / deleting.  Our own mutations advance
//      the daemon's revision; comparing the polled value against
//      the store before our receipts have landed would false-
//      positive.  Defer; the post-mutation tick catches up.
//   3. `this.fetching` -- a previous tick's GET is still
//      outstanding (slow daemon).  Skip so a stalled call
//      doesn't backpressure into N concurrent fetches.
//
// Single-flight `fetching` flag instead of an AbortController
// because `wsApi.get` doesn't accept a signal and adding one
// across the fetch wrapper is more refactor than the design
// budget.  The poster of a stale fetch result is rejected by
// the `this.workspaceId !== wsId` guard after the await.
//
// Failure handling:
//   - 404 → workspace gone; fire `onGone`, stop self-scheduling
//     (caller's onGone typically navigates away + calls stop()).
//   - Other → fire `onError` once per occurrence; keep
//     scheduling (network blips heal).
//
// Daemon-as-master semantics live in [slices.refresh /
// categories.refresh]; this poller's role is purely to trigger
// invalidation.  It never touches the lists / entries directly.

export interface WorkspacePollerOptions {
  // Tick cadence in ms; 2_000 by default.  Daemon `GET
  // /workspace/{id}` is cache-only (no asset walk) so 30 GETs/
  // min is trivial load even on a busy host.
  intervalMs?: number;
  // Called on every successful tick with the freshly-fetched
  // detail.  The detail page wires this to refresh `detail.name`,
  // `detail.heads`, and the revision chip with no extra round-
  // trip; revision-chip liveness is the most-visible payoff for
  // the operator.
  onDetail?: (detail: WorkspaceDetail) => void;
  // Called once when the daemon returns 404 for the workspace.
  // The caller is expected to navigate away (or render a "gone"
  // empty state); the poller stops self-scheduling so a
  // forgotten teardown doesn't spam 404s.
  onGone?: () => void;
  // Called on any non-404 error.  The poller continues ticking;
  // a transient network blip resolves on the next interval.
  onError?: (err: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 2_000;

export class WorkspacePoller {
  private workspaceId: Uuid | null = null;
  private intervalMs = DEFAULT_INTERVAL_MS;
  private opts: WorkspacePollerOptions = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fetching = false;
  private visibilityHandler: (() => void) | null = null;

  // Begin polling for `detail.id` using the loaded revision as
  // the comparison baseline.  Idempotent: a second `start`
  // tears down the prior poller (the caller may swap workspaces
  // via the same instance).
  start(detail: WorkspaceDetail, opts: WorkspacePollerOptions = {}): void {
    this.stop();
    this.workspaceId = detail.id;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.opts = opts;
    // Seed the slices store with the loaded revision so the
    // first tick's comparison short-circuits when the workspace
    // hasn't actually advanced since the page's initial load.
    // Without this seed, a fresh workspace with no prior receipts
    // would have `slices.latestRevisionFor() === null` (treated
    // as -1) and the first tick would always mark stale.
    slices.setRevisionAtLeast(detail.id, detail.workspace_revision.id);

    if (typeof document !== 'undefined') {
      this.visibilityHandler = (): void => {
        if (document.hidden) return;
        // Returning to visibility -- immediate tick so a long
        // background pause doesn't keep stale data on screen for
        // a full interval.  Pending timer is cleared so this
        // tick takes its slot.
        this.cancelTimer();
        void this.tick();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    this.scheduleNextTick();
  }

  stop(): void {
    this.workspaceId = null;
    this.cancelTimer();
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.visibilityHandler = null;
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextTick(): void {
    this.cancelTimer();
    if (this.workspaceId === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    const wsId = this.workspaceId;
    if (wsId === null) return;
    if (this.fetching) {
      // A prior tick is still in flight.  Don't pile up; the
      // outstanding fetch's finally will reschedule.
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      this.scheduleNextTick();
      return;
    }
    if (slices.mutationsInFlightFor(wsId) > 0) {
      this.scheduleNextTick();
      return;
    }

    this.fetching = true;
    try {
      const detail = await wsApi.get(wsId);
      // Workspace swapped or poller stopped while the GET was in
      // flight; ignore the stale response.
      if (this.workspaceId !== wsId) return;

      this.opts.onDetail?.(detail);

      // Re-check the mutation gate AFTER the await: a fresh
      // upload or remote-delete that started during the network
      // round-trip would advance the daemon's revision before
      // its receipt updates our store.  Comparing now would
      // false-positive "external change" against our own work.
      // Skip stale-decision; the next tick (or post-mutation
      // resume) reconciles cleanly.
      if (slices.mutationsInFlightFor(wsId) > 0) return;

      const incoming = detail.workspace_revision.id;
      // Always advance the in-memory "highest daemon revision
      // seen" -- the UI's live revision chip + the slices
      // store's recursion-on-newer-rev hook read from this.
      slices.setRevisionAtLeast(wsId, incoming);
      // Compare against the LAST REVISION WE FULLY RECONCILED
      // (mirrors the persisted `workspace_sync` row), not the
      // in-memory upper bound.  A failed / in-flight-blocked
      // reconcile leaves the persisted record behind the
      // daemon, and this comparison keeps re-firing until one
      // succeeds.  Using `latestRevisionFor` here would let
      // the poller silently swallow the advance (it bumps
      // `latestRevisions` itself), masking the failure.
      const synced = slices.lastSyncedRevisionFor(wsId) ?? -1;
      if (incoming > synced) {
        // External advance.  Flip per-category stale + the
        // workspace's categories-list stale; expanded SlicePane
        // and the CategoryList effect re-fire from their
        // tracked-stale reads and run their refreshers under
        // `untrack`.  `markStaleForWorkspace` also kicks a
        // background Tier 2 reconcile so the persisted
        // `workspace_sync` record catches up to `incoming`.
        slices.markStaleForWorkspace(wsId, incoming);
        categories.markStale(wsId);
      }
    } catch (e) {
      if (this.workspaceId !== wsId) return;
      if (isNotFound(e)) {
        // Workspace deleted (this tab, another tab, or
        // operator-side CLI).  Tear down fully -- the page's
        // onGone typically routes back to the list and would
        // call `stop()` itself on unmount, but if it chooses to
        // render an in-place EmptyState the visibility listener
        // would otherwise linger until route change.  `stop()`
        // is idempotent so an external `stop()` after this is a
        // no-op.  Notify AFTER teardown so onGone observes a
        // fully-torn-down poller (no `workspaceId`, no
        // scheduled tick, no live listener).
        this.stop();
        this.opts.onGone?.();
        return;
      }
      this.opts.onError?.(e);
    } finally {
      this.fetching = false;
      // Reschedule only if the poller is still bound to the
      // same workspace.  A stop() or onGone branch cleared
      // `workspaceId`, so this no-ops in those cases.
      if (this.workspaceId === wsId) this.scheduleNextTick();
    }
  }
}
