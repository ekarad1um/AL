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

// IMPORTANT wire-name asymmetry: `source_workspace_id` and
// `source_head_id` carry the `source_` prefix, but the revision
// field is shipped as bare `workspace_revision` (no prefix).  See
// [`modules/api/routes/active.rs`](../../../modules/api/routes/active.rs)
// `ActiveResp`: the field's serde name is `workspace_revision` —
// a daemon-side asymmetry kept here verbatim so the runtime
// payload deserialises cleanly.  An earlier typo modelled it as
// `source_workspace_revision`, which made the ActiveHeadCard
// throw the moment a workspace head was activated (the
// undefined-`.id` read froze Svelte's effect flush and dropped
// the Configuration panel back to "loading…").
export type ActiveResp =
  | (ActiveBase & {
      origin: 'head';
      source_workspace_id: Uuid;
      workspace_revision: WorkspaceRevision;
      source_head_id: Uuid;
      source_workspace_alive: boolean;
    })
  | (ActiveBase & { origin: 'default' });

// `POST /api/v1/workspace/{id}/train` request body.  Field bounds
// mirror [`validate_training_cfg`](../../modules/file_mgr/request_payload.rs)
// and are surfaced as numeric constants in
// `components/training/cfg-validate.ts` so the operator-facing
// form pre-validates without a round-trip.  `seed` is `null` when
// the daemon should pick its own entropy; `validation_split = 0`
// disables the stratified split and publishes the last-epoch
// head (otherwise the best-val-loss epoch wins).
export interface TrainingCfg {
  epochs: number;
  batch_size: number;
  learning_rate: number;
  seed?: number | null;
  validation_split?: number;
}

// `POST /api/v1/workspace/{id}/train` response.  `head_id` is
// pre-allocated by the daemon so the operator can match a
// running job against an eventual head record without a JSONL
// round-trip after publish.
export interface TrainStartResp {
  head_id: Uuid;
  job_id: Uuid;
}

// Pipeline stage emitted on every `phase_started` event and
// included in every terminal `job_failed` / `job_cancelled`
// payload so the frontend can attribute a failure to the step
// that produced it.  Wire form is snake_case per the daemon's
// `serde(rename_all = "snake_case")` on `finetune::Stage`.
//
// Six variants: `prepare` (workspace + tempdir setup),
// `dataset_scan` (walking `<workspace>/datasets/`),
// `feature_extract` (frozen-backbone feature extraction),
// `train` (head fine-tune loop), `save` (atomic local write of
// the trained `.mpk`), `publish` (rotation primitive lands the
// head into `<workspace>/heads/`).  Replaces the prior
// 5-variant `Phase` (`loading | feature_extract | train |
// saving | done`) which conflated workspace prep with dataset
// scan and local save with publish.
export type Stage = 'prepare' | 'dataset_scan' | 'feature_extract' | 'train' | 'save' | 'publish';

// Per-epoch metrics, present only when `progress.phase === 'train'`.
// `train_loss` is f64 in Rust; the rest are f32 (display rounding
// chops them anyway, so the precision loss is invisible).
// `val_acc` is `null` on the wire when `validation_split === 0`
// (the daemon serialises NaN to JSON null via
// `serialize_finite_or_null`); we type it as `number | null` so
// consumers explicitly handle the no-validation case.
export interface EpochMetrics {
  epoch: number;
  epochs: number;
  train_loss: number;
  train_acc: number;
  val_acc: number | null;
  best_val_acc: number | null;
}

// In-memory training progress watched by the daemon's
// `training::JobRegistry`.  Surfaced verbatim by
// `GET /workspace/{id}/training/{job}` for the snapshot read
// path (used by `recover()` after a page reload to find the
// running job), and reconstructed client-side from typed
// events in the SSE stream during routine live progress (see
// [`lib/api/training-subscriber.ts`]).
export interface TrainingProgress {
  phase: Stage;
  current: number;
  total: number;
  message: string;
  metrics?: EpochMetrics;
}

// Terminal artefacts of a successful train.  `final_val_acc` is
// `null` on the wire when `validation_split === 0` (the daemon
// serialises NaN to JSON null via `serialize_finite_or_null`);
// consumers must explicitly handle the no-validation case.
export interface TrainingResult {
  head_id: Uuid;
  head_sha256: string;
  n_classes: number;
  classes: string[];
  final_train_acc: number;
  final_val_acc: number | null;
}

