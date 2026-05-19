// Reactive training-job tracker.  Holds at most one tracked job
// daemon-wide (the daemon enforces `max_train_jobs = 1`) plus a
// rolling per-workspace history of terminal jobs so the
// operator can review each run's logs + metrics chart without
// chasing the daemon's JSONL backstop.
//
// ## Persistent history hydration (2026-05-15)
//
// The daemon writes every typed `TrainEvent` to a durable
// `<ws>/training_logs/<job_id>.jsonl` file at admission time
// and writes through to terminal.  These files survive daemon
// restarts and the in-memory `training::JobRegistry`'s
// retention window, so we surface them on workspace mount via
// `hydrateHistory(ws)`: list the directory, sort by mtime,
// fetch the top 2 JSONLs (eager), replay each through
// `replayJsonl` to synthesise a `TrackedTrainingJob`, push
// into `historyByWs`.  Older entries reveal on expand of the
// "Show N older runs" disclosure: the expand handler refreshes
// `discoveredByWs` from the backend (so the count reflects
// current keep-last-N state, not the mount-time snapshot) and,
// on the first expand only, auto-loads one batch of up to
// `PAGE_SIZE` JSONLs.  Subsequent batches arrive via the
// explicit "Load N more" click so the per-burst HTTP fan-out
// stays bounded on eMMC backends.  The eager 2 keep most
// operators' "what did I just run" question instant; the rest
// is opt-in.
//
// Hydration is idempotent: a second call for the same
// workspace returns immediately when `discoveredByWs` is
// already populated.  Failure (network error during list)
// leaves `discoveredByWs` unset so the next mount retries.
// Dismissal (per-card × or batch "Clear finished") hard-
// deletes the JSONL via the daemon's async asset-delete
// surface; the row vanishes from the in-memory list
// synchronously and a refresh during the daemon's drain
// window relies on `listLogs` no longer enumerating the
// tombstoned entry.
//
// ## Why a singleton, not per-workspace
//
// The daemon's training admission gate is global: one train job
// at a time across every workspace.  A second `POST /train`
// returns 409 `another_train_running`.  The store mirrors this
// invariant -- one active `tracked` slot -- so the UI can also
// guard a submit attempt locally (per-card "Train" buttons
// disable while the global slot is held).  Once a job hits a
// terminal state, it moves into the per-workspace `history`
// list and the active slot frees so the next submit lands.
//
// ## Why a history *list*, not a single terminal slot
//
// The TrainPane renders one collapsible card per run (the
// expandable training-history list).  The live run is just the
// top card, auto-expanded; when it terminates the same card
// stays in place -- only its status pill morphs.  Two
// consequences for the store:
//
//   1. Terminal jobs accumulate.  `historyByWs` keeps the
//      most-recent N (`MAX_HISTORY_PER_WS`) per workspace,
//      newest-first.  Beyond the cap, the oldest entry is
//      dropped on push.  Bounded so a long-running tab doesn't
//      leak memory through per-epoch arrays + log scrollback.
//   2. The previous `terminalByWs: Map<Uuid, ...>` is now
//      derived: `terminalFor(ws)` returns `history[0]` for
//      backwards-compatible callers (the workspace-detail
//      heads-refresh hook).
//
// ## Per-epoch metrics capture
//
// `finetune::run` emits a typed `TrainEvent::EpochCompleted`
// once per `epoch_end`, broadcast via
// `emit_train_event` → `JobHandle::append_log` to the cross-
// cutting SSE bus.  The subscriber's `onEvent` callback
// hands the typed payload to `ingestLogEvent`, which calls
// `mergeEpochFromEvent` to append one `EpochMetrics` entry
// per distinct epoch.  Dedup on `epoch` index makes replays
// (e.g. EventSource auto-reconnect from `?after_seq=0`)
// idempotent.  Because SSE pushes every emitted event in
// real time (vs. the prior 1 Hz watch-channel sample),
// fast runs that previously lost ~95 % of per-epoch
// metrics now capture all of them.
//
// ## Gap recovery
//
// The daemon's per-job SSE ring (1024 slots) gives ~14x
// headroom on a typical 50-epoch run.  A 1000-epoch run
// brushes the ceiling; older events get evicted, and a
// recovering subscriber that asks for `after_seq=0`
// receives an HTTP 409 `event_gap` from the daemon.  The
// subscriber's diagnostic-fetch path classifies this and
// fires `onGap({oldest_seq, latest_seq})`; the store's
// `recoverFromGap` then pages the durable JSONL backstop
// to fill the gap and re-binds SSE at the post-backfill
// cursor.  Bounded to `MAX_GAP_RETRIES` consecutive
// recoveries to keep a pathological loop from recursing
// forever.
//
// ## Workspace-detail refresh hook
//
// After a successful terminal, the workspace detail page needs
// to re-fetch so its `heads[]` picks up the newly-published
// head with the freshest revision.  The store exposes a
// `terminalSeq` counter incremented on every terminal landing;
// the detail page binds an `$effect` to it that re-`load()`s.
// We use a counter (not the terminal job itself) so the
// detail's effect re-fires correctly even on two-back-to-back
// terminals from the same workspace.

import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { training as trainingApi } from '$lib/api/endpoints';
import { isApiError } from '$lib/api/http';
import { enqueueDelete } from '$lib/api/delete-queue';
import { awaitJobTerminal } from '$lib/api/jobs';
import { TrainingSubscriber } from '$lib/api/training-subscriber';
import { TrainingLogTail } from '$lib/api/training-log-tail';
import { capFirst, errorCopy } from '$lib/utils/error-copy';
import { STAGE_LABEL, TERMINAL_TRAINING_STATES } from '$lib/components/training/labels';
import { formatBytes } from '$lib/utils/format';
import type {
  EpochMetrics,
  JobProgress,
  JobState,
  LogEvent,
  Rfc3339,
  Stage,
  TrainLogLine,
  TrainingCfg,
  TrainingJobView,
  Uuid
} from '$lib/api/types';

// One entry in the rolling event log shown by TrainLogs.
// Reconstructed client-side from the daemon's typed
// `TrainEvent` stream over SSE (see [`TrainingSubscriber`]).
// Earlier revisions of this surface derived `logLines` from
// observed `progress.message` deltas on the daemon's
// `tokio::sync::watch<finetune::Progress>` channel; that
// approach was lossy on fast runs because the watch channel
// retains only the *latest* snapshot and we sampled at 1 Hz,
// so most messages were overwritten before the next poll.
// A subsequent revision paged the JSONL backstop at
// `<ws>/training_logs/<job>.jsonl` instead -- correct but
// still polled, requiring a 3-second post-terminal drain to
// race the daemon's flush.  This revision moves to the SSE
// surface (`GET /api/v1/jobs/{job}/events`) which the daemon
// already exposes: events arrive in real time, terminal
// events are in-band, no drain wait, no polling load.  The
// JSONL backstop is retained as the durable substrate the
// subscriber's `event_gap` recovery path backfills from
// (see `recoverFromGap`); both substrates carry the same
// `TrainLogLine` shape so the store consumes them
// identically.
//
// The shape stays operator-facing-flat (`{at, phase, message}`)
// because the TrainLogs renderer reads exactly those fields;
// migrating the renderer to consume `TrainLogLine` (the
// discriminated-union typed envelope) would let us render
// per-kind chrome, but the value of that is small next to the
// flat-text scrollback we have today, and the cost is a
// re-architecture of an established surface.  The `event` slot
// below stashes the original typed line for any future
// per-kind affordance (an "Activate from epoch K" CTA hooked
// off `epoch_completed`, say) without forcing a rewrite now.
export interface TrainingLogLine {
  at: Rfc3339;
  phase: TrainingJobView['progress']['phase'];
  message: string;
  // Monotonic seq from the JSONL backstop.  Used by the store
  // to dedup against a tail that ever re-emits from seq=0
  // (e.g. a future SSE-driven path that replays on reconnect).
  // Today the tail doesn't replay during a single job
  // lifecycle so this is paranoia; cheap to carry.
  seq: number;
  // The original typed event the line was rendered from.
  // Optional because two seeded lines (one in `start()`, one
  // in `recover()`) are local synthetic entries that pre-date
  // any JSONL fetch -- they have no underlying TrainEvent.
  event?: TrainLogLine;
}

// Maximum log entries retained per job.  Bounded so a worst-case
// 1000-epoch run with churning trace strings stays cheap to
// re-render.  Practical runs emit ~few-dozen distinct messages.
const MAX_LOG_LINES = 500;

// Maximum terminal jobs retained per workspace.  Holds session-
// observed terminals AND entries loaded from the durable JSONL
// backstop during `hydrateHistory` / `loadMoreHistory`.  Pinned
// to the daemon's `LOG_RETENTION_KEEP_COUNT` (see
// `modules/file_mgr/log_retention.rs`) so the in-memory
// surface matches what the producer-side retention keeps on
// disk: a longer-lived session that runs ≥11 training jobs
// no longer accumulates zombie entries that vanish on the
// next page refresh.  Each entry retains its full `epochs[]` +
// `logLines[]` (~30 KB), so 10 lands a ~300 KB ceiling per
// workspace.  Beyond the cap, `pushHistoryBatch` evicts the
// oldest on each push.  Bump in lockstep with the daemon
// constant if either side ever changes.
//
// Exported so the TrainHistory retention-hint copy can
// interpolate the same number it gates on -- the daemon ↔
// frontend coupling stays a one-place mirror, but the
// frontend ↔ UI copy is single-sourced.
export const TRAINING_HISTORY_MAX_PER_WS = 10;
const MAX_HISTORY_PER_WS = TRAINING_HISTORY_MAX_PER_WS;

// Number of cards rendered eagerly when a workspace mounts.
// The eager tier covers the typical operator question ("what
// did I just run") at the lowest possible network cost (1
// directory listing + 2 JSONL fetches in parallel).  Older
// runs sit behind an "Show {N} older runs" disclosure until
// the operator asks for them.
const INITIAL_VISIBLE = 2;

// Per-click cap for the "Load N more" affordance (and for
// the auto-load that fires on the first disclosure expand).
// Five matches the visual density of the eager tier (one
// click per visible row of finished runs) and bounds the
// `Promise.all` parallelism so a slow eMMC backend doesn't
// stall the UI on a single click.  Exported so the
// TrainHistory button label can clamp its visible count
// against the same constant without duplicating the magic
// number.
//
// With the backend's `LOG_RETENTION_KEEP_COUNT = 10` cap
// mirrored on the frontend by `MAX_HISTORY_PER_WS`, the
// older tier holds at most `MAX_HISTORY_PER_WS -
// INITIAL_VISIBLE = 8` entries, so a fully-loaded disclosure
// is at most two clicks deep (5 + 3) -- explicit pagination,
// not single-batch, keeps each click cheap.
export const TRAINING_HISTORY_PAGE_SIZE = 5;
const PAGE_SIZE = TRAINING_HISTORY_PAGE_SIZE;

// Maximum consecutive `event_gap` (HTTP 409) recoveries before
// the consumer gives up.  Each recovery does one JSONL drain +
// one SSE rebind; bound the chain so a pathological loop (the
// daemon's ring evicts events faster than we backfill) can't
// recurse forever.  Three retries cover the case of "the ring
// evicted a few events between our reconnect and the diagnostic
// fetch" -- a 1000-epoch run brushing the 1024-slot ceiling --
// without papering over a real backend problem (a worker
// emitting at infinite rate would loop indefinitely otherwise).
const MAX_GAP_RETRIES = 3;

// Maximum JSONL events fetched per past-run hydration.  The
// daemon caps its `read_jsonl_page` response at
// `MAX_LOG_PAGE_LIMIT` (~1000); 1024 here covers a worst-case
// 1000-epoch run in one round-trip.  Operators with longer
// runs would page through multiple times -- not implemented
// today; a future enhancement if anyone reports the
// truncation.  Realistic runs (50-100 epochs) come in at
// ~70-150 events, well under this ceiling.
const HYDRATION_LOG_LIMIT = 1024;

// One file in `<ws>/training_logs/`, discovered via the
// `assets` directory-listing endpoint.  Holds only the
// directory-listing metadata (jobId derived from filename,
// mtime, size) -- the JSONL payload itself is fetched lazily
// on tier-1 hydration or "Load older runs" click.
interface DiscoveredRun {
  jobId: Uuid;
  // RFC3339 mtime from the directory listing -- last-write
  // time of the JSONL file, which approximates the run's
  // finish time (terminal events are the last writes).
  mtime: Rfc3339;
  // Total JSONL size in bytes.  Used informationally; the
  // hydration path doesn't consult it (the
  // `HYDRATION_LOG_LIMIT` cap is line-count, not bytes).
  sizeBytes: number;
}

