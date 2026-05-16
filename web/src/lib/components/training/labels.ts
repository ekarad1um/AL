// Training UI strings + numeric bounds.  Bounds mirror the
// daemon's `validate_training_cfg`
// ([modules/file_mgr/request_payload.rs])
// so the form's live validation fails on the same inputs the
// daemon would 400 on -- the operator gets feedback at keystroke
// rather than at submit.

import type { Stage, TrainingJobState } from '$lib/api/types';

export const MIN_EPOCHS = 1;
export const MAX_EPOCHS = 1_000;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 4_096;
// `learning_rate` is `(0, MAX_LEARNING_RATE]` -- exclusive low,
// inclusive high.  Validation catches NaN / Infinity too.
export const MAX_LEARNING_RATE = 1.0;
// `validation_split` is `[0, 1)`.  0 disables stratified split
// entirely; values approaching 1 leave no training data.
export const MIN_VALIDATION_SPLIT = 0.0;
export const MAX_VALIDATION_SPLIT = 0.999; // operator-facing cap; daemon validates `< 1.0`

// Sensible defaults for a fresh form.  Tuned for the "small
// dataset, a few minutes of training" workflow that's the
// device's typical use case; the operator can override per-run.
// `validation_split = 0.2` (the heuristic standard) gives the
// trainer enough holdout to pick a best-val-loss epoch over
// runs > a handful of epochs.
export const DEFAULT_EPOCHS = 50;
export const DEFAULT_BATCH_SIZE = 32;
export const DEFAULT_LEARNING_RATE = 1e-3;
export const DEFAULT_VALIDATION_SPLIT = 0.2;

// Ordered stage strip displayed by [JobProgress].  Matches the
// daemon's `finetune::Stage` enum order so the indicator
// progresses left-to-right as the trainer advances.  `publish`
// is the terminal stage the wrapper emits after the rotation
// primitive lands the head; on a successful run every chip
// lights including this one.
export const STAGE_ORDER: readonly Stage[] = [
  'prepare',
  'dataset_scan',
  'feature_extract',
  'train',
  'save',
  'publish'
];

// Operator-facing labels for the stage strip.  Title case to
// match the [NOTES.md] §"Type & casing hierarchy" rule for
// status chips (rendered as Title via `text-transform: capitalize`
// where appropriate; the strings are already-cased here because
// `feature_extract` has two words and `capitalize` only flips
// the first letter).
export const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  prepare: 'Preparing',
  dataset_scan: 'Scanning dataset',
  feature_extract: 'Extracting features',
  train: 'Training',
  save: 'Saving',
  publish: 'Publishing'
};

// Operator-facing label for the (separate) training-job-state
// dimension.  `running` is intentionally lowercase to match the
// existing pill-rendering convention (`text-transform: capitalize`
// on the surface).
export const TRAINING_STATE_LABEL: Readonly<Record<TrainingJobState, string>> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled'
};

// Terminal training-job states.  Used by the store + the cancel
// button + the poller's stop condition.
export const TERMINAL_TRAINING_STATES: ReadonlySet<TrainingJobState> = new Set([
  'completed',
  'failed',
  'cancelled'
]);
