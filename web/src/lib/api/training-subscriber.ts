// Live SSE subscription to a training job's typed-event stream
// at `GET /api/v1/jobs/{job_id}/events?after_seq=0&logs=true`.
//
// ## Why a dedicated subscriber alongside `api/jobs.ts:trackJob`
//
// `trackJob` is shaped for delete-family jobs: open SSE, wait
// for one terminal `state` transition, close.  Training jobs
// need a richer surface:
//
//   1. **Continuous streaming**.  Every typed `TrainEvent`
//      mid-run (60-ish per typical 50-epoch run) must reach
//      the consumer, not just the terminal state.
//   2. **Three event shapes**.  `JobEvent` is a sum-with-
//      optional-fields: `{state?}` for transitions,
//      `{progress?}` for the rate-limited 4-Hz progress tick,
//      and `{message?}` for the JSON-stringified typed
//      `TrainEvent` payload.  Each shape drives a different
//      consumer slot (state → `view.state` + terminal trigger;
//      progress → `view.progress.current / total`; message →
//      `logLines` + `epochs[]` + per-kind view-field
//      updates).  The training store consumes all three and
//      reconstructs the full `TrainingJobView` from the event
//      stream alone; the polled `/training/{job}` endpoint is
//      no longer on the routine path.
//   3. **JSON-in-JSON parsing**.  The daemon serialises
//      `TrainEvent` as a string in `JobEvent.message` (because
//      the cross-cutting `JobEvent` schema can't carry typed
//      payloads natively).  We `JSON.parse` the inner payload
//      and lift the envelope (`seq` + `at`) onto it to
//      produce a `TrainLogLine` -- the same shape the dormant
//      JSONL backfill tail produces, so the store's
//      `renderEvent` + `mergeEpochFromEvent` paths work
//      identically whether the line arrived live over SSE or
//      via a future gap-recovery page.
//   4. **Reconnect resilience**.  EventSource auto-reconnects
//      on transient errors but re-uses the original URL --
//      so a reconnect replays from `after_seq=0`.  Our
//      consumer dedups on `seq` (the store's `ingestLogEvent`
//      already does this on the JSONL path), so replays are
//      idempotent.  We don't pre-empt the browser's reconnect
//      because doing so cleanly is hard (close+reopen races
//      against in-flight `error` events); accepting the
//      browser default + relying on dedup is simpler and
//      equally correct.
//
// ## Lifecycle
//
//   - `start(jobId, opts)` opens the EventSource.  Idempotent:
//     a second `start` tears down the prior source.  Begins
//     paging the daemon's 1024-slot per-job event ring; the
//     ring is large enough to retain a full training run
//     (~70 events / 50-epoch run, 14× headroom).
//   - `stop()` closes the source.  Idempotent.
//   - The daemon closes the stream cleanly after broadcasting
//     a terminal state event (`state: succeeded | failed |
//     cancelled`).  We flag `terminalObserved` so the
//     subsequent `error` event with `readyState === CLOSED`
//     is recognised as a normal shutdown rather than a
//     transport failure.
//
// ## Why not consume `Last-Event-ID` for cursor preservation
//
// EventSource auto-attaches a `Last-Event-ID` header on
// reconnect if the server provided per-event `id:` lines.
// The daemon's SSE writer at `modules/api/routes/jobs.rs`
// doesn't emit `id:` lines (it only emits `event: job` +
// `data: ...`), so `Last-Event-ID` arrives empty.  We could
// emit `id:` server-side and consume it to skip server-side
// replay -- but client-side dedup-on-seq (in the store's
// `ingestLogEvent`) is sufficient and avoids a backend
// change.

import { jobs as jobsApi } from './endpoints';
import type {
  JobEvent,
  JobProgress,
  JobState,
  Rfc3339,
  TrainEvent,
  TrainLogLine,
  Uuid
} from './types';

// Terminal-state set, mirroring `api/jobs.ts:isTerminal` but
// inlined to avoid a cross-file circular dependency (this
// module is downstream of `endpoints.ts`).
const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set(['succeeded', 'failed', 'cancelled']);

