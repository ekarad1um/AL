// Global serial queue for daemon-side delete operations.
//
// The daemon's `JobRegistry` admits at most one job at a time from
// the entire delete family (`WorkspaceDelete`, `DatasetDelete`,
// `ConverterDelete`, `*LogsDelete`; `max_delete_jobs = 1`).  Firing
// N parallel DELETEs would 409 the overflow even when targeting
// unrelated resources.  This chain funnels every delete-flavoured
// API call so the next request only fires after the previous job's
// terminal SSE event lands.  One queue spans every feature area
// because the daemon's serialisation is global.

let chain: Promise<unknown> = Promise.resolve();

// Enqueue a delete on the global chain.  Resolves with the task's
// value on success; rejects with its error.  The chain itself
// never rejects -- a per-link `.catch` swallows failures so one
// bad delete doesn't stall the queue.  Callers own the full
// DELETE-ack + SSE-terminal lifecycle inside `task`.
export function enqueueDelete<T>(task: () => Promise<T>): Promise<T> {
  const work = chain.then(() => task());
  chain = work.catch(() => undefined);
  return work;
}
