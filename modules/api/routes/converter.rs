//! `POST /workspace/{id}/convert` -- producer for the head-extraction
//! convert pipeline.  The route validates the request, snapshots
//! workspace revision, resolves each converter-rooted input path on
//! the blocking pool, takes a `Workspace` job-reference (so a
//! concurrent `WorkspaceDelete` is excluded but uploads and
//! file-deletes overlap freely), allocates the destination
//! `head_id`, then spawns the conversion and returns
//! `{head_id, job_id}` immediately.  Convert concurrency is bounded
//! by the `max_convert_jobs` semaphore acquired before admission.

use std::path::PathBuf;
use std::sync::Arc;

use crate::common::asset_path::AssetPath;
use crate::common::ids::{HeadId, WorkspaceId};
use crate::common::workspace::{JobReference, JobType, WorkspaceRevision};
use crate::file_mgr::{
    ConvertRequest, ConverterPath, FsService, JobRegistry, validate_convert_request,
};
use axum::Router;
use axum::extract::{Path, State};
use axum::response::Json;
use axum::routing::post;
use serde::Serialize;
use tokio::task;

use crate::api::AppState;
use crate::api::error::ApiError;
use crate::api::extract::ApiJson;

/// SHA-256 hex helper kept `pub(crate)` so the dataset-upload
/// streaming tests can verify the production digest against an
/// independent hash.  Test-only today; the `allow(dead_code)`
/// keeps non-test builds clippy-clean.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let d = sha2::Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Producer response: the daemon-allocated identifiers the caller
/// uses to follow progress through `converter_logs/<job_id>.jsonl`
/// and the `/jobs/{job_id}` SSE stream.
#[derive(Debug, Serialize)]
struct ConvertStartResp {
    /// Pre-allocated head id stable across the job lifetime; the
    /// index entry is committed only after `publish_trained_head`
    /// returns successfully.
    head_id: String,
    job_id: String,
}

/// Resolve a converter-rooted input to its on-disk path, promoting
/// ENOENT to 404 and rejecting non-regular files (dir/symlink) as 400.
fn resolve_converter_input(
    files: &Arc<dyn FsService>,
    workspace_id: &WorkspaceId,
    path: &AssetPath,
) -> Result<PathBuf, ApiError> {
    let (resolved, md) = files.open_workspace_file(workspace_id, path).map_err(|e| {
        use std::error::Error as _;
        let is_not_found = e
            .source()
            .and_then(|s| s.downcast_ref::<crate::file_mgr::FileError>())
            .map(|fe| {
                matches!(
                    fe,
                    crate::file_mgr::FileError::Io { source, .. }
                        if source.kind() == std::io::ErrorKind::NotFound
                )
            })
            .unwrap_or(false);
        if is_not_found {
            ApiError::NotFound(format!(
                "convert input not found: /{}",
                strip_converter_prefix(path)
            ))
        } else {
            ApiError::from(e)
        }
    })?;
    if !md.is_file() {
        return Err(ApiError::Bad(format!(
            "convert input /{} is not a regular file",
            strip_converter_prefix(path),
        )));
    }
    Ok(resolved)
}

/// Render a `converters/<sub>` workspace-rooted path back to the
/// wire-form `<sub>` for operator-facing diagnostics only.
fn strip_converter_prefix(path: &AssetPath) -> &str {
    path.as_str()
        .strip_prefix("converters/")
        .expect("converter input path starts with converters/")
}