// Gap-recovery payload from a `code: event_gap` 409 response.
// The daemon returns these bounds when the requested
// `after_seq` falls outside the per-job event ring.  The
// consumer is expected to backfill JSONL events between
// `oldest_seq` and `latest_seq` (inclusive of both ends),
// then resubscribe SSE at `after_seq = latest_seq`.
export interface TrainingSubscriberGap {
  oldest_seq: number;
  latest_seq: number;
}

export interface TrainingSubscriberOptions {
  // Subscribe cursor.  Default `0` (the per-job ring's
  // beginning).  Gap recovery passes the daemon's
  // `latest_seq` here so the new subscription picks up live
  // events after the JSONL backfill.
  afterSeq?: number;
  // Fired for every event carrying a typed `TrainEvent`
  // payload in `JobEvent.message`.  The payload is parsed
  // and wrapped with the envelope (`seq` + `at`) into a
  // `TrainLogLine`.  The store's existing `ingestLogEvent`
  // consumes this shape; unknown event kinds reach the
  // consumer untouched (forward-compat).
  onEvent?: (event: TrainLogLine) => void;
  // Fired when a `JobEvent.state` transition arrives.  The
  // daemon emits state events only on terminal (succeeded /
  // failed / cancelled); mid-run state stays implicitly
  // 'running'.  The store consumes this to update
  // `view.state` + `view.finished_at` and route the job into
  // history via `handleTerminal`.
  onStateTransition?: (state: JobState, at: Rfc3339, seq: number) => void;
  // Fired when a `JobEvent.progress` tick arrives.  The
  // daemon's `JobHandle::update_progress` rate-limits to
  // 4 Hz and carries flat `{done, total}` (no phase or
  // metrics).  Drives `view.progress.current / total`
  // between epoch_completed events.
  onProgress?: (progress: JobProgress, at: Rfc3339, seq: number) => void;
  // Fired when the daemon's SSE handler returns HTTP 409 +
  // `code: event_gap`.  This happens when the subscription's
  // `after_seq` is older than the ring's current `oldest_seq`
  // (the ring has evicted events the caller hasn't seen).
  // The consumer pages JSONL between `oldest_seq` and
  // `latest_seq`, then resubscribes at `after_seq =
  // latest_seq`.  EventSource alone can't see HTTP status
  // codes; we detect the 409 via a diagnostic `fetch()` when
  // the initial EventSource open closes without ever
  // delivering an event.
  onGap?: (gap: TrainingSubscriberGap) => void;
  // Non-recoverable error.  The browser's auto-reconnect
  // is allowed to fire for transient errors (`readyState
  // === CONNECTING` after the error fires); we only
  // signal `onError` when the stream is permanently
  // CLOSED without a terminal having been observed and
  // not classifiable as a gap.
  onError?: (reason: string) => void;
}

export class TrainingSubscriber {
  private source: EventSource | null = null;
  private jobId: Uuid | null = null;
  private afterSeq = 0;
  private opts: TrainingSubscriberOptions = {};
  // Latched true once a terminal `state` arrives so we can
  // distinguish the daemon's clean post-terminal stream
  // close (expected; no operator-visible warning) from a
  // transport failure (worth a `console.warn` via
  // `onError`).
  private terminalObserved = false;
  // True after the EventSource has delivered at least one
  // `job` frame.  Drives the error handler's classification
  // path: a permanent CLOSE with `hasReceivedAnyEvent ===
  // false` is likely a 4xx (404 / 409) at connection time
  // and warrants a diagnostic `fetch()` to read the actual
  // status; a CLOSE after events flowed is a mid-stream
  // failure (the browser retried + gave up).
  private hasReceivedAnyEvent = false;