// Legacy localStorage key namespace.  Earlier revisions
// soft-hid dismissed runs under this key with a "Show K
// hidden" reveal; the redesign replaced that with a hard
// delete of the JSONL backstop, so any persisted set here is
// now inert.  We opportunistically clear it on workspace
// hydration so the key doesn't leak forever (see
// `clearLegacyHiddenStorage`).
const LEGACY_HIDDEN_STORAGE_PREFIX = 'acoustics-lab:training-hidden:';

function clearLegacyHiddenStorage(workspaceId: Uuid): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(`${LEGACY_HIDDEN_STORAGE_PREFIX}${workspaceId}`);
  } catch {
    /* best-effort */
  }
}

// A job currently being polled (active) or pinned as the
// workspace's most-recent terminal (terminal slot).  The two
// states share a shape; the `cancelling` flag is only meaningful
// on the active slot.
export interface TrackedTrainingJob {
  workspaceId: Uuid;
  jobId: Uuid;
  // Pre-allocated by the daemon at submit time.  Pinned across
  // the job lifetime; the head record itself appears in the
  // workspace detail's `heads[]` only on a successful publish.
  headId: Uuid;
  // Newest snapshot from the poller.  Starts null until the
  // first tick lands; the form shows "submitting…" during that
  // window.
  view: TrainingJobView | null;
  // Per-epoch metrics observed during the run.  Ordered by
  // epoch index; one entry per distinct epoch.  Capped at the
  // hard daemon ceiling (MAX_EPOCHS = 1000) implicitly because
  // the trainer can't emit more than that many epoch_end ticks.
  epochs: EpochMetrics[];
  // Rolling log of typed events from the JSONL backstop (one
  // line per `TrainEvent`), rendered to operator copy and
  // ordered by daemon-emitted `seq` (which matches `at` order
  // because the producer emits seq + at atomically).  Includes
  // every event the daemon emitted -- no per-epoch loss the
  // earlier polled-message path suffered from.
  logLines: TrainingLogLine[];
  // True after `cancel()` fires.  The poller will eventually
  // observe `state: cancelled` and route through the terminal
  // path; this flag drives the "cancelling…" affordance during
  // the gap.
  cancelling: boolean;
}

class TrainingStore {
  // The single in-flight tracked job, daemon-wide.  Null when
  // no train job is in flight from this tab; another tab's
  // train would still be in flight at the daemon (a 409 on
  // submit reveals it) but isn't owned here.
  active = $state<TrackedTrainingJob | null>(null);
  // Per-workspace rolling history of terminal jobs, newest-
  // first, capped at `MAX_HISTORY_PER_WS`.  Survives the
  // `active` slot freeing so the workspace detail page (a) can
  // surface a permanent training-history list and (b) can
  // recover heads info without polling.  Dropped on
  // `forget(workspaceId)` (workspace delete).  Older entries
  // are pruned daemon-side by producer-driven keep-last-N
  // retention (`modules/file_mgr/log_retention.rs`) -- no
  // operator-driven clear path lives here.
  private historyByWs = new SvelteMap<Uuid, TrackedTrainingJob[]>();
  // Counter that increments on every terminal transition --
  // workspace detail pages bind an `$effect` to this and
  // re-fetch on bump so heads list / revision pick up the
  // published head.
  terminalSeq = $state(0);
  // Submit-time backend error surfaced inline on the form.
  // Cleared on the next submit attempt or on operator dismissal.
  startError = $state<string | null>(null);
  // True while `start()` is awaiting the daemon's ack -- the
  // form's submit shows a spinner during this window.
  starting = $state(false);

  // Single source of truth for every observed signal during
  // the run.  Subscribes to the cross-cutting
  // `GET /api/v1/jobs/{id}/events` SSE stream and incrementally
  // updates the store's `active` slot:
  //   - typed `TrainEvent` payloads (`onEvent`) drive
  //     `logLines`, `epochs`, and the per-event view fields
  //     (`progress.phase`, `result`, `error`, terminal
  //     `state`).  See `applyEventToView` for the per-kind
  //     mapping.
  //   - rate-limited `JobEvent.progress` ticks (`onProgress`)
  //     drive `view.progress.current / total`.  These arrive
  //     between epoch_completed messages when the daemon's
  //     `JobHandle::update_progress` is called.
  //   - terminal `JobEvent.state` transitions
  //     (`onStateTransition`) drive `view.state` +
  //     `view.finished_at` and fire `handleTerminal` to move
  //     the job into history.
  //
  // The poller-and-tail dual-surface that preceded this is
  // gone: a single long-lived EventSource replaces the two
  // 1-Hz polls, eliminates the watch-channel-vs-JSONL flush
  // race, and lets the operator see every event with daemon-
  // faithful `at` timestamps in real time.
  private subscriber = new TrainingSubscriber();

  // Dormant JSONL paging substrate, bound only on
  // `event_gap` recovery (`onGap` fires when the daemon's
  // SSE ring has evicted events older than our subscribe
  // cursor).  In practice the ring's 1024-slot capacity
  // gives a 14x headroom on a typical 50-epoch run, so this
  // path doesn't fire under routine load -- but having the
  // tail wired means a 1000-epoch run that brushes the
  // ring's ceiling recovers transparently rather than
  // losing events.  See `recoverFromGap` for the flow.
  private logTail = new TrainingLogTail();

  // ── Persistent-history hydration state ─────────────────────
  //
  // `discoveredByWs` holds the directory listing of
  // `<ws>/training_logs/<job_id>.jsonl` from a single
  // listing call per workspace mount, sorted newest-first
  // by `mtime`.  Presence acts as the hydration idempotence
  // guard: a second `hydrateHistory(ws)` call returns
  // immediately when `discoveredByWs.has(ws)` is true.  A
  // failed listing leaves it unset so the next mount
  // retries.
  private discoveredByWs = new SvelteMap<Uuid, DiscoveredRun[]>();

  // True between the `listLogs` call's start and the eager
  // batch's settlement (success or failure).  Drives the
  // TrainHistory skeleton-vs-empty rendering: skeletons show
  // while this is true; the empty state shows only after
  // hydration completes with zero discovered entries.
  private hydratingByWs = new SvelteMap<Uuid, boolean>();

  // True while a `loadMoreHistory` batch is in flight for the
  // workspace.  Drives the "Load older runs" button's
  // disabled + spinner state to prevent double-click.
  private loadingMoreByWs = new SvelteMap<Uuid, boolean>();

  // True when the "older runs" accordion section is open.
  // Defaults false (the eager 2 are always visible; older
  // hide behind the disclosure).  Lives in store so the
  // operator's expansion choice survives a TrainPane remount
  // within the session.  Reset on `forget(ws)`.
  private olderExpandedByWs = new SvelteMap<Uuid, boolean>();

  // Per-workspace set of jobIds with an in-flight history-row
  // delete.  Drives the "Deleting…" disabled state on the row's
  // right-click ContextMenu's Delete item and the `aria-busy`
  // visual treatment on `TrainHistoryItem` while the daemon's
  // async delete drains.  Per-workspace (not global) because
  // `enqueueDelete` already serialises across workspaces;
  // operator-visible in-flight feedback IS scoped to the row
  // the operator clicked.
  private deletingHistoryByWs = new SvelteMap<Uuid, SvelteSet<Uuid>>();

  // Per-workspace inline-banner copy for the most recent
  // history-delete failure.  Cleared at the start of the next
  // delete attempt or on explicit operator dismissal.  Per-
  // workspace because the banner is rendered inside
  // `TrainHistory` which is mounted under a workspace detail
  // page; an error from workspace A would be invisible (and
  // confusing) on workspace B.
  private historyDeleteErrorByWs = new SvelteMap<Uuid, string | null>();

  // In-flight refcount of `refillEagerAfterDelete` calls per
  // workspace.  A refcount (not a boolean) so that two rapid
  // deletes whose refills overlap each report `true` until
  // BOTH have settled -- the eager-tier skeleton placeholder
  // stays visible across the whole "shrink → backfill" window
  // rather than flickering off when the first refill's await
  // resolves while a second refill is still mid-fetch.  The
  // refcount also self-converges to zero through the
  // `finally` block in `refillEagerAfterDelete`, so a thrown
  // fetch never strands the flag.
  private autoRefillingByWs = new SvelteMap<Uuid, number>();

  // Snapshotted older-tier batch size for the in-flight load.
  // Set at click-time on `setOlderExpanded(true)` /
  // `loadMoreHistory`, derived as `min(loadable, PAGE_SIZE)`
  // against the cached `discoveredByWs` -- which is the same
  // arithmetic the visible "Show N older runs" badge uses.
  // The placeholder count in `TrainHistory` reads exactly this
  // value so the badge ↔ skeleton ↔ landed-rows progression
  // is always honest: a click on "Show 3 older runs" paints 3
  // skeletons, then 3 rows materialise in place.  A click that
  // resolves to a no-op load (already at-or-above PAGE_SIZE in
  // the older tier) leaves the slot at 0 so no placeholders
  // appear.  Cleared in the load chain's `finally` so a
  // failure path doesn't strand the count.
  private olderLoadingPendingByWs = new SvelteMap<Uuid, number>();

  // In-flight `recover` Promises per workspace.  Plain `Map`
  // (not SvelteMap): no UI surface tracks this -- it's purely
  // a concurrency-coalescing handle so two callsites that fire
  // `recover(id)` at almost the same instant share one
  // `GET /workspace/{id}/training` round-trip rather than
  // racing parallel requests.  Practically this fires on
  // workspace-detail mount: the page's `load()` kicks recover
  // off in parallel with the workspace detail GET, and
  // `TrainPane.onMount` then fires its own redundant recover
  // as a safety net (in case the page surface ever mounts
  // without going through `load`).  The pre-existing
  // `this.active !== null` guard only covers the post-await
  // case; without this Promise dedup both calls enter the
  // await and the daemon sees two GETs.  Cleared on settle so
  // a subsequent recover (e.g. a long session that observes
  // the active slot freeing via terminal) still hits the
  // network.
  private recoveringByWs = new Map<Uuid, Promise<void>>();

  // Read the entire history list for one workspace, newest-
  // first.  Returns an empty array when no terminal jobs are
  // pinned for the workspace.  The TrainPane renders this
  // alongside the active slot (if bound here) as a single
  // collapsible-card list.
  historyFor(workspaceId: Uuid): readonly TrackedTrainingJob[] {
    return this.historyByWs.get(workspaceId) ?? [];
  }

  // Read the most-recent terminal slot for one workspace.
  // Equivalent to `historyFor(ws)[0] ?? null`; kept for callers
  // that only care about "what was the last verdict" (e.g. the
  // workspace-detail heads-refresh hook on `terminalSeq` bump).
  terminalFor(workspaceId: Uuid): TrackedTrainingJob | null {
    const hist = this.historyByWs.get(workspaceId);
    return hist && hist.length > 0 ? hist[0] : null;
  }

  // Read the active slot when it's bound to `workspaceId`.
  // Otherwise null -- a job running for a sibling workspace
  // is invisible to this workspace's surfaces.
  activeFor(workspaceId: Uuid): TrackedTrainingJob | null {
    if (this.active?.workspaceId === workspaceId) return this.active;
    return null;
  }

  // Submit a new training job.  Re-throws on failure so the
  // form can surface an inline banner.  Returns the pre-
  // allocated head id (matches the eventual published head).
  async start(workspaceId: Uuid, cfg: TrainingCfg): Promise<Uuid> {
    if (this.active !== null) {
      // Defence-in-depth: form's `canSubmit` derived gates
      // this; this throw is for stray callsites that bypass
      // the form (programmatic re-submit, etc.).
      throw new Error('A training job is already in flight.');
    }
    this.starting = true;
    this.startError = null;
    try {
      const resp = await trainingApi.start(workspaceId, cfg);
      this.active = {
        workspaceId,
        jobId: resp.job_id,
        headId: resp.head_id,
        view: null,
        epochs: [],
        // Local pre-tail seed.  The JSONL backstop already
        // has `job_submitted` + `job_running` by the time
        // this `start()` resolves (the daemon writes them
        // synchronously during admission, before the POST
        // response), but the first tail tick takes a network
        // round-trip to land them in the scrollback -- this
        // seed gives the operator immediate "we're moving"
        // feedback during that ~tens-of-ms window.  `seq: -1`
        // ensures it can never collide with a real
        // daemon-emitted seq (which is monotonic from 1).
        logLines: [
          {
            seq: -1,
            at: new Date().toISOString(),
            phase: 'prepare',
            message: 'Submitted; waiting for daemon to start emitting events…'
          }
        ],
        cancelling: false
      };
      // History is intentionally NOT cleared on a new submit --
      // the operator can scroll back through previous runs while
      // the new one is in flight.  The new run lands at the top
      // of the list as the live (auto-expanded) item; previous
      // terminal items stay where they are, collapsed.
      this.bindSubscriber(resp.job_id);
      return resp.head_id;
    } catch (e) {
      this.startError = errorCopy(e);
      throw e;
    } finally {
      this.starting = false;
    }
  }

