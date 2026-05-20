//! Request-payload contracts for `POST .../train` and
//! `POST .../convert`.
//!
//! # Wire shape
//!
//! - **Train body** is the flattened [`TrainingCfg`] (no wrapper, no
//!   `dataset_path`).  The trainer always walks the fixed
//!   `<workspace>/datasets/` root.  [`TrainRequest`] is preserved
//!   as a type alias for source-level continuity.
//! - **Convert body** is internally tagged on `converter_type`;
//!   each variant validates its own fields with
//!   `deny_unknown_fields`.  Per-converter file paths are
//!   converter-rooted (e.g. `tfjs/model.json` resolves to
//!   `<workspace>/converters/tfjs/model.json`).  A legacy leading
//!   `/` is accepted and stripped for one release (BC shim);
//!   canonical wire form drops it.
//!
//! # Validation
//!
//! - `deny_unknown_fields` rejects stray request keys.
//! - [`AssetPath`] runs at deserialize time on every plain path
//!   field; [`ConverterPath`] runs on every converter-rooted path
//!   (optional leading `/`, non-empty tail, per-component
//!   allowlist).
//! - [`validate_training_cfg`] / [`validate_convert_request`] add
//!   numeric / cardinality range gates the type system cannot
//!   express.
//!
//! # Persistence
//!
//! Training config is not persisted on the head manifest.  The
//! [`canonical_training_cfg_sha256`] / [`from_manifest_value`] /
//! [`to_manifest_value`] helpers remain useful for diagnostics +
//! replay tooling but no daemon-owned bytes consume them today.

use crate::common::asset_path::{AssetPath, AssetPathError};
use crate::common::error::{Categorized, ErrorKind};
use crate::file_mgr::error::{FileError, metadata_parse_err};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

// MARK: TrainRequest / TrainingCfg

/// Type alias kept so callers that still import `TrainRequest`
/// keep compiling; equality / serde flow through to [`TrainingCfg`].
pub type TrainRequest = TrainingCfg;

/// Operator-tunable training hyperparameters carried in the
/// `POST /workspace/{id}/train` body.  Field-by-field bounds
/// enforced by [`validate_training_cfg`].
///
/// Not `Eq` because [`Self::learning_rate`] is `f32`; equality /
/// hash callers compare via canonical SHA-256
/// ([`canonical_training_cfg_sha256`]) instead.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrainingCfg {
    /// Number of training epochs.  Bounds: `1..=1_000`.
    pub epochs: u32,
    /// Mini-batch size in samples.  Bounds: `1..=4_096`.
    pub batch_size: u32,
    /// Optimizer learning rate.  Bounds: finite, `0.0 < lr <= 1.0`.
    pub learning_rate: f32,
    /// Optional deterministic-seed override.  `None` lets the daemon
    /// pick a seed (per-job entropy); `Some(_)` pins replay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    /// Per-class fraction held out for validation.  Bounds:
    /// finite, `0.0 <= split < 1.0` (default `0.0`).
    ///
    /// When `0.0`, the trainer uses the full dataset and the
    /// published head is the last-epoch snapshot.  When in
    /// `(0.0, 1.0)`, the trainer performs a stratified per-class
    /// deterministic split and publishes the best-val-loss epoch.
    /// Per-class clamping guarantees at least one train and one
    /// val sample per class when enabled; singleton classes are
    /// rejected with a structured error.
    #[serde(default)]
    pub validation_split: f32,
}

// MARK: ConverterPath

/// Failure shapes for [`ConverterPath::parse`].  All variants
/// classify as `UserInput` (400).
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ConverterPathError {
    /// Empty input or `/` alone -- a converter request must name
    /// an actual file under `<workspace>/converters/`.
    #[error("converter path is empty")]
    Empty,
    /// The component-level validator on the (optionally
    /// slash-stripped) input rejected the path -- traversal, NUL,
    /// depth, length, etc.
    #[error("converter path invalid: {0}")]
    Invalid(#[from] AssetPathError),
}

impl Categorized for ConverterPathError {
    fn kind(&self) -> ErrorKind {
        ErrorKind::UserInput
    }
}

/// Operator-supplied path identifying a regular file under a
/// workspace's daemon-owned `<workspace>/converters/` tree.
/// Canonical wire form is `<sub>` (no leading slash); a single
/// legacy leading `/` is accepted via a one-release BC shim.
/// Internally stored as the workspace-rooted [`AssetPath`]
/// `converters/<sub>` so resolvers get a typed handle that
/// already carries the tree-root component.  Serialize emits
/// the canonical slashless form regardless of which input
/// variant the parser saw.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ConverterPath {
    workspace_relative: AssetPath,
}

