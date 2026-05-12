import { jobs as jobsApi } from './endpoints';
import type { JobEvent, JobState, Uuid } from './types';

const TERMINAL_STATES: ReadonlySet<JobState> = new Set(['succeeded', 'failed', 'cancelled']);

export function isTerminal(state: JobState | undefined): boolean {
  return state !== undefined && TERMINAL_STATES.has(state);
}

export interface TrackJobOptions {
  // Initial cursor.  Subsequent events with `seq > afterSeq` are
  // emitted; older ones are skipped.  Caller is expected to pass 0
  // for a fresh subscription.
  afterSeq?: number;
  // Whether the daemon should include log-line events.  Slice B.1
  // (delete tracking) doesn't need logs, so the default `false`
  // keeps the SSE traffic to state transitions + progress.  Slice C
  // (train monitoring) will set this true.
  logs?: boolean;
  onEvent?: (ev: JobEvent) => void;
  onTerminal?: (ev: JobEvent) => void;
  // Fired for connection-level errors and SSE channel errors that
  // EventSource cannot auto-recover from.  Owners typically surface
  // it inline and treat the job as terminally unknown.
  onError?: (reason: string) => void;
}

export interface JobTracker {
  // Idempotent.  Once called, no further callbacks fire.
  cancel(): void;
}

// Minimal SSE subscriber for `GET /api/v1/jobs/{job_id}/events`.
// Slice B.1 only uses this for async workspace / asset delete jobs,
// which finish in seconds and rarely overflow the daemon's event
// ring -- so we deliberately do NOT yet implement the 409
// `event_gap` -> JSONL-backfill state machine called out in
// [docs/web/PLAN.md] Slice C.  Slice C will wrap this with a
// gap-recovering paginator + reconnect; this minimal implementation
// remains correct for short jobs and the wrapper can replace it
// without churning the call sites (the contract is closed via the
// `TrackJobOptions` shape).
export function trackJob(jobId: Uuid, opts: TrackJobOptions = {}): JobTracker {
  const url = jobsApi.eventsUrl(jobId, {
    afterSeq: opts.afterSeq,
    logs: opts.logs ?? false
  });
  const source = new EventSource(url);
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    source.close();
  };

  // Daemon names its SSE frames `event: job`.  Listen specifically
  // so a future addition of other event types (heartbeats, etc.)
  // doesn't accidentally route through the job handler.
  source.addEventListener('job', (e: MessageEvent) => {
    if (closed) return;
    let ev: JobEvent;
    try {
      ev = JSON.parse(e.data as string) as JobEvent;
    } catch (parseErr) {
      opts.onError?.(`malformed SSE payload: ${String(parseErr)}`);
      close();
      return;
    }
    opts.onEvent?.(ev);
    if (isTerminal(ev.state)) {
      opts.onTerminal?.(ev);
      close();
    }
  });

  // EventSource fires `error` for transport failures *and* for
  // normal close after a terminal event.  Distinguish by readyState:
  // CLOSED (2) after a terminal frame is expected; CONNECTING (0)
  // means the browser is retrying and we should let it; only OPEN
  // (1) or CLOSED-without-terminal needs operator visibility.
  source.addEventListener('error', () => {
    if (closed) return;
    if (source.readyState === EventSource.CLOSED) {
      opts.onError?.('event stream closed before terminal state');
      close();
    }
    // CONNECTING: browser auto-reconnects; nothing to do.
  });

  return {
    cancel: close
  };
}
