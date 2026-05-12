import { api, ApiError } from './http';
import type {
  ActiveResp,
  AsyncJobAck,
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