  // Recover an in-flight job after a page reload.  Lists
  // `/workspace/{id}/training` for the workspace, finds the
  // (at most one) entry in `running` state, and binds the SSE
  // subscriber.  No-op when the active slot is already bound
  // elsewhere (the daemon enforces global single-train; if a
  // job is running we'll find it on at most one workspace's
  // list).  Idempotent; safe to call on every workspace-detail
  // mount.
  //
  // We still hit `/workspace/{id}/training` rather than the
  // cross-cutting `/jobs` listing because `JobSnapshot`'s
  // `workspace_id` is `Some(_)` only for jobs whose references
  // haven't been released yet (running jobs still hold their
  // workspace reference; terminal jobs have it released by
  // `JobHandle::terminate`).  In practice that's identical for
  // our use case (running = workspace_id present), but the
  // training-specific endpoint is more direct + carries the
  // job's `started_at` snapshot for free.
  //
  // Coalesces concurrent callers via `recoveringByWs`: the
  // workspace-detail page's `load()` fires recover in parallel
  // with the detail GET, and `TrainPane.onMount` (firing a
  // tick or two later, once the detail render has resolved)
  // would otherwise enter the await on a separate
  // `trainingApi.list` call before the first one's
  // `this.active = ...` write lands.  The pre-await
  // `this.active !== null` guard catches the second caller
  // only if the first has finished -- not if the two are both
  // mid-await.  An in-flight Promise dedup deduplicates the
  // HTTP request itself, not just the post-resolve write.
  async recover(workspaceId: Uuid): Promise<void> {
    if (this.active !== null) return;
    const inflight = this.recoveringByWs.get(workspaceId);
    if (inflight) return inflight;
    const p = this.doRecover(workspaceId).finally(() => {
      this.recoveringByWs.delete(workspaceId);
    });
    this.recoveringByWs.set(workspaceId, p);
    return p;
  }

  private async doRecover(workspaceId: Uuid): Promise<void> {
    let jobs: TrainingJobView[] = [];
    try {
      jobs = await trainingApi.list(workspaceId);
    } catch {
      // Recovery is best-effort -- a transient failure here
      // means the operator might miss the live progress until
      // the next submit, but the worker keeps going.  Silent.
      return;
    }
    // Re-check after the await: a concurrent `start()` (the
    // operator submitting while the page is still mounting)
    // would have set `this.active` while we were awaiting the
    // listing.  Overwriting it here would orphan the freshly-
    // bound subscriber and leave the UI tracking a stale view.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.active !== null) return;
    // Pick the most-recent running entry; the daemon's
    // `list_for_workspace` sorts ascending by `started_at`, so
    // the newest is at the end.
    const running = jobs.filter((j) => j.state === 'running');
    if (running.length === 0) return;
    const view = running[running.length - 1];

    // `headId` isn't on the wire here (the JobView shape
    // doesn't carry it).  The active-run UI doesn't use it
    // directly; the terminal-slot UI uses
    // `view.result?.head_id` after `job_completed` lands via
    // SSE.  Empty placeholder is fine.
    //
    // `view: null` rather than seeding with the polled
    // snapshot: the SSE subscriber replays from `seq=0`, and
    // `applyEventToView` would otherwise *downgrade* the
    // polled view's phase ("train" → "prepare" → "train"
    // again) as it processed early events.  Starting from
    // null avoids the flicker -- the first event lands
    // within tens of ms and the view rebuilds in monotonic
    // forward order.
    //
    // `logLines` starts with a synthetic "recovered" line so
    // the scrollback makes it obvious the operator returned
    // mid-flight (vs. submitted-from-scratch).  SSE replay
    // appends every typed event below it; the seed (`seq:
    // -1`) can never collide with a real daemon-emitted seq.
    // `at` is `now` (when recovery happened), matching `start()`'s
    // seed -- using `view.started_at` would stamp the line at
    // the original submission time, putting an hours-old time
    // ahead of the actually-fresh SSE events that follow and
    // making the scrollback look like the log was replayed
    // backwards.
    this.active = {
      workspaceId,
      jobId: view.job_id,
      headId: '',
      view: null,
      epochs: [],
      logLines: [
        {
          seq: -1,
          at: new Date().toISOString(),
          phase: 'prepare',
          message: 'Recovered an in-flight training job from the daemon.'
        }
      ],
      cancelling: false
    };
    this.bindSubscriber(view.job_id);
  }

