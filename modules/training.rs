//! In-process training job registry.
//!
//! - `POST /workspace/{id}/train` body is the flattened
//!   [`TrainingCfg`].  The trainer always walks
//!   `<workspace_dir>/datasets/` as the fixed root: immediate
//!   non-hidden children are class folders; the deeper walk
//!   discovers per-class samples.
//! - At most one unfinished train job daemon-wide; a second request
//!   rejects with `FileError::AnotherTrainRunning` (409).
//! - The job-reference lease (`JobReference::Workspace`) excludes
//!   only an active `WorkspaceDelete` for the same workspace;
//!   uploads and file-deletes overlap freely.
//! - `finetune::run` opens / reads / closes per batch, so worst-case
//!   FDs are `batch_size * parallel_loaders` independent of dataset
//!   size.
//! - On success the trainer stages the `.mpk` under
//!   `<workspace_dir>/.tmp/`, builds the per-head manifest, and
//!   publishes through the head-rotation primitive.  No head record
//!   is committed on failure.
//!
//! Daemon-side archive extraction was removed; bulk dataset loads
//! use repeated single-file uploads via
//! `PUT /workspace/{id}/assets/{*path}`.

#![warn(missing_debug_implementations)]

mod finetune;
pub(crate) mod registry;
pub use finetune::{ClassCount, EpochMetrics, Stage};
pub use registry::TrainingRegistry;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use crate::common::ids::{HeadId, JobId, WorkspaceId};
use crate::common::workspace::{HeadManifest, WorkspaceRevision};
use crate::file_mgr::{
    DATASETS_DIR_NAME, FsService, JobHandle, PendingHead, RegistryJobResult, TrainingCfg,
    now_rfc3339, sha256_file_streaming, validate_training_cfg,
};
use dashmap::DashMap;
use parking_lot::Mutex;
use serde::Serialize;
use thiserror::Error;
use tokio::sync::watch;

// `JobEntry::cancel` is an `AtomicU8` so the terminal
// `JobCancelled` event can carry a typed [`CancelReason`].  The
// finetune-side cancel closure only sees a `() -> bool`; the
// reason is read at terminal-transition time by `run_job`.
const CANCEL_NONE: u8 = 0;
const CANCEL_OPERATOR: u8 = 1;
const CANCEL_SHUTDOWN: u8 = 2;

/// Daemon-internal job descriptor produced from a validated
/// `TrainRequest` (= flattened [`TrainingCfg`]).  The dataset root
/// is fixed at `<workspace_dir>/datasets/`; `head_id` is allocated
/// by the api producer so the response carries the published id
/// before the job spawns.
#[derive(Clone, Debug)]
pub struct TrainingJob {
    pub workspace_id: WorkspaceId,
    /// Pre-allocated; published verbatim on success.
    pub head_id: HeadId,
    /// Producer-snapshotted; recorded in the head manifest for
    /// stale detection.
    pub workspace_revision: WorkspaceRevision,
    /// Already validated by `validate_training_cfg`.
    pub training_cfg: TrainingCfg,
    pub backbone_path: PathBuf,
}

// MARK: typed events
//
// Wire shape for the durable JSONL log + the cross-cutting SSE
// bridge.  Every line is a [`TrainLogLine`] envelope (`seq` +
// `at` + flattened [`TrainEvent`]), so a tab-refresh hydrates
// from the JSONL with no shape divergence from the live SSE
// stream.  Forward-compat is carried by the `kind` discriminator
// and `#[non_exhaustive]` on `TrainEvent` (consumers must
// tolerate unknown variants); a future wire-breaking change can
// introduce versioning lazily by adding a `schema_version` field
// only at that point (absence on a line means today's shape).

/// Operator-vs-internal axis for [`TrainEvent::JobFailed`].
/// Derived from [`crate::common::error::Categorized::kind`] on
/// the source error — `UserInput` lifts to `OperatorFixable`,
/// everything else to `Internal`.  Frontend uses this to colour
/// the failure card (amber vs red) without parsing free-form
/// strings.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// The operator can act on this — typically a dataset shape
    /// problem they can fix and retry.
    OperatorFixable,
    /// Daemon-internal failure (panic, IO mid-job, model
    /// corruption).  Retry is the only operator action.
    Internal,
}

/// Why a job ended in [`JobState::Cancelled`].  Distinguishes
/// "operator clicked cancel" from "daemon shutdown drained the
/// running jobs"; the frontend renders different copy for the
/// two cases.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    /// `DELETE /workspace/{id}/training/{job}` set the cancel flag.
    Operator,
    /// Daemon's pre-drain hook
    /// ([`JobRegistry::cancel_all_for_shutdown`]) set the flag
    /// during shutdown.
    Shutdown,
}

/// Tagged failure payload for [`TrainEvent::JobFailed`].
/// `category` discriminates; the per-variant fields carry
/// structured details the frontend uses to build hint copy
/// without re-parsing free-form error strings.  Mirrors the
/// existing [`TrainingError`] / [`finetune::FinetuneError`]
/// variant set so every error path has a typed wire shape.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "category", rename_all = "snake_case")]
pub enum FailPayload {
    /// Operator uploaded a malformed dataset (no class folders,
    /// stray non-dir entry, duplicate label, empty class folder,
    /// unreadable subdir).  Detected by `scan_dataset` at
    /// admission time.
    BadDataset { path: String, reason: String },
    /// A previously-discovered dataset file disappeared or
    /// became unreadable mid-walk (uploads/deletes overlap with
    /// training; the trainer skips the missing file but cannot
    /// hide the failure from the operator).
    DatasetRead { path: String, reason: String },
    /// Post-extract per-class accounting found a class with zero
    /// kept examples.  The operator either uploaded only corrupt
    /// `.wav` files for the class or hit the per-file preproc
    /// drop path en masse.
    EmptyClass {
        class: String,
        per_class_kept: Vec<(String, usize)>,
    },
    /// Drop ratio across all classes exceeded the daemon's
    /// `MAX_DROP_RATIO` ceiling (10 % of samples failed
    /// preproc).  Below the ceiling drops are silent; above it
    /// the run fails so the published head's metrics describe
    /// the full dataset, not a degraded subset.
    DropRatioExceeded {
        dropped: usize,
        total: usize,
        threshold: f32,
        per_class_kept: Vec<(String, usize)>,
        per_class_dropped: Vec<(String, usize)>,
    },
    /// A class has too few samples for the requested
    /// `validation_split` to leave at least one example in each
    /// of train + val.  Most common cause: singleton classes
    /// (`class_n == 1`) with `validation_split > 0`.
    StratifiedSplitImpossible {
        class: String,
        per_class_kept: Vec<(String, usize)>,
        val_split: f32,
    },
    /// Numeric / shape validation failure on the training
    /// config or a derived constraint.  Pre-spawn validation
    /// catches the request-shape variant; this surfaces the
    /// post-spawn variant (e.g. on-device feature-buffer cap
    /// exceeded).
    InvalidConfig { detail: String },
    /// Burn `.mpk` load/save error from `model`'s helpers.
    ModelError { detail: String },
    /// IO failure on a daemon-owned file (workspace tree,
    /// dataset, tempfile).
    Io { path: String, detail: String },
    /// Training loop panicked.  Diagnostic carries the panic
    /// payload's stringified form.
    Panic { detail: String },
    /// Catch-all for daemon-internal errors that don't fit a
    /// more specific variant (job-registry conflict, FsService
    /// failure, `spawn_blocking` join failure).
    Internal { detail: String },
}