// `GET /workspace/{id}/training/{job}` response and the per-entry
// shape of `GET /workspace/{id}/training`.  Distinct from the
// cross-cutting [`JobSnapshot`] which the unified `/jobs` surface
// returns: this shape carries rich phase + per-epoch metrics that
// `JobSnapshot` cannot (the registry only stores `JobProgress {
// done, total? }`).  `state` is the *training-domain* enum --
// `running | completed | failed | cancelled` -- with no `queued`
// (the producer transitions to `running` synchronously at
// admission).
export type TrainingJobState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface TrainingJobView {
  job_id: Uuid;
  workspace_id: Uuid;
  state: TrainingJobState;
  progress: TrainingProgress;
  result?: TrainingResult | null;
  error?: string | null;
  started_at: Rfc3339;
  finished_at?: Rfc3339 | null;
}

// `GET /workspace/{id}/training` list envelope.
export interface TrainingListResp {
  jobs: TrainingJobView[];
}

// `DELETE /workspace/{id}/training/{job}` ack.  Trivial shape
// (no job id, no progress) because cancellation is synchronous
// from the API perspective -- the trainer's cancel flag is set;
// the worker observes it at the next checkpoint and exits with
// `state: cancelled`.
export interface CancelResp {
  ok: true;
}

// `DELETE /workspace/{id}/heads/{head_id}` response.  Synchronous;
// no job machinery.
export interface DeleteHeadResp {
  deleted_head_id: Uuid;
}

// One line of a JSONL backstop, deserialised forgivingly by the
// daemon (see [log_page.rs] LogEvent).  Only `seq` and `at` are
// fixed; every other field is producer-defined and rides via
// `#[serde(flatten)]` on the Rust side.  Two producer schemas
// share this envelope today:
//
// - **Training** (`<ws>/training_logs/<job_id>.jsonl`): each
//   line carries `kind: TrainEvent['kind']` plus the event-
//   specific fields for that `kind` (see [`TrainEvent`]).
//   Narrow by switching on `kind`; treat unknown values as
//   forward-compat (skip silently).
// - **Converter** (`<ws>/converter_logs/<job_id>.jsonl`): each
//   line carries `state: string`, `progress?: number | null`,
//   `message?: string`.
export interface LogEvent {
  seq: number;
  at: Rfc3339;
  // Producer-defined payload fields; arbitrary JSON.
  [key: string]: unknown;
}

// One class entry surfaced in `dataset_scanned` events.
export interface ClassCount {
  name: string;
  n_samples: number;
}

// Severity axis for `job_failed` events.  `operator_fixable`
// indicates a dataset-shape or upload-layout problem the user
// can correct and retry; `internal` is a daemon-side failure
// (panic, IO, model corruption) where retry is the only
// operator action.  Drives the failure-card colour (amber vs
// red) and copy template selection.
export type Severity = 'operator_fixable' | 'internal';

// Why a `job_cancelled` event fired.  `operator` =
// DELETE /workspace/{id}/training/{job}; `shutdown` = daemon
// pre-drain hook.  Drives different copy ("Training cancelled
// by operator" vs "Training interrupted by daemon shutdown").
export type CancelReason = 'operator' | 'shutdown';

// Tagged failure payload carried under the `kind: 'job_failed'`
// event.  `category` discriminates; the per-variant fields
// carry structured details the frontend uses to build hint copy
// without re-parsing the free-form `error` string.  Mirrors the
// daemon's `training::FailPayload` enum 1:1.
export type FailPayload =
  | { category: 'bad_dataset'; path: string; reason: string }
  | { category: 'dataset_read'; path: string; reason: string }
  | {
      category: 'empty_class';
      class: string;
      per_class_kept: readonly (readonly [string, number])[];
    }
  | {
      category: 'drop_ratio_exceeded';
      dropped: number;
      total: number;
      threshold: number;
      per_class_kept: readonly (readonly [string, number])[];
      per_class_dropped: readonly (readonly [string, number])[];
    }
  | {
      category: 'stratified_split_impossible';
      class: string;
      per_class_kept: readonly (readonly [string, number])[];
      val_split: number;
    }
  | { category: 'invalid_config'; detail: string }
  | { category: 'model_error'; detail: string }
  // `io` (not `io_error`) — serde's `rename_all = "snake_case"`
  // on the daemon's single-word `Io` variant produces `"io"`
  // verbatim (no underscore boundary to insert).  If the Rust
  // variant is ever renamed to `IoError`, update the literal
  // here in lock-step.
  | { category: 'io'; path: string; detail: string }
  | { category: 'panic'; detail: string }
  | { category: 'internal'; detail: string };

