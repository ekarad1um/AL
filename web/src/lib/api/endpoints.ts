import { api, ApiError } from './http';
import type {
  ActiveResp,
  AsyncJobAck,
  CancelResp,
  DatasetListing,
  DeleteHeadResp,
  HeadManifest,
  HeadRecord,
  InferenceCfg,
  JobSnapshot,
  LogPageResp,
  MicPolicy,
  MicState,
  StatusSnapshot,
  TrainingCfg,
  TrainingJobView,
  TrainingListResp,
  TrainStartResp,
  Uuid,
  WorkspaceCreateReq,
  WorkspaceDetail,
  WorkspaceListEntry,
  WorkspaceMutationResp,
  WorkspacePatchReq
} from './types';

export const status = {
  get: () => api.get<StatusSnapshot>('/api/v1/status')
};

export const mic = {
  get: (minVersion?: number) => {
    const q = minVersion !== undefined ? `?min_version=${minVersion}` : '';
    return api.get<MicState>(`/api/v1/mic${q}`);
  },
  set: async (policy: MicPolicy): Promise<MicState> => {
    const fresh = await api.post<MicState>('/api/v1/mic', { policy });
    return readYourWrites(fresh.version);
  }
};

// Read-your-writes gate -- after a POST, fetch the policy again with
// ?min_version=N until the daemon agrees, then return the canonical state.
async function readYourWrites(minVersion: number, attempts = 0): Promise<MicState> {
  try {
    return await mic.get(minVersion);
  } catch (err) {
    if (err instanceof ApiError && err.status === 425 && attempts < 3) {
      await sleep(50 * 2 ** attempts);
      return readYourWrites(minVersion, attempts + 1);
    }
    throw err;
  }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export const inference = {
  get: () => api.get<{ cfg: InferenceCfg }>('/api/v1/inference').then((r) => r.cfg),
  set: (cfg: Partial<InferenceCfg>) =>
    api.post<{ cfg: InferenceCfg }>('/api/v1/inference', cfg).then((r) => r.cfg)
};

export const active = {
  get: () => api.get<ActiveResp>('/api/v1/active'),
  setHead: (workspace_id: Uuid, head_id: Uuid) =>
    api.post<ActiveResp>('/api/v1/active', { workspace_id, head_id }),
  setDefault: () => api.post<ActiveResp>('/api/v1/active', { default: true })
};

// Workspace CRUD.  The daemon distinguishes three response shapes:
//  * `list` -> bare `{id, name, created_at}` rows, unwrapped from
//    the envelope `{ workspaces: [...] }`.
//  * `get` -> includes `workspace_revision` + `heads[]`, no `tags`.
//  * `create` / `patch` -> include the post-mutation `tags`.
// Delete is asynchronous -- the 202 ack carries a `job_id` and the
// caller drains terminal state via `jobs.events()`.
export const workspaces = {
  list: () =>
    api.get<{ workspaces: WorkspaceListEntry[] }>('/api/v1/workspace').then((r) => r.workspaces),
  get: (id: Uuid) => api.get<WorkspaceDetail>(`/api/v1/workspace/${encodeURIComponent(id)}`),
  create: (req: WorkspaceCreateReq) => api.post<WorkspaceMutationResp>('/api/v1/workspace', req),
  patch: (id: Uuid, req: WorkspacePatchReq) =>
    api.patch<WorkspaceMutationResp>(`/api/v1/workspace/${encodeURIComponent(id)}`, req),
  delete: (id: Uuid) => api.delete<AsyncJobAck>(`/api/v1/workspace/${encodeURIComponent(id)}`)
};

// Workspace asset surface.  Unified `/assets/{*path}` family
// where the HTTP method picks the operation (`GET` reads / lists,
// `PUT` writes, `DELETE` removes -- see [docs/API.md §"Workspace
// assets"]).  All listing endpoints share the `DatasetListing`
// shape.  `encodeURIComponent` per path component encodes `/` as
// `%2F`, so a single segment can't smuggle separators.
function buildPaging(opts: { offset?: number; limit?: number }): string {
  const params = new URLSearchParams();
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const q = params.toString();
  return q ? `?${q}` : '';
}

// Shared URL builder for one slice's asset path.  GET / PUT / DELETE
// all share this URI; exporting it as a stand-alone function (rather
// than reaching for `assets.sliceAssetPath` inside the object) keeps
// the two member aliases below from depending on `this`, which would
// break under destructuring.
export function sliceAssetPath(workspaceId: Uuid, category: string, filename: string): string {
  return `/api/v1/workspace/${encodeURIComponent(workspaceId)}/assets/datasets/${encodeURIComponent(category)}/${encodeURIComponent(filename)}`;
}

// Async DELETE acks (`deleteCategory` / `deleteSlice`) MUST flow
// through `enqueueDelete` in [api/delete-queue.ts] to avoid 409s
// against concurrent delete-family jobs.
export const assets = {
  // Workspace root listing -- direct children (`datasets`,
  // `converters`, ...).  Categories themselves live under
  // `datasets/`, fetched by `listDatasets`.
  listRoot: (workspaceId: Uuid, opts: { offset?: number; limit?: number } = {}) =>
    api.get<DatasetListing>(
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/assets${buildPaging(opts)}`
    ),
  // Categories with at least one slice on disk.  Empty-on-disk
  // categories (operator-added, no slices yet) are absent here;
  // the categories store synthesises them from IDB.
  listDatasets: (workspaceId: Uuid, opts: { offset?: number; limit?: number } = {}) =>
    api.get<DatasetListing>(
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/assets/datasets${buildPaging(opts)}`
    ),
  // Slices inside one category.
  listCategory: (
    workspaceId: Uuid,
    category: string,
    opts: { offset?: number; limit?: number } = {}
  ) =>
    api.get<DatasetListing>(
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/assets/datasets/${encodeURIComponent(category)}${buildPaging(opts)}`
    ),
  // Async whole-tree delete of one category directory.
  deleteCategory: (workspaceId: Uuid, category: string) =>
    api.delete<AsyncJobAck>(
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/assets/datasets/${encodeURIComponent(category)}`
    ),
  // Async single-file delete inside a category.
  deleteSlice: (workspaceId: Uuid, category: string, filename: string) =>
    api.delete<AsyncJobAck>(
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/assets/datasets/${encodeURIComponent(category)}/${encodeURIComponent(filename)}`
    ),
  // Slice asset URI -- GET for download, PUT for upload, DELETE for
  // removal.  Both names survive for grep + call-site intent; the
  // upload path-builder is just the same URI with a different verb.
  sliceAssetPath,
  slicePutPath: sliceAssetPath
};

// Async-job introspection.  `eventsUrl` is a path builder; the actual
// SSE consumer lives in `$lib/api/jobs` (delete-family wrapper
// `trackJob`) and `$lib/api/training-subscriber` (training-specific
// continuous stream with view reconstruction), each owning its own
// EventSource lifecycle (reconnect, cursor, close) outside the
// fetch wrapper.
//
// The unified `/jobs` family covers every producer wired into
// `file_mgr::JobRegistry`: delete-family jobs (`workspace_delete`,
// `dataset_delete`, ...), `convert`, and -- as of the bridge
// completed in 2026-05 -- `train` as well.  Training jobs appear in
// `GET /jobs` and stream typed events via `GET /jobs/{id}/events`
// (the `JobEvent.message` field carries a JSON-stringified
// `TrainEvent` payload).  The training-specific `/workspace/{id}/
// training[*]` endpoints below stay for workspace-scoped lists +
// the `started_at` snapshot that recovery needs.
export const jobs = {
  get: (id: Uuid) => api.get<JobSnapshot>(`/api/v1/jobs/${encodeURIComponent(id)}`),
  eventsUrl: (id: Uuid, opts: { afterSeq?: number; logs?: boolean } = {}): string => {
    const params = new URLSearchParams();
    if (opts.afterSeq !== undefined) params.set('after_seq', String(opts.afterSeq));
    if (opts.logs !== undefined) params.set('logs', String(opts.logs));
    const q = params.toString();
    return `/api/v1/jobs/${encodeURIComponent(id)}/events${q ? `?${q}` : ''}`;
  }
};

// Training producer surface.  `start` POSTs a flat `TrainingCfg`
// (no envelope) and receives the pre-allocated head id + the job
// id; the head record itself is committed only when the run
// publishes successfully.
//
// Routine live progress flows over SSE via the cross-cutting
// `/jobs/{id}/events` stream (see [`api/training-subscriber.ts`]),
// not through `get` -- the polled view is now a snapshot endpoint
// for the recovery flow (`list` discovers the running job;
// `get` is rarely needed once SSE binds).  `list` enumerates the
// workspace's training jobs (running + recent terminals retained
// in the daemon's training registry).  `cancel` is idempotent at
// the daemon -- it sets a cancel flag the worker polls; a
// `state: cancelled` terminal lands on the next checkpoint and
// flows out over SSE as a typed `TrainEvent::JobCancelled` plus a
// cross-cutting `JobEvent.state = cancelled` transition.
export const training = {
  start: (workspaceId: Uuid, cfg: TrainingCfg) =>
    api.post<TrainStartResp>(`/api/v1/workspace/${encodeURIComponent(workspaceId)}/train`, cfg),
  list: (workspaceId: Uuid) =>
    api
      .get<TrainingListResp>(`/api/v1/workspace/${encodeURIComponent(workspaceId)}/training`)
      .then((r) => r.jobs),
  get: (workspaceId: Uuid, jobId: Uuid) =>
    api.get<TrainingJobView>(
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/training/${encodeURIComponent(jobId)}`
    ),
  cancel: (workspaceId: Uuid, jobId: Uuid) =>
    api.delete<CancelResp>(
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/training/${encodeURIComponent(jobId)}`
    ),
  // No client-bound `deleteLog` / `deleteAllLogs` -- the daemon's
  // `storage_reaper` prunes per-workspace JSONLs older than 30
  // days automatically (see `modules/file_mgr/storage_reaper.rs`),
  // so no UI surface needs an explicit-delete affordance.  The
  // bare-path DELETE endpoints still exist daemon-side for
  // operational tooling.
  // Path builder for the durable JSONL backstop.  Exposed for
  // tooling; the `LogPageResp` reader below is the typed entry
  // point.  The backstop is sparse (today's training producer
  // emits only `started` + a single terminal event), so this is
  // mostly useful for confirming a job actually started and for
  // surfacing a terminal failure reason after the workspace
  // detail page reloads past the in-memory `TrainingJobView`'s
  // retention window.
  logPath: (workspaceId: Uuid, jobId: Uuid): string =>
    `/api/v1/workspace/${encodeURIComponent(workspaceId)}/assets/training_logs/${encodeURIComponent(jobId)}.jsonl`,
  // Read one JSONL page bounded by `?after_seq=<u64>&limit=<u64>`.
  // Defaults match the daemon (`after_seq=0`, `limit=200`).
  // `after_seq` is *exclusive* per the backend's
  // `read_jsonl_page`: yields entries with `seq > after_seq`.
  readLogPage: (
    workspaceId: Uuid,
    jobId: Uuid,
    opts: { afterSeq?: number; limit?: number } = {}
  ) => {
    const params = new URLSearchParams();
    if (opts.afterSeq !== undefined) params.set('after_seq', String(opts.afterSeq));
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const q = params.toString();
    return api.get<LogPageResp>(
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/assets/training_logs/${encodeURIComponent(jobId)}.jsonl${q ? `?${q}` : ''}`
    );
  },
  // Directory listing of every `<job_id>.jsonl` the workspace's
  // training producer has ever opened.  Powers persistent
  // history hydration: a refresh that lands past the in-memory
  // training registry's retention window can still reconstruct
  // past runs by listing this directory and paging each entry
  // through `readLogPage`.  Empty `entries` on a workspace that
  // has never trained (the daemon synthesises an empty
  // `DatasetListing` rather than 404-ing); a missing workspace
  // surfaces as 404 like every other workspace-scoped read.
  // Sorted by name (= jobId) server-side; consumers sort by
  // `mtime` for chronological order.  `limit` clamps to the
  // daemon's MAX_DATASET_LIST_LIMIT (1000); the default of 100
  // covers our display cap with comfortable headroom and keeps
  // the response small for the eager-mount path.
  listLogs: (workspaceId: Uuid, opts: { offset?: number; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const q = params.toString();
    return api.get<DatasetListing>(
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/assets/training_logs${q ? `?${q}` : ''}`
    );
  }
};

// Per-workspace head management.  `list` is the operator-facing
// hot read (already inlined on the workspace detail response, but
// the dedicated endpoint exists for refresh-after-train flows
// when the detail's `heads[]` hasn't picked up the new record
// yet).  The list returns plain `HeadRecord` entries -- the
// daemon's `list_heads` route (`modules/api/routes/heads.rs`)
// builds its response from `summary.heads.heads` without
// reading the per-head manifest from disk, so `labels` is NOT
// on the wire here.  Use `manifest(...)` for the per-head read
// when `labels` is needed.  `delete` is synchronous; the
// daemon refuses if the head is the active generation's source
// (409 conflict).
export const heads = {
  list: (workspaceId: Uuid) =>
    api
      .get<{ heads: HeadRecord[] }>(`/api/v1/workspace/${encodeURIComponent(workspaceId)}/heads`)
      .then((r) => r.heads),
  manifest: (workspaceId: Uuid, headId: Uuid) =>
    api.get<HeadManifest>(
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/heads/${encodeURIComponent(headId)}`
    ),
  delete: (workspaceId: Uuid, headId: Uuid) =>
    api.delete<DeleteHeadResp>(
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/heads/${encodeURIComponent(headId)}`
    )
};