  // Cancel the currently-tracked job, if any.  Returns
  // immediately after the DELETE ack; the worker's actual exit
  // (and the `state: cancelled` terminal) lands on a later poll
  // tick.  Subsequent operator clicks are no-ops via
  // `cancelling`.
  async cancel(): Promise<void> {
    const job = this.active;
    if (!job || job.cancelling) return;
    // Spread-with-override does one reactivity fire (new object
    // identity).  The earlier `job.cancelling = true; this.active
    // = { ...job }` mutated the live $state value first AND then
    // reassigned it -- two fires for the same logical edit, and
    // a transient state where the mutation had landed but the
    // identity hadn't changed yet.
    this.active = { ...job, cancelling: true };
    try {
      await trainingApi.cancel(job.workspaceId, job.jobId);
    } catch (e) {
      // Cancel failed mid-flight; un-set so the operator can
      // retry.  We don't surface a banner here -- the cancel
      // affordance is a quiet escape hatch, and a transient
      // failure recovers on retry.  Log for diagnostics.
      //
      // The poller might have transitioned the job to a
      // terminal during the await (single-threaded JS but the
      // network IO yields), so re-read `this.active` and only
      // patch when it's still the job we tried to cancel.  TS
      // narrows `this.active` to non-null after the pre-await
      // assignment (it doesn't track potential re-assignment
      // across the yield); the runtime null check is therefore
      // load-bearing despite reading as "unnecessary".
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.active !== null && this.active.jobId === job.jobId) {
        this.active = { ...this.active, cancelling: false };
      }
      console.warn('[training] cancel failed', e);
      throw e;
    }
  }

  // ── Operator-driven history-row deletion ───────────────────
  //
  // Per-entry only -- there is no "Clear finished" / batch
  // path here.  Two reasons:
  //   1. The daemon enforces keep-last-N=10 retention at every
  //      producer open
  //      (`modules/file_mgr/log_retention.rs`), so the steady-
  //      state surface stays bounded without manual operator
  //      action.  Per-entry delete is the *targeted* prune
  //      ("drop this noisy failed run from the list", "free
  //      that 100 MB JSONL my pathological cancel cycle
  //      generated"), not a bulk-management tool.
  //   2. An earlier revision shipped a "Clear finished" path
  //      that fanned out N parallel deletes; they collided
  //      with the daemon's `max_delete_jobs = 1` admission
  //      slot, admitting one and 409'ing the rest, so the UI
  //      reported success while only one disk file got
  //      removed.  Per-entry deletes routed through the
  //      shared `enqueueDelete` chain serialise correctly and
  //      give the operator one click → one round-trip → one
  //      visible result.
  //
  // The daemon refuses (`JobConflict`) any log delete while a
  // Train job for the same workspace is active; the caller is
  // expected to gate the menu's Delete item on
  // `activeFor(workspaceId) === null` before firing.  The
  // backend check is best-effort (a producer can start
  // between our gate read and the dispatcher's pre-check), so
  // we still parse the error envelope and surface it inline
  // via `historyDeleteErrorFor` on any failure rather than
  // assuming success.

  // True while a history row's daemon-side delete is in
  // flight.  Drives the row's `isDeleting` chrome and the
  // menu's "Deleting…" disabled state if the operator
  // re-right-clicks during the await.
  historyDeletingForJob(workspaceId: Uuid, jobId: Uuid): boolean {
    return this.deletingHistoryByWs.get(workspaceId)?.has(jobId) ?? false;
  }

  // Operator-facing copy for the most recent failed
  // `deleteHistoryEntry` on this workspace, or null if the
  // previous attempt landed cleanly.  Source for the inline
  // rose banner in `TrainHistory`.  Shape matches the
  // banner-family convention used by TrainPane's `startError`
  // and HeadsTable's `actionError` so the three surfaces read
  // as one alert vocabulary.
  historyDeleteErrorFor(workspaceId: Uuid): string | null {
    return this.historyDeleteErrorByWs.get(workspaceId) ?? null;
  }

  // Operator dismiss of the inline banner.  Pure UI state --
  // the daemon doesn't care.
  dismissHistoryDeleteError(workspaceId: Uuid): void {
    this.historyDeleteErrorByWs.set(workspaceId, null);
  }

  // Delete one terminal history row's JSONL backstop.  Async
  // pipeline (DELETE → 202 ack → SSE terminal wait) serialised
  // through the global delete-queue so it can't 409 against a
  // concurrent dataset / converter / workspace delete.  On
  // success the row is dropped from `historyByWs` AND from
  // `discoveredByWs` so a subsequent `hydrateHistory` /
  // `loadMoreHistory` doesn't bring it back via a directory
  // re-listing.  On failure the local state is untouched so
  // the operator can retry from the same row, and the inline
  // banner surfaces the typed error message.
  //
  // No-op when the row is already in flight (idempotent
  // re-click) or when the jobId belongs to the live active
  // slot (the daemon would 409; the menu's gating should have
  // already disabled the entry, but the runtime guard backs
  // that up).
  async deleteHistoryEntry(workspaceId: Uuid, jobId: Uuid): Promise<void> {
    if (this.historyDeletingForJob(workspaceId, jobId)) return;
    if (this.active?.workspaceId === workspaceId && this.active.jobId === jobId) return;
    let set = this.deletingHistoryByWs.get(workspaceId);
    if (!set) {
      set = new SvelteSet<Uuid>();
      this.deletingHistoryByWs.set(workspaceId, set);
    }
    set.add(jobId);
    // Clear the previous error so the rose banner doesn't
    // shadow a pending retry while the new attempt is in
    // flight.  Mirrors TrainPane's `startError` reset on the
    // next submit.
    this.historyDeleteErrorByWs.set(workspaceId, null);
    try {
      await enqueueDelete(async () => {
        const ack = await trainingApi.deleteLog(workspaceId, jobId);
        await awaitJobTerminal(ack.job_id, 'training-log delete');
      });
      // Daemon delete drained.  Drop the row from history (so
      // it vanishes from the list immediately) AND from
      // `discoveredByWs` (so a subsequent re-mount /
      // hydration doesn't observe the now-missing JSONL via
      // a stale listing and try to replay it).
      this.removeFromHistory(workspaceId, jobId);
      // Eager-tier auto-refill.  Deleting an eager row leaves
      // a visual gap (the operator sees 1 row instead of the
      // expected `INITIAL_VISIBLE = 2`) AND a stale-looking
      // `olderTotal` badge: because `removeFromHistory` drops
      // the jobId from BOTH `historyByWs` and `discoveredByWs`,
      // the `loadable - loaded` math stays numerically
      // identical -- the operator's mental "I just removed
      // one, the count should drop" never appears in the UI.
      // Pulling the next discovered entry into the eager tier
      // closes both gaps in one go: the visible row count
      // returns to budget, and the loadable pool drops by one
      // (because the just-loaded entry leaves it), so the
      // badge ticks down by 1 as the operator expects.
      //
      // Fire-and-forget so the operator's primary action (the
      // delete) resolves promptly.  A network failure mid-
      // refill leaves the eager tier short, which the next
      // mount / explicit "Show older runs" expand recovers
      // from; surfacing that case to the operator inline would
      // be noise.
      //
      // When `older` is expanded, this is typically a no-op
      // (already-loaded older entries shift up via
      // `eagerHistoryFor`'s slice; `history.length` stays at
      // or above `INITIAL_VISIBLE` so the gap check
      // short-circuits).  The fix is observable only on the
      // "older not expanded" path the operator pointed at, but
      // the gap-condition is the load-bearing predicate.
      void this.refillEagerAfterDelete(workspaceId);
    } catch (e) {
      const message =
        e instanceof Error && e.message ? capFirst(e.message, 'Delete failed.') : errorCopy(e);
      this.historyDeleteErrorByWs.set(workspaceId, message);
      console.warn('[training] history delete failed', e);
      throw e;
    } finally {
      const cur = this.deletingHistoryByWs.get(workspaceId);
      if (cur) {
        cur.delete(jobId);
        if (cur.size === 0) this.deletingHistoryByWs.delete(workspaceId);
      }
    }
  }

  // Local-only removal: drop a single jobId from `historyByWs`
  // and `discoveredByWs` for `workspaceId`.  Used by the
  // terminal-success branch of `deleteHistoryEntry`; not
  // called elsewhere.  Inlining would be fine but a named
  // helper documents the two-store invariant: both surfaces
  // must agree after a delete, otherwise the "Show N older
  // runs" badge re-counts the just-deleted entry against the
  // current keep-last-N state.
  private removeFromHistory(workspaceId: Uuid, jobId: Uuid): void {
    const hist = this.historyByWs.get(workspaceId);
    if (hist) {
      const filtered = hist.filter((j) => j.jobId !== jobId);
      if (filtered.length !== hist.length) {
        if (filtered.length === 0) this.historyByWs.delete(workspaceId);
        else this.historyByWs.set(workspaceId, filtered);
      }
    }
    this.dropFromDiscovered(workspaceId, jobId);
  }

  // Refill the eager tier after a delete that left it under
  // budget.  No-op when:
  //   * History is already at-or-above `INITIAL_VISIBLE` (the
  //     common "older expanded" path, where the eager slice
  //     absorbs the gap from already-loaded older entries).
  //   * `loadableOlderCountFor` is zero (discovery pool is
  //     exhausted; nothing to fetch).
  //
  // Otherwise sets the `autoRefillingByWs` flag (so the eager
  // `<ul>` paints a single skeleton placeholder in the freshly-
  // emptied slot — see `eagerSkeletonCountFor`) and calls
  // `loadBatch` for exactly the gap.  The placeholder is the
  // load-bearing UX detail: without it the row vanishes the
  // moment the daemon-delete drains, the eager tier shrinks
  // by one card-height, then expands back when the fetch
  // resolves — a perceptible "shrink → re-grow" judder for
  // the operator.  Setting the flag BEFORE the await and
  // clearing it in `finally` brackets the loadBatch's await
  // window precisely, so the placeholder is visible from
  // (post-`removeFromHistory`) through (`pushHistoryBatch`)
  // and not a frame longer.
  //
  // Routes through the same `fetchAndReplay` substrate the
  // eager hydration uses, so:
  //   * `MAX_HISTORY_PER_WS` capacity cap is honored.
  //   * Active-slot collisions are filtered (we never push the
  //     live jobId into history).
  //   * A stale-discovery 404 prunes that entry from
  //     `discoveredByWs` automatically, converging the
  //     `loadableOlderCountFor` math without a retry loop.
  //
  // Fire-and-forget caller: a network failure here just leaves
  // the eager tier short and the badge slightly stale; the
  // next mount or explicit older-expand refresh recovers
  // from that, and surfacing the failure inline would be more
  // noise than signal for a background polish-the-list call.
  //
  // Gates only on `autoRefillingByWs`, not on the older-tier's
  // `loadingMoreByWs` flag.  A delete + an immediate "Load N
  // more" click (or older-disclosure expand) can therefore run
  // their `loadBatch` calls in parallel and end up fetching the
  // same newest-discovered jobId twice.  `pushHistoryBatch`'s
  // `incomingIds` dedup makes the overlap benign (the second
  // landing is a no-op), so the worst case is one extra JSONL
  // round-trip in a niche timing window -- not worth a global
  // serialiser that would also stall the more common
  // independent-path case.
  private async refillEagerAfterDelete(workspaceId: Uuid): Promise<void> {
    const hist = this.historyByWs.get(workspaceId) ?? [];
    if (hist.length >= INITIAL_VISIBLE) return;
    const gap = INITIAL_VISIBLE - hist.length;
    if (this.loadableOlderCountFor(workspaceId) === 0) return;
    const prev = this.autoRefillingByWs.get(workspaceId) ?? 0;
    this.autoRefillingByWs.set(workspaceId, prev + 1);
    try {
      await this.loadBatch(workspaceId, gap);
    } catch (e) {
      console.warn('[training] eager-tier auto-refill after delete failed', e);
    } finally {
      const cur = this.autoRefillingByWs.get(workspaceId) ?? 0;
      if (cur <= 1) this.autoRefillingByWs.delete(workspaceId);
      else this.autoRefillingByWs.set(workspaceId, cur - 1);
    }
  }

  // Toggle / explicit-set the "older runs" disclosure for
  // `workspaceId`.  On expand, kicks off a refresh + load
  // chain so the disclosure operates on the backend's
  // current state -- mount-time `discoveredByWs` drifts as
  // the producer prunes older `<job_id>.jsonl` files past
  // the backend's keep-last-N cap (and we can't observe
  // cross-tab / external prunes any other way).  The chain
  // is fire-and-forget; `loadingMoreByWs` is held across
  // BOTH phases (directory re-list + JSONL fetches) so the
  // UI's pending affordance covers the whole click → settle
  // window, not just the load tail.
  setOlderExpanded(workspaceId: Uuid, expanded: boolean): void {
    this.olderExpandedByWs.set(workspaceId, expanded);
    if (expanded) {
      void this.handleOlderExpand(workspaceId);
    }
  }

  // Inner sequence for `setOlderExpanded(_, true)`:
  //
  //   1. Refresh the directory listing so
  //      `loadableOlderCountFor` reads the backend's current
  //      keep-last-N state and the "Show N older runs" badge
  //      is honest at click time -- not a mount-time
  //      snapshot the producer's retention has since
  //      drifted past.
  //   2. Auto-load the first batch (capped at `PAGE_SIZE`)
  //      iff the older tier holds fewer than one batch worth
  //      of entries.  An earlier revision gated on
  //      `history.length <= INITIAL_VISIBLE` -- effectively
  //      "the older tier is completely empty" -- but that
  //      heuristic misses a very common case: after a fresh
  //      mount loaded 2 eager entries and the operator
  //      trained ONE job, the new terminal pushes the
  //      bottom eager card into the older tier, so
  //      `history.length` is now 3 (> INITIAL_VISIBLE) AND
  //      `olderHistory.length` is 1 (< PAGE_SIZE).  The old
  //      gate stayed false; the disclosure expanded showing
  //      a single row instead of the ~5 the operator
  //      expected from the badge.  Gating on the older
  //      tier's own length fires correctly in both the
  //      fresh-mount and post-train cases.
  //
  // Subsequent expansions (after the operator has loaded a
  // full batch) re-run only the refresh -- the operator then
  // drives further loads via the explicit "Load N more"
  // affordance, so the per-click cap stays bounded and
  // surprise auto-fetches don't pile up.  Any residual delta
  // between fresh discovery and the cached history surfaces
  // on the badge + button without triggering work.
  //
  // `loadingMoreByWs` is held across BOTH phases so the
  // pending affordance covers the directory re-list too --
  // on a slow `listLogs` the operator would otherwise see an
  // instantly-expanded section that suddenly switches to a
  // loading indicator partway through.  Acquiring the flag
  // also serialises against the explicit "Load N more"
  // click (`loadMoreHistory` no-ops while held), preventing
  // two parallel `loadBatch` calls if a user clicks the
  // pager during the auto-load tail.  We call `loadBatch`
  // directly (not `loadMoreHistory`) to avoid the re-entry
  // guard tripping on the flag we just set.
  private async handleOlderExpand(workspaceId: Uuid): Promise<void> {
    if (this.loadingMoreByWs.get(workspaceId)) return;
    this.loadingMoreByWs.set(workspaceId, true);
    // Optimistic pre-refresh skeleton count so the disclosure
    // mounts with placeholders in the same frame as the click,
    // instead of opening to empty space for the duration of
    // the `refreshDiscovery` round-trip (~50-200 ms on a
    // healthy daemon).  Gated on the pre-refresh older-tier
    // size against the page budget -- an already-full tier
    // doesn't fire `loadBatch` below, so painting phantom
    // skeletons that never resolve to rows would lie to the
    // operator.  `refreshDiscovery` only mutates the
    // discovered pool, not history, so the pre-refresh older-
    // tier check matches the post-refresh load-branch decision
    // below.  The authoritative post-refresh re-snapshot then
    // adjusts the count if the producer's retention pruned
    // (or a sibling SSE terminal pushed) between the click and
    // the refresh landing -- the post-refresh number always
    // wins.
    if (this.olderHistoryFor(workspaceId).length < PAGE_SIZE) {
      const initial = Math.min(this.loadableOlderCountFor(workspaceId), PAGE_SIZE);
      if (initial > 0) this.olderLoadingPendingByWs.set(workspaceId, initial);
    }
    try {
      await this.refreshDiscovery(workspaceId);
      const older = this.olderHistoryFor(workspaceId);
      if (older.length < PAGE_SIZE) {
        // Authoritative post-refresh snapshot -- the count
        // `loadBatch` will actually surface, capped at
        // PAGE_SIZE.  Branches `set` vs `delete` on zero so
        // the skeleton tier collapses to nothing in the same
        // tick if discovery resolved to an exhausted pool;
        // the outer finally performs the canonical cleanup
        // regardless.
        const pending = Math.min(this.loadableOlderCountFor(workspaceId), PAGE_SIZE);
        if (pending > 0) this.olderLoadingPendingByWs.set(workspaceId, pending);
        else this.olderLoadingPendingByWs.delete(workspaceId);
        await this.loadBatch(workspaceId, PAGE_SIZE);
      }
    } finally {
      // Clears every path: happy-path load (skeleton vanishes
      // in the same tick `pushHistoryBatch` mounts the real
      // rows), no-load branch (post-refresh found older >=
      // PAGE_SIZE, e.g. an SSE terminal landed during the
      // refresh round-trip and shifted an eager row down),
      // and a pre-refresh optimistic snapshot stranded by a
      // thrown `refreshDiscovery`.
      this.olderLoadingPendingByWs.delete(workspaceId);
      this.loadingMoreByWs.set(workspaceId, false);
    }
  }

  // ── Persistent-history hydration accessors ─────────────────

  // Read the discovered (directory-listed) past runs for one
  // workspace, in newest-first mtime order.  Empty when
  // hydration hasn't yet been called or the listing returned
  // zero entries.  Used by the UI to compute "Show {N} older
  // runs" counts and the "Load more" button's visibility.
  discoveredFor(workspaceId: Uuid): readonly DiscoveredRun[] {
    return this.discoveredByWs.get(workspaceId) ?? [];
  }

  // True between the `hydrateHistory` start and its
  // settlement.  TrainHistory renders skeleton cards while
  // this is true (so the "empty" empty-state never flashes
  // during loading).
  hydratingFor(workspaceId: Uuid): boolean {
    return this.hydratingByWs.get(workspaceId) ?? false;
  }

  // True while at least one `refillEagerAfterDelete` is in
  // flight for `workspaceId`.  Together with the eager-tier
  // gap count (see `eagerSkeletonCountFor`), this drives the
  // single-skeleton placeholder rendered in `TrainHistory`
  // immediately after a delete drains the eager tier under
  // its `INITIAL_VISIBLE` budget.  Without the placeholder
  // the row visibly disappears, the eager `<ul>` shrinks by
  // one card-height, and then re-grows when the backfilled
  // entry lands -- the operator sees a "shrink → re-grow"
  // judder.  The placeholder reserves the slot from
  // (post-`removeFromHistory`) through (`pushHistoryBatch`),
  // converting the transition to a single in-place card swap.
  autoRefillingFor(workspaceId: Uuid): boolean {
    return (this.autoRefillingByWs.get(workspaceId) ?? 0) > 0;
  }

  // Skeleton-row count for the eager `<ul>` in `TrainHistory`.
  // Returns the exact gap between current history length and
  // `INITIAL_VISIBLE` whenever a "load is incoming" signal is
  // active -- either the initial hydration is still running,
  // OR an auto-refill from a recent delete is awaiting its
  // backfill fetch.  Otherwise returns 0 so the eager `<ul>`
  // renders no placeholders.  Unified across the two loading
  // shapes so the rendering code stays a single
  // `{#each Array(gap)}` block; the existing hydration path's
  // empty-then-2-skeletons rendering is preserved naturally
  // by the same arithmetic (history.length === 0 →
  // gap === INITIAL_VISIBLE).
  eagerSkeletonCountFor(workspaceId: Uuid): number {
    if (!this.hydratingFor(workspaceId) && !this.autoRefillingFor(workspaceId)) return 0;
    const hist = this.historyByWs.get(workspaceId) ?? [];
    return Math.max(0, INITIAL_VISIBLE - hist.length);
  }

  // Skeleton-row count for the older-tier `<ul>` in
  // `TrainHistory`.  Snapshotted at click-time by
  // `handleOlderExpand` / `loadMoreHistory` to exactly the
  // number of rows the in-flight `loadBatch` will surface,
  // capped at `PAGE_SIZE`.  Zero when no load is pending --
  // including the "expand on an already-loaded older tier"
  // case where `handleOlderExpand` only refreshes discovery
  // and does NOT call `loadBatch`, AND including the case
  // where discovery is fully drained (`loadable === 0`).
  //
  // Honest by construction: the placeholder count never
  // exceeds the count of rows that will land in this batch.
  // A click on "Show 3 older runs" paints 3 skeletons and 3
  // rows replace them in place; a click on "Show 8 older
  // runs" paints 5 (one PAGE_SIZE) and the "Load 3 more"
  // affordance surfaces below afterwards.  Previously the
  // pane painted a single skeleton regardless of N, which
  // read as "1 row incoming" to the operator's eye even when
  // they'd just asked for many.
  olderSkeletonCountFor(workspaceId: Uuid): number {
    return this.olderLoadingPendingByWs.get(workspaceId) ?? 0;
  }

  // True while a `loadMoreHistory` call is in flight for this
  // workspace.  Drives the "Load older runs" button's
  // disabled + spinner affordance.
  loadingMoreFor(workspaceId: Uuid): boolean {
    return this.loadingMoreByWs.get(workspaceId) ?? false;
  }

  // True when the "older runs" accordion is open.  Defaults
  // false (collapsed).  Mirrors operator's last toggle within
  // the session; reset on `forget`.
  olderExpandedFor(workspaceId: Uuid): boolean {
    return this.olderExpandedByWs.get(workspaceId) ?? false;
  }

  // Eager-tier visible history: the top `INITIAL_VISIBLE`
  // entries of `historyByWs`.  These render unconditionally
  // on workspace mount.  Returns session-observed terminals
  // interspersed with hydrated entries in mtime order (per
  // `pushHistoryBatch`'s sort).
  eagerHistoryFor(workspaceId: Uuid): readonly TrackedTrainingJob[] {
    const hist = this.historyByWs.get(workspaceId) ?? [];
    if (hist.length <= INITIAL_VISIBLE) return hist;
    return hist.slice(0, INITIAL_VISIBLE);
  }

  // Older-tier visible history: every loaded entry past the
  // eager tier.  Rendered inside the "Show older runs"
  // disclosure.
  olderHistoryFor(workspaceId: Uuid): readonly TrackedTrainingJob[] {
    const hist = this.historyByWs.get(workspaceId) ?? [];
    if (hist.length <= INITIAL_VISIBLE) return [];
    return hist.slice(INITIAL_VISIBLE);
  }

  // Count of older-tier entries the operator could still
  // reveal -- i.e., discovered but not yet loaded into
  // `historyByWs`.  Drives the "Load N more" pagination
  // button's count + visibility.  Zero hides the affordance.
  //
  // Clamped at `MAX_HISTORY_PER_WS - history.length` to stay
  // honest against backend-side retention: a session that
  // trains many jobs causes the producer to prune older
  // entries from disk, but `discoveredByWs` is a mount-time
  // snapshot and does not refresh.  Without the clamp, a
  // session that runs N jobs would inflate the "Show K older
  // runs" badge by up to N stale entries that the user can
  // never load (the JSONLs no longer exist).  The clamp ties
  // the visible count to the backend's keep-last-N invariant:
  // at most `MAX_HISTORY_PER_WS - history.length` more entries
  // can possibly be loaded, regardless of how many stale
  // jobIds linger in `discoveredByWs`.  `fetchAndReplay`'s
  // 404 handler eventually prunes the stale ids so the loop
  // count also converges.
  loadableOlderCountFor(workspaceId: Uuid): number {
    const discovered = this.discoveredByWs.get(workspaceId);
    if (!discovered) return 0;
    const history = this.historyByWs.get(workspaceId) ?? [];
    const loadedIds = new Set<Uuid>(history.map((j) => j.jobId));
    let n = 0;
    for (const r of discovered) {
      if (loadedIds.has(r.jobId)) continue;
      n++;
    }
    const remainingCapacity = Math.max(0, MAX_HISTORY_PER_WS - history.length);
    return Math.min(n, remainingCapacity);
  }

  // ── Persistent-history hydration methods ───────────────────

  // Idempotent: a second call for the same workspace returns
  // immediately when `discoveredByWs` is already populated.
  // Failure (network error) leaves the discovery slot unset
  // so the next workspace mount retries automatically.
  //
  // The workspace-page mount calls this fire-and-forget
  // alongside `recover()`.  Both run concurrently because
  // they're independent: `recover` finds an active running
  // job (via `/training`); `hydrateHistory` populates
  // terminal history from disk (via `/assets/training_logs`).
  // A jobId that surfaces in both -- a running run whose
  // JSONL is also on disk -- is gated by `fetchAndReplay`'s
  // active-slot guard: we never push the active jobId into
  // history.
  async hydrateHistory(workspaceId: Uuid): Promise<void> {
    if (this.discoveredByWs.has(workspaceId)) return;
    if (this.hydratingByWs.get(workspaceId)) return;
    this.hydratingByWs.set(workspaceId, true);
    // Best-effort migration: drop any soft-hide list a prior
    // revision wrote so the localStorage key doesn't leak
    // past the redesign that hard-deletes instead of hiding.
    clearLegacyHiddenStorage(workspaceId);
    try {
      const discovered = await this.fetchDiscoveryListing(workspaceId);
      this.discoveredByWs.set(workspaceId, discovered);
      // Eager tier: load up to `INITIAL_VISIBLE` non-active,
      // non-already-loaded entries.
      await this.loadBatch(workspaceId, INITIAL_VISIBLE);
    } catch (e) {
      // Best-effort; the next mount retries.  No surfaced
      // banner -- a workspace with no past runs and a
      // transient backend hiccup looks identical, and a
      // banner here would be noisy on every cold start.
      console.warn('[training] hydrate failed', e);
    } finally {
      this.hydratingByWs.set(workspaceId, false);
    }
  }

  // List the workspace's `training_logs/` directory and project
  // the response into a sorted, capped `DiscoveredRun[]`.
  // Shared between `hydrateHistory` (initial mount) and
  // `refreshDiscovery` (older-disclosure expand) so both paths
  // agree on shape, sort order, and the
  // `MAX_HISTORY_PER_WS` ceiling.  Throws on listing error
  // (caller decides how to surface).
  //
  // `limit: 100` keeps a comfortable headroom over the
  // backend's `LOG_RETENTION_KEEP_COUNT = 10` for the
  // transition window where a workspace straddles a daemon
  // upgrade and still has pre-cap files on disk; the server
  // sorts by jobId (not mtime), so over-fetching guarantees
  // we see the actual mtime-newest entries when we sort
  // client-side here.
  private async fetchDiscoveryListing(workspaceId: Uuid): Promise<DiscoveredRun[]> {
    const listing = await trainingApi.listLogs(workspaceId, { limit: 100 });
    const discovered: DiscoveredRun[] = [];
    for (const entry of listing.entries) {
      if (entry.kind !== 'file') continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      const jobId = entry.name.slice(0, -'.jsonl'.length);
      if (jobId.length === 0) continue;
      discovered.push({
        jobId,
        mtime: entry.mtime,
        sizeBytes: entry.size_bytes ?? 0
      });
    }
    // Newest-first by mtime; tie-break by jobId so the order
    // is stable across listings (filesystems can produce
    // sub-second-equal mtimes on fast back-to-back runs).
    // Strict-weak tiebreak: return 0 on equal jobIds.  In
    // practice `<workspace>/training_logs/<job_id>.jsonl` paths
    // are unique per jobId so the equal case never fires, but
    // a non-zero-on-equal comparator violates `Array.sort`'s
    // contract and is fragile to future call sites that pass
    // arrays with duplicates.
    discovered.sort((a, b) => {
      if (a.mtime > b.mtime) return -1;
      if (a.mtime < b.mtime) return 1;
      if (a.jobId < b.jobId) return -1;
      if (a.jobId > b.jobId) return 1;
      return 0;
    });
    // Clamp to `MAX_HISTORY_PER_WS` so the discovery surface
    // never overstates the loadable count.  The backend's
    // producer-side retention keeps at most that many
    // `<job_id>.jsonl` files per tree, but a workspace
    // straddling an upgrade window (or a transient race
    // against a producer that hasn't run its first
    // retention sweep yet) can briefly list more.  Trimming
    // here keeps `loadableOlderCountFor` honest and prevents
    // `loadBatch` from fetching entries that
    // `pushHistoryBatch` would immediately evict (the
    // newest `MAX_HISTORY_PER_WS` always win the sort).
    return discovered.slice(0, MAX_HISTORY_PER_WS);
  }

  // Re-list the workspace's `training_logs/` directory and
  // replace `discoveredByWs` with the fresh entries.  Called
  // from the "Show N older runs" expand handler so the
  // disclosure operates on the backend's current
  // keep-last-N state -- including any pruning that happened
  // since mount (session producer, cross-tab trains, daemon
  // restart, ...).  Best-effort: a network failure leaves the
  // existing discovery in place so the user can still
  // interact with what we already know.
  private async refreshDiscovery(workspaceId: Uuid): Promise<void> {
    try {
      const discovered = await this.fetchDiscoveryListing(workspaceId);
      this.discoveredByWs.set(workspaceId, discovered);
    } catch (e) {
      console.warn('[training] refresh discovery failed', { workspaceId, error: e });
    }
  }

  // Reveal up to `PAGE_SIZE` older-tier runs from the
  // backend.  Drives BOTH the auto-load on the first
  // disclosure expand and the explicit "Load N more"
  // pagination button.  Bounded per-click so the
  // `Promise.all` never fans out wider than `PAGE_SIZE`
  // parallel JSONL fetches -- 8 parallel fetches was
  // noticeably laggy on eMMC backends.  Serialised against
  // itself via `loadingMoreByWs` so a double-click can't
  // fire two parallel batches.
  async loadMoreHistory(workspaceId: Uuid): Promise<void> {
    if (!this.discoveredByWs.has(workspaceId)) return;
    if (this.loadingMoreByWs.get(workspaceId)) return;
    this.loadingMoreByWs.set(workspaceId, true);
    // Snapshot the batch size BEFORE the fetch so the
    // skeleton-row count `TrainHistory` paints matches what
    // the "Load N more" button just promised.  Computed
    // against the cached discovery + history, capped at
    // `PAGE_SIZE` -- identical to `loadBatch`'s internal
    // `min(targetAdd, available)` cap, so the placeholders
    // line up one-to-one with the rows that actually land.
    // A zero snapshot (already at the discovered floor) skips
    // setting the slot at all, so the placeholder loop renders
    // nothing -- belt-and-suspenders for the
    // `loadable === 0` path that should never reach here (the
    // `Load N more` button hides on that condition).
    const pending = Math.min(this.loadableOlderCountFor(workspaceId), PAGE_SIZE);
    if (pending > 0) this.olderLoadingPendingByWs.set(workspaceId, pending);
    try {
      await this.loadBatch(workspaceId, PAGE_SIZE);
    } finally {
      this.loadingMoreByWs.set(workspaceId, false);
      this.olderLoadingPendingByWs.delete(workspaceId);
    }
  }

  // Walk `discoveredByWs` from the start, skipping already-
  // loaded entries, fetch up to `targetAdd` JSONLs in
  // parallel, and push them into history.  Used by both the
  // eager (hydrateHistory) and lazy (loadMoreHistory) paths
  // with different `targetAdd` values.
  //
  // Returns silently when there's nothing to add -- the
  // caller's `loadableOlderCountFor` already conveyed the
  // exhausted state to the UI.
  private async loadBatch(workspaceId: Uuid, targetAdd: number): Promise<void> {
    if (targetAdd <= 0) return;
    const discovered = this.discoveredByWs.get(workspaceId);
    if (!discovered || discovered.length === 0) return;
    const loadedIds = new Set<Uuid>((this.historyByWs.get(workspaceId) ?? []).map((j) => j.jobId));
    const toFetch: DiscoveredRun[] = [];
    for (const run of discovered) {
      if (toFetch.length >= targetAdd) break;
      if (loadedIds.has(run.jobId)) continue;
      // Skip the active slot (recover() owns it).  We can't
      // also reliably gate later on race-with-recover because
      // active may bind between this check and the JSONL
      // fetch's resolution; `fetchAndReplay` re-checks at
      // push time.
      if (this.active?.jobId === run.jobId) continue;
      toFetch.push(run);
    }
    if (toFetch.length === 0) return;
    const fetched = await Promise.all(
      toFetch.map((run) => this.fetchAndReplay(workspaceId, run.jobId))
    );
    const terminals = fetched.filter((j): j is TrackedTrainingJob => j !== null);
    if (terminals.length > 0) this.pushHistoryBatch(workspaceId, terminals);
  }

  // Fetch one JSONL page and replay it into a
  // `TrackedTrainingJob`.  Returns `null` when:
  //   - the JSONL is unreadable (parse error / transient
  //     network failure)
  //   - the JSONL is permanently gone (HTTP 404 — the
  //     producer's keep-last-N retention swept it past the
  //     window after the mount-time directory listing
  //     snapshotted its existence).  Confirmed-gone entries
  //     are pruned from `discoveredByWs` here so the next
  //     `loadableOlderCountFor` reads a converged count and
  //     a subsequent `loadMoreHistory` click won't re-attempt
  //     the same dead path.
  //   - replay produced no view (empty file)
  //   - the run is still in-flight (no terminal event in
  //     JSONL; either `recover()` will pick it up via SSE,
  //     or it's an abandoned run that we don't surface in
  //     v1)
  //   - the jobId matches the current active slot (recover
  //     owns it; double-tracking would render two cards for
  //     one run)
  private async fetchAndReplay(workspaceId: Uuid, jobId: Uuid): Promise<TrackedTrainingJob | null> {
    if (this.active?.jobId === jobId) return null;
    let page;
    try {
      page = await trainingApi.readLogPage(workspaceId, jobId, {
        afterSeq: 0,
        limit: HYDRATION_LOG_LIMIT
      });
    } catch (e) {
      if (isApiError(e) && e.status === 404) {
        // The backend's producer-side keep-last-N retention
        // swept this entry after we discovered it; prune the
        // stale jobId from `discoveredByWs` so the
        // loadable-count and re-attempt loop converge.
        // Transient errors (5xx / network) leave the entry
        // in place so the next mount's hydration can retry.
        this.dropFromDiscovered(workspaceId, jobId);
      } else {
        console.warn('[training] replay fetch failed', { workspaceId, jobId, error: e });
      }
      return null;
    }
    // Re-check active after the await: a fast-finishing run
    // we tried to fetch could have terminated and re-pushed
    // via SSE handleTerminal during the round-trip.  In that
    // case, the session-pushed entry is authoritative.
    if (this.active?.jobId === jobId) return null;
    if (page.events.length === 0) return null;
    return replayJsonl(workspaceId, jobId, page.events);
  }

  // Remove a confirmed-stale jobId from `discoveredByWs`.
  // Called when a `fetchAndReplay` hits a 404, indicating
  // the backend's producer-side retention has pruned the
  // file we discovered at mount time.  Idempotent and a
  // no-op when the workspace has no discovery state or the
  // id is already absent.
  private dropFromDiscovered(workspaceId: Uuid, jobId: Uuid): void {
    const prev = this.discoveredByWs.get(workspaceId);
    if (!prev) return;
    const next = prev.filter((r) => r.jobId !== jobId);
    if (next.length === prev.length) return;
    this.discoveredByWs.set(workspaceId, next);
  }

  // Clear all state for `workspaceId` (e.g. workspace deleted).
  // If the active slot belongs to this workspace, the
  // subscriber stops, an in-flight gap-recovery backfill
  // stops, and the slot frees.  Also clears the persistent-
  // history bookkeeping (discoveredByWs, accordion state,
  // loading flags) so a re-mount triggers fresh hydration.
  // No daemon-side mutation -- the workspace delete flow
  // already cancels the train job through `WorkspaceDelete`'s
  // reference release; we just drop the local tracker.  Any
  // legacy soft-hide list left over from an earlier revision
  // is opportunistically cleaned up so the localStorage key
  // doesn't outlive its workspace.
  forget(workspaceId: Uuid): void {
    if (this.active?.workspaceId === workspaceId) {
      this.subscriber.stop();
      this.logTail.stop();
      this.active = null;
    }
    this.historyByWs.delete(workspaceId);
    this.discoveredByWs.delete(workspaceId);
    this.hydratingByWs.delete(workspaceId);
    this.loadingMoreByWs.delete(workspaceId);
    this.olderExpandedByWs.delete(workspaceId);
    // Drop history-row delete state too -- a workspace-delete
    // implicitly cleans up every JSONL in the tree (the daemon's
    // `WorkspaceDelete` flow stages the whole workspace dir),
    // so any in-flight `deleteHistoryEntry` resolves into a
    // no-op locally.  The `deletingHistoryByWs` clear races
    // benignly with the in-flight pipeline's `finally` block
    // (the `.get(workspaceId)` returns undefined, the cleanup
    // short-circuits).  The error banner from a previous failed
    // attempt has no surface to render on once the workspace is
    // gone, so wipe it too.
    this.deletingHistoryByWs.delete(workspaceId);
    this.historyDeleteErrorByWs.delete(workspaceId);
    // Drop any in-flight auto-refill counter.  Like the
    // recover Promise tracked below, the actual `loadBatch`
    // call can't be aborted -- it resolves into a no-op
    // (`pushHistoryBatch` reads the now-empty `historyByWs`
    // and writes back), or 404s the deleted workspace's
    // JSONLs.  Clearing the counter keeps the eager-tier
    // skeleton from lingering visually on a re-mount of the
    // same id (unlikely after a workspace delete, but cheap
    // to be exact).
    this.autoRefillingByWs.delete(workspaceId);
    // Same reasoning for the older-tier pending-count
    // snapshot.  A workspace-delete mid-load lets the
    // in-flight `loadBatch` resolve into nothing (no rows
    // land); the snapshot would self-clear via its own
    // `finally` block, but a stale entry surviving a
    // workspace re-mount would render N phantom skeletons.
    this.olderLoadingPendingByWs.delete(workspaceId);
    // Drop any in-flight recover Promise reference.  The Promise
    // itself can't be aborted (`trainingApi.list` doesn't take a
    // signal) so the round-trip still resolves -- but its
    // post-await `this.active = ...` write either no-ops (the
    // daemon's listing returned empty / 404 because the
    // workspace is gone) or binds a freshly-orphaned active slot
    // we'll have to deal with on the next mount.  Removing the
    // entry from the map at least frees the slot so a re-mount
    // of the same id can fire a fresh recover without coalescing
    // onto the orphaned Promise.
    this.recoveringByWs.delete(workspaceId);
    clearLegacyHiddenStorage(workspaceId);
  }

  // Bind the SSE subscriber for a fresh-started or recovered
  // job.  Subscribes from `after_seq=afterSeq` (default `0`
  // for fresh start; the daemon's `latest_seq` for the
  // post-backfill rebind in `recoverFromGap`).  Idempotent:
  // the subscriber's own `start()` calls `stop()` first, so
  // a re-bind for the same jobId resets the cursor;
  // re-binding for a different jobId fires events into the
  // new active slot.
  //
  // The transport is `EventSource` over the cross-cutting
  // `GET /api/v1/jobs/{id}/events` route, which the daemon's
  // training producer feeds via the `JobHandle::append_log`
  // bridge in `modules/training.rs:emit_train_event`.
  //
  // Four callback shapes fan into the store, each updating a
  // disjoint slice of the active job:
  //
  //   - `onEvent(TrainLogLine)` -- typed `TrainEvent` payload
  //      lifted with `seq` + `at` from the envelope.  Drives
  //      `logLines`, `epochs[]` (on `epoch_completed`), and
  //      the per-kind view-field effects (phase, result,
  //      error, terminal state).  Also fires the belt-and-
  //      braces terminal trigger so a stream that drops the
  //      separate state transition (e.g. close-mid-flight)
  //      still routes the job into history.
  //   - `onProgress(progress, at, seq)` -- rate-limited
  //      (~4 Hz) cross-cutting progress tick from
  //      `JobHandle::update_progress`.  Drives
  //      `view.progress.current / total`.
  //   - `onStateTransition(state, at, seq)` -- the daemon's
  //      terminal `Succeeded | Failed | Cancelled` flip from
  //      `JobHandle::terminate`.  Drives `view.state` and
  //      fires `handleTerminal`.
  //   - `onGap({oldest_seq, latest_seq})` -- daemon returned
  //      HTTP 409 `event_gap` (ring evicted events older
  //      than our cursor).  Route to `recoverFromGap`, which
  //      backfills via JSONL then re-binds SSE at
  //      `latest_seq`.  Bounded to `MAX_GAP_RETRIES`
  //      consecutive recoveries.
  //
  // `gapRetries` accumulates across the gap → recover →
  // rebind chain so a pathological loop (daemon ring keeps
  // evicting faster than we can backfill) terminates instead
  // of recursing forever.
  private bindSubscriber(jobId: Uuid, afterSeq = 0, gapRetries = 0): void {
    this.subscriber.start(jobId, {
      afterSeq,
      onEvent: (event) => {
        this.ingestLogEvent(jobId, event);
      },
      onProgress: (progress, at) => {
        const cur = this.active;
        if (cur?.jobId !== jobId) return;
        this.active = {
          ...cur,
          view: applyProgressToView(cur.view, progress, at, jobId, cur.workspaceId)
        };
      },
      onStateTransition: (state, at) => {
        const cur = this.active;
        if (cur?.jobId !== jobId) return;
        const nextView = applyStateToView(cur.view, state, at, jobId, cur.workspaceId);
        this.active = { ...cur, view: nextView };
        if (nextView.state !== 'running') {
          this.handleTerminal(cur.workspaceId, jobId, nextView);
        }
      },
      onGap: ({ latest_seq }) => {
        if (gapRetries >= MAX_GAP_RETRIES) {
          console.warn(
            '[training-subscriber] gap-recovery retries exhausted; UI may be incomplete'
          );
          return;
        }
        void this.recoverFromGap(jobId, latest_seq, gapRetries + 1);
      },
      onError: (reason) => {
        // Transient transport errors leave EventSource in
        // CONNECTING state; the browser auto-reconnects and
        // our seq dedup catches the replay.  This fires
        // only for unexpected permanent closes that the
        // diagnostic fetch couldn't classify as a gap or
        // 404.  Log so an engineer notices but don't
        // surface a banner.
        console.warn('[training-subscriber]', reason);
      }
    });
  }

  // Backfill the daemon's JSONL log over the gap window,
  // then re-bind the SSE subscriber at the post-backfill
  // cursor.  Called when the subscriber's `onGap` fires
  // because the daemon's SSE ring has evicted events older
  // than our `after_seq`.
  //
  // Flow:
  //   1. Stop the failed SSE subscriber so its retries
  //      don't compete with the tail's paging.
  //   2. Start `TrainingLogTail` to page JSONL from `seq=0`.
  //      The store's `ingestLogEvent` dedups on `seq`, so
  //      any events we already have are silently dropped.
  //      The tail's `drain()` waits for the page to return
  //      zero new events for the stable threshold OR a
  //      hard 3-second timeout -- bounded recovery time
  //      regardless of how much JSONL the daemon has
  //      accumulated.
  //   3. Re-bind SSE at the highest seq we now have in
  //      `logLines`, with the incremented gap-retry counter.
  //      A second gap that fires before
  //      `MAX_GAP_RETRIES` consecutive recoveries re-enters
  //      this method; beyond the cap the consumer gives up.
  //
  // No-op if the active slot has shifted (terminal observed
  // while the backfill was in flight, or workspace
  // forgotten).  The JSONL backfill *can* itself deliver the
  // terminal `job_completed | _failed | _cancelled` event,
  // in which case the store's belt-and-braces terminal
  // trigger in `ingestLogEvent` calls `handleTerminal` and
  // the rebind guard catches it.
  private async recoverFromGap(jobId: Uuid, latest: number, gapRetries: number): Promise<void> {
    const cur = this.active;
    if (cur?.jobId !== jobId) return;
    this.subscriber.stop();
    this.logTail.start(cur.workspaceId, jobId, {
      onEvent: (event) => {
        this.ingestLogEvent(jobId, event);
      },
      onError: (err) => {
        console.warn('[training-log-tail] gap backfill error', err);
      }
    });
    try {
      await this.logTail.drain();
    } catch (e) {
      console.warn('[training-log-tail] gap backfill drain failed', e);
    }
    this.logTail.stop();
    const still = this.active;
    if (still?.jobId !== jobId) return;
    // Resubscribe at the highest seq we now have.  If the
    // JSONL drain caught the terminal event, `handleTerminal`
    // already nulled `active` and the guard above returned.
    const lastSeq = still.logLines.reduce((m, l) => (l.seq > m ? l.seq : m), Math.max(0, latest));
    this.bindSubscriber(jobId, lastSeq, gapRetries);
  }

  // Apply one typed `TrainEvent` to the active slot.  Three
  // updates fan out from one event:
  //
  //   1. **logLines**: render the event to operator copy via
  //      `renderEvent` and append the resulting line.  Unknown
  //      kinds drop silently (forward-compat).
  //   2. **epochs[]**: on `epoch_completed`, merge an
  //      `EpochMetrics` entry via `mergeEpochFromEvent`
  //      (de-duped on `epoch` index).
  //   3. **view**: per-kind view-field updates via
  //      `applyEventToView` (`phase_started` → phase,
  //      `epoch_completed` → progress + metrics, terminal
  //      kinds → state/finished_at/result/error).
  //
  // Belt-and-braces: a terminal-kind event also fires
  // `handleTerminal` (idempotent with the
  // `onStateTransition` path) so a stream that closes
  // before delivering the separate `state` transition
  // still routes the job into history.
  //
  // De-duped on the event's `seq` so a future replay path
  // (SSE reconnect, etc.) can't introduce duplicate
  // scrollback rows or double-applied view fields.  No-op
  // when the active slot has shifted to a different job
  // mid-await.
  private ingestLogEvent(jobId: Uuid, event: TrainLogLine): void {
    const cur = this.active;
    if (cur?.jobId !== jobId) return;
    const last = cur.logLines.length > 0 ? cur.logLines[cur.logLines.length - 1] : null;
    if (last !== null && last.seq >= event.seq && last.seq >= 0) return;
    const rendered = renderEvent(event);
    const nextEpochs =
      event.kind === 'epoch_completed' ? mergeEpochFromEvent(cur.epochs, event) : cur.epochs;
    const nextLogLines =
      rendered === null
        ? cur.logLines
        : capLog([
            ...cur.logLines,
            {
              seq: event.seq,
              at: event.at,
              phase: rendered.phase,
              message: rendered.message,
              event
            }
          ]);
    const nextView = applyEventToView(cur.view, event, jobId, cur.workspaceId);
    // Capture the pre-allocated head_id when it's on the wire.
    // `start()` seeds `cur.headId` from the daemon's POST ack so
    // a fresh-launched job already has it; `recover()` seeds `''`
    // because the polled `TrainingJobView` doesn't carry head_id
    // -- the first `job_submitted` event then populates it here,
    // and `head_published` re-asserts the same value at publish
    // time.  Mirrors `replayJsonl`'s capture so the JSONL replay
    // path and the live SSE path produce identical
    // `TrackedTrainingJob.headId` for the same run.
    const nextHeadId =
      event.kind === 'job_submitted' || event.kind === 'head_published'
        ? event.head_id
        : cur.headId;
    this.active = {
      ...cur,
      headId: nextHeadId,
      view: nextView,
      epochs: nextEpochs,
      logLines: nextLogLines
    };
    // Belt-and-braces terminal trigger; idempotent with the
    // subscriber's `onStateTransition` path via the
    // `cur?.jobId !== jobId` guard inside `handleTerminal`.
    if (
      event.kind === 'job_completed' ||
      event.kind === 'job_failed' ||
      event.kind === 'job_cancelled'
    ) {
      this.handleTerminal(cur.workspaceId, jobId, nextView);
    }
  }

  // Freeze the active slot into the workspace's history.
  // Called from three paths -- the typed-event path in
  // `ingestLogEvent`, the state-transition path in
  // `bindSubscriber`, and any future synthetic-terminal
  // path -- so the `cur?.jobId !== jobId` guard below makes
  // every call after the first a no-op.  The guard runs
  // BEFORE the subscriber/tail teardown so a stale-jobId call
  // (e.g. a hypothetical future path that fires after a new
  // job has bound) can't accidentally rip the live transports
  // out from under the new active slot.  Today every caller
  // gates on the matching jobId immediately before the call,
  // so the guard is defensive; the ordering hardens the
  // method against future callers that forget that gate.
  //
  // `cur.epochs` is already fully built up via
  // `mergeEpochFromEvent` -- one epoch_completed event = one
  // entry, applied synchronously when the event landed -- so
  // we copy it straight through without re-deriving from a
  // polled metrics snapshot.
  private handleTerminal(workspaceId: Uuid, jobId: Uuid, view: TrainingJobView): void {
    const cur = this.active;
    if (cur?.jobId !== jobId) return;
    this.subscriber.stop();
    this.logTail.stop();
    const terminal: TrackedTrainingJob = {
      ...cur,
      view,
      cancelling: false
    };
    this.pushHistory(workspaceId, terminal);
    this.active = null;
    // Increment the signal so any workspace-detail `$effect`
    // re-fetches.  Even if no consumer is bound, the
    // increment is free.
    this.terminalSeq = this.terminalSeq + 1;
  }

  // Push a terminal job onto the workspace's history list.
  // Delegates to `pushHistoryBatch` so the merge + sort +
  // cap discipline lives in one place.
  private pushHistory(workspaceId: Uuid, terminal: TrackedTrainingJob): void {
    this.pushHistoryBatch(workspaceId, [terminal]);
  }

  // Merge a batch of terminal jobs into the workspace's
  // history list.  Newest-first by `view.started_at` (tied
  // by jobId for stable ordering), de-duped on `jobId`
  // (incoming entries win), and capped at
  // `MAX_HISTORY_PER_WS` (oldest evicted).
  //
  // Sorting (vs. the prior prepend-only model) is what makes
  // the hydration path correct: a hydrated entry with an
  // older `started_at` than a session terminal lands at its
  // chronological position rather than the front.  Session-
  // path callers pass a single fresh-terminal element whose
  // `started_at` is the newest -- the sort lands it at index
  // 0, matching the prior behavior.
  private pushHistoryBatch(workspaceId: Uuid, terminals: readonly TrackedTrainingJob[]): void {
    if (terminals.length === 0) return;
    const prev = this.historyByWs.get(workspaceId) ?? [];
    const incomingIds = new Set(terminals.map((t) => t.jobId));
    const filtered = prev.filter((j) => !incomingIds.has(j.jobId));
    const merged = [...filtered, ...terminals];
    // Strict-weak tiebreak: return 0 on equal jobIds.  `filtered`
    // + dedup-by-jobId above ensures `merged` has no duplicates
    // so the equal-jobId branch is unreachable today, but
    // returning non-zero on equal violates `Array.sort`'s
    // contract -- a fragile assumption for a comparator that a
    // future call site might feed a duplicate-bearing array.
    merged.sort((a, b) => {
      const aT = a.view?.started_at ?? '';
      const bT = b.view?.started_at ?? '';
      if (aT > bT) return -1;
      if (aT < bT) return 1;
      if (a.jobId < b.jobId) return -1;
      if (a.jobId > b.jobId) return 1;
      return 0;
    });
    this.historyByWs.set(workspaceId, merged.slice(0, MAX_HISTORY_PER_WS));
  }
}

