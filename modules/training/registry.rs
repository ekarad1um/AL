//! `TrainingRegistry` trait + production
//! [`JobRegistry`] impl.  Held by the api crate as
//! `Arc<dyn TrainingRegistry>`; tests substitute mocks
//! without touching the in-process job machinery.
//!
//! ## Trait location
//!
//! Colocates with [`JobRegistry`] and the training DTOs so the
//! trait sits next to its DTO references.  Lifting into
//! `crate::common::traits` would force `common` to re-export
//! `TrainingJob`, `JobView`, `TrainingError`, etc. -- wide
//! surface for zero architectural benefit; the api crate already
//! imports `training` for those DTOs.
//!
//! ## Object safety
//!
//! Every method takes concrete params + returns concrete
//! `Result<_, TrainingError>` -- no generics, no `Self:
//! Sized`.  `Arc<dyn TrainingRegistry>` is constructible.

use crate::common::ids::{JobId, WorkspaceId};
use crate::file_mgr::{FsService, JobHandle};
use crate::training::{JobRegistry, JobView, TrainingError, TrainingJob};
use std::sync::Arc;

/// Submit + observe + cancel in-process training jobs.
/// Production impl: [`JobRegistry`] (DashMap-backed).
///
/// Admission against `max_train_jobs = 1` is enforced by the
/// cross-cutting [`crate::file_mgr::JobRegistry`] via
/// `register_train_job` at the api boundary; the resulting
/// [`JobHandle`] is passed through `spawn` so the worker can
/// fan typed events out to the SSE bridge and consume the
/// handle at terminal.
pub trait TrainingRegistry: Send + Sync + std::fmt::Debug {
    /// Submit a training job.  Validates the wire `TrainingCfg`
    /// (defence-in-depth — the api route already validated)
    /// and registers the job in the in-memory map; the actual
    /// training runs on a `spawn_blocking` worker.
    ///
    /// `job_handle` is the cross-cutting [`JobHandle`] obtained
    /// from `FsService::register_train_job`.  When `Some`, the
    /// worker bridges typed events into the `/jobs` + SSE
    /// surface and consumes the handle at terminal.  When
    /// `None` (test-only path), the worker still writes the
    /// JSONL backstop and surfaces state via
    /// `/workspace/{id}/training/{job}` but no `/jobs`-side
    /// snapshot is created.
    fn spawn(
        &self,
        files: Arc<dyn FsService>,
        job: TrainingJob,
        job_handle: Option<JobHandle>,
    ) -> Result<JobId, TrainingError>;

    /// Cancel an in-flight job.  The training task observes
    /// the cancel flag at its next progress emit and exits;
    /// the result is reported as
    /// [`crate::training::JobState::Cancelled`].
    fn cancel(&self, workspace_id: &WorkspaceId, job_id: JobId) -> Result<(), TrainingError>;

    /// Read one job's view by `(workspace, job_id)`.
    fn status(&self, workspace_id: &WorkspaceId, job_id: JobId) -> Result<JobView, TrainingError>;

    /// All jobs registered against `workspace_id`.
    fn list_for_workspace(&self, workspace_id: &WorkspaceId) -> Vec<JobView>;

    /// Set the cancel flag on every running job.  Daemon's
    /// drain registry uses this as a pre-drain hook so blocking
    /// trainers observe shutdown immediately.  Returns the
    /// number of jobs whose flag was newly set.
    fn cancel_all_for_shutdown(&self) -> usize;

    /// Number of jobs currently running.  Surfaced through the
    /// `training` heartbeat so `/api/v1/status` distinguishes
    /// "idle" from "running" from "cancelling N jobs".
    fn active_count(&self) -> usize;
}

impl TrainingRegistry for JobRegistry {
    fn spawn(
        &self,
        files: Arc<dyn FsService>,
        job: TrainingJob,
        job_handle: Option<JobHandle>,
    ) -> Result<JobId, TrainingError> {
        JobRegistry::spawn(self, files, job, job_handle)
    }
    fn cancel(&self, workspace_id: &WorkspaceId, job_id: JobId) -> Result<(), TrainingError> {
        JobRegistry::cancel(self, workspace_id, job_id)
    }
    fn status(&self, workspace_id: &WorkspaceId, job_id: JobId) -> Result<JobView, TrainingError> {
        JobRegistry::status(self, workspace_id, job_id)
    }
    fn list_for_workspace(&self, workspace_id: &WorkspaceId) -> Vec<JobView> {
        JobRegistry::list_for_workspace(self, workspace_id)
    }
    fn cancel_all_for_shutdown(&self) -> usize {
        JobRegistry::cancel_all_for_shutdown(self)
    }
    fn active_count(&self) -> usize {
        JobRegistry::active_count(self)
    }
}

// Object-safety smoke.
#[cfg(test)]
const _: fn() = || {
    fn assert_obj_safe<T: ?Sized>() {}
    assert_obj_safe::<dyn TrainingRegistry>();
};