  // Begin subscribing to `jobId`.  Idempotent: a second
  // `start` tears down the prior source via `stop()`.  The
  // EventSource is opened with `?after_seq={afterSeq}`
  // (default `0` -- replay every event in the per-job
  // ring).  Gap recovery passes the daemon's `latest_seq`
  // here so a recovering subscription picks up live events
  // *after* a JSONL backfill catches the gap up.
  //
  // The per-job ring holds 1024 events (vs. ~70 emitted by
  // a typical 50-epoch run, 14x headroom), so a fresh
  // `afterSeq=0` subscribe almost never gaps under normal
  // load.  On the rare gap, the diagnostic `fetch()` in the
  // error handler resolves the daemon's `code: event_gap`
  // body and fires `onGap`.
  start(jobId: Uuid, opts: TrainingSubscriberOptions = {}): void {
    this.stop();
    this.jobId = jobId;
    this.afterSeq = opts.afterSeq ?? 0;
    this.opts = opts;
    this.terminalObserved = false;
    this.hasReceivedAnyEvent = false;

    const url = jobsApi.eventsUrl(jobId, { afterSeq: this.afterSeq, logs: true });
    const source = new EventSource(url);
    this.source = source;

    // Daemon names its SSE frames `event: job`.  Listen
    // specifically so a future addition of other event
    // types (heartbeats, status, ...) doesn't accidentally
    // route through the job handler.
    source.addEventListener('job', (e: MessageEvent<string>) => {
      // Stale-source guard: a re-`start()` swapped the
      // EventSource under us between this listener being
      // bound and firing.  Drop the event on the floor.
      if (this.source !== source) return;
      if (typeof e.data !== 'string') return;
      this.hasReceivedAnyEvent = true;
      let envelope: JobEvent;
      try {
        envelope = JSON.parse(e.data) as JobEvent;
      } catch (err) {
        opts.onError?.(`malformed SSE envelope: ${String(err)}`);
        return;
      }
      this.dispatch(envelope);
    });

    source.addEventListener('error', () => {
      if (this.source !== source) return;
      // Browser distinguishes auto-reconnect (readyState ==
      // CONNECTING) from permanent close (readyState ==
      // CLOSED).  We act only on CLOSED.  CONNECTING is the
      // browser's own retry loop; replayed events get
      // de-duped on `seq` at the consumer.
      if (source.readyState !== EventSource.CLOSED) return;
      if (this.terminalObserved) return;
      if (this.hasReceivedAnyEvent) {
        // Stream was open + flowing, then died.  Either a
        // mid-flight transport failure or a daemon-side
        // close.  EventSource has given up retrying; the
        // operator's view shows the partial state captured
        // so far.
        opts.onError?.('event stream closed mid-stream');
        return;
      }
      // No events received before close -- the daemon
      // probably returned a 4xx (404 / 409) at connection
      // time.  Diagnose with a fetch on the same URL to
      // read the actual status + body.
      void this.diagnoseFailedSubscribe();
    });
  }

  stop(): void {
    this.jobId = null;
    if (this.source !== null) {
      this.source.close();
      this.source = null;
    }
  }

  // True while the EventSource is bound and not yet
  // permanently closed.  Mirrors [`TrainingLogTail.running`]
  // so a future gap-recovery consumer that owns both surfaces
  // can branch identically across them.
  get running(): boolean {
    return this.source !== null && this.source.readyState !== EventSource.CLOSED;
  }

  // Fan one `JobEvent` out to its three optional sinks.  A
  // single SSE event may carry any subset of
  // `{state, progress, message}` populated (the daemon
  // batches `state + progress` on terminal, for example),
  // so each branch fires independently.  Terminal-state
  // detection latches `terminalObserved` for the error
  // handler's "expected close" check.
  private dispatch(ev: JobEvent): void {
    if (ev.state !== undefined && TERMINAL_JOB_STATES.has(ev.state)) {
      this.terminalObserved = true;
    }
    if (ev.message !== undefined) {
      // A malformed payload (typically the daemon's 8 KiB
      // `max_log_line_bytes` truncation appending
      // ` ... [truncated]` to a long `dataset_scanned`,
      // breaking the JSON tail) must NOT short-circuit the
      // dispatch -- the daemon batches `state` + `progress` +
      // `message` on terminal frames, so an early return
      // would drop the terminal-state transition and leave
      // the store stuck at `running`.  Surface the parse
      // failure via `onError` and fall through to the other
      // branches; the typed-event emit is skipped for this
      // envelope only.
      let payload: TrainEvent | null = null;
      try {
        payload = JSON.parse(ev.message) as TrainEvent;
      } catch (err) {
        this.opts.onError?.(`malformed TrainEvent payload: ${String(err)}`);
      }
      if (payload !== null) {
        // Lift the envelope fields onto the typed payload
        // to produce a `TrainLogLine`.  Order matters:
        // spreading `payload` first means a (defensive)
        // event whose internal fields happen to be named
        // `seq` or `at` is overwritten by the envelope's
        // values -- the envelope is the source of truth.
        const line: TrainLogLine = { ...payload, seq: ev.seq, at: ev.at };
        this.opts.onEvent?.(line);
      }
    }
    if (ev.progress !== undefined) {
      this.opts.onProgress?.(ev.progress, ev.at, ev.seq);
    }
    if (ev.state !== undefined) {
      this.opts.onStateTransition?.(ev.state, ev.at, ev.seq);
    }
  }

