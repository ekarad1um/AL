// JSONL-paged tail of a training job's typed event log --
// reserved for `event_gap` (409) fallback.
//
// ## Status: not on the routine event path
//
// As of the SSE bridge (2026-05), routine live progress flows
// through the cross-cutting SSE stream at
// `GET /api/v1/jobs/{id}/events`, consumed by
// [`TrainingSubscriber`].  This tail is kept as a backfill
// substrate for the one scenario SSE can't cover: the daemon's
// per-job event ring (default 1024 slots) overflows + evicts
// older events, the consumer reconnects with an `after_seq`
// older than the ring's oldest, and the SSE handler responds
// with HTTP 409 + `code: event_gap` carrying `oldest_seq` +
// `latest_seq`.  In that case the consumer pages JSONL from
// `oldest_seq - 1` until catching up, then resubscribes SSE at
// `after_seq = latest_seq`.
//
// In practice the gap never fires for typical loads (a 50-epoch
// run emits ~70 events vs. 1024 ring slots = 14x headroom), so
// this file is dormant.  We keep it so the gap-recovery path
// can be wired without re-deriving the JSONL paging discipline.
//
// ## Why two log substrates exist
//
// The daemon's training producer broadcasts every typed
// `TrainEvent` to two sinks via `emit_train_event` in
// `modules/training.rs`:
//   1. A `<workspace>/training_logs/<job_id>.jsonl` append-only
//      file -- the durable backstop, read by this module.
//   2. The cross-cutting `JobHandle::append_log` channel that
//      fans out over the SSE event ring to live subscribers.
//
// Both carry the same payload shape (`TrainLogLine = TrainEvent
// & {seq, at}`).  SSE is the routine path because it pushes
// instead of pulling; JSONL is the gap fallback because it
// retains everything the SSE ring may have evicted.
//
// ## Gates
//
// Three gates short-circuit a tick without ever calling the
// daemon:
//   1. `document.hidden` -- background tabs don't burn round-
//      trips on stale data.  `visibilitychange` resumes by
//      firing an immediate tick on regain.
//   2. `this.fetching` -- a previous tick's GET is still
//      outstanding.  Skip so a stalled call doesn't
//      backpressure into N concurrent fetches.
//   3. `start()`-cleared bindings post-await: a `stop()` or
//      `start()` swap while the GET was in flight drops the
//      response on the floor.
//
// ## Lifecycle
//
//   - `start(wsId, jobId, opts)` once per (job, log-tail
//     consumer) binding.  Idempotent: a second `start` tears
//     down the prior tail.  Begins paging from `seq=0` (or
//     wherever the consumer points it via a future
//     `afterSeq` option); replays every event the daemon has
//     emitted so far.
//   - `stop()` clears bindings + cancels the pending timer.
//     Idempotent.
//   - `drain()` returns a Promise that resolves once paging
//     catches up to the daemon's tail (a sequence of
//     `next_after_seq === afterSeq` ticks).  Useful for
//     gap-fill catch-up before re-arming the SSE subscriber.
//
// ## 404 handling
//
// The JSONL file is created by `TrainJobLog::open` at the
// daemon's training-admission path -- BEFORE the
// `POST /train` response returns -- so by the time a caller
// can `start()` this tail with the response's `job_id`, the
// file already exists with at least `job_submitted` +
// `job_running` inside.  A 404 is treated as "no events yet"
// and the tail retries on the next tick rather than fail
// hard.

import { training as trainingApi } from './endpoints';
import { isNotFound } from '$lib/utils/error-copy';
import type { LogEvent, TrainLogLine, Uuid } from './types';

