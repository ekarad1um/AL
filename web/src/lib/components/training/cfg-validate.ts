// Live training-cfg validation.  Mirrors the daemon's
// `validate_training_cfg` ([modules/file_mgr/request_payload.rs])
// so the operator sees the same verdict locally without a
// round-trip.  Each function returns `null` on success or a
// terse operator-facing sentence on failure -- consumed by the
// form via `aria-invalid` + an inline `role="alert"` paragraph,
// not toasts.
//
// Numbers arrive as `number | null` because the form's bind
// targets are `<input type="number">` (browser parses NaN /
// missing into `null` when typed empty).  Each validator
// short-circuits on `null` so the form's "required" affordance
// (a placeholder + disabled submit) does the work instead of
// noisy red text on first paint.

import {
  MIN_EPOCHS,
  MAX_EPOCHS,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  MAX_LEARNING_RATE,
  MIN_VALIDATION_SPLIT,
  MAX_VALIDATION_SPLIT
} from './labels';

export function validateEpochs(v: number | null): string | null {
  if (v === null || Number.isNaN(v)) return null;
  if (!Number.isInteger(v)) return `Epochs must be a whole number.`;
  if (v < MIN_EPOCHS || v > MAX_EPOCHS) {
    return `Epochs must be between ${MIN_EPOCHS} and ${MAX_EPOCHS}.`;
  }
  return null;
}

export function validateBatchSize(v: number | null): string | null {
  if (v === null || Number.isNaN(v)) return null;
  if (!Number.isInteger(v)) return `Batch size must be a whole number.`;
  if (v < MIN_BATCH_SIZE || v > MAX_BATCH_SIZE) {
    return `Batch size must be between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE}.`;
  }
  return null;
}

export function validateLearningRate(v: number | null): string | null {
  if (v === null || Number.isNaN(v)) return null;
  if (!Number.isFinite(v)) return `Learning rate must be a finite number.`;
  if (v <= 0) return `Learning rate must be greater than 0.`;
  if (v > MAX_LEARNING_RATE) return `Learning rate must be at most ${MAX_LEARNING_RATE}.`;
  return null;
}

// `seed` is optional; an empty input is "let the daemon pick".
// When typed, it must be a non-negative integer (Rust `u64`).
// We don't enforce the upper u64 bound here because JS numbers
// lose precision before reaching `2^64`, and a value past
// `Number.MAX_SAFE_INTEGER` is already ambiguous; the daemon's
// `deny_unknown_fields` JSON parser still rejects truly absurd
// inputs.  The form prefers the practical `0 <= seed <= 2^53 - 1`
// surface to match the JS reality.
export function validateSeed(v: number | null): string | null {
  if (v === null || Number.isNaN(v)) return null;
  if (!Number.isInteger(v)) return `Seed must be a whole number.`;
  if (v < 0) return `Seed must be 0 or positive.`;
  if (v > Number.MAX_SAFE_INTEGER) return `Seed is too large.`;
  return null;
}

export function validateValidationSplit(v: number | null): string | null {
  if (v === null || Number.isNaN(v)) return null;
  if (!Number.isFinite(v)) return `Validation split must be a finite number.`;
  if (v < MIN_VALIDATION_SPLIT) return `Validation split must be 0 or greater.`;
  if (v > MAX_VALIDATION_SPLIT) {
    return `Validation split must be less than 1.`;
  }
  return null;
}