/// One algorithmic / lifecycle event emitted to the durable
/// JSONL log AND the cross-cutting SSE broadcast.  Discriminator
/// is `kind`, snake_case on the wire.  Variants split into:
///
/// - **Wrapper-only** (`JobSubmitted`, `JobRunning`,
///   `HeadPublished`, `JobCompleted`, `JobFailed`, `JobCancelled`):
///   emitted by [`run_job`] before / after [`finetune::run`].
/// - **Algorithmic** (`PhaseStarted`, `DatasetScanned`,
///   `FeatureExtractCompleted`, `TrainSplit`, `EpochCompleted`,
///   `TrainCompleted`): lifted from [`finetune::Event`] via the
///   [`From`] impl below.
///
/// `#[non_exhaustive]`: the wire `kind` discriminator is open by
/// design — future producers will add variants and external
/// matches must handle the unknown case.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum TrainEvent {
    /// Admission cleared, log opened, before any pipeline work.
    /// Carries the cfg snapshot so a JSONL replay describes
    /// "what was attempted" without a side file.
    JobSubmitted {
        head_id: HeadId,
        cfg: TrainingCfg,
        /// Basename of the backbone artifact (full path withheld
        /// — operator-facing logs shouldn't carry server paths).
        backbone: String,
    },
    /// Worker started executing on the blocking pool (post-
    /// admission, post-tempdir-prep).  Distinct from
    /// `JobSubmitted` so the SSE consumer can render a
    /// "queued -> running" transition even when the gap is
    /// sub-second.
    JobRunning,
    /// Stage transition.  Lifted from [`finetune::Event`] via
    /// the `From` impl below; same applies to the four
    /// algorithmic variants that follow (`DatasetScanned`,
    /// `FeatureExtractCompleted`, `TrainSplit`,
    /// `EpochCompleted`, `TrainCompleted`).
    PhaseStarted { phase: Stage },
    /// Dataset scan completed; per-class breakdown + total.
    DatasetScanned {
        n_classes: u32,
        classes: Vec<ClassCount>,
        n_examples_total: u64,
    },
    /// Feature extraction completed; kept + drop counters.
    FeatureExtractCompleted {
        kept: u64,
        dropped_nan: u64,
        dropped_io: u64,
        elapsed_ms: u64,
    },
    /// Stratified split landed.
    TrainSplit { train_n: u64, val_n: u64 },
    /// One epoch completed; full per-epoch metrics.
    EpochCompleted {
        epoch: u32,
        epochs: u32,
        train_loss: f64,
        train_acc: f32,
        #[serde(serialize_with = "serialize_finite_or_null")]
        val_acc: f32,
        #[serde(serialize_with = "serialize_finite_or_null")]
        best_val_acc: f32,
        lr: f32,
        elapsed_ms: u64,
    },
    /// Training loop returned; epoch count + best-val summary.
    TrainCompleted {
        epochs_run: u32,
        total_elapsed_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        best_val_epoch: Option<u32>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            serialize_with = "serialize_finite_or_null_opt"
        )]
        best_val_acc: Option<f32>,
    },
    /// Trained head landed in `<workspace>/heads/<head_id>.mpk`
    /// via the rotation primitive.  Emitted only on success;
    /// the absence of this event in a JSONL transcript means
    /// the publish was not reached (`JobFailed` will follow).
    HeadPublished {
        head_id: HeadId,
        head_sha256: String,
        size_bytes: u64,
        n_classes: u32,
        classes: Vec<String>,
        workspace_revision: WorkspaceRevision,
    },
    /// Terminal: success.  Carries the full `TrainingResult`
    /// so a tab-refresh hydration of the JSONL surfaces the
    /// run's verdict without a separate fetch.
    JobCompleted { result: TrainingResult },
    /// Terminal: failure.  `stage` is the last `phase_started`
    /// observed by the wrapper; `severity` is derived from the
    /// underlying error's [`crate::common::error::ErrorKind`];
    /// `error` is the human-readable diagnostic; `payload` is
    /// the typed structured-fields enum the frontend uses to
    /// build hint copy.
    JobFailed {
        stage: Stage,
        severity: Severity,
        error: String,
        #[serde(flatten)]
        payload: FailPayload,
    },
    /// Terminal: cancellation.  `stage` is the last
    /// `phase_started` observed; `reason` distinguishes
    /// operator-initiated from shutdown-drain.
    JobCancelled { stage: Stage, reason: CancelReason },
}

/// Wire envelope for one JSONL line.  `seq` is monotonic per
/// file (best-effort; one-line loss from a crash mid-write is
/// tolerated by the page reader).
#[derive(Debug, Serialize)]
struct TrainLogLine<'a> {
    seq: u64,
    at: String,
    #[serde(flatten)]
    event: &'a TrainEvent,
}

/// Lift the algorithmic event variants from `finetune` into
/// the wrapper's wire shape.  The variant pairs are 1:1; field
/// types are preserved verbatim so the transformation is purely
/// structural (no information added or lost).
impl From<finetune::Event> for TrainEvent {
    fn from(e: finetune::Event) -> Self {
        match e {
            finetune::Event::PhaseStarted { phase } => TrainEvent::PhaseStarted { phase },
            finetune::Event::DatasetScanned {
                n_classes,
                classes,
                n_examples_total,
            } => TrainEvent::DatasetScanned {
                n_classes,
                classes,
                n_examples_total,
            },
            finetune::Event::FeatureExtractCompleted {
                kept,
                dropped_nan,
                dropped_io,
                elapsed_ms,
            } => TrainEvent::FeatureExtractCompleted {
                kept,
                dropped_nan,
                dropped_io,
                elapsed_ms,
            },
            finetune::Event::TrainSplit { train_n, val_n } => {
                TrainEvent::TrainSplit { train_n, val_n }
            }
            finetune::Event::EpochCompleted {
                epoch,
                epochs,
                train_loss,
                train_acc,
                val_acc,
                best_val_acc,
                lr,
                elapsed_ms,
            } => TrainEvent::EpochCompleted {
                epoch,
                epochs,
                train_loss,
                train_acc,
                val_acc,
                best_val_acc,
                lr,
                elapsed_ms,
            },
            finetune::Event::TrainCompleted {
                epochs_run,
                total_elapsed_ms,
                best_val_epoch,
                best_val_acc,
            } => TrainEvent::TrainCompleted {
                epochs_run,
                total_elapsed_ms,
                best_val_epoch,
                best_val_acc,
            },
        }
    }
}

/// Map a [`TrainingError`] to the typed [`FailPayload`].  Used
/// at the wrapper's terminal transition to build the
/// `JobFailed` event without losing structure.
fn fail_payload_from_error(err: &TrainingError) -> FailPayload {
    use finetune::FinetuneError as F;
    match err {
        TrainingError::BadDataset { path, reason } => FailPayload::BadDataset {
            path: path.clone(),
            reason: reason.clone(),
        },
        TrainingError::DatasetRead { path, reason } => FailPayload::DatasetRead {
            path: path.clone(),
            reason: reason.clone(),
        },
        TrainingError::Finetune(F::EmptyClassAfterScan {
            class,
            per_class_kept,
        }) => FailPayload::EmptyClass {
            class: class.clone(),
            per_class_kept: per_class_kept.clone(),
        },
        TrainingError::Finetune(F::DropRatioExceeded {
            dropped,
            total,
            ratio: _,
            max_ratio,
            per_class_kept,
            per_class_dropped,
        }) => FailPayload::DropRatioExceeded {
            dropped: *dropped,
            total: *total,
            threshold: *max_ratio,
            per_class_kept: per_class_kept.clone(),
            per_class_dropped: per_class_dropped.clone(),
        },
        TrainingError::Finetune(F::StratifiedSplitImpossible {
            class,
            per_class_kept,
            val_split,
        }) => FailPayload::StratifiedSplitImpossible {
            class: class.clone(),
            per_class_kept: per_class_kept.clone(),
            val_split: *val_split,
        },
        TrainingError::Finetune(F::InvalidConfig(detail)) | TrainingError::InvalidConfig(detail) => {
            FailPayload::InvalidConfig {
                detail: detail.clone(),
            }
        }
        TrainingError::Finetune(F::Model(e)) => FailPayload::ModelError {
            detail: e.to_string(),
        },
        TrainingError::Io { path, source } => FailPayload::Io {
            path: path.clone(),
            detail: source.to_string(),
        },
        TrainingError::Finetune(F::Io { path, source }) => FailPayload::Io {
            path: path.clone(),
            detail: source.to_string(),
        },
        TrainingError::Finetune(F::Panic(detail)) => FailPayload::Panic {
            detail: detail.clone(),
        },
        // Catch-alls: surface as `Internal` with the underlying
        // diagnostic string preserved.  `BadDataset` /
        // `DatasetRead` from the inner finetune layer are
        // already lifted by `From<FinetuneError> for
        // TrainingError`, so they don't reach this branch.
        TrainingError::Finetune(other) => FailPayload::Internal {
            detail: other.to_string(),
        },
        TrainingError::File(e) => FailPayload::Internal {
            detail: e.to_string(),
        },
        TrainingError::Fs(e) => FailPayload::Internal {
            detail: e.to_string(),
        },
        TrainingError::Join(e) => FailPayload::Internal {
            detail: e.to_string(),
        },
        // `Cancelled` never reaches this function: the cancel
        // path goes through `JobCancelled`, not `JobFailed`.
        // Preserve the variant for exhaustiveness; an
        // accidental call surfaces as a generic Internal.
        TrainingError::Cancelled => FailPayload::Internal {
            detail: "cancelled".into(),
        },
        TrainingError::JobNotFound(_) | TrainingError::WrongWorkspace { .. } => {
            FailPayload::Internal {
                detail: err.to_string(),
            }
        }
    }
}

/// Map a [`TrainingError`] to the [`Severity`] axis the frontend
/// uses for failure card colour.  Delegates to
/// [`Categorized::kind`] so adding a new error variant only
/// requires updating that single mapping; everything that isn't
/// operator-supplied input is `Internal` from the training-card
/// perspective (Conflict / NotFound only reach this path via
/// `lookup_for_workspace`, which `run_job` does not call).
fn severity_from_error(err: &TrainingError) -> Severity {
    use crate::common::error::{Categorized, ErrorKind};
    match err.kind() {
        ErrorKind::UserInput => Severity::OperatorFixable,
        ErrorKind::Conflict
        | ErrorKind::NotFound
        | ErrorKind::NotImplemented
        | ErrorKind::Unavailable
        | ErrorKind::Internal => Severity::Internal,
    }
}

fn serialize_finite_or_null<S: serde::Serializer>(v: &f32, s: S) -> Result<S::Ok, S::Error> {
    if v.is_finite() {
        s.serialize_f32(*v)
    } else {
        s.serialize_none()
    }
}

fn serialize_finite_or_null_opt<S: serde::Serializer>(
    v: &Option<f32>,
    s: S,
) -> Result<S::Ok, S::Error> {
    match v {
        Some(f) if f.is_finite() => s.serialize_f32(*f),
        _ => s.serialize_none(),
    }
}

/// Lifecycle state of a training job, surfaced on `GET
/// /api/v1/training/{id}` and used by the cancel path.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    /// Accepted; running on a `spawn_blocking` worker.
    Running,
    /// Trained head published successfully.
    Completed,
    /// Failed before the publish step.
    Failed,
    /// Operator-cancelled.
    Cancelled,
}

