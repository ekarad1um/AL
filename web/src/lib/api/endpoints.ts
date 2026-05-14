import { api, ApiError } from './http';
import type {
  ActiveResp,
  AsyncJobAck,
  DatasetListing,
  InferenceCfg,
  JobSnapshot,
  MicPolicy,
  MicState,
  StatusSnapshot,
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
// SSE consumer lives in `$lib/api/jobs` because `EventSource` has its
// own lifecycle (reconnect, cursor, close) outside the fetch wrapper.
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