  // Diagnostic fetch on EventSource permanent-close-without-
  // events.  EventSource can't expose HTTP status / body to
  // the caller, so we issue a regular `fetch()` to the same
  // URL and inspect the daemon's response.  Three outcomes:
  //
  //   - **HTTP 409 + `code: event_gap`**: the daemon's ring
  //     has evicted events older than the subscribe cursor.
  //     Fire `onGap({oldest_seq, latest_seq})` so the
  //     consumer can backfill JSONL and resubscribe at
  //     `latest_seq`.
  //   - **HTTP 404**: the job doesn't exist (yet / anymore).
  //     Fire `onError` with the typed reason.
  //   - **HTTP 200**: the daemon would have streamed
  //     successfully now -- the original EventSource close
  //     was a transient transport issue the browser gave up
  //     on.  Cancel the diagnostic stream so we don't leak
  //     the body, then fire `onError` so the consumer can
  //     decide how to surface this (today: console.warn).
  //
  // The diagnostic re-uses the subscriber's current
  // `afterSeq` so the daemon evaluates the gap predicate
  // identically to what the failing EventSource sent.  An
  // AbortController bounds the fetch at 5 seconds so a slow
  // / stalled daemon doesn't hold the recovery dance
  // forever; on timeout we fall through to `onError`.
  private async diagnoseFailedSubscribe(): Promise<void> {
    const jobId = this.jobId;
    if (jobId === null) return;
    const url = jobsApi.eventsUrl(jobId, { afterSeq: this.afterSeq, logs: true });
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, 5_000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      this.opts.onError?.(`gap-diagnostic fetch failed: ${String(e)}`);
      return;
    }
    clearTimeout(timer);
    // Bindings may have swapped (re-`start()`, `stop()`) while
    // the fetch was in flight.  Drop the response on the floor.
    if (this.jobId !== jobId) {
      // Cancel the response stream so the body isn't held.
      void resp.body?.cancel();
      return;
    }
    if (resp.status === 200) {
      // Stream would have flowed; the original EventSource
      // close was transport-side.  Don't consume the body.
      void resp.body?.cancel();
      this.opts.onError?.('event stream closed before terminal state');
      return;
    }
    if (resp.status === 409) {
      let body: { code?: string; oldest_seq?: number; latest_seq?: number };
      try {
        body = (await resp.json()) as typeof body;
      } catch {
        this.opts.onError?.('409 response had non-JSON body');
        return;
      }
      if (
        body.code === 'event_gap' &&
        typeof body.oldest_seq === 'number' &&
        typeof body.latest_seq === 'number'
      ) {
        this.opts.onGap?.({ oldest_seq: body.oldest_seq, latest_seq: body.latest_seq });
        return;
      }
      this.opts.onError?.(`409 with unexpected body code: ${body.code ?? 'unknown'}`);
      return;
    }
    if (resp.status === 404) {
      void resp.body?.cancel();
      this.opts.onError?.('job not found at daemon');
      return;
    }
    void resp.body?.cancel();
    this.opts.onError?.(`unexpected diagnostic status: ${resp.status}`);
  }
}