/// Derive every TFJS shard file's converter-rooted
/// [`AssetPath`] from the operator-supplied `model.json` path
/// + the parsed `weightsManifest[].paths` list.
///
/// Convention: TFJS bundles ship `model.json` next to its
/// shard files; the manifest's `paths` are sibling-relative
/// (no traversal, no absolute paths) per the TFJS exporter
/// contract.  The frontend uploads everything flat under
/// `converters/tfjs/<timestamp>/`, so the derived paths
/// resolve to the operator's uploaded files; any external
/// client following the same "model.json beside its shards"
/// convention round-trips too.
///
/// ## Safety
///
/// Three invariants make the derivation traversal-safe:
///   1. The model.json's parent string is AssetPath-clean
///      (validated by [`ConverterPath::parse`] at deserialize).
///   2. The shard relative paths went through the converter's
///      `validate_shard_path` inside `parse_tfjs_manifest_with_
///      limits` -- rejects absolute paths, `..`, `\`, NUL.
///   3. The derived absolute string is re-parsed via
///      [`AssetPath::parse`] as belt-and-suspenders, so a
///      future weakening of either invariant surfaces as a
///      typed 400 here instead of slipping past the daemon's
///      allowlist.
fn derive_tfjs_shard_asset_paths(
    model_json_path: &ConverterPath,
    relative_shards: &[String],
) -> Result<Vec<AssetPath>, ApiError> {
    let manifest_str = model_json_path.workspace_path().as_str();
    // Strip the final filename component to get the parent
    // directory string.  `ConverterPath` guarantees >= 2
    // components (`converters/<sub>`); the `None` arm stays as
    // a defensive fallback if that invariant ever weakens.
    let parent = manifest_str
        .rsplit_once('/')
        .map(|(p, _)| p)
        .ok_or_else(|| {
            ApiError::Bad(format!(
                "TFJS model_json path has no parent directory: {manifest_str}"
            ))
        })?;
    let mut out = Vec::with_capacity(relative_shards.len());
    for shard in relative_shards {
        let derived = format!("{parent}/{shard}");
        let asset = AssetPath::parse(&derived).map_err(|e| {
            ApiError::Bad(format!(
                "TFJS derived shard path is malformed ({derived}): {e}"
            ))
        })?;
        out.push(asset);
    }
    Ok(out)
}

/// Derive the `.alpkg` weights file's converter-rooted [`AssetPath`]
/// from the operator-supplied manifest path + the manifest's
/// `head_id`.
///
/// Convention: `<parent>/<head_id>.mpk` -- the `.mpk` always lives
/// next to its manifest under the same directory, named after the
/// head_id.  The frontend's import orchestrator writes both files
/// under `converters/alpkg/<head_id>/{<head_id>.json,<head_id>.mpk}`
/// so the derived path resolves to a file the operator just
/// uploaded; any external client following the same convention
/// round-trips too.
///
/// ## Safety
///
/// Two invariants make the derivation traversal-safe by
/// construction:
///   1. The parent component string is already AssetPath-clean
///      because [`ConverterPath::parse`] validated the input at
///      deserialize.  Re-using the parent slice cannot introduce
///      `..` or NUL bytes.
///   2. `head_id`'s [`Display`] impl emits a UUID
///      (`[0-9a-f-]` only), which is allowlist-clean for AssetPath
///      components AND has no leading `.`.  Appending it as
///      `<head_id>.mpk` is always safe.
///
/// Belt-and-suspenders: the result is re-parsed via
/// [`AssetPath::parse`] so a future change to either invariant
/// surfaces as a typed 400 here instead of slipping past the
/// daemon-side allowlist.
fn derive_alpkg_mpk_asset_path(
    manifest_path: &ConverterPath,
    head_id: HeadId,
) -> Result<AssetPath, ApiError> {
    let manifest_str = manifest_path.workspace_path().as_str();
    // Strip the final filename component to get the parent
    // directory string.  `ConverterPath` guarantees the path
    // starts with `converters/<sub>` (>= 2 components), so
    // `rsplit_once('/')` always succeeds; the `None` arm is
    // defensive against a future ConverterPath invariant
    // weakening.
    let parent = manifest_str
        .rsplit_once('/')
        .map(|(p, _)| p)
        .ok_or_else(|| {
            ApiError::Bad(format!(
                "alpkg manifest path has no parent directory: {manifest_str}"
            ))
        })?;
    let derived = format!("{parent}/{head_id}.mpk");
    AssetPath::parse(&derived).map_err(|e| {
        ApiError::Bad(format!(
            "alpkg derived weights path is malformed ({derived}): {e}"
        ))
    })
}