impl ConverterPath {
    /// Parse a converter-rooted path.  Strips an optional legacy
    /// leading `/` (BC shim, slated for removal next release),
    /// rejects empty input, then validates the remainder via the
    /// shared [`AssetPath`] component allowlist after prepending
    /// `converters/`.
    pub fn parse(input: &str) -> Result<Self, ConverterPathError> {
        let stripped = input.strip_prefix('/').unwrap_or(input);
        if stripped.is_empty() {
            return Err(ConverterPathError::Empty);
        }
        let mut combined = String::with_capacity("converters/".len() + stripped.len());
        combined.push_str("converters/");
        combined.push_str(stripped);
        let workspace_relative = AssetPath::parse(&combined)?;
        Ok(Self { workspace_relative })
    }

    /// Workspace-rooted [`AssetPath`] (`converters/<sub>`); pass
    /// directly to `FsService::workspace_asset_path` /
    /// `FsService::open_workspace_file`.
    pub fn workspace_path(&self) -> &AssetPath {
        &self.workspace_relative
    }

    /// Canonical wire-form string -- the converter-rooted sub-path
    /// with no leading slash (`tfjs/model.json`).  Used for
    /// round-trip serialization and operator-facing diagnostics.
    pub fn wire_form(&self) -> String {
        self.workspace_relative
            .as_str()
            .strip_prefix("converters/")
            .expect("ConverterPath invariant: workspace path starts with converters/")
            .to_owned()
    }
}

impl std::fmt::Display for ConverterPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.wire_form())
    }
}

impl TryFrom<String> for ConverterPath {
    type Error = ConverterPathError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl TryFrom<&str> for ConverterPath {
    type Error = ConverterPathError;
    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl std::str::FromStr for ConverterPath {
    type Err = ConverterPathError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl From<ConverterPath> for String {
    fn from(p: ConverterPath) -> Self {
        p.wire_form()
    }
}

// MARK: ConvertRequest / LabelsFormat

/// `POST /workspace/{id}/convert` request body: internally
/// tagged on `converter_type`, each variant carries the
/// converter-specific param struct.  Per-variant
/// `deny_unknown_fields` rejects stray keys after dispatch; every
/// field that names a file is converter-rooted and serialized in
/// canonical slashless form.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "converter_type", rename_all = "snake_case")]
pub enum ConvertRequest {
    /// TFJS bundle conversion.
    Tfjs(TfjsConvertParams),
    /// `.alpkg` head import.  Operator-uploaded `.mpk` +
    /// `.json` pair (the daemon's own export format) is
    /// verified + published as a head via the same rotation
    /// primitive training uses.  See
    /// [`crate::common::workspace::ConverterType::Alpkg`] for
    /// the pipeline narrative.
    Alpkg(AlpkgParams),
}

impl ConvertRequest {
    /// Selected converter discriminator -- handy for log /
    /// diagnostic output without matching the variant payload.
    pub fn converter_type(&self) -> crate::common::workspace::ConverterType {
        match self {
            ConvertRequest::Tfjs(_) => crate::common::workspace::ConverterType::Tfjs,
            ConvertRequest::Alpkg(_) => crate::common::workspace::ConverterType::Alpkg,
        }
    }
}

/// TFJS-specific convert payload.  Both path fields are
/// [`ConverterPath`]s (rooted under `<workspace>/converters/`);
/// `deny_unknown_fields` rejects any stray key after the
/// `converter_type = "tfjs"` dispatch.
///
/// ## Shard derivation
///
/// The shard file list is derived on the daemon side, not
/// supplied by the operator.  `model.json`'s
/// `weightsManifest[].paths` already names every shard as a
/// path relative to the model.json directory, so the convert
/// route parses it, prepends the model.json's parent, and
/// resolves each derived path through the same converter input
/// pipeline the operator-named fields go through.  Safety:
/// each derived shard is re-validated via [`AssetPath::parse`]
/// (rejects path traversal, NUL bytes, allowlist violations);
/// see the route's `derive_tfjs_shard_asset_paths` helper for
/// the full rationale.  Operators only name the manifest +
/// labels file; shards "come along" with the manifest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TfjsConvertParams {
    /// Converter-rooted path to `model.json` (the TFJS
    /// manifest the converter parses).  Its embedded
    /// `weightsManifest[].paths` drives the shard discovery
    /// described in the type-level docstring.
    pub model_json_path: ConverterPath,
    /// Converter-rooted path to the labels source.
    pub labels_path: ConverterPath,
    /// Encoding of [`Self::labels_path`].
    pub labels_format: LabelsFormat,
}

/// On-disk encoding of the converter's labels source.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelsFormat {
    /// `labels.txt` -- one label per line, blank lines stripped.
    Lines,
    /// TFJS `metadata.json` carrying labels under `wordLabels`
    /// (Teachable Machine) or `words` (upstream Speech-Commands).
    TfjsMetadata,
}

/// `.alpkg`-import convert payload.  Single-path shape: the
/// operator only names the `.json` manifest, and the daemon
/// derives the sibling `.mpk` from `<parent>/<head_id>.mpk`
/// where `<head_id>` comes from the manifest itself.  The
/// `head_id` is a UUID (`[0-9a-f-]` only -- always AssetPath-
/// allowlist-clean) and the parent is already validated by
/// [`ConverterPath::parse`], so the derived path is safe by
/// construction; the route re-parses through [`AssetPath`] as
/// belt-and-suspenders.
///
/// The frontend's import orchestrator uploads both files under
/// `converters/alpkg/<head_id>/{<head_id>.json,<head_id>.mpk}`
/// so the convention "manifest's sibling named after the
/// head_id" holds round-trip.  Any other client that follows
/// the same convention (manifest + sibling `.mpk` named after
/// the manifest's declared head_id) round-trips too.
///
/// The convert worker reads the manifest, structurally
/// validates it, stream-verifies the `.mpk` bytes against the
/// manifest's `size_bytes` and `sha256`, and -- on success
/// with no `head_id` collision in the destination workspace
/// -- publishes the head via the rotation primitive.  A re-
/// import of an already-present `head_id` is an idempotent
/// no-op when the `sha256` also matches, or a 409
/// `head_id_collision` when the `sha256` differs (operator
/// must delete the existing head before re-importing a
/// divergent version).  `deny_unknown_fields` rejects any
/// stray key after the `converter_type = "alpkg"` dispatch.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AlpkgParams {
    /// Converter-rooted path to the head's `.json` manifest.
    /// The manifest's `head_id` decides the published head's id
    /// AND drives the daemon's derivation of the sibling
    /// `.mpk` weights file's location (`<parent>/<head_id>.mpk`).
    /// `sha256` from the manifest is the integrity gate the
    /// worker checks against the derived `.mpk`'s actual bytes.
    pub manifest_path: ConverterPath,
}