// Initial `TrainingJobView` for a freshly-bound job slot
// before any event has landed.  Used by the view-derivation
// helpers when called with `view = null`.  The shape is
// minimal: `state: running` (the active slot only holds
// running jobs), `phase: prepare` (the first daemon stage),
// `current/total = 0` (no progress yet), and `started_at` set
// to whatever timestamp the *first* event the helper was
// called with carried -- typically the daemon's
// `job_submitted` emission time, which is the closest thing
// to a true wall-clock start.  `result`, `error`, and
// `finished_at` stay absent until a terminal event lands.
function initialView(jobId: Uuid, workspaceId: Uuid, startedAt: Rfc3339): TrainingJobView {
  return {
    job_id: jobId,
    workspace_id: workspaceId,
    state: 'running',
    progress: { phase: 'prepare', current: 0, total: 0, message: '' },
    started_at: startedAt
  };
}

// Apply one typed `TrainEvent` to the running view.  Returns
// a new view object with the relevant fields updated; passes
// `base` through unchanged for kinds with no view-field
// effect.  This is the only path that surfaces phase + per-
// epoch metrics into the view, since the cross-cutting
// `JobEvent.progress` field only carries flat `{done, total}`
// (no phase or metrics).
//
// Per-kind effects:
//   - `job_submitted`     → state='running', started_at=at,
//                           progress.phase='prepare'
//   - `phase_started`     → progress.phase=event.phase
//   - `epoch_completed`   → progress.current/total + .metrics
//   - `job_completed`     → state='completed', finished_at=at,
//                           result=event.result
//   - `job_failed`        → state='failed', finished_at=at,
//                           error=event.error
//   - `job_cancelled`     → state='cancelled', finished_at=at
//   - other kinds         → no-op (informational; their data
//                           lives in the typed event payload
//                           on the log line)
function applyEventToView(
  view: TrainingJobView | null,
  event: TrainLogLine,
  jobId: Uuid,
  workspaceId: Uuid
): TrainingJobView {
  const base: TrainingJobView = view ?? initialView(jobId, workspaceId, event.at);
  switch (event.kind) {
    case 'job_submitted':
      return {
        ...base,
        state: 'running',
        started_at: event.at,
        progress: { ...base.progress, phase: 'prepare' }
      };
    case 'phase_started':
      return { ...base, progress: { ...base.progress, phase: event.phase } };
    case 'epoch_completed': {
      const metrics: EpochMetrics = {
        epoch: event.epoch,
        epochs: event.epochs,
        train_loss: event.train_loss,
        train_acc: event.train_acc,
        val_acc: event.val_acc,
        best_val_acc: event.best_val_acc
      };
      return {
        ...base,
        progress: {
          ...base.progress,
          current: event.epoch,
          total: event.epochs,
          metrics
        }
      };
    }
    case 'job_completed':
      return {
        ...base,
        state: 'completed',
        finished_at: event.at,
        result: event.result
      };
    case 'job_failed':
      return {
        ...base,
        state: 'failed',
        finished_at: event.at,
        error: event.error
      };
    case 'job_cancelled':
      return {
        ...base,
        state: 'cancelled',
        finished_at: event.at
      };
    // job_running / dataset_scanned / feature_extract_completed
    // / train_split / train_completed / head_published: no
    // view-field effects.
    default:
      return base;
  }
}