/// Read + parse the operator-uploaded alpkg manifest just enough
/// to extract its [`HeadId`].  The synchronous convert-start
/// response echoes this id, so it must be resolved before the
/// worker spawns; IO or JSON-parse failures here surface as 400
/// (operator-input fault).  The convert worker re-reads + fully
/// structurally validates the manifest later -- this read is
/// purely for the identity field.
fn read_alpkg_head_id_from_manifest_file(
    manifest_path: &std::path::Path,
) -> Result<HeadId, ApiError> {
    let manifest_bytes = std::fs::read(manifest_path).map_err(|e| {
        ApiError::Bad(format!(
            "alpkg manifest read failed: {}: {}",
            manifest_path.display(),
            e
        ))
    })?;
    let manifest: crate::common::workspace::HeadManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| {
            ApiError::Bad(format!(
                "alpkg manifest JSON parse failed: {}: {}",
                manifest_path.display(),
                e
            ))
        })?;
    Ok(manifest.head_id)
}

async fn start_convert(
    State(files): State<Arc<dyn FsService>>,
    State(jobs): State<Arc<JobRegistry>>,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<ConvertRequest>,
) -> Result<Json<ConvertStartResp>, ApiError> {
    let workspace_id = WorkspaceId::parse(&id)?;
    // Path traversal was rejected at deserialize via ConverterPath; this
    // pass enforces only cardinality (shards >= 1, <= MAX_CONVERT_SHARDS).
    validate_convert_request(&req).map_err(|e| ApiError::Bad(e.to_string()))?;

    // Workspace existence + revision snapshot + per-file regular-file
    // resolution all happen on the blocking pool so the runtime stays
    // free under eMMC pressure.  For `Alpkg` the blocking phase also
    // reads + parses the manifest so the synchronous response can
    // echo the manifest-supplied `head_id` -- the only converter type
    // where the head id is operator-supplied rather than daemon-
    // allocated.
    let files_for_resolve = files.clone();
    let req_for_resolve = req.clone();
    let (workspace_revision, job_kind, head_id): (
        WorkspaceRevision,
        crate::converter::ConvertJobKind,
        HeadId,
    ) = task::spawn_blocking(move || -> Result<_, ApiError> {
        let summary = files_for_resolve
            .summary(&workspace_id)
            .map_err(ApiError::from)?;
        let rev = summary.core.workspace_revision.clone();
        match &req_for_resolve {
            ConvertRequest::Tfjs(params) => {
                // Resolve model.json + labels first; both are
                // operator-named paths and surface 404/400 here
                // if missing.
                let model_json = resolve_converter_input(
                    &files_for_resolve,
                    &workspace_id,
                    params.model_json_path.workspace_path(),
                )?;
                let labels = resolve_converter_input(
                    &files_for_resolve,
                    &workspace_id,
                    params.labels_path.workspace_path(),
                )?;
                // Parse model.json to extract the shard list -- the
                // operator no longer enumerates them; the manifest's
                // `weightsManifest[].paths` is the single source of
                // truth.  See `derive_tfjs_shard_asset_paths` for
                // the safety + convention rationale.  A parse
                // failure here surfaces synchronously as 400 vs.
                // deferring it to the worker's `failed` SSE
                // terminal.
                let model_json_bytes = std::fs::read(&model_json).map_err(|e| {
                    ApiError::Bad(format!(
                        "TFJS model.json read failed: {}: {}",
                        model_json.display(),
                        e
                    ))
                })?;
                let parsed_manifest = crate::converter::parse_tfjs_manifest_with_limits(
                    &model_json_bytes,
                    &crate::converter::ConvertLimits::default(),
                )
                .map_err(|e| {
                    ApiError::Bad(format!(
                        "TFJS model.json parse failed: {}: {}",
                        model_json.display(),
                        e
                    ))
                })?;
                let shard_asset_paths = derive_tfjs_shard_asset_paths(
                    &params.model_json_path,
                    &parsed_manifest.shards,
                )?;
                let mut shards: Vec<PathBuf> = Vec::with_capacity(shard_asset_paths.len());
                for shard in &shard_asset_paths {
                    shards.push(resolve_converter_input(
                        &files_for_resolve,
                        &workspace_id,
                        shard,
                    )?);
                }
                let kind =
                    crate::converter::ConvertJobKind::Tfjs(crate::converter::ConvertJobTfjs {
                        model_json_path: model_json,
                        shard_paths: shards,
                        labels_path: labels,
                        labels_format: params.labels_format,
                    });
                // Daemon-allocated head_id for TFJS: the published
                // head's identity is established here.
                Ok((rev, kind, HeadId::new()))
            }
            ConvertRequest::Alpkg(params) => {
                // Single-path request: the operator only names the
                // `.json` manifest; we resolve it, peek inside for
                // the `head_id`, then DERIVE the sibling `.mpk`
                // path via the `<parent>/<head_id>.mpk` convention.
                // See `derive_alpkg_mpk_asset_path` for the safety
                // rationale; the derivation is traversal-safe by
                // construction.
                let manifest_path = resolve_converter_input(
                    &files_for_resolve,
                    &workspace_id,
                    params.manifest_path.workspace_path(),
                )?;
                let head_id = read_alpkg_head_id_from_manifest_file(&manifest_path)?;
                // Derive + resolve the sibling `.mpk`.  Resolution
                // through `resolve_converter_input` enforces
                // "exists + is regular file" with the same
                // 404 / 400 mapping the manifest path went through,
                // so the operator sees the right error if they
                // forgot to upload the `.mpk` alongside the
                // manifest (or named it differently from the
                // `<head_id>.mpk` convention).
                let mpk_asset_path = derive_alpkg_mpk_asset_path(&params.manifest_path, head_id)?;
                let mpk_path =
                    resolve_converter_input(&files_for_resolve, &workspace_id, &mpk_asset_path)?;
                let kind =
                    crate::converter::ConvertJobKind::Alpkg(crate::converter::ConvertJobAlpkg {
                        mpk_path,
                        manifest_path,
                    });
                Ok((rev, kind, head_id))
            }
        }
    })
    .await??;

    // Single-tenant by design (`max_convert_jobs = 1`); a second
    // concurrent request gets `ConvertError::Busy` -> 409 here, before
    // any job-reference lease is taken.
    let convert_permit = crate::converter::acquire_convert_permit()?;

    // The registry-allocated job id is reused for the JSONL log
    // filename so operators can correlate `GET /jobs` and the on-disk
    // log by id.  The single Workspace reference excludes only
    // `WorkspaceDelete`; uploads and file-deletes overlap freely.
    let job_handle = jobs
        .try_acquire(
            JobType::Convert,
            vec![JobReference::Workspace { workspace_id }],
            None,
        )
        .map_err(|c| ApiError::File(crate::file_mgr::FileError::from(c)))?;
    let job_id = job_handle.job_id();

    let files_for_worker = files.clone();
    let job = crate::converter::ConvertJob {
        job_id,
        workspace_id,
        head_id,
        workspace_revision,
        kind: job_kind,
    };
    tokio::task::spawn_blocking(move || {
        // Permit moves into the worker so the slot stays held until
        // the job terminates.  `JobHandle` moves into
        // `run_convert_job` too: the worker fans the typed
        // `ConvertEvent` stream through it (rich SSE payloads
        // for every stage transition) AND consumes it at
        // terminal via the internal `handle.succeed` /
        // `handle.fail` calls.  The route is now thin: it logs
        // a terminal-error breadcrumb and lets the worker own
        // both the registry transition and the JSONL trace.
        let _convert_permit = convert_permit;
        if let Err(e) = crate::converter::run_convert_job(files_for_worker, job, Some(job_handle)) {
            tracing::warn!(
                target: "converter",
                job_id = %job_id,
                workspace_id = %workspace_id,
                err = %e,
                "convert job failed",
            );
        }
    });

    Ok(Json(ConvertStartResp {
        head_id: head_id.to_string(),
        job_id: job_id.to_string(),
    }))
}

pub fn router() -> Router<AppState> {
    Router::new().route("/workspace/{id}/convert", post(start_convert))
}