// MARK: Validation

/// Inclusive lower bound on [`TrainingCfg::epochs`].
pub const MIN_EPOCHS: u32 = 1;
/// Inclusive upper bound on [`TrainingCfg::epochs`].
pub const MAX_EPOCHS: u32 = 1_000;
/// Inclusive lower bound on [`TrainingCfg::batch_size`].
pub const MIN_BATCH_SIZE: u32 = 1;
/// Inclusive upper bound on [`TrainingCfg::batch_size`].
pub const MAX_BATCH_SIZE: u32 = 4_096;
/// Inclusive upper bound on [`TrainingCfg::learning_rate`].  Lower
/// bound is the strict `> 0.0` finiteness check.
pub const MAX_LEARNING_RATE: f32 = 1.0;

/// Structured failure for [`validate_training_cfg`] /
/// [`validate_convert_request`].  Every variant is operator-input;
/// mapped to `400 Bad Request` via [`Categorized`].  Not `Eq`
/// because [`Self::LearningRateOutOfRange`] carries `f32`.
#[derive(Debug, Error, Clone, PartialEq)]
pub enum ValidationError {
    /// Epoch count outside `[MIN_EPOCHS, MAX_EPOCHS]`.
    #[error("epochs out of range: got {got}, allowed {min}..={max}")]
    EpochsOutOfRange {
        /// Observed value.
        got: u32,
        /// Allowed minimum.
        min: u32,
        /// Allowed maximum.
        max: u32,
    },
    /// Batch size outside `[MIN_BATCH_SIZE, MAX_BATCH_SIZE]`.
    #[error("batch_size out of range: got {got}, allowed {min}..={max}")]
    BatchSizeOutOfRange {
        /// Observed value.
        got: u32,
        /// Allowed minimum.
        min: u32,
        /// Allowed maximum.
        max: u32,
    },
    /// Learning rate not finite, `<= 0.0`, or `> MAX_LEARNING_RATE`.
    #[error("learning_rate out of range: got {got}, allowed (0.0, {max}] and finite")]
    LearningRateOutOfRange {
        /// Observed value (rendered with full precision).
        got: f32,
        /// Allowed maximum.
        max: f32,
    },
    /// Validation split not finite, negative, or `>= 1.0`.
    #[error("validation_split out of range: got {got}, allowed [0.0, 1.0) and finite")]
    ValidationSplitOutOfRange {
        /// Observed value (rendered with full precision).
        got: f32,
    },
    /// Alpkg request's `manifest_path` doesn't end in `.json`.
    /// Operator-input hygiene: the converter worker would
    /// fail later when the manifest read returns
    /// non-JSON bytes, but a 400 at the boundary is friendlier
    /// than a generic parse failure deep in the convert job.
    /// The sibling `.mpk` derivation depends on a `.json`
    /// manifest filename to be well-defined.
    #[error("alpkg manifest_path must end in `.json`: got {got}")]
    AlpkgManifestExtension {
        /// Observed converter-rooted path (display form).
        got: String,
    },
}