// Discriminated union of every typed event the training
// producer emits to JSONL + SSE.  The discriminator is `kind`
// (snake_case).  Every line additionally carries `seq: number`
// + `at: Rfc3339` (envelope fields not repeated in each
// variant; see [`TrainLogLine`]).
//
// Two transports carry the same payload shape:
//  - **JSONL page** (`assets.readTrainingLog(...)`): the
//    envelope arrives as a `LogEvent`; cast to `TrainLogLine`
//    and narrow on `kind`.
//  - **SSE stream** (`/jobs/{id}/events`): the envelope arrives
//    as a `JobEvent` whose `message: string` carries the JSON
//    body; `JSON.parse(message)` then `kind`-narrow.
//
// Treat unknown `kind` as forward-compat (skip silently).
export type TrainEvent =
  | {
      kind: 'job_submitted';
      head_id: Uuid;
      cfg: TrainingCfg;
      backbone: string;
    }
  | { kind: 'job_running' }
  | { kind: 'phase_started'; phase: Stage }
  | {
      kind: 'dataset_scanned';
      n_classes: number;
      classes: ClassCount[];
      n_examples_total: number;
    }
  | {
      kind: 'feature_extract_completed';
      kept: number;
      dropped_nan: number;
      dropped_io: number;
      elapsed_ms: number;
    }
  | { kind: 'train_split'; train_n: number; val_n: number }
  | {
      kind: 'epoch_completed';
      epoch: number;
      epochs: number;
      train_loss: number;
      train_acc: number;
      val_acc: number | null;
      best_val_acc: number | null;
      lr: number;
      elapsed_ms: number;
    }
  | {
      kind: 'train_completed';
      epochs_run: number;
      total_elapsed_ms: number;
      best_val_epoch?: number;
      best_val_acc?: number | null;
    }
  | {
      kind: 'head_published';
      head_id: Uuid;
      head_sha256: string;
      size_bytes: number;
      n_classes: number;
      classes: string[];
      workspace_revision: WorkspaceRevision;
    }
  | { kind: 'job_completed'; result: TrainingResult }
  | ({
      kind: 'job_failed';
      stage: Stage;
      severity: Severity;
      error: string;
    } & FailPayload)
  | { kind: 'job_cancelled'; stage: Stage; reason: CancelReason };

// Wire envelope of one training-side JSONL line / SSE event.
// Casting a [`LogEvent`] via this type is the canonical
// narrowing entry point.  Implemented as an intersection (not
// an `interface ... extends`) because [`TrainEvent`] is a
// discriminated union and TypeScript only allows interfaces to
// extend object types with statically known members.
export type TrainLogLine = TrainEvent & {
  seq: number;
  at: Rfc3339;
};

// `GET /workspace/{id}/assets/{*path}` JSONL-paging response.
// `next_after_seq` echoes the last yielded `seq` when the page is
// non-empty; it equals the caller's `after_seq` when the page is
// empty (so a poll that catches up reads `next_after_seq ===
// after_seq` and knows nothing has been added).
export interface LogPageResp {
  events: LogEvent[];
  next_after_seq: number;
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

// One direct-child entry in a dataset listing -- file or directory.
// `size_bytes` is null on directories per the daemon (the listing
// path never walks).  `mtime` is RFC3339 UTC.
//
// `kind` mirrors the daemon's `EntryKind` enum
// ([modules/file_mgr/dataset.rs] `#[serde(rename_all = "snake_case")]`):
// `File` → `"file"`, `Directory` → `"directory"`.  An earlier
// typo modelled the directory variant as `"dir"`, which silently
// filtered every server-only category out of the list (the
// categories store's `e.kind === 'dir'` never matched) -- so a
// freshly-opened workspace with slices uploaded from another tab
// or via the daemon CLI would render with only the mandatory
// `_background_noise_` row visible, even though the daemon had
// extra categories on disk.  Same hazard for any future
// `=== 'dir'` filter.
export interface AssetEntry {
  name: string;
  kind: 'file' | 'directory';
  size_bytes: number | null;
  mtime: Rfc3339;
}

// `GET /api/v1/workspace/{id}/assets[/{*path}]` directory response.
// File reads return raw bytes; directory reads return this shape.
// `offset` / `limit` echo the request parameters (defaults: 0 / 100,
// max limit 1000 per the daemon).
export interface DatasetListing {
  entries: AssetEntry[];
  total: number;
  offset: number;
  limit: number;
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