// Apply a rate-limited progress tick from
// `JobHandle::update_progress`.  Updates `view.progress.current
// / total` from the cross-cutting registry's flat `JobProgress`
// shape; phase + metrics are unaffected (those flow only via
// typed events through `applyEventToView`).  `total` falls
// back to the prior value when the producer hasn't yet
// learned the work-set size (e.g. early in dataset scan).
function applyProgressToView(
  view: TrainingJobView | null,
  progress: JobProgress,
  at: Rfc3339,
  jobId: Uuid,
  workspaceId: Uuid
): TrainingJobView {
  const base: TrainingJobView = view ?? initialView(jobId, workspaceId, at);
  return {
    ...base,
    progress: {
      ...base.progress,
      current: progress.done,
      total: progress.total ?? base.progress.total
    }
  };
}

// Apply a `JobState` transition from `JobHandle::terminate`.
// In the cross-cutting registry, state events only fire on
// terminal (succeeded / failed / cancelled); pre-terminal
// state is implicitly 'running'.  Map the cross-cutting
// enum (`queued | running | succeeded | failed | cancelled`)
// to the training-domain enum (`running | completed |
// failed | cancelled`): `succeeded` → `completed`,
// `queued | running` → `running` (training has no queue).
function applyStateToView(
  view: TrainingJobView | null,
  state: JobState,
  at: Rfc3339,
  jobId: Uuid,
  workspaceId: Uuid
): TrainingJobView {
  const base: TrainingJobView = view ?? initialView(jobId, workspaceId, at);
  let trainState: TrainingJobView['state'];
  switch (state) {
    case 'succeeded':
      trainState = 'completed';
      break;
    case 'failed':
      trainState = 'failed';
      break;
    case 'cancelled':
      trainState = 'cancelled';
      break;
    case 'queued':
    case 'running':
    default:
      trainState = 'running';
      break;
  }
  const isTerminal =
    trainState === 'completed' || trainState === 'failed' || trainState === 'cancelled';
  return {
    ...base,
    state: trainState,
    finished_at: isTerminal ? at : base.finished_at
  };
}