impl Categorized for ValidationError {
    fn kind(&self) -> ErrorKind {
        ErrorKind::UserInput
    }
}

/// Numeric range validator for [`TrainingCfg`].  Run at the api
/// request boundary AND at trained-head publish time so a
/// hand-crafted manifest (recovered from disk, replayed from a
/// future tool) cannot smuggle out-of-range values past the typed
/// gate.
pub fn validate_training_cfg(cfg: &TrainingCfg) -> Result<(), ValidationError> {
    if !(MIN_EPOCHS..=MAX_EPOCHS).contains(&cfg.epochs) {
        return Err(ValidationError::EpochsOutOfRange {
            got: cfg.epochs,
            min: MIN_EPOCHS,
            max: MAX_EPOCHS,
        });
    }
    if !(MIN_BATCH_SIZE..=MAX_BATCH_SIZE).contains(&cfg.batch_size) {
        return Err(ValidationError::BatchSizeOutOfRange {
            got: cfg.batch_size,
            min: MIN_BATCH_SIZE,
            max: MAX_BATCH_SIZE,
        });
    }
    if !cfg.learning_rate.is_finite()
        || cfg.learning_rate <= 0.0
        || cfg.learning_rate > MAX_LEARNING_RATE
    {
        return Err(ValidationError::LearningRateOutOfRange {
            got: cfg.learning_rate,
            max: MAX_LEARNING_RATE,
        });
    }
    // Half-open `[0.0, 1.0)`: 0.0 disables validation (full
    // dataset → last-epoch head); 1.0 would split off every
    // sample, leaving no training data.  `Range::contains`
    // returns false for NaN and ±∞ (both comparisons short-
    // circuit to false), so the finiteness check is implicit.
    if !(0.0..1.0).contains(&cfg.validation_split) {
        return Err(ValidationError::ValidationSplitOutOfRange {
            got: cfg.validation_split,
        });
    }
    // `seed` is unconstrained: any `u64` is a valid replay seed.
    Ok(())
}

/// Numeric / cardinality validator for [`ConvertRequest`].
/// Dispatches by variant to the per-converter rules; path shape is
/// already enforced by [`ConverterPath`] at deserialize time, so
/// this function only checks bounds the type system cannot express.
///
/// TFJS has no request-level checks today: every operator-supplied
/// path is validated by [`ConverterPath`] at deserialize, the shard
/// list is derived by the route from the parsed model.json (so
/// there's no operator-supplied cardinality to bound here -- the
/// daemon's own DoS gate against pathological shard counts lives
/// inside the converter via `ConvertLimits::max_shards`), and the
/// labels_format is an enum the deserializer already exhausted.
pub fn validate_convert_request(req: &ConvertRequest) -> Result<(), ValidationError> {
    match req {
        ConvertRequest::Tfjs(_params) => Ok(()),
        ConvertRequest::Alpkg(params) => validate_alpkg_params(params),
    }
}

/// File-extension hygiene for [`AlpkgParams`].  Case-sensitive
/// because the daemon's own export emits lowercase `.json`; a
/// non-matching extension is almost certainly a swapped path on
/// the operator side, AND the sibling `.mpk` derivation depends
/// on a `.json` suffix to be well-defined.  `ConverterPath`
/// already enforced the AssetPath allowlist at deserialize, so
/// this check is the only extra guard.
fn validate_alpkg_params(params: &AlpkgParams) -> Result<(), ValidationError> {
    let manifest = params.manifest_path.workspace_path().as_str();
    if !manifest.ends_with(".json") {
        return Err(ValidationError::AlpkgManifestExtension {
            got: manifest.to_string(),
        });
    }
    Ok(())
}

// MARK: Canonical SHA-256

/// Hex-lowercase SHA-256 of the canonical JSON encoding of `cfg`.
///
/// "Canonical" = the fixed serde-derived field order on
/// [`TrainingCfg`] (a stable JSON map ordering today; the type's
/// field order is the contract).  Two calls with values that
/// compare equal under [`PartialEq`] produce the same hash; two
/// JSON inputs that differ only in whitespace / key order produce
/// the same hash (because both round-trip through the typed
/// struct first via [`from_manifest_value`]).  The head schema
/// does not persist this hash on disk; the helper survives for
/// diagnostic fingerprinting (e.g. correlating job logs to a
/// parameter set).
///
/// Returns a canonical hash IFF `cfg` passes
/// [`validate_training_cfg`].  `learning_rate = NaN/inf` is caught
/// in-function (defense in depth) so a stray caller path that
/// skipped pre-validation surfaces a typed `ValidationError`
/// instead of panicking inside `serde_json::to_vec`.
pub fn canonical_training_cfg_sha256(cfg: &TrainingCfg) -> Result<String, ValidationError> {
    validate_training_cfg(cfg)?;
    let bytes = serde_json::to_vec(cfg)
        .expect("validated TrainingCfg serializes infallibly via serde_json::to_vec");
    let digest = Sha256::digest(&bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        write!(&mut out, "{b:02x}").expect("writing to String never fails");
    }
    Ok(out)
}