/// Final artefacts published by a successful training run.
/// `head_id` echoes the producer-allocated id; `head_sha256`
/// is the lowercase-hex digest of the published `.mpk` bytes.
#[derive(Clone, Debug, Serialize)]
pub struct TrainingResult {
    /// Identifier of the published head (matches the `head_id`
    /// returned to the client at job-spawn time).
    pub head_id: HeadId,
    /// Lowercase-hex SHA-256 of the published `<head_id>.mpk`.
    pub head_sha256: String,
    /// Number of output classes baked into the head.
    pub n_classes: u32,
    /// Class labels in inference order.
    pub classes: Vec<String>,
    /// Training accuracy of the published head.
    pub final_train_acc: f32,
    /// NaN when `validation_split == 0.0` (no holdout — the
    /// finetuner publishes the last-epoch head and skips
    /// val-accuracy reporting); finite for any `(0.0, 1.0)`
    /// split that produced a non-empty val partition.
    /// Serialises to JSON `null` in the NaN case so the
    /// `JobView` endpoint round-trips (serde_json refuses
    /// non-finite floats by default).
    #[serde(serialize_with = "serialize_finite_or_null")]
    pub final_val_acc: f32,
}

/// Read-shape returned by `/api/v1/training/{id}`.
#[derive(Clone, Debug, Serialize)]
pub struct JobView {
    /// Job id (UUID-v4).
    pub job_id: String,
    /// Owning workspace.
    pub workspace_id: String,
    /// Lifecycle state.
    pub state: JobState,
    /// Latest progress snapshot from the trainer.
    pub progress: finetune::Progress,
    /// Terminal artifact summary (only present once `state == Completed`).
    pub result: Option<TrainingResult>,
    /// Failure diagnostic (only present once `state == Failed`).
    pub error: Option<String>,
    /// RFC3339 wall-clock at job spawn.
    pub started_at: String,
    /// RFC3339 wall-clock at terminal state, if any.
    pub finished_at: Option<String>,
}