// Drop the oldest entries when the log exceeds the cap.  A
// 500-entry slice is the trade-off between "see everything"
// and "the operator's scrollback fits comfortably".  We cap
// here rather than in the renderer so the store's footprint
// stays bounded even if a consumer forgets to paginate.
function capLog(lines: TrainingLogLine[]): TrainingLogLine[] {
  if (lines.length <= MAX_LOG_LINES) return lines;
  return lines.slice(lines.length - MAX_LOG_LINES);
}

// Merge one `epoch_completed` event into the running per-epoch
// metrics list.  Mirrors `collectEpochs`'s dedup discipline
// (same `epoch` index → keep newest; out-of-order → replace
// slot; unobserved → append) but takes a typed event rather
// than a polled view so the JSONL replay path bypasses the
// `progress.metrics` field entirely.  Returns a new array
// (never mutates) so the caller's `$state` signal fires.
function mergeEpochFromEvent(
  prev: EpochMetrics[],
  event: Extract<TrainLogLine, { kind: 'epoch_completed' }>
): EpochMetrics[] {
  const m: EpochMetrics = {
    epoch: event.epoch,
    epochs: event.epochs,
    train_loss: event.train_loss,
    train_acc: event.train_acc,
    val_acc: event.val_acc,
    best_val_acc: event.best_val_acc
  };
  if (m.epoch === 0) return prev; // 1-indexed
  const last = prev.length > 0 ? prev[prev.length - 1] : null;
  if (last?.epoch === m.epoch) {
    // Same epoch already in the array.  Replace iff
    // `best_val_acc` advanced; otherwise return the same
    // reference so Svelte reactivity doesn't fire.
    const cur = m.best_val_acc;
    const ref = last.best_val_acc;
    if (cur !== null && ref !== null && cur > ref) {
      return [...prev.slice(0, -1), m];
    }
    return prev;
  }
  if (last !== null && last.epoch > m.epoch) {
    const idx = prev.findIndex((e) => e.epoch === m.epoch);
    if (idx >= 0) {
      const next = prev.slice();
      next[idx] = m;
      return next;
    }
    return prev;
  }
  return [...prev, m];
}