export interface TrainingLogTailOptions {
  // Tick cadence in ms.  1 Hz by default -- one round-trip
  // per wall-clock second is the daemon's expected client
  // load on the workspace's asset surface for a paging
  // consumer.
  intervalMs?: number;
  // Maximum events per page.  500 is the practical ceiling
  // for a 1000-epoch run's worst case (epoch_completed ×
  // 1000 + a small handful of stage events) -- a paranoia
  // value, since typical runs emit <100 events total.  The
  // daemon caps at 1000 internally per `read_jsonl_page`.
  pageLimit?: number;
  // Called once per typed event, in monotonic `seq` order.
  // Unknown `kind` values arrive forward-compat as typed
  // narrows that miss every case -- consumers should skip
  // them silently rather than throw.
  onEvent?: (event: TrainLogLine) => void;
  // Called on any non-404 transport / parse error.  Paging
  // continues; the daemon keeps writing, and the next tick
  // recovers.  Persistent failures are visible in console
  // (the store wires this to `console.warn`).
  onError?: (err: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_PAGE_LIMIT = 500;

// Tiny non-cancellable sleep.  Used inside `drain()` between
// retries; the surrounding loop's bindings + `maxWaitMs`
// already bound the wait, so we don't need an AbortSignal.
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class TrainingLogTail {
  private workspaceId: Uuid | null = null;
  private jobId: Uuid | null = null;
  // Exclusive seq cursor: a tick paged events with `seq >
  // afterSeq`.  The daemon's `read_jsonl_page` echoes
  // `next_after_seq` -- which equals the last yielded seq on
  // a non-empty page, or our `afterSeq` on an empty page (so
  // a "no new events" tick is observable as
  // `next_after_seq === afterSeq`).
  private afterSeq = 0;
  private intervalMs = DEFAULT_INTERVAL_MS;
  private pageLimit = DEFAULT_PAGE_LIMIT;
  private opts: TrainingLogTailOptions = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fetching = false;
  private visibilityHandler: (() => void) | null = null;

  start(workspaceId: Uuid, jobId: Uuid, opts: TrainingLogTailOptions = {}): void {
    this.stop();
    this.workspaceId = workspaceId;
    this.jobId = jobId;
    this.afterSeq = 0;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.pageLimit = opts.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.opts = opts;

    if (typeof document !== 'undefined') {
      this.visibilityHandler = (): void => {
        if (document.hidden) return;
        // Returning to visibility -- immediate tick so a
        // long background pause doesn't keep the operator
        // looking at stale logs for a full interval.
        this.cancelTimer();
        void this.tick();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    // First tick fires immediately so a `start()` right after
    // `POST /train` makes the operator see the daemon's first
    // two events (`job_submitted` + `job_running`) within one
    // round-trip rather than waiting for the interval.
    void this.tick();
  }

  stop(): void {
    this.workspaceId = null;
    this.jobId = null;
    this.cancelTimer();
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.visibilityHandler = null;
  }

  // True while bound to a workspace + job.  Mirrors the
  // [`TrainingSubscriber.running`] getter so a future
  // gap-recovery consumer that owns both surfaces can branch
  // identically across them.
  get running(): boolean {
    return this.workspaceId !== null && this.jobId !== null;
  }

  // Force-drain to the current daemon tail.  Keeps paging
  // until a tick returns zero new events for
  // `stableThreshold` consecutive attempts OR a hard
  // `maxWaitMs` elapses.  Awaited by the training store on
  // terminal observation -- by the time this resolves, the
  // JSONL's final event (the terminal `job_completed |
  // _failed | _cancelled` line) has been forwarded through
  // `onEvent`.
  //
  // ## Why we don't just stop at the first empty tick
  //
  // The daemon's polled `state` field flips terminal *before*
  // the JSONL writer flushes the tail events for the run.
  // The dispatch order in `modules/training.rs` is:
  //   1. registry state update (poller observes terminal)
  //   2. watch channel send (poller observes terminal)
  //   3. JSONL log emit + `best-effort flush`
  // Steps 1 and 2 are synchronous; step 3 hits a tokio
  // buffered writer that lands the bytes "soon" but not
  // instantly.  A naive "stop at the first empty tick"
  // drain loop would observe one empty page during that
  // gap and bail, losing every event after the gap.
  //
  // We therefore retry empty ticks up to `stableThreshold`
  // times with a `tickDelayMs` pause between them, giving
  // the daemon a multi-hundred-ms window to land its tail.
  // Total maximum wall time is bounded by `maxWaitMs` so a
  // daemon that genuinely never flushes (defensive against
  // an IO stall, not expected) can't wedge the promise
  // forever.
  //
  // ## Idempotency
  //
  // No-op if not running.  Re-entrant via the `fetching`
  // mutex on `tickOnce`.  The periodic 1-Hz timer keeps
  // firing during drain; both paths serialise on
  // `fetching` so we never observe a duplicate fetch.
  async drain(
    opts: {
      maxWaitMs?: number;
      stableThreshold?: number;
      tickDelayMs?: number;
    } = {}
  ): Promise<void> {
    const maxWait = opts.maxWaitMs ?? 3_000;
    const stableTarget = opts.stableThreshold ?? 4;
    const tickDelay = opts.tickDelayMs ?? 150;
    const startedAt = Date.now();
    let stable = 0;
    // Bound the loop at a large iteration count so a
    // pathological zero-delay-zero-progress combination
    // (impossible given the `tickDelayMs` sleep below, but
    // defensive) can't spin forever.
    const MAX_ITERS = 200;
    for (let i = 0; i < MAX_ITERS; i++) {
      const wsId = this.workspaceId;
      const jobId = this.jobId;
      if (wsId === null || jobId === null) return;
      if (Date.now() - startedAt > maxWait) return;
      const before = this.afterSeq;
      await this.tickOnce();
      if (this.workspaceId !== wsId || this.jobId !== jobId) return;
      if (this.afterSeq > before) {
        // Made progress; reset the empty-tick counter and
        // keep paging hard (no delay -- we want to catch up
        // to a fast-emitting run as quickly as possible).
        stable = 0;
        continue;
      }
      stable += 1;
      if (stable >= stableTarget) return; // caught up + held stable
      // Tick produced nothing; give the daemon a beat to
      // flush before re-asking.  This is the gap that
      // closed the bug -- without it, drain returned
      // after observing the polled-state's "terminal" race
      // window where step 3 (JSONL flush) hadn't landed
      // yet.
      await sleep(tickDelay);
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextTick(): void {
    this.cancelTimer();
    if (this.workspaceId === null || this.jobId === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.intervalMs);
  }

  // Periodic tick.  Wraps `tickOnce` + schedules the next
  // interval.  Background-tab gate happens here; `tickOnce`
  // is the network-layer-only one used by `drain()` where
  // visibility gating is inappropriate.
  private async tick(): Promise<void> {
    if (typeof document !== 'undefined' && document.hidden) {
      this.scheduleNextTick();
      return;
    }
    await this.tickOnce();
    if (this.workspaceId !== null && this.jobId !== null) {
      this.scheduleNextTick();
    }
  }

  private async tickOnce(): Promise<void> {
    const wsId = this.workspaceId;
    const jobId = this.jobId;
    if (wsId === null || jobId === null) return;
    if (this.fetching) return;
    this.fetching = true;
    try {
      const page = await trainingApi.readLogPage(wsId, jobId, {
        afterSeq: this.afterSeq,
        limit: this.pageLimit
      });
      // Bindings swapped while the GET was in flight; drop
      // the response on the floor.  A re-start to a different
      // job would otherwise re-fire events from the old job
      // into the new job's consumer.
      if (this.workspaceId !== wsId || this.jobId !== jobId) return;
      for (const evt of page.events) {
        // Cast the `LogEvent` envelope (with `seq` + `at` +
        // arbitrary properties) to the discriminated
        // `TrainLogLine`.  Consumers narrow on `kind`;
        // unknown kinds drop silently.  We rely on the
        // backend honouring the schema -- a malformed line
        // would surface as a parse error in `readLogPage`,
        // not here.
        this.opts.onEvent?.(evt as unknown as TrainLogLine);
      }
      this.afterSeq = page.next_after_seq;
    } catch (e) {
      if (this.workspaceId !== wsId || this.jobId !== jobId) return;
      if (isNotFound(e)) {
        // The JSONL file doesn't exist yet (very early in
        // the admission path, before `TrainJobLog::open`).
        // Should not happen on a job we just got an ack
        // for, but the recovery flow could observe it on a
        // job the daemon hasn't fully wired.  Retry next
        // tick.
        return;
      }
      this.opts.onError?.(e);
    } finally {
      this.fetching = false;
    }
  }
}

// Re-export the envelope type so consumers don't have to
// reach into the `types` module separately when they only
// need to type-narrow what the tail handed them.
export type { LogEvent };