/// Failure shapes for the training pipeline.  Mapped to HTTP
/// statuses via the [`crate::common::error::Categorized`] impl
/// below.
#[derive(Debug, Error)]
pub enum TrainingError {
    /// Inputs failed numeric / shape validation.  `cfg`
    /// already passed [`validate_training_cfg`] at the request
    /// boundary; this surfaces internal-config issues (e.g. a
    /// missing backbone artefact).
    #[error("invalid config: {0}")]
    InvalidConfig(String),
    /// Job id not registered.
    #[error("job not found: {0}")]
    JobNotFound(String),
    /// Job belongs to a different workspace than the caller asserted.
    #[error("job {job} does not belong to workspace {workspace}")]
    WrongWorkspace {
        /// Registered job id.
        job: String,
        /// Workspace the caller asserted.
        workspace: String,
    },
    /// Operator cancelled the job; the worker exited at the
    /// next checkpoint.
    #[error("cancelled")]
    Cancelled,
    /// Wrapped `file_mgr::FileError` (e.g. missing workspace,
    /// path resolution failure, publish failure).
    #[error("file: {0}")]
    File(#[from] crate::file_mgr::FileError),
    /// Wrapped trait-object filesystem error.
    #[error("fs: {0}")]
    Fs(#[from] crate::file_mgr::FsError),
    /// Underlying head fine-tune algorithm failure.  The wrapper
    /// translates the inner `BadDataset` and `DatasetRead`
    /// variants into [`Self::BadDataset`] / [`Self::DatasetRead`]
    /// so operator-facing tooling pattern-matches once at the
    /// [`TrainingError`] boundary; other inner variants flow
    /// through transparently.
    #[error("finetune: {0}")]
    Finetune(finetune::FinetuneError),
    /// Typed dataset-shape rejection at scan time.  `path` is the
    /// offending file or class folder, `reason` the operator
    /// diagnostic.  Maps to 400 so the operator can fix the
    /// upload layout.
    #[error("bad dataset {path}: {reason}")]
    BadDataset {
        /// Path under `<workspace>/datasets/` that triggered
        /// the rejection.
        path: String,
        /// Operator-readable diagnostic.
        reason: String,
    },
    /// IO failure on a daemon-owned file (workspace tree, dataset, tempfile).
    #[error("io {path}: {source}")]
    Io {
        /// File path involved.
        path: String,
        /// Underlying IO error.
        #[source]
        source: std::io::Error,
    },
    /// `tokio::task::spawn_blocking` join failed (panic / shutdown).
    #[error("spawn_blocking join: {0}")]
    Join(#[from] tokio::task::JoinError),
    /// A dataset file disappeared between admission and the
    /// per-batch open / read / close.  Surfaces as `Internal`
    /// because `datasets/` is daemon-owned and the JobReference
    /// lease blocks legitimate mutations.
    #[error("dataset read failure {path}: {reason}")]
    DatasetRead {
        /// Path the trainer tried to read (relative or absolute).
        path: String,
        /// Operator-readable failure description.
        reason: String,
    },
}

impl crate::common::error::Categorized for TrainingError {
    fn kind(&self) -> crate::common::error::ErrorKind {
        use crate::common::error::ErrorKind::*;
        match self {
            // Operator-supplied request shape failed validation.
            TrainingError::InvalidConfig(_) => UserInput,
            // Cancellation reflects an explicit operator action;
            // surfaces as a "your request didn't go through"
            // signal.  409 fits axum better than 200/400.
            TrainingError::Cancelled => Conflict,
            // Job/workspace pair not found.
            TrainingError::JobNotFound(_) | TrainingError::WrongWorkspace { .. } => NotFound,
            // Delegate to the wrapped error's classifier.
            TrainingError::File(e) => e.kind(),
            TrainingError::Fs(e) => e.kind(),
            // Operator-supplied dataset layout is bad; 400.
            TrainingError::BadDataset { .. } => UserInput,
            // Delegate so dataset-quality variants
            // (EmptyClassAfter*, DropRatioExceeded,
            // StratifiedSplitImpossible) keep their 400 while
            // panic / Io / Model stay Internal.
            TrainingError::Finetune(e) => e.kind(),
            // Filesystem mid-job, join failures, dataset-tampering:
            // the dataset tree is daemon-owned so a missing mid-walk
            // file is not operator-fixable.
            TrainingError::Io { .. }
            | TrainingError::Join(_)
            | TrainingError::DatasetRead { .. } => Internal,
        }
    }
}

/// Lift `BadDataset` / `DatasetRead` to the wrapper's typed
/// shapes so operator tooling pattern-matches once at the
/// boundary; other variants flow through `Finetune(_)` unchanged.
impl From<finetune::FinetuneError> for TrainingError {
    fn from(value: finetune::FinetuneError) -> Self {
        match value {
            finetune::FinetuneError::BadDataset { path, reason } => {
                TrainingError::BadDataset { path, reason }
            }
            finetune::FinetuneError::DatasetRead { path, reason } => {
                TrainingError::DatasetRead { path, reason }
            }
            other => TrainingError::Finetune(other),
        }
    }
}

/// In-process registry of training jobs.  Cheaply cloneable.
///
/// Admission against `max_train_jobs = 1` is enforced by the
/// cross-cutting [`crate::file_mgr::JobRegistry`] at the api
/// boundary; this registry holds the rich per-job state
/// (`Progress`, `TrainingResult`, cancel flag) the cross-cutting
/// registry's flat `JobProgress` shape cannot express.  When
/// bridged, both registries key on the same [`JobId`] (the id
/// flows in via the [`JobHandle`] passed to [`Self::spawn`]);
/// the test-only `job_handle: None` path mints a local id.
#[derive(Clone, Debug)]
pub struct JobRegistry {
    jobs: Arc<DashMap<JobId, Arc<JobEntry>>>,
}

impl JobRegistry {
    /// Construct an empty registry.
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(DashMap::new()),
        }
    }

    /// Spawn a new training job from a producer-built [`TrainingJob`].
    ///
    /// Validates the wire `TrainingCfg`, registers the job in
    /// the in-memory map, and returns the assigned [`JobId`].
    /// The training task runs on a `spawn_blocking` worker;
    /// the per-job tokio task transitions the entry to a
    /// terminal state on completion.
    ///
    /// `job_handle` is the cross-cutting [`JobHandle`] obtained
    /// from `FsService::register_train_job` at the api route.
    /// When `Some`, the worker fans typed events out to its SSE
    /// broadcast and transitions its terminal state at the end
    /// of the run.  When `None` (test-only path), the worker
    /// runs without the cross-cutting bridge -- the durable
    /// JSONL is still written and the per-workspace `JobView`
    /// surface is unaffected.  Admission against
    /// `max_train_jobs = 1` happens at the api boundary via
    /// `register_train_job`; this function trusts the caller.
    pub fn spawn(
        &self,
        files: Arc<dyn FsService>,
        job: TrainingJob,
        job_handle: Option<JobHandle>,
    ) -> Result<JobId, TrainingError> {
        // Re-run validate_training_cfg at the spawn boundary; the
        // api route already validated, but a hand-built
        // TrainingJob (test, future replay tool) must hit the
        // same gate.
        validate_training_cfg(&job.training_cfg).map_err(|e| {
            TrainingError::File(crate::file_mgr::FileError::InvalidName(e.to_string()))
        })?;

        // Reuse the file_mgr-allocated id when bridged so
        // `/jobs/{id}` and `/workspace/{id}/training/{job}` agree
        // on a single id; `JobId::default()` mints a fresh
        // UUID-v4 for the test-only no-bridge path.
        let job_id = job_handle.as_ref().map(|h| h.job_id()).unwrap_or_default();
        let initial = finetune::Progress {
            phase: Stage::Prepare,
            current: 0,
            total: 0,
            message: "training job accepted".into(),
            metrics: None,
        };
        let (progress_tx, progress_rx) = watch::channel(initial);
        let cancel = Arc::new(AtomicU8::new(CANCEL_NONE));
        let entry = Arc::new(JobEntry {
            job_id,
            workspace_id: job.workspace_id,
            started_at: now_rfc3339(),
            progress: progress_rx,
            cancel: cancel.clone(),
            core: Mutex::new(JobCore {
                state: JobState::Running,
                result: None,
                error: None,
                finished_at: None,
                finished_at_instant: None,
            }),
        });
        self.jobs.insert(job_id, entry.clone());

        // Detached on purpose: the `JobEntry` (above) carries
        // every API-visible field, and shutdown reaches the worker
        // via the `cancel` flag (set by `cancel_all_for_shutdown`
        // from the pre-drain hook).  The blocking pool cannot
        // abort mid-batch, so cancel latency is bounded by one
        // BACKBONE_BATCH (~hundreds of ms).  The `JobHandle` is
        // moved into the closure and consumed at terminal
        // (succeed/cancel/fail), restoring the file_mgr admission
        // slot exactly at terminal publication; if the closure
        // panics before the terminal transition the
        // `JobHandle::Drop` records `Failed`.
        tokio::spawn(async move {
            let outcome = run_job(files, job, job_id, progress_tx, cancel, job_handle).await;
            let mut core = entry.core.lock();
            core.finished_at = Some(now_rfc3339());
            core.finished_at_instant = Some(std::time::Instant::now());
            match outcome {
                Ok(result) => {
                    core.state = JobState::Completed;
                    core.result = Some(result);
                }
                Err(TrainingError::Cancelled)
                | Err(TrainingError::Finetune(finetune::FinetuneError::Cancelled)) => {
                    core.state = JobState::Cancelled;
                    core.error = Some("cancelled".into());
                }
                Err(e) => {
                    core.state = JobState::Failed;
                    core.error = Some(e.to_string());
                    tracing::warn!(target: "training", job_id = %job_id, err = %e, "training job failed");
                }
            }
        });

        Ok(job_id)
    }

    /// Look up `job_id` and confirm it belongs to `workspace_id`.
    /// Returns `JobNotFound` if absent and `WrongWorkspace` if the
    /// caller asked across workspaces (a cross-workspace job_id is
    /// the same wire shape as a stale id, but the api layer
    /// distinguishes the two).  The returned `Arc<JobEntry>`
    /// outlives the dashmap shard guard, so the caller is free to
    /// take any per-entry locks (`core.lock`, atomic stores)
    /// without holding the registry's shard ref.
    fn lookup_for_workspace(
        &self,
        workspace_id: &WorkspaceId,
        job_id: JobId,
    ) -> Result<Arc<JobEntry>, TrainingError> {
        let entry = self
            .jobs
            .get(&job_id)
            .ok_or_else(|| TrainingError::JobNotFound(job_id.to_string()))?;
        if entry.workspace_id != *workspace_id {
            return Err(TrainingError::WrongWorkspace {
                job: job_id.to_string(),
                workspace: workspace_id.to_string(),
            });
        }
        Ok(entry.clone())
    }

    /// Request cancellation of `job_id`.  Sets the cancel flag
    /// (with `CANCEL_OPERATOR` reason) the trainer's epoch /
    /// chunk loops poll; the job exits at the next checkpoint
    /// and the terminal `JobCancelled` event carries
    /// `reason: operator`.  Idempotent: a second call after
    /// shutdown set the flag preserves the operator reason.
    pub fn cancel(&self, workspace_id: &WorkspaceId, job_id: JobId) -> Result<(), TrainingError> {
        let entry = self.lookup_for_workspace(workspace_id, job_id)?;
        // Operator cancel takes precedence over shutdown if both
        // fire concurrently: a shutdown drain followed by an
        // operator click should still surface as "operator
        // cancelled" because that's the more specific signal.
        // Always store unconditionally.
        entry.cancel.store(CANCEL_OPERATOR, Ordering::SeqCst);
        Ok(())
    }

    /// Latest [`JobView`] for `job_id`, scoped to `workspace_id`.
    pub fn status(
        &self,
        workspace_id: &WorkspaceId,
        job_id: JobId,
    ) -> Result<JobView, TrainingError> {
        Ok(self.lookup_for_workspace(workspace_id, job_id)?.view())
    }

    /// All jobs scoped to `workspace_id`, sorted by start time.
    pub fn list_for_workspace(&self, workspace_id: &WorkspaceId) -> Vec<JobView> {
        let mut out: Vec<_> = self
            .jobs
            .iter()
            .filter(|entry| entry.value().workspace_id == *workspace_id)
            .map(|entry| entry.value().view())
            .collect();
        out.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        out
    }

    /// Set the shutdown cancel flag on every running job.
    /// Daemon shutdown calls this from a pre-drain hook so the
    /// blocking trainer observes shutdown without waiting for
    /// the per-job cancel API.  The terminal `JobCancelled`
    /// event for each affected job carries `reason: shutdown`.
    /// Returns the number of jobs whose flag transitioned
    /// from `CANCEL_NONE` to `CANCEL_SHUTDOWN`; jobs already
    /// cancelled by an operator (`CANCEL_OPERATOR`) are
    /// preserved at that reason and not double-counted.
    pub fn cancel_all_for_shutdown(&self) -> usize {
        let mut n = 0usize;
        for entry in self.jobs.iter() {
            let core = entry.value().core.lock();
            if core.state != JobState::Running {
                continue;
            }
            drop(core);
            if entry
                .value()
                .cancel
                .compare_exchange(
                    CANCEL_NONE,
                    CANCEL_SHUTDOWN,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_ok()
            {
                n = n.saturating_add(1);
            }
        }
        n
    }

    /// Number of jobs currently in [`JobState::Running`].
    pub fn active_count(&self) -> usize {
        self.jobs
            .iter()
            .filter(|entry| entry.value().core.lock().state == JobState::Running)
            .count()
    }

    /// Drop finished entries whose `finished_at` is older than
    /// `max_age`.  Returns the number reaped.  Running jobs
    /// and entries with no recorded finish time are kept.
    pub fn reap_finished(&self, max_age: std::time::Duration) -> usize {
        let now = std::time::Instant::now();
        let to_remove: Vec<JobId> = self
            .jobs
            .iter()
            .filter_map(|entry| {
                let core = entry.value().core.lock();
                let finished_at = core.finished_at_instant?;
                if now.duration_since(finished_at) >= max_age {
                    Some(*entry.key())
                } else {
                    None
                }
            })
            .collect();
        let n = to_remove.len();
        for id in to_remove {
            self.jobs.remove(&id);
        }
        n
    }
}

impl Default for JobRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
struct JobEntry {
    job_id: JobId,
    workspace_id: WorkspaceId,
    started_at: String,
    /// `watch::Receiver` is internally synchronized and `borrow`
    /// only needs `&self`, so no extra mutex is required for
    /// concurrent readers.
    progress: watch::Receiver<finetune::Progress>,
    /// 0 = not cancelled, 1 = operator-cancelled, 2 =
    /// shutdown-cancelled.  See [`CANCEL_NONE`] /
    /// [`CANCEL_OPERATOR`] / [`CANCEL_SHUTDOWN`] for the
    /// constants.  Read at every chunk / epoch boundary in the
    /// trainer (via the `cancel: () -> bool` closure) and at
    /// terminal-transition time by the wrapper to attach a
    /// [`CancelReason`] to the typed `JobCancelled` event.
    cancel: Arc<AtomicU8>,
    core: Mutex<JobCore>,
}

impl JobEntry {
    fn view(&self) -> JobView {
        let progress = self.progress.borrow().clone();
        let core = self.core.lock();
        JobView {
            job_id: self.job_id.to_string(),
            workspace_id: self.workspace_id.to_string(),
            state: core.state.clone(),
            progress,
            result: core.result.clone(),
            error: core.error.clone(),
            started_at: self.started_at.clone(),
            finished_at: core.finished_at.clone(),
        }
    }
}

#[derive(Clone, Debug)]
struct JobCore {
    state: JobState,
    result: Option<TrainingResult>,
    error: Option<String>,
    finished_at: Option<String>,
    finished_at_instant: Option<std::time::Instant>,
}

/// Run a single training job end-to-end:
/// open the JSONL log, emit `JobSubmitted` + `JobRunning`, then
/// run [`run_job_inner`] (workspace prep, [`finetune::run`] on
/// the blocking pool fanning algorithmic events to JSONL + SSE,
/// then `publish_trained_head` + `HeadPublished`).  After
/// `run_job_inner` returns, emit a typed terminal event
/// (`JobCompleted` / `JobFailed` / `JobCancelled`) and consume
/// the cross-cutting [`JobHandle`] -- `succeed` carries
/// [`RegistryJobResult::Train`] so `GET /jobs/{id}` surfaces
/// the new head id.
///
/// An unwritable `training_logs/` refuses the run loudly rather
/// than silently losing the trace.  Any failure before
/// `publish_trained_head` returns leaves no head record on
/// disk; the `JobHandle` lease auto-releases on `succeed` /
/// `fail` / `cancel`.
async fn run_job(
    files: Arc<dyn FsService>,
    job: TrainingJob,
    job_id: JobId,
    progress_tx: watch::Sender<finetune::Progress>,
    cancel: Arc<AtomicU8>,
    job_handle: Option<JobHandle>,
) -> Result<TrainingResult, TrainingError> {
    let workspace_dir = crate::file_mgr::schema::workspace_dir_for(files.root(), &job.workspace_id);
    let backbone_basename = job
        .backbone_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "<unknown>".to_string());

    // Open + first event under TrainingError so an unwritable
    // training_logs surfaces as a typed failure (the worker's
    // `succeed`/`cancel` arms below would never see a result if
    // the log can't be opened, so the JobHandle drops as
    // `Failed` -- the right cross-cutting state).
    let log = match TrainJobLog::open(&workspace_dir, job_id) {
        Ok(l) => Arc::new(Mutex::new(l)),
        Err(e) => {
            // No JSONL line is possible at this point; surface
            // the failure on the cross-cutting bridge if any.
            if let Some(h) = job_handle {
                h.fail(e.to_string());
            }
            return Err(e);
        }
    };
    let stage = Arc::new(Mutex::new(Stage::Prepare));
    // `Option<Arc<JobHandle>>`: cloned into the spawn_blocking
    // closures that need to emit append_log / update_progress
    // via the cross-cutting registry; consumed at terminal via
    // `Arc::try_unwrap` once all child clones have dropped.
    let handle_arc: Option<Arc<JobHandle>> = job_handle.map(Arc::new);

    let head_id = job.head_id;
    let cfg_snapshot = job.training_cfg.clone();
    emit_train_event(
        &log,
        handle_arc.as_deref(),
        &stage,
        TrainEvent::JobSubmitted {
            head_id,
            cfg: cfg_snapshot,
            backbone: backbone_basename,
        },
    );
    emit_train_event(
        &log,
        handle_arc.as_deref(),
        &stage,
        TrainEvent::JobRunning,
    );

    let result = run_job_inner(
        files,
        job,
        progress_tx,
        cancel.clone(),
        log.clone(),
        stage.clone(),
        handle_arc.clone(),
    )
    .await;

    // Build the typed terminal event before tearing down the
    // JobHandle so the SSE consumer sees the rich payload
    // followed by the registry's flat state transition.
    let final_event = match &result {
        Ok(r) => TrainEvent::JobCompleted { result: r.clone() },
        Err(TrainingError::Cancelled)
        | Err(TrainingError::Finetune(finetune::FinetuneError::Cancelled)) => {
            let stage_now = *stage.lock();
            let reason = match cancel.load(Ordering::SeqCst) {
                CANCEL_SHUTDOWN => CancelReason::Shutdown,
                // Treat CANCEL_NONE as operator too: the worker
                // returned Cancelled without the atomic being
                // set, which only happens when finetune::run
                // surfaced its own internal Cancelled.  Bias
                // toward "operator" so the frontend doesn't
                // mis-attribute a stale state to shutdown.
                _ => CancelReason::Operator,
            };
            TrainEvent::JobCancelled {
                stage: stage_now,
                reason,
            }
        }
        Err(e) => {
            let stage_now = *stage.lock();
            TrainEvent::JobFailed {
                stage: stage_now,
                severity: severity_from_error(e),
                error: e.to_string(),
                payload: fail_payload_from_error(e),
            }
        }
    };
    emit_train_event(&log, handle_arc.as_deref(), &stage, final_event);

    // Cross-cutting registry terminal transition.  All
    // intermediate clones of `handle_arc` were held by the
    // `spawn_blocking` closures and dropped when those returned
    // (already awaited above); `try_unwrap` should always
    // succeed.  An `Err` here would mean a clone leaked into a
    // detached future -- log loudly and rely on `JobHandle::Drop`
    // to mark `Failed` so the cross-cutting state is at least
    // terminal.
    if let Some(handle_arc) = handle_arc {
        match Arc::try_unwrap(handle_arc) {
            Ok(handle) => match &result {
                Ok(r) => handle.succeed(Some(RegistryJobResult::Train {
                    head_id: r.head_id,
                    sha256: r.head_sha256.clone(),
                    n_classes: r.n_classes,
                })),
                Err(TrainingError::Cancelled)
                | Err(TrainingError::Finetune(finetune::FinetuneError::Cancelled)) => {
                    handle.cancel()
                }
                Err(e) => handle.fail(e.to_string()),
            },
            Err(arc) => {
                tracing::warn!(
                    target: "training",
                    job_id = %job_id,
                    "JobHandle still shared at terminal; relying on Drop to mark Failed",
                );
                drop(arc);
            }
        }
    }

    result
}

/// Fan one [`TrainEvent`] out to its three sinks: the stage
/// tracker (so the next terminal event has a stage to attach),
/// the durable JSONL log (best-effort), and the cross-cutting
/// SSE broadcast via the [`JobHandle`] (best-effort).  All
/// failures are tracing-warned, never returned -- a failed log
/// write must not promote a successful run to failed.
fn emit_train_event(
    log: &Arc<Mutex<TrainJobLog>>,
    handle: Option<&JobHandle>,
    stage: &Arc<Mutex<Stage>>,
    event: TrainEvent,
) {
    if let TrainEvent::PhaseStarted { phase } = &event {
        *stage.lock() = *phase;
    }
    if let (Some(h), TrainEvent::EpochCompleted { epoch, epochs, .. }) = (handle, &event) {
        h.update_progress(crate::file_mgr::JobProgress {
            done: u64::from(*epoch),
            total: Some(u64::from(*epochs)),
        });
    }
    if let Err(err) = log.lock().emit(&event) {
        tracing::warn!(target: "training", err = %err, "training: log emit failed");
    }
    if let Some(h) = handle {
        match serde_json::to_string(&event) {
            Ok(s) => h.append_log(s),
            Err(e) => {
                tracing::warn!(target: "training", err = %e, "training: SSE event serialize failed")
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_job_inner(
    files: Arc<dyn FsService>,
    job: TrainingJob,
    progress_tx: watch::Sender<finetune::Progress>,
    cancel: Arc<AtomicU8>,
    log: Arc<Mutex<TrainJobLog>>,
    stage: Arc<Mutex<Stage>>,
    handle: Option<Arc<JobHandle>>,
) -> Result<TrainingResult, TrainingError> {
    let workspace = job.workspace_id;

    emit_train_event(
        &log,
        handle.as_deref(),
        &stage,
        TrainEvent::PhaseStarted {
            phase: Stage::Prepare,
        },
    );

    // Fixed dataset root.  The cached `summary` re-confirms the
    // workspace exists without walking `datasets/`; the scan helper
    // inside `finetune::run` enforces the directory shape and
    // surfaces missing/unreadable entries as `DatasetRead`.
    let files_for_summary = files.clone();
    tokio::task::spawn_blocking(move || files_for_summary.summary(&workspace))
        .await?
        .map_err(TrainingError::Fs)?;
    let dataset_root = crate::file_mgr::schema::workspace_dir_for(files.root(), &workspace)
        .join(DATASETS_DIR_NAME);
    let stat_root = dataset_root.clone();
    let md = tokio::task::spawn_blocking(move || std::fs::symlink_metadata(&stat_root))
        .await?
        .map_err(|source| TrainingError::Io {
            path: dataset_root.display().to_string(),
            source,
        })?;
    if !md.is_dir() {
        return Err(TrainingError::InvalidConfig(format!(
            "dataset root {} is not a directory",
            dataset_root.display(),
        )));
    }

    // Stage trained-head output under `<workspace_dir>/.tmp/`.
    // Same filesystem as `heads/` so the post-train atomic
    // rename inside `publish_trained_head` is intra-FS POSIX-
    // atomic.  The tempdir guard auto-removes on function exit
    // unless we explicitly persist the `.mpk` (the rename
    // inside `publish_trained_head` removes the file, so an
    // empty tempdir is the success state).
    let workspace_tmpdir = files.workspace_tmpdir(&workspace);
    let workspace_tmpdir_for_create = workspace_tmpdir.clone();
    tokio::task::spawn_blocking(move || std::fs::create_dir_all(&workspace_tmpdir_for_create))
        .await?
        .map_err(|source| TrainingError::Io {
            path: workspace_tmpdir.display().to_string(),
            source,
        })?;
    let workspace_tmpdir_for_temp = workspace_tmpdir.clone();
    let output_temp =
        tokio::task::spawn_blocking(move || tempfile::tempdir_in(&workspace_tmpdir_for_temp))
            .await?
            .map_err(|source| TrainingError::Io {
                path: workspace_tmpdir.display().to_string(),
                source,
            })?;
    let output_head = output_temp.path().join(format!("{}.mpk", job.head_id));

    if cancel.load(Ordering::SeqCst) != CANCEL_NONE {
        return Err(TrainingError::Cancelled);
    }

    // Cross-validate every component of every relative file
    // path against AssetPath's per-component allowlist before
    // handing them to the wav reader.  `datasets/` is daemon-
    // owned, but a stray name (e.g. uploaded class dir whose
    // entries were renamed by an external process despite the
    // lease) should fail closed with `DatasetRead`.
    let ft_cfg = finetune::FinetuneConfig {
        data: dataset_root.clone(),
        backbone: job.backbone_path.clone(),
        init_head: None,
        out: output_head.clone(),
        epochs: job.training_cfg.epochs as usize,
        batch: job.training_cfg.batch_size as usize,
        lr: job.training_cfg.learning_rate,
        // 0.0 disables the stratified split; any value in
        // `(0.0, 1.0)` runs validation and publishes the
        // best-val-loss epoch.  Range gated by
        // `validate_training_cfg` at the request boundary.
        val_split: job.training_cfg.validation_split,
        seed: job.training_cfg.seed.unwrap_or(42),
    };
    let cancel_for_run = cancel.clone();
    let progress_for_run = progress_tx.clone();
    let log_for_run = log.clone();
    let handle_for_run = handle.clone();
    let stage_for_run = stage.clone();
    let output = tokio::task::spawn_blocking(move || {
        let progress = |p: &finetune::Progress| {
            let _ = progress_for_run.send(p.clone());
        };
        let event_cb = |e: finetune::Event| {
            emit_train_event(&log_for_run, handle_for_run.as_deref(), &stage_for_run, e.into());
        };
        let cancel_fn = || cancel_for_run.load(Ordering::SeqCst) != CANCEL_NONE;
        finetune::run(&ft_cfg, &progress, &event_cb, &cancel_fn)
    })
    .await??;

    if cancel.load(Ordering::SeqCst) != CANCEL_NONE {
        return Err(TrainingError::Cancelled);
    }

    emit_train_event(
        &log,
        handle.as_deref(),
        &stage,
        TrainEvent::PhaseStarted {
            phase: Stage::Publish,
        },
    );

    // Compute final sha256 + size of the published head bytes.
    // `output.head_mpk` lives under `output_temp` -- moved into
    // the workspace via `publish_trained_head` below.  Hash on
    // the blocking pool so the runtime stays free.
    let mpk_path_for_sha = output.head_mpk.clone();
    let head_sha256 =
        tokio::task::spawn_blocking(move || sha256_file_streaming(&mpk_path_for_sha)).await??;
    let mpk_path_for_meta = output.head_mpk.clone();
    let size_bytes = tokio::task::spawn_blocking(move || std::fs::metadata(&mpk_path_for_meta))
        .await?
        .map_err(|source| TrainingError::Io {
            path: output.head_mpk.display().to_string(),
            source,
        })?
        .len();

    let n_classes_u32 = u32::try_from(output.classes.len()).map_err(|_| {
        TrainingError::InvalidConfig(format!(
            "trained head has {} classes; exceeds u32 cap",
            output.classes.len(),
        ))
    })?;

    let manifest = HeadManifest {
        head_id: job.head_id,
        workspace_id: workspace,
        workspace_revision: job.workspace_revision.clone(),
        sha256: head_sha256.clone(),
        n_classes: n_classes_u32,
        size_bytes,
        created_at: now_rfc3339(),
        labels: output.classes.clone(),
    };
    let pending = PendingHead {
        head_id: job.head_id,
        mpk_tempfile: output.head_mpk.clone(),
        manifest,
    };

    // Publish into the 2-slot rotation.  The primitive holds the
    // per-workspace mutation mutex internally and the cell lookup
    // goes through `WorkspaceMgr::caches` so the cache installed at
    // workspace-create time is the one that observes the new head.
    let files_for_publish = files.clone();
    tokio::task::spawn_blocking(move || {
        files_for_publish.publish_trained_head(&workspace, pending)
    })
    .await??;

    // Emit `HeadPublished` ONLY after the rotation primitive
    // returned successfully; the absence of this event in a
    // JSONL transcript is the load-bearing signal that the
    // publish step did not commit.
    emit_train_event(
        &log,
        handle.as_deref(),
        &stage,
        TrainEvent::HeadPublished {
            head_id: job.head_id,
            head_sha256: head_sha256.clone(),
            size_bytes,
            n_classes: n_classes_u32,
            classes: output.classes.clone(),
            workspace_revision: job.workspace_revision.clone(),
        },
    );

    let result = TrainingResult {
        head_id: job.head_id,
        head_sha256,
        n_classes: n_classes_u32,
        classes: output.classes,
        final_train_acc: output.final_train_acc,
        final_val_acc: output.final_val_acc,
    };

    // `output_temp` drops when this function returns.  The
    // `.mpk` was renamed out of the tempdir by
    // `publish_trained_head`; remaining residue is just the
    // (now empty) tempdir + sibling labels.txt finetune writes,
    // both safe to delete.
    Ok(result)
}

// MARK: TrainJobLog
//
// Per-job typed-event JSONL writer for
// `<workspace_dir>/training_logs/<job_id>.jsonl`.  Read by the
// unified `GET /assets/.../<job_id>.jsonl?after_seq=&limit=`
// page surface, which is producer-agnostic (see
// [`crate::file_mgr::log_page::LogEvent`]).

/// Per-job JSONL writer for training-side typed events.  One
/// line per [`TrainJobLog::emit`] call; best-effort flush (per-
/// line fsync would 10x the eMMC cost for negligible recovery
/// benefit -- a crash loses at most the trailing event).
struct TrainJobLog {
    file: std::fs::File,
    seq: u64,
}

impl TrainJobLog {
    /// Open `<workspace_dir>/training_logs/<job_id>.jsonl` for
    /// append; creates the dir if missing.  Surfaces failures as
    /// [`TrainingError::Io`] so an unwritable training_logs dir
    /// fails the run loudly instead of silently losing the trace.
    fn open(workspace_dir: &std::path::Path, job_id: JobId) -> Result<Self, TrainingError> {
        let dir = workspace_dir.join("training_logs");
        std::fs::create_dir_all(&dir).map_err(|e| TrainingError::Io {
            path: dir.display().to_string(),
            source: e,
        })?;
        let path = dir.join(format!("{job_id}.jsonl"));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| TrainingError::Io {
                path: path.display().to_string(),
                source: e,
            })?;
        Ok(Self { file, seq: 0 })
    }

    /// Append one JSONL line carrying a typed [`TrainEvent`].
    /// The wire envelope is [`TrainLogLine`] (`seq` + `at` +
    /// flattened event payload).
    fn emit(&mut self, event: &TrainEvent) -> Result<(), TrainingError> {
        use std::io::Write as _;
        self.seq = self.seq.saturating_add(1);
        let line = TrainLogLine {
            seq: self.seq,
            at: now_rfc3339(),
            event,
        };
        let mut bytes = serde_json::to_vec(&line).map_err(|e| TrainingError::Io {
            path: "<training_logs>".to_string(),
            source: std::io::Error::other(e),
        })?;
        bytes.push(b'\n');
        self.file.write_all(&bytes).map_err(|e| TrainingError::Io {
            path: "<training_logs>".to_string(),
            source: e,
        })?;
        let _ = self.file.flush();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]
    // Dataset-shape fixtures intentionally use direct file writes.

    use super::*;
    use crate::common::ids::{HeadId, WorkspaceId};
    use std::fs;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    fn synthetic_entry(
        workspace: &WorkspaceId,
        finished_state: Option<(JobState, Option<Instant>)>,
    ) -> Arc<JobEntry> {
        let job_id = JobId::new();
        let initial = finetune::Progress {
            phase: Stage::Prepare,
            current: 0,
            total: 0,
            message: "synthetic".into(),
            metrics: None,
        };
        let (_tx, rx) = watch::channel(initial);
        let (state, finished_at_instant) = match finished_state {
            Some((s, t)) => (s, t),
            None => (JobState::Running, None),
        };
        Arc::new(JobEntry {
            job_id,
            workspace_id: *workspace,
            started_at: now_rfc3339(),
            progress: rx,
            cancel: Arc::new(AtomicU8::new(CANCEL_NONE)),
            core: Mutex::new(JobCore {
                state,
                result: None,
                error: None,
                finished_at: finished_at_instant.map(|_| now_rfc3339()),
                finished_at_instant,
            }),
        })
    }

    /// `TrainingResult` carries no filesystem paths; the head
    /// identity + sha256 + n_classes + final metrics are sufficient
    /// for client display, and `GET /workspace/{id}/heads/{head_id}`
    /// owns artifact access.
    #[test]
    fn training_result_serialization_carries_no_filesystem_path() {
        let result = TrainingResult {
            head_id: HeadId::new(),
            head_sha256: "0".repeat(64),
            n_classes: 2,
            classes: vec!["a".into(), "b".into()],
            final_train_acc: 0.9,
            final_val_acc: 0.85,
        };
        let v = serde_json::to_value(&result).expect("serialize TrainingResult");
        let body = v
            .as_object()
            .expect("TrainingResult serializes as a JSON object");
        let allowed: std::collections::BTreeSet<&str> = [
            "head_id",
            "head_sha256",
            "n_classes",
            "classes",
            "final_train_acc",
            "final_val_acc",
        ]
        .into_iter()
        .collect();
        let actual: std::collections::BTreeSet<&str> = body.keys().map(String::as_str).collect();
        assert_eq!(
            actual, allowed,
            "TrainingResult must serialize exactly {allowed:?}; got {actual:?}",
        );
        for forbidden in [
            "head_mpk_path",
            "labels_path",
            "head_path",
            "weights_path",
            "path",
            "dataset_path",
        ] {
            assert!(
                body.get(forbidden).is_none(),
                "TrainingResult must not carry filesystem path field `{forbidden}`; body={v}",
            );
        }
    }

    #[test]
    fn reap_finished_drops_stale_keeps_fresh_and_running() {
        let reg = JobRegistry::new();
        let workspace = WorkspaceId::new();

        let now = Instant::now();
        let stale = synthetic_entry(
            &workspace,
            Some((JobState::Completed, Some(now - Duration::from_secs(7200)))),
        );
        let fresh = synthetic_entry(
            &workspace,
            Some((JobState::Completed, Some(now - Duration::from_secs(60)))),
        );
        let running = synthetic_entry(&workspace, None);

        reg.jobs.insert(stale.job_id, stale.clone());
        reg.jobs.insert(fresh.job_id, fresh.clone());
        reg.jobs.insert(running.job_id, running.clone());

        let n = reg.reap_finished(Duration::from_secs(3600));
        assert_eq!(n, 1, "exactly one stale entry expected");
        assert!(!reg.jobs.contains_key(&stale.job_id));
        assert!(reg.jobs.contains_key(&fresh.job_id));
        assert!(reg.jobs.contains_key(&running.job_id));
    }

    #[test]
    fn cancel_all_for_shutdown_sets_flag_on_running_only() {
        let reg = JobRegistry::new();
        let workspace = WorkspaceId::new();

        let running1 = synthetic_entry(&workspace, None);
        let running2 = synthetic_entry(&workspace, None);
        let completed = synthetic_entry(
            &workspace,
            Some((JobState::Completed, Some(Instant::now()))),
        );
        let cancelled = synthetic_entry(
            &workspace,
            Some((JobState::Cancelled, Some(Instant::now()))),
        );
        // Pre-set with the operator reason; the shutdown drain
        // must not overwrite it (operator wins).
        let running_pre_cancelled = synthetic_entry(&workspace, None);
        running_pre_cancelled
            .cancel
            .store(CANCEL_OPERATOR, Ordering::SeqCst);

        reg.jobs.insert(running1.job_id, running1.clone());
        reg.jobs.insert(running2.job_id, running2.clone());
        reg.jobs.insert(completed.job_id, completed.clone());
        reg.jobs.insert(cancelled.job_id, cancelled.clone());
        reg.jobs
            .insert(running_pre_cancelled.job_id, running_pre_cancelled.clone());

        let n = reg.cancel_all_for_shutdown();
        assert_eq!(n, 2, "exactly two newly-signalled jobs expected");
        assert_eq!(
            running1.cancel.load(Ordering::SeqCst),
            CANCEL_SHUTDOWN,
            "drain stamps SHUTDOWN reason on freshly-cancelled jobs",
        );
        assert_eq!(running2.cancel.load(Ordering::SeqCst), CANCEL_SHUTDOWN);
        assert_eq!(
            completed.cancel.load(Ordering::SeqCst),
            CANCEL_NONE,
            "terminal jobs are skipped by the drain",
        );
        assert_eq!(cancelled.cancel.load(Ordering::SeqCst), CANCEL_NONE);
        assert_eq!(
            running_pre_cancelled.cancel.load(Ordering::SeqCst),
            CANCEL_OPERATOR,
            "operator-cancelled jobs keep their OPERATOR reason; shutdown does not overwrite",
        );

        let n2 = reg.cancel_all_for_shutdown();
        assert_eq!(n2, 0, "idempotent on repeat shutdown drain");
    }

    #[test]
    fn active_count_only_counts_running_jobs() {
        let reg = JobRegistry::new();
        let workspace = WorkspaceId::new();
        assert_eq!(reg.active_count(), 0);

        let r1 = synthetic_entry(&workspace, None);
        let r2 = synthetic_entry(&workspace, None);
        let f = synthetic_entry(
            &workspace,
            Some((JobState::Completed, Some(Instant::now()))),
        );
        reg.jobs.insert(r1.job_id, r1.clone());
        reg.jobs.insert(r2.job_id, r2.clone());
        reg.jobs.insert(f.job_id, f.clone());
        assert_eq!(reg.active_count(), 2);
    }

    /// `scan_dataset` walks each class folder recursively (not
    /// just the direct-child level) and treats every non-hidden
    /// `.wav` file as a sample.  Hidden entries (leading `.`) are
    /// skipped; non-hidden non-dir root entries fail closed with
    /// `BadDataset`, so the operator can hide metadata files
    /// (e.g. `.README`) to keep them out of the way.  Exercises
    /// the same scan helper `finetune::run` uses in production.
    #[test]
    fn class_file_discovery_walks_recursively() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        for cls in ["cat", "dog"] {
            fs::create_dir_all(root.join(cls)).unwrap();
            for i in 0..3 {
                fs::write(root.join(cls).join(format!("s{i}.wav")), b"stub").unwrap();
            }
        }
        // Hidden root entry: silently ignored.
        fs::write(root.join(".README"), b"meta").unwrap();
        // Recursive discovery picks up `cat/nested/x.wav` as a
        // sample under the `cat` class.
        fs::create_dir_all(root.join("cat").join("nested")).unwrap();
        fs::write(root.join("cat").join("nested").join("x.wav"), b"deeper").unwrap();

        let (classes, examples) = finetune::scan_dataset_for_test(root);
        // Two classes, sorted by canonical byte order.
        assert_eq!(classes, vec!["cat".to_string(), "dog".to_string()]);
        // 3 direct + 1 nested = 4 samples for cat; 3 for dog.
        assert_eq!(examples.len(), 7);
        for (path, _label) in &examples {
            assert!(path.extension().is_some_and(|e| e == "wav"));
        }
        // The nested wav is associated with the `cat` class
        // (label index 0 because cat sorts before dog).
        let cat_count = examples.iter().filter(|(_, l)| *l == 0).count();
        let dog_count = examples.iter().filter(|(_, l)| *l == 1).count();
        assert_eq!(cat_count, 4);
        assert_eq!(dog_count, 3);
    }

    /// Mid-walk file disappearance surfaces as
    /// `TrainingError::DatasetRead` in production.  Here we
    /// drive the helper synchronously and convert
    /// `FinetuneError::Io` -> `TrainingError::DatasetRead` at
    /// the boundary the same way `run_job` would (the
    /// finetune-side error already carries the path; the
    /// production code just rewraps).
    #[test]
    fn dataset_read_failure_surfaces_typed_error() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("cat")).unwrap();
        fs::write(root.join("cat").join("a.wav"), b"stub").unwrap();
        // Simulate the file disappearing between scan and
        // open -- delete after the scan but before the
        // synthetic open below.
        let (_classes, examples) = finetune::scan_dataset_for_test(root);
        assert_eq!(examples.len(), 1);
        fs::remove_file(root.join("cat").join("a.wav")).unwrap();
        let err = match std::fs::File::open(&examples[0].0) {
            Ok(_) => panic!("expected ENOENT"),
            Err(e) => TrainingError::DatasetRead {
                path: examples[0].0.display().to_string(),
                reason: e.to_string(),
            },
        };
        match err {
            TrainingError::DatasetRead { path, .. } => assert!(path.ends_with("a.wav")),
            other => panic!("expected DatasetRead; got {other:?}"),
        }
    }

    /// `From<FinetuneError>` lifts the inner `BadDataset` /
    /// `DatasetRead` variants to the typed
    /// `TrainingError::BadDataset` / `TrainingError::DatasetRead`
    /// shapes; other inner variants flow through `Finetune(_)`
    /// unchanged.  Pinned so operator-facing tooling can
    /// pattern-match once at the wrapper boundary.
    #[test]
    fn finetune_bad_dataset_translates_to_training_bad_dataset() {
        let inner = finetune::FinetuneError::BadDataset {
            path: "/ws/datasets/empty".into(),
            reason: "no class folders".into(),
        };
        let outer: TrainingError = inner.into();
        match outer {
            TrainingError::BadDataset { path, reason } => {
                assert_eq!(path, "/ws/datasets/empty");
                assert_eq!(reason, "no class folders");
            }
            other => panic!("expected TrainingError::BadDataset, got {other:?}"),
        }
    }

    #[test]
    fn finetune_dataset_read_translates_to_training_dataset_read() {
        let inner = finetune::FinetuneError::DatasetRead {
            path: "/ws/datasets/cat/a.wav".into(),
            reason: "ENOENT".into(),
        };
        let outer: TrainingError = inner.into();
        match outer {
            TrainingError::DatasetRead { path, reason } => {
                assert_eq!(path, "/ws/datasets/cat/a.wav");
                assert_eq!(reason, "ENOENT");
            }
            other => panic!("expected TrainingError::DatasetRead, got {other:?}"),
        }
    }

    /// `BadDataset` -> 400, `DatasetRead` -> 500; the wrapping
    /// `Finetune(_)` delegates to the inner classifier so dataset-
    /// quality variants keep their 400 instead of being blanket-
    /// classified as Internal.
    #[test]
    fn training_error_kinds_classify_correctly() {
        use crate::common::error::{Categorized, ErrorKind};
        let bad = TrainingError::BadDataset {
            path: "/x".into(),
            reason: "y".into(),
        };
        assert_eq!(bad.kind(), ErrorKind::UserInput);
        let read = TrainingError::DatasetRead {
            path: "/x".into(),
            reason: "y".into(),
        };
        assert_eq!(read.kind(), ErrorKind::Internal);

        // `Finetune(_)` delegates to the inner classifier so
        // dataset-quality variants keep their 400.
        let wrapped_bad = TrainingError::Finetune(finetune::FinetuneError::EmptyClassAfterScan {
            class: "cat".into(),
            per_class_kept: vec![],
        });
        assert_eq!(wrapped_bad.kind(), ErrorKind::UserInput);
        // Panic (daemon-internal) -> Internal.
        let wrapped_panic = TrainingError::Finetune(finetune::FinetuneError::Panic("oops".into()));
        assert_eq!(wrapped_panic.kind(), ErrorKind::Internal);
    }

    /// FD usage is bounded by `batch_size * parallel_loaders`: the
    /// scan returns `(PathBuf, label)` pairs without opening any
    /// file (opens live in the per-batch chunk path).  Failing
    /// this would mean the trainer pre-opened every file and peak
    /// FD count would scale with dataset size.
    #[test]
    fn lazy_fd_bounded_no_open_during_scan() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("cat")).unwrap();
        fs::create_dir_all(root.join("dog")).unwrap();
        // 100 files per class; if scan opened each, peak FDs
        // would scale with dataset size.
        for cls in ["cat", "dog"] {
            for i in 0..100 {
                fs::write(root.join(cls).join(format!("s{i}.wav")), b"x").unwrap();
            }
        }
        let (classes, examples) = finetune::scan_dataset_for_test(root);
        assert_eq!(classes.len(), 2);
        assert_eq!(examples.len(), 200);
        // The scan returns paths; no file handle is held by
        // any element of the returned vector.  This is the
        // load-bearing assertion: the trainer's per-batch
        // preproc opens by path inside the batch closure, so
        // peak FDs cap at `batch_size * parallel_loaders`.
        for (p, _) in &examples {
            assert!(p.is_file(), "scan returned a non-file path: {p:?}");
        }
    }

    /// `TrainJobLog::open` materialises
    /// `<workspace>/training_logs/<job_id>.jsonl` and writes one
    /// JSONL line per [`TrainJobLog::emit`] call.  Pinned
    /// because the unified `GET /assets/training_logs/<id>.jsonl`
    /// reader expects every line to carry `seq`, `at`, `kind`,
    /// plus event-specific fields under the `kind`
    /// discriminator -- a writer-side regression here would
    /// silently break the page response.
    #[test]
    fn train_job_log_writes_one_jsonl_line_per_event() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace_dir = tmp.path();
        let job_id = JobId::new();
        let mut log = TrainJobLog::open(workspace_dir, job_id).expect("open log");
        log.emit(&TrainEvent::JobRunning).expect("running");
        log.emit(&TrainEvent::EpochCompleted {
            epoch: 3,
            epochs: 5,
            train_loss: 0.42,
            train_acc: 0.91,
            val_acc: 0.88,
            best_val_acc: 0.89,
            lr: 0.01,
            elapsed_ms: 750,
        })
        .expect("epoch");
        log.emit(&TrainEvent::JobCancelled {
            stage: Stage::Train,
            reason: CancelReason::Operator,
        })
        .expect("cancelled");
        drop(log);

        let path = workspace_dir
            .join("training_logs")
            .join(format!("{job_id}.jsonl"));
        let body = std::fs::read_to_string(&path).expect("read log");
        let lines: Vec<_> = body.lines().collect();
        assert_eq!(lines.len(), 3, "one JSONL line per emit() call");

        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["seq"], 1);
        assert_eq!(first["kind"], "job_running");
        assert!(first["at"].as_str().unwrap().ends_with('Z'));

        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["seq"], 2);
        assert_eq!(second["kind"], "epoch_completed");
        assert_eq!(second["epoch"], 3);
        assert_eq!(second["epochs"], 5);
        assert_eq!(second["train_acc"], 0.91);
        assert_eq!(second["val_acc"], 0.88);
        assert_eq!(second["lr"], 0.01);
        assert_eq!(second["elapsed_ms"], 750);

        let third: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(third["seq"], 3);
        assert_eq!(third["kind"], "job_cancelled");
        assert_eq!(third["stage"], "train");
        assert_eq!(third["reason"], "operator");
    }

    /// `val_split == 0.0` runs land NaN into the `JobView`'s
    /// `Progress.metrics` and `TrainingResult.final_val_acc`.
    /// serde_json refuses non-finite floats by default, so
    /// without the `serialize_finite_or_null` shims the
    /// `GET /workspace/{id}/training/{job}` handler would 500
    /// on the first poll.  Pinned at both sites.
    #[test]
    fn jobview_serializes_with_nan_val_acc() {
        let metrics = finetune::EpochMetrics {
            epoch: 1,
            epochs: 1,
            train_loss: 0.5,
            train_acc: 0.9,
            val_acc: f32::NAN,
            best_val_acc: f32::NAN,
        };
        let v = serde_json::to_value(metrics).expect("EpochMetrics serialises");
        assert!(v["val_acc"].is_null(), "EpochMetrics::val_acc NaN -> null");
        assert!(v["best_val_acc"].is_null());

        let result = TrainingResult {
            head_id: HeadId::new(),
            head_sha256: "0".repeat(64),
            n_classes: 2,
            classes: vec!["a".into(), "b".into()],
            final_train_acc: 0.9,
            final_val_acc: f32::NAN,
        };
        let v = serde_json::to_value(&result).expect("TrainingResult serialises");
        assert!(
            v["final_val_acc"].is_null(),
            "TrainingResult::final_val_acc NaN -> null",
        );
    }

    /// NaN `val_acc` / `best_val_acc` serialise to JSON `null`
    /// (not the spec-violating `NaN` literal serde_json refuses
    /// by default).  Pinned because `validation_split == 0.0`
    /// runs always emit NaN here and the page reader must not
    /// 500 on a serialise call.
    #[test]
    fn epoch_completed_nan_val_acc_serializes_to_null() {
        let event = TrainEvent::EpochCompleted {
            epoch: 1,
            epochs: 1,
            train_loss: 0.5,
            train_acc: 0.6,
            val_acc: f32::NAN,
            best_val_acc: f32::NAN,
            lr: 0.01,
            elapsed_ms: 100,
        };
        let v = serde_json::to_value(&event).expect("serialize");
        assert_eq!(v["kind"], "epoch_completed");
        assert!(v["val_acc"].is_null(), "NaN val_acc must be JSON null");
        assert!(
            v["best_val_acc"].is_null(),
            "NaN best_val_acc must be JSON null",
        );
    }

    /// `From<finetune::Event> for TrainEvent` lifts each
    /// algorithmic variant 1:1 with no information loss.  Pinned
    /// at the boundary so a future variant added on the
    /// finetune side without a matching arm here surfaces as a
    /// compile error (exhaustive match).
    #[test]
    fn finetune_event_lifts_to_train_event() {
        let inner = finetune::Event::TrainSplit {
            train_n: 80,
            val_n: 20,
        };
        let outer: TrainEvent = inner.into();
        match outer {
            TrainEvent::TrainSplit { train_n, val_n } => {
                assert_eq!(train_n, 80);
                assert_eq!(val_n, 20);
            }
            other => panic!("expected TrainSplit, got {other:?}"),
        }

        let inner = finetune::Event::EpochCompleted {
            epoch: 2,
            epochs: 4,
            train_loss: 0.1,
            train_acc: 0.95,
            val_acc: 0.9,
            best_val_acc: 0.92,
            lr: 0.005,
            elapsed_ms: 333,
        };
        let outer: TrainEvent = inner.into();
        match outer {
            TrainEvent::EpochCompleted {
                epoch, epochs, lr, ..
            } => {
                assert_eq!(epoch, 2);
                assert_eq!(epochs, 4);
                assert!((lr - 0.005).abs() < f32::EPSILON);
            }
            other => panic!("expected EpochCompleted, got {other:?}"),
        }
    }

    /// `fail_payload_from_error` discriminates each
    /// `TrainingError` / `FinetuneError` variant onto its typed
    /// `FailPayload` shape.  Pinned for the high-leverage
    /// operator-fixable variants the frontend renders distinct
    /// copy / actions for.
    #[test]
    fn fail_payload_lifts_each_error_variant() {
        // BadDataset → BadDataset
        let err = TrainingError::BadDataset {
            path: "/ws/datasets".into(),
            reason: "no class folders".into(),
        };
        match fail_payload_from_error(&err) {
            FailPayload::BadDataset { path, reason } => {
                assert_eq!(path, "/ws/datasets");
                assert_eq!(reason, "no class folders");
            }
            other => panic!("expected BadDataset, got {other:?}"),
        }

        // EmptyClassAfterScan → EmptyClass with per-class table
        let err = TrainingError::Finetune(finetune::FinetuneError::EmptyClassAfterScan {
            class: "cat".into(),
            per_class_kept: vec![("cat".into(), 0), ("dog".into(), 5)],
        });
        match fail_payload_from_error(&err) {
            FailPayload::EmptyClass {
                class,
                per_class_kept,
            } => {
                assert_eq!(class, "cat");
                assert_eq!(per_class_kept.len(), 2);
            }
            other => panic!("expected EmptyClass, got {other:?}"),
        }

        // DropRatioExceeded → DropRatioExceeded with full table
        let err = TrainingError::Finetune(finetune::FinetuneError::DropRatioExceeded {
            dropped: 30,
            total: 100,
            ratio: 0.30,
            max_ratio: 0.1,
            per_class_kept: vec![("cat".into(), 35), ("dog".into(), 35)],
            per_class_dropped: vec![("cat".into(), 15), ("dog".into(), 15)],
        });
        match fail_payload_from_error(&err) {
            FailPayload::DropRatioExceeded {
                dropped,
                total,
                threshold,
                per_class_kept,
                per_class_dropped,
            } => {
                assert_eq!(dropped, 30);
                assert_eq!(total, 100);
                assert!((threshold - 0.1).abs() < f32::EPSILON);
                assert_eq!(per_class_kept.len(), 2);
                assert_eq!(per_class_dropped.len(), 2);
            }
            other => panic!("expected DropRatioExceeded, got {other:?}"),
        }

        // Internal `Io` → Io with path + detail
        let err = TrainingError::Io {
            path: "/ws/.tmp".into(),
            source: std::io::Error::other("disk full"),
        };
        match fail_payload_from_error(&err) {
            FailPayload::Io { path, detail } => {
                assert_eq!(path, "/ws/.tmp");
                assert!(detail.contains("disk full"));
            }
            other => panic!("expected Io, got {other:?}"),
        }

        // Severity classifier: BadDataset → operator_fixable;
        // Io → internal.
        let bad = TrainingError::BadDataset {
            path: "x".into(),
            reason: "y".into(),
        };
        assert_eq!(severity_from_error(&bad), Severity::OperatorFixable);
        let io = TrainingError::Io {
            path: "x".into(),
            source: std::io::Error::other("y"),
        };
        assert_eq!(severity_from_error(&io), Severity::Internal);
    }
}