// Render one typed `TrainEvent` to an operator-facing log line.
// Returns `null` to drop the event from the scrollback (no
// kind currently does, but the path exists so a future event
// kind can be silently absorbed if its information is already
// captured by an adjacent line -- e.g. if we ever add a
// `metric_sample` event that's redundant with `epoch_completed`).
//
// The phase column is keyed off the event's natural phase:
//   - `phase_started` carries its own `phase` field
//   - `dataset_scanned` is emitted within `dataset_scan`
//   - `feature_extract_completed` within `feature_extract`
//   - `train_split` / `epoch_completed` / `train_completed`
//      within `train`
//   - `head_published` within `publish`
//   - `job_*` terminal events use the daemon-emitted `stage`
//      field where present (failed / cancelled) or fall back
//      to `prepare` (submitted / running)
// This per-event phase hard-coding mirrors the daemon's actual
// emission order (see `modules/training/finetune.rs`); a
// future producer that emits an event in a different phase
// would need its phase mapped here.
function renderEvent(event: TrainLogLine): { phase: Stage; message: string } | null {
  switch (event.kind) {
    case 'job_submitted':
      return {
        phase: 'prepare',
        message: `Job submitted · backbone ${event.backbone}`
      };
    case 'job_running':
      return { phase: 'prepare', message: 'Job running' };
    case 'phase_started':
      return { phase: event.phase, message: `Phase: ${STAGE_LABEL[event.phase]}` };
    case 'dataset_scanned': {
      // Class-count summary kept compact -- the per-class
      // breakdown (`event.classes`) is rich enough to deserve
      // its own affordance (a future "class distribution"
      // mini-bar in the expanded body), but a 3-of-N
      // truncation here would be misleading.  Surface the
      // headline and trust the typed event in `event` for
      // any future deeper view.
      return {
        phase: 'dataset_scan',
        message: `Scanned dataset · ${event.n_classes} ${event.n_classes === 1 ? 'class' : 'classes'} · ${event.n_examples_total} examples`
      };
    }
    case 'feature_extract_completed': {
      const dropped = event.dropped_nan + event.dropped_io;
      const droppedSuffix = dropped > 0 ? ` · dropped ${dropped}` : '';
      return {
        phase: 'feature_extract',
        message: `Features extracted · kept ${event.kept}${droppedSuffix} · ${(event.elapsed_ms / 1000).toFixed(2)}s`
      };
    }
    case 'train_split':
      return {
        phase: 'train',
        message: `Train split · ${event.train_n} train · ${event.val_n} val`
      };
    case 'epoch_completed': {
      const lossStr = Number.isFinite(event.train_loss) ? event.train_loss.toFixed(4) : '—';
      const trainAccStr = Number.isFinite(event.train_acc)
        ? `${(event.train_acc * 100).toFixed(1)}%`
        : '—';
      const valPart =
        event.val_acc !== null && Number.isFinite(event.val_acc)
          ? ` · val ${(event.val_acc * 100).toFixed(1)}%`
          : '';
      return {
        phase: 'train',
        message: `Epoch ${event.epoch}/${event.epochs} · loss ${lossStr} · train ${trainAccStr}${valPart}`
      };
    }
    case 'train_completed': {
      const bestPart =
        event.best_val_epoch !== undefined &&
        event.best_val_acc !== undefined &&
        event.best_val_acc !== null &&
        Number.isFinite(event.best_val_acc)
          ? ` · best val ${(event.best_val_acc * 100).toFixed(1)}% @ epoch ${event.best_val_epoch}`
          : '';
      return {
        phase: 'train',
        message: `Training loop done · ${event.epochs_run} ${event.epochs_run === 1 ? 'epoch' : 'epochs'} in ${(event.total_elapsed_ms / 1000).toFixed(2)}s${bestPart}`
      };
    }
    case 'head_published':
      // Full head id is part of the message string (not a separate
      // styled sub-row) so it reads as one continuous dot-separated
      // verdict line, matches the surrounding log typography, and
      // is selectable as part of the same text run for copy.  The
      // 8-char prefix shown in the TrainHistoryItem header is a
      // lookup tag; the log is where the full id lives for anyone
      // who needs to grab it.  Ordering puts the head id first
      // (the operator's primary "what just landed?" question),
      // then the metadata in HeadRow's `size · classes · rev`
      // order so the artifact-fact triple reads identically
      // across the deploy table, the delete-confirmation dialog,
      // and the training log: artifact-intrinsic facts (size +
      // classes) lead, workspace-version (rev) trails.  `rev N`
      // matches the DeployPane / HeadRow / ActiveHeadCard
      // convention so the workspace-revision token reads
      // identically across surfaces.
      return {
        phase: 'publish',
        message: `Head published · ${event.head_id} · ${formatBytes(event.size_bytes)} · ${event.n_classes} ${event.n_classes === 1 ? 'class' : 'classes'} · rev ${event.workspace_revision.id}`
      };
    case 'job_completed':
      return { phase: 'publish', message: 'Job completed' };
    case 'job_failed':
      return {
        phase: event.stage,
        message: `Job failed at ${STAGE_LABEL[event.stage]} · ${event.error}`
      };
    case 'job_cancelled':
      return {
        phase: event.stage,
        message: `Job cancelled at ${STAGE_LABEL[event.stage]}${event.reason === 'shutdown' ? ' (daemon shutdown)' : ''}`
      };
    default: {
      // Forward-compat: a newer daemon may emit a `kind` this
      // build doesn't recognise.  Return null so both the live
      // SSE path (`ingestLogEvent`) and the JSONL replay path
      // (`replayJsonl`) skip the log line silently rather than
      // dereferencing `undefined` on the next access (an
      // implicit-return without this arm).  The `never` assertion
      // catches a forgotten case at compile time: when a new
      // `TrainEvent` variant lands in `types.ts`, `event` here
      // narrows to that variant instead of `never` and TS errors,
      // pointing at the renderer that needs the new case.  Mirrors
      // `applyEventToView`'s default arm + the typed-event
      // comments in [api/types.ts §"TrainEvent"].
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

// Synthesise a `TrackedTrainingJob` from a JSONL page's events.
// Used by `hydrateHistory` + `loadMoreHistory` to rebuild a
// terminal run's full UI state -- view, per-epoch metrics,
// rendered log scrollback, captured `head_id` -- from the
// durable backstop alone, without depending on any in-memory
// daemon state.
//
// The fold is a straight replay of the same helpers the live
// SSE path uses: `applyEventToView` per kind, `mergeEpochFromEvent`
// on `epoch_completed`, `renderEvent` for the operator-facing
// log line.  This shared substrate is why a hydrated card is
// indistinguishable from a session-observed terminal -- they
// emerge from the same machine, just fed from a different
// source.
//
// Returns `null` when:
//   - `events` is empty (an open-but-never-written JSONL,
//     typically impossible because the daemon writes
//     `job_submitted` synchronously at admission);
//   - replay produced no view (no event had a recognised
//     kind);
//   - the final view's `state` is still `running` (no
//     terminal event in the JSONL).  These are
//     "abandoned" runs -- the worker crashed without
//     emitting a terminal -- which we omit in v1.  A
//     future enhancement could surface them under an
//     "interrupted" pill.
//
// Caller filters `null` returns before pushing to history.
function replayJsonl(
  workspaceId: Uuid,
  jobId: Uuid,
  events: readonly LogEvent[]
): TrackedTrainingJob | null {
  if (events.length === 0) return null;
  let view: TrainingJobView | null = null;
  let epochs: EpochMetrics[] = [];
  let logLines: TrainingLogLine[] = [];
  // The daemon emits the pre-allocated head_id in the very
  // first event (`job_submitted.head_id`) and again on
  // successful publish (`head_published.head_id`); both
  // match for a successful run.  We capture the latest
  // observation so a failed run still has the pre-allocated
  // id available (matching the live-path `start()` seed).
  let headId: Uuid = '';
  for (const raw of events) {
    // The wire envelope is `LogEvent` (loose `[k: string]:
    // unknown` payload); cast to the discriminated
    // `TrainLogLine` so the per-kind narrowing in the
    // helpers below resolves.  Unknown kinds drop silently
    // through the default arms in `applyEventToView` and
    // `renderEvent`.
    const event = raw as unknown as TrainLogLine;
    if (event.kind === 'job_submitted' || event.kind === 'head_published') {
      headId = event.head_id;
    }
    view = applyEventToView(view, event, jobId, workspaceId);
    if (event.kind === 'epoch_completed') {
      epochs = mergeEpochFromEvent(epochs, event);
    }
    const rendered = renderEvent(event);
    if (rendered !== null) {
      logLines.push({
        seq: event.seq,
        at: event.at,
        phase: rendered.phase,
        message: rendered.message,
        event
      });
    }
  }
  if (view === null) return null;
  // Skip in-flight runs (the SSE path owns those; a hydrated
  // duplicate would render two cards for one job).
  if (view.state === 'running') return null;
  // Apply the same per-job log-line cap the live path enforces
  // so a long abandoned-run JSONL doesn't blow our memory
  // budget through hydration alone.
  if (logLines.length > MAX_LOG_LINES) {
    logLines = logLines.slice(logLines.length - MAX_LOG_LINES);
  }
  return {
    workspaceId,
    jobId,
    headId,
    view,
    epochs,
    logLines,
    cancelling: false
  };
}

// Convenience for `view.state` terminal check across the
// codebase; centralises the import of `TERMINAL_TRAINING_STATES`.
export function isTerminalTrainingState(state: TrainingJobView['state'] | undefined): boolean {
  return state !== undefined && TERMINAL_TRAINING_STATES.has(state);
}

// Format the worst-case failure message a terminal job can
// carry.  `error` is the daemon's typed diagnostic; `message`
// is the trainer's last progress.message (often blank on
// abrupt failures).  Falls back to a state-flavoured generic
// so the operator never reads "undefined".
export function describeTerminalFailure(view: TrainingJobView): string {
  if (view.state !== 'failed') return '';
  // Prefer the daemon's typed `error` (set on the failed
  // terminal); fall back to the trainer's last progress
  // message.  Both are nullable on the wire.  `||` (not `??`)
  // because an empty-string `error` is just as useless as a
  // null one -- treat both as "no message".
  const errorMsg = view.error?.trim() ?? '';
  const progressMsg = view.progress.message.trim();
  const raw = errorMsg || progressMsg;
  return raw ? capFirst(raw, 'Training failed.') : 'Training failed.';
}

export const training = new TrainingStore();
