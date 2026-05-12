// TypeScript types mirroring the acousticsd REST contract.
// Authoritative shapes live in docs/API.md and the Rust modules; this
// file is a thin restatement -- when backend types change, update here
// and the call sites will fail to compile.

export type Uuid = string;
export type Rfc3339 = string;

export interface WorkspaceRevision {
  id: number;
  at: Rfc3339;
}

// GET /api/v1/workspace -- minimal entry for the list view.  The daemon
// deliberately omits `tags`, `workspace_revision`, and any head data
// here so the listing is a cached `workspace.json` read with no asset
// walk; per-workspace detail (incl. heads) lives on `WorkspaceDetail`.
export interface WorkspaceListEntry {
  id: Uuid;
  name: string;
  created_at: Rfc3339;
}

// GET /api/v1/workspace/{id} -- hot summary that does NOT walk the
// asset tree.  `tags` is intentionally not on the wire here either
// (only POST/PATCH responses carry it); operator-tag UI reads tags
// from a prior mutation or refetches via PATCH-no-op when needed.
export interface WorkspaceDetail {
  id: Uuid;
  name: string;
  created_at: Rfc3339;
  workspace_revision: WorkspaceRevision;
  heads: HeadRecord[];
}

// POST /api/v1/workspace and PATCH /api/v1/workspace/{id} share this
// response shape -- both return the post-mutation `WorkspaceCore`
// fields including `tags`, the one place tags travel the wire.
export interface WorkspaceMutationResp {
  id: Uuid;
  name: string;
  tags: string[];
  created_at: Rfc3339;
  workspace_revision: WorkspaceRevision;
}

export interface WorkspaceCreateReq {
  name: string;
  tags?: string[];
}

export interface WorkspacePatchReq {
  name?: string;
  tags?: string[];
}

// DELETE /api/v1/workspace/{id} and DELETE /api/v1/workspace/{id}/
// assets/{*path} both ack with a job id (status 202); clients track
// terminal state via `GET /api/v1/jobs/{job_id}/events`.
export interface AsyncJobAck {
  job_id: Uuid;
}

export type HeadStatus = 'current' | 'stale';

export interface HeadRecord {
  head_id: Uuid;
  workspace_revision: WorkspaceRevision;
  sha256: string;
  n_classes: number;
  size_bytes: number;
  created_at: Rfc3339;
  status: HeadStatus;
}

export interface HeadManifest extends HeadRecord {
  labels: string[];
}

export type ActiveOrigin = 'head' | 'default';

interface ActiveBase {
  sha256: string;
  labels_sha256: string;
  runtime_head_id: Uuid;
  n_classes: number;
  labels: string[];
  activated_at: Rfc3339;
  activation_id: Uuid;
}

export type ActiveResp =
  | (ActiveBase & {
      origin: 'head';
      source_workspace_id: Uuid;
      source_workspace_revision: WorkspaceRevision;
      source_head_id: Uuid;
      source_workspace_alive: boolean;
    })
  | (ActiveBase & { origin: 'default' });

export interface TrainParams {
  epochs: number;
  batch_size: number;
  learning_rate: number;
  seed?: number;
  validation_split?: number;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobType =
  | 'train'
  | 'convert'
  | 'dataset_delete'
  | 'converter_delete'
  | 'workspace_delete'
  | 'training_logs_delete'
  | 'converter_logs_delete';

export interface JobProgress {
  done: number;
  total?: number;
}

// `GET /api/v1/jobs` and `GET /api/v1/jobs/{job_id}` share this
// snapshot.  Several fields are absent from the wire on jobs that
// don't populate them (e.g. `target_path` is only meaningful for the
// asset-delete variants; `workspace_id` is None on a job with no
// workspace reference) -- they arrive as missing properties, not
// `null`, per the backend's `skip_serializing_if = "Option::is_none"`.
export interface JobSnapshot {
  job_id: Uuid;
  job_type: JobType;
  workspace_id?: Uuid;
  target_path?: string;
  state: JobState;
  progress?: JobProgress;
  result?: unknown;
  last_seq: number;
  updated_at: Rfc3339;
}

// SSE event over `GET /api/v1/jobs/{job_id}/events`.  Any one event
// may carry a state transition, a progress tick, a log line, or any
// combination thereof; clients react to whichever fields are present.
export interface JobEvent {
  seq: number;
  at: Rfc3339;
  state?: JobState;
  progress?: JobProgress;
  message?: string;
}

export interface SubsystemHealth {
  healthy: boolean;
  detail?: string;
  degraded_reason?: string;
  age_ms?: number;
  stale: boolean;
}

// The /status response is flat: process metrics, subsystem heartbeats,
// broadcast-drop counters, and workspace counters all live at the root.
// `inference_engine` is NOT in /status — query /active for the runtime
// head + labels.
export interface StatusSnapshot {
  cpu_pct: number;
  mem_rss_kb: number;
  disk_free_kb: number;
  metrics_age_ms: number;
  metrics_stale: boolean;
  uptime_s: number;
  subsystems: Record<string, SubsystemHealth>;
  broadcast_audio_messages_dropped: number;
  broadcast_inference_messages_dropped: number;
  workspace: Record<string, number>;
}

export interface InferenceCfg {
  hop_samples: number;
  top_k: number;
}

// Variant fields mirror `CandidateSource` in the Rust enum: mock declares a
// static sample_rate; alsa exposes launch-time hardware fields and negotiates
// the actual rate at open time.  Adding a new kind here forces every consumer
// site to update its narrowing instead of silently falling through.
export interface AlsaMicSource {
  kind: 'alsa';
  hw_spec: string;
  period_size: number;
  buffer_size: number;
}

export interface MockMicSource {
  kind: 'mock';
  sample_rate: number;
  period_size: number;
  waveforms: unknown[];
}

export type MicSource = AlsaMicSource | MockMicSource;

export interface MicCandidate {
  id: string;
  source: MicSource;
  channels: number[];
}

export interface MicCatalogue {
  candidates: MicCandidate[];
}

export type MicPolicyMic = { kind: 'first_available' } | { kind: 'fixed'; id: string };
export type MicPolicyChannel = { kind: 'auto' } | { kind: 'fixed'; channel: number };

export interface MicPolicy {
  mic: MicPolicyMic;
  channel: MicPolicyChannel;
}

export interface MicState {
  catalogue: MicCatalogue;
  policy: MicPolicy;
  version: number;
}

export interface TfjsConvertParams {
  converter_type: 'tfjs';
  model_json_path: string;
  shards: string[];
  labels_path: string;
  labels_format: 'lines' | 'tfjs_metadata';
}

export interface AssetReceipt {
  path: string;
  sha256: string;
  size_bytes: number;
  workspace_revision_id: number;
}

export interface ApiErrorBody {
  error: string;
  code: string;
  oldest_seq?: number;
  latest_seq?: number;
}