// MARK: Manifest round-trip helpers

/// Convert a typed [`TrainingCfg`] to an opaque
/// [`serde_json::Value`] carrier.  No on-disk caller today; the
/// helper exists for diagnostic log payloads and future replay
/// tooling.
pub fn to_manifest_value(cfg: &TrainingCfg) -> serde_json::Value {
    serde_json::to_value(cfg).expect("TrainingCfg serializes infallibly to serde_json::Value")
}

/// Parse an opaque [`serde_json::Value`] into the typed
/// [`TrainingCfg`].  Parse failures (unknown fields, missing
/// required fields, type mismatches) surface as
/// [`FileError::MetadataParse`] so any future caller that re-stamps
/// the cfg into a manifest still classifies corruption as
/// daemon-internal (HTTP 500), never operator-input.
pub fn from_manifest_value(value: &serde_json::Value) -> Result<TrainingCfg, FileError> {
    serde_json::from_value(value.clone())
        .map_err(|source| metadata_parse_err("<HeadManifest::training_cfg>", source))
}

// MARK: Tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::error::Categorized;

    fn good_cfg() -> TrainingCfg {
        TrainingCfg {
            epochs: 4,
            batch_size: 16,
            learning_rate: 1e-3,
            seed: Some(42),
            validation_split: 0.0,
        }
    }

    fn good_tfjs_params() -> TfjsConvertParams {
        TfjsConvertParams {
            model_json_path: ConverterPath::parse("/tfjs/model.json").unwrap(),
            labels_path: ConverterPath::parse("/tfjs/metadata.json").unwrap(),
            labels_format: LabelsFormat::TfjsMetadata,
        }
    }

    fn good_convert_request() -> ConvertRequest {
        ConvertRequest::Tfjs(good_tfjs_params())
    }

    // MARK: TrainingCfg / TrainRequest

    #[test]
    fn train_request_round_trips_flat() {
        let body = r#"{"epochs":4,"batch_size":16,"learning_rate":0.001,"seed":42}"#;
        let req: TrainRequest = serde_json::from_str(body).unwrap();
        assert_eq!(req.epochs, 4);
        assert_eq!(req.batch_size, 16);
        assert!((req.learning_rate - 1e-3).abs() < 1e-9);
        assert_eq!(req.seed, Some(42));

        let back = serde_json::to_string(&req).unwrap();
        let v: serde_json::Value = serde_json::from_str(&back).unwrap();
        assert!(v.get("epochs").is_some());
        assert!(v.get("dataset_path").is_none(), "no dataset_path");
        assert!(v.get("training_cfg").is_none(), "no wrapper object");
    }

    #[test]
    fn train_request_seed_is_optional() {
        let body = r#"{"epochs":1,"batch_size":1,"learning_rate":0.5}"#;
        let req: TrainRequest = serde_json::from_str(body).unwrap();
        assert_eq!(req.seed, None);
    }

    #[test]
    fn train_request_rejects_round_1_wrapper_shape() {
        // The legacy `{dataset_path, training_cfg}` shape: both
        // keys are unknown to the flat `TrainingCfg` under
        // `deny_unknown_fields`.
        let body = r#"{"dataset_path":"audio","training_cfg":{"epochs":1,"batch_size":1,"learning_rate":0.001}}"#;
        let res: Result<TrainRequest, _> = serde_json::from_str(body);
        assert!(res.is_err(), "wrapper body must fail to parse");
    }

    #[test]
    fn train_request_rejects_unknown_fields() {
        let body = r#"{"epochs":1,"batch_size":1,"learning_rate":0.001,"momentum":0.9}"#;
        let res: Result<TrainRequest, _> = serde_json::from_str(body);
        assert!(res.is_err(), "stray field must be rejected");
    }

    #[test]
    fn training_cfg_validates_epoch_range() {
        let mut cfg = good_cfg();
        cfg.epochs = 0;
        assert!(matches!(
            validate_training_cfg(&cfg),
            Err(ValidationError::EpochsOutOfRange { .. })
        ));
        cfg.epochs = MAX_EPOCHS + 1;
        assert!(matches!(
            validate_training_cfg(&cfg),
            Err(ValidationError::EpochsOutOfRange { .. })
        ));
        cfg.epochs = MAX_EPOCHS;
        assert!(validate_training_cfg(&cfg).is_ok());
        cfg.epochs = MIN_EPOCHS;
        assert!(validate_training_cfg(&cfg).is_ok());
    }

    #[test]
    fn training_cfg_validates_batch_size_range() {
        let mut cfg = good_cfg();
        cfg.batch_size = 0;
        assert!(matches!(
            validate_training_cfg(&cfg),
            Err(ValidationError::BatchSizeOutOfRange { .. })
        ));
        cfg.batch_size = MAX_BATCH_SIZE + 1;
        assert!(matches!(
            validate_training_cfg(&cfg),
            Err(ValidationError::BatchSizeOutOfRange { .. })
        ));
        cfg.batch_size = MAX_BATCH_SIZE;
        assert!(validate_training_cfg(&cfg).is_ok());
    }

    #[test]
    fn training_cfg_validates_learning_rate_range() {
        let mut cfg = good_cfg();

        cfg.learning_rate = 0.0;
        assert!(matches!(
            validate_training_cfg(&cfg),
            Err(ValidationError::LearningRateOutOfRange { .. })
        ));

        cfg.learning_rate = -1e-3;
        assert!(matches!(
            validate_training_cfg(&cfg),
            Err(ValidationError::LearningRateOutOfRange { .. })
        ));

        cfg.learning_rate = f32::NAN;
        assert!(matches!(
            validate_training_cfg(&cfg),
            Err(ValidationError::LearningRateOutOfRange { .. })
        ));

        cfg.learning_rate = f32::INFINITY;
        assert!(matches!(
            validate_training_cfg(&cfg),
            Err(ValidationError::LearningRateOutOfRange { .. })
        ));

        cfg.learning_rate = MAX_LEARNING_RATE + 1.0;
        assert!(matches!(
            validate_training_cfg(&cfg),
            Err(ValidationError::LearningRateOutOfRange { .. })
        ));

        cfg.learning_rate = MAX_LEARNING_RATE;
        assert!(validate_training_cfg(&cfg).is_ok());

        cfg.learning_rate = 1e-6;
        assert!(validate_training_cfg(&cfg).is_ok());
    }

    #[test]
    fn training_cfg_seed_is_unconstrained() {
        let mut cfg = good_cfg();
        cfg.seed = None;
        assert!(validate_training_cfg(&cfg).is_ok());
        cfg.seed = Some(0);
        assert!(validate_training_cfg(&cfg).is_ok());
        cfg.seed = Some(u64::MAX);
        assert!(validate_training_cfg(&cfg).is_ok());
    }

    // MARK: ConverterPath

    #[test]
    fn converter_path_round_trips_via_serde_string_canonical_form() {
        let p = ConverterPath::parse("tfjs/model.json").unwrap();
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(s, r#""tfjs/model.json""#);
        let back: ConverterPath = serde_json::from_str(&s).unwrap();
        assert_eq!(p, back);
        assert_eq!(p.workspace_path().as_str(), "converters/tfjs/model.json");
        assert_eq!(p.wire_form(), "tfjs/model.json");
    }

    #[test]
    fn converter_path_accepts_legacy_leading_slash_bc_shim() {
        // Both forms must parse to the same `workspace_path` and
        // serialize to the canonical slashless form.
        let p_legacy = ConverterPath::parse("/tfjs/model.json").unwrap();
        let p_canonical = ConverterPath::parse("tfjs/model.json").unwrap();
        assert_eq!(p_legacy, p_canonical);
        assert_eq!(p_legacy.wire_form(), "tfjs/model.json");
        assert_eq!(
            p_legacy.workspace_path().as_str(),
            "converters/tfjs/model.json"
        );
    }

    #[test]
    fn converter_path_rejects_empty_input() {
        // Empty / lone-slash both collapse to empty after the
        // optional strip.
        for bad in ["", "/"] {
            let err = ConverterPath::parse(bad).unwrap_err();
            assert!(
                matches!(err, ConverterPathError::Empty),
                "{bad:?} should reject as Empty; got {err:?}",
            );
            assert_eq!(err.kind(), ErrorKind::UserInput);
        }
    }

    #[test]
    fn converter_path_rejects_traversal_in_either_form() {
        for bad in [
            "..",
            "../etc",
            "a/../b",
            ".hidden/file",
            "/..",
            "/../etc",
            "/a/../b",
            "/.hidden/file",
        ] {
            let res = ConverterPath::parse(bad);
            assert!(res.is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn converter_path_rejects_double_slash() {
        // `//tfjs/...` -> after stripping one leading slash leaves
        // `/tfjs/...` with empty first component; AssetPath
        // rejects empty components.
        let res = ConverterPath::parse("//tfjs/model.json");
        assert!(res.is_err());
    }

    #[test]
    fn converter_path_rejects_url_encoded_traversal() {
        for bad in ["%2E%2E/etc", "/%2E%2E/etc"] {
            let res = ConverterPath::parse(bad);
            assert!(
                res.is_err(),
                "URL-encoded traversal {bad:?} must be rejected"
            );
        }
    }

    // MARK: ConvertRequest

    #[test]
    fn convert_request_round_trips_tfjs() {
        let body = r#"{
            "converter_type": "tfjs",
            "model_json_path": "/tfjs/model.json",
            "labels_path": "/tfjs/metadata.json",
            "labels_format": "tfjs_metadata"
        }"#;
        let req: ConvertRequest = serde_json::from_str(body).unwrap();
        assert_eq!(
            req.converter_type(),
            crate::common::workspace::ConverterType::Tfjs
        );
        let ConvertRequest::Tfjs(p) = &req else {
            panic!("expected ConvertRequest::Tfjs");
        };
        assert_eq!(p.labels_format, LabelsFormat::TfjsMetadata);
        assert_eq!(
            p.model_json_path.workspace_path().as_str(),
            "converters/tfjs/model.json",
        );
        validate_convert_request(&req).expect("good shape");

        let serialized = serde_json::to_string(&req).unwrap();
        let v: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(v["converter_type"], "tfjs");
        // Serialize emits the canonical (slashless) form even when
        // the parser saw the legacy leading slash.
        assert_eq!(v["model_json_path"], "tfjs/model.json");
    }

    #[test]
    fn convert_request_rejects_unknown_converter_type() {
        let body = r#"{
            "converter_type": "onnx",
            "model_json_path": "/m",
            "labels_path": "/l",
            "labels_format": "lines"
        }"#;
        let res: Result<ConvertRequest, _> = serde_json::from_str(body);
        assert!(res.is_err(), "unknown converter_type must be rejected");
    }

    #[test]
    fn convert_request_rejects_missing_converter_type() {
        // Legacy flat shape with no discriminator.
        let body = r#"{
            "model_json_path": "/tfjs/model.json",
            "labels_path": "/tfjs/metadata.json",
            "labels_format": "tfjs_metadata"
        }"#;
        let res: Result<ConvertRequest, _> = serde_json::from_str(body);
        assert!(
            res.is_err(),
            "body without converter_type must fail to parse",
        );
    }

    #[test]
    fn convert_request_rejects_unknown_field_after_dispatch() {
        let body = r#"{
            "converter_type": "tfjs",
            "model_json_path": "/m",
            "labels_path": "/l",
            "labels_format": "lines",
            "stray": true
        }"#;
        let res: Result<ConvertRequest, _> = serde_json::from_str(body);
        assert!(
            res.is_err(),
            "stray field after converter dispatch must be rejected",
        );
    }

    #[test]
    fn convert_request_accepts_relative_paths_as_canonical_form() {
        // Mixing slashless (canonical) and slashed (legacy) paths
        // on the same body is fine; both resolve to the same
        // workspace path.  The shard-level slashless test was
        // dropped along with the `shards` field's removal from
        // `TfjsConvertParams`; the daemon derives shards from
        // `model.json` now (see [`TfjsConvertParams`] doc) so
        // there's no operator-supplied shard string to validate.
        for field in ["model_json_path", "labels_path"] {
            let mut v = serde_json::json!({
                "converter_type": "tfjs",
                "model_json_path": "/m",
                "labels_path": "/l",
                "labels_format": "lines",
            });
            v[field] = serde_json::Value::String("relative/path".into());
            let body = serde_json::to_string(&v).unwrap();
            let req: ConvertRequest =
                serde_json::from_str(&body).expect("slashless path is canonical");
            let ConvertRequest::Tfjs(p) = &req else {
                panic!("expected ConvertRequest::Tfjs");
            };
            let bound_field = match field {
                "model_json_path" => p.model_json_path.workspace_path().as_str(),
                "labels_path" => p.labels_path.workspace_path().as_str(),
                _ => unreachable!(),
            };
            assert_eq!(bound_field, "converters/relative/path");
        }
    }

    #[test]
    fn convert_request_round_trips_lines_format() {
        let body = r#"{
            "converter_type": "tfjs",
            "model_json_path": "/tfjs/model.json",
            "labels_path": "/tfjs/labels.txt",
            "labels_format": "lines"
        }"#;
        let req: ConvertRequest = serde_json::from_str(body).unwrap();
        let ConvertRequest::Tfjs(p) = &req else {
            panic!("expected ConvertRequest::Tfjs");
        };
        assert_eq!(p.labels_format, LabelsFormat::Lines);
    }

    #[test]
    fn convert_request_rejects_traversal_in_paths() {
        // Shard traversal is now a daemon-side concern (the
        // worker's `validate_shard_path` runs over manifest-
        // declared paths inside `parse_tfjs_manifest_with_limits`),
        // not a request-shape concern.  The standalone shard-
        // traversal sub-test that used to live here was dropped
        // when the `shards` field left the wire shape.
        for field in ["model_json_path", "labels_path"] {
            let mut v = serde_json::json!({
                "converter_type": "tfjs",
                "model_json_path": "/m",
                "labels_path": "/l",
                "labels_format": "lines",
            });
            v[field] = serde_json::Value::String("/..".into());
            let body = serde_json::to_string(&v).unwrap();
            let res: Result<ConvertRequest, _> = serde_json::from_str(&body);
            assert!(res.is_err(), "{field}=/.. must be rejected");
        }
    }

    #[test]
    fn labels_format_serializes_snake_case() {
        let lines = serde_json::to_string(&LabelsFormat::Lines).unwrap();
        assert_eq!(lines, "\"lines\"");
        let tfjs = serde_json::to_string(&LabelsFormat::TfjsMetadata).unwrap();
        assert_eq!(tfjs, "\"tfjs_metadata\"");
        let parsed: LabelsFormat = serde_json::from_str("\"lines\"").unwrap();
        assert_eq!(parsed, LabelsFormat::Lines);
        let parsed: LabelsFormat = serde_json::from_str("\"tfjs_metadata\"").unwrap();
        assert_eq!(parsed, LabelsFormat::TfjsMetadata);
        let res: Result<LabelsFormat, _> = serde_json::from_str("\"Lines\"");
        assert!(res.is_err());
    }

    // MARK: Canonical SHA + manifest helpers

    #[test]
    fn training_cfg_canonical_sha256_is_deterministic() {
        let cfg = good_cfg();
        let h1 = canonical_training_cfg_sha256(&cfg).expect("good cfg validates");
        let h2 = canonical_training_cfg_sha256(&cfg).expect("good cfg validates");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        assert!(
            h1.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        );

        let reordered = r#"{"learning_rate":0.001,"seed":42,"epochs":4,"batch_size":16}"#;
        let parsed: TrainingCfg = serde_json::from_str(reordered).unwrap();
        let h_reordered = canonical_training_cfg_sha256(&parsed).expect("good cfg validates");
        assert_eq!(h1, h_reordered);
    }

    #[test]
    fn training_cfg_canonical_sha256_rejects_non_finite_learning_rate() {
        let mut cfg = good_cfg();
        cfg.learning_rate = f32::NAN;
        assert!(canonical_training_cfg_sha256(&cfg).is_err());
        cfg.learning_rate = f32::INFINITY;
        assert!(canonical_training_cfg_sha256(&cfg).is_err());
    }

    #[test]
    fn training_cfg_canonical_sha256_changes_with_value() {
        let cfg_a = good_cfg();
        let cfg_b = TrainingCfg {
            epochs: cfg_a.epochs + 1,
            ..cfg_a.clone()
        };
        assert_ne!(
            canonical_training_cfg_sha256(&cfg_a).expect("good cfg validates"),
            canonical_training_cfg_sha256(&cfg_b).expect("good cfg validates")
        );
    }

    #[test]
    fn training_cfg_round_trips_through_manifest_value() {
        let cfg = good_cfg();
        let v = to_manifest_value(&cfg);
        let back = from_manifest_value(&v).unwrap();
        assert_eq!(cfg, back);
        assert_eq!(
            canonical_training_cfg_sha256(&cfg).expect("good cfg validates"),
            canonical_training_cfg_sha256(&back).expect("good cfg validates")
        );
    }

    #[test]
    fn from_manifest_value_classifies_corruption_as_internal() {
        let bad = serde_json::json!({
            "epochs": "four",
            "batch_size": 16,
            "learning_rate": 1e-3,
        });
        let err = from_manifest_value(&bad).unwrap_err();
        assert!(matches!(err, FileError::MetadataParse { .. }));
        assert_eq!(err.kind(), ErrorKind::Internal);
    }

    #[test]
    fn from_manifest_value_rejects_unknown_fields() {
        let bad = serde_json::json!({
            "epochs": 1,
            "batch_size": 1,
            "learning_rate": 1e-3,
            "stray": true,
        });
        assert!(from_manifest_value(&bad).is_err());
    }

    #[test]
    fn validation_error_classifies_user_input() {
        let err = ValidationError::EpochsOutOfRange {
            got: 0,
            min: 1,
            max: 1_000,
        };
        assert_eq!(err.kind(), ErrorKind::UserInput);
        let err = ValidationError::AlpkgManifestExtension {
            got: "alpkg/foo.bin".to_string(),
        };
        assert_eq!(err.kind(), ErrorKind::UserInput);
    }

    // Smoke test using the builder: round-trip through JSON keeps
    // the typed shape intact under serialize+deserialize.
    #[test]
    fn good_convert_request_round_trips_through_json() {
        let req = good_convert_request();
        let s = serde_json::to_string(&req).unwrap();
        let back: ConvertRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(req, back);
    }
}
