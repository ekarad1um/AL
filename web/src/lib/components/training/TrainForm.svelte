<script lang="ts">
  import { inputClass } from '$lib/components/ui/inputClass';
  import { training as trainingStore } from '$lib/stores/training.svelte';
  import {
    DEFAULT_BATCH_SIZE,
    DEFAULT_EPOCHS,
    DEFAULT_LEARNING_RATE,
    DEFAULT_VALIDATION_SPLIT,
    MAX_BATCH_SIZE,
    MAX_EPOCHS,
    MAX_LEARNING_RATE,
    MAX_VALIDATION_SPLIT,
    MIN_BATCH_SIZE,
    MIN_EPOCHS,
    MIN_VALIDATION_SPLIT
  } from './labels';
  import {
    validateBatchSize,
    validateEpochs,
    validateLearningRate,
    validateSeed,
    validateValidationSplit
  } from './cfg-validate';
  import type { TrainingCfg } from '$lib/api/types';

  // Controlled hyperparameter panel.  Field state lives here; the
  // parent (TrainPane) reads validity + the wire shape via
  // `bind:cfg` / `bind:hasFieldErrors` and owns the submit button +
  // start-error surfacing.  Lifting the action button up keeps the
  // header's "primary action lives at the top" rule consistent
  // with the dataset module while still encapsulating the field
  // bookkeeping that doesn't belong in the orchestrator.

  interface Props {
    // Disabled at the parent's discretion (e.g. when an active
    // training job is in flight elsewhere in the app, even on a
    // sibling workspace -- the daemon's max_train_jobs=1 means
    // a global slot is held).  Also applied while `starting` so
    // the operator can't tweak fields out from under the in-flight
    // request.
    disabled?: boolean;
    // Reflects the form's current wire shape, or `null` when any
    // required field is empty / has an error.  The parent gates
    // submit on `cfg !== null`.
    cfg?: TrainingCfg | null;
    // True iff any field carries a validation error.  Distinct
    // from `cfg === null` (which also fires on empty required
    // fields) so the parent can render an inline note differently
    // for "fix the highlighted fields" vs "fill in epochs / batch
    // / lr / val-split".
    hasFieldErrors?: boolean;
  }
  let {
    disabled = false,
    cfg = $bindable(null),
    hasFieldErrors = $bindable(false)
  }: Props = $props();

  // `<input type="number">` binds to `number | null` in Svelte 5
  // (empty input → null).  We model every field that way so a
  // cleared field re-enters the "required" affordance instead of
  // being treated as 0.  Optional fields (`seed`,
  // `validation_split`) keep `null` as the legitimate "absent"
  // value.
  let epochs = $state<number | null>(DEFAULT_EPOCHS);
  let batchSize = $state<number | null>(DEFAULT_BATCH_SIZE);
  let learningRate = $state<number | null>(DEFAULT_LEARNING_RATE);
  let seed = $state<number | null>(null);
  let validationSplit = $state<number | null>(DEFAULT_VALIDATION_SPLIT);

  const epochsError = $derived(validateEpochs(epochs));
  const batchSizeError = $derived(validateBatchSize(batchSize));
  const learningRateError = $derived(validateLearningRate(learningRate));
  const seedError = $derived(validateSeed(seed));
  const validationSplitError = $derived(validateValidationSplit(validationSplit));

  // Required fields: epochs, batch_size, learning_rate, validation_split.
  // (`seed` is optional; null = let daemon pick.)
  const allRequiredPresent = $derived(
    epochs !== null && batchSize !== null && learningRate !== null && validationSplit !== null
  );
  const computedHasErrors = $derived(
    !!epochsError ||
      !!batchSizeError ||
      !!learningRateError ||
      !!seedError ||
      !!validationSplitError
  );

  // Surface validity to the parent.  Two writes (cfg + hasFieldErrors)
  // happen in separate $effects so a no-op write on one binding doesn't
  // trigger a re-fire of the other -- Svelte 5's bindable writes are
  // reactive and would otherwise chain.
  $effect(() => {
    hasFieldErrors = computedHasErrors;
  });
  $effect(() => {
    if (
      !allRequiredPresent ||
      computedHasErrors ||
      epochs === null ||
      batchSize === null ||
      learningRate === null ||
      validationSplit === null
    ) {
      cfg = null;
      return;
    }
    const next: TrainingCfg = {
      epochs,
      batch_size: batchSize,
      learning_rate: learningRate,
      validation_split: validationSplit
    };
    // Omit `seed` from the request body when null so the daemon's
    // `Option<u64>` parses as None (per-job entropy) rather than a
    // null literal.
    if (seed !== null) next.seed = seed;
    cfg = next;
  });

  // Field-level disabled is the OR of the parent's gate and the
  // store's `starting` flag.  We read `starting` here (rather than
  // forcing the parent to push it down) so the form is locked the
  // moment the submit lands, even if the parent is mid-recompute.
  const fieldsDisabled = $derived(disabled || trainingStore.starting);
</script>

<!-- Two-column grid at sm+, single column on narrow.  The
     daemon's defaults are conservative enough that the operator
     often submits unchanged; the form's role is to make the
     parameters discoverable, not to require thought every run. -->
<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
  <label class="block">
    <span class="mb-1 block text-xs text-zinc-600">Epochs</span>
    <input
      type="number"
      bind:value={epochs}
      disabled={fieldsDisabled}
      min={MIN_EPOCHS}
      max={MAX_EPOCHS}
      step="1"
      inputmode="numeric"
      aria-invalid={epochsError ? true : undefined}
      aria-describedby={epochsError ? 'train-epochs-error' : undefined}
      class={inputClass(!!epochsError)}
    />
    {#if epochsError}
      <p id="train-epochs-error" class="mt-1 text-xs text-rose-700" role="alert">
        {epochsError}
      </p>
    {/if}
  </label>

  <label class="block">
    <span class="mb-1 block text-xs text-zinc-600">Batch size</span>
    <input
      type="number"
      bind:value={batchSize}
      disabled={fieldsDisabled}
      min={MIN_BATCH_SIZE}
      max={MAX_BATCH_SIZE}
      step="1"
      inputmode="numeric"
      aria-invalid={batchSizeError ? true : undefined}
      aria-describedby={batchSizeError ? 'train-batch-error' : undefined}
      class={inputClass(!!batchSizeError)}
    />
    {#if batchSizeError}
      <p id="train-batch-error" class="mt-1 text-xs text-rose-700" role="alert">
        {batchSizeError}
      </p>
    {/if}
  </label>

  <label class="block">
    <span class="mb-1 block text-xs text-zinc-600">Learning rate</span>
    <input
      type="number"
      bind:value={learningRate}
      disabled={fieldsDisabled}
      min="0"
      max={MAX_LEARNING_RATE}
      step="0.0001"
      inputmode="decimal"
      aria-invalid={learningRateError ? true : undefined}
      aria-describedby={learningRateError ? 'train-lr-error' : undefined}
      class={inputClass(!!learningRateError)}
    />
    {#if learningRateError}
      <p id="train-lr-error" class="mt-1 text-xs text-rose-700" role="alert">
        {learningRateError}
      </p>
    {/if}
  </label>

  <label class="block">
    <span class="mb-1 block text-xs text-zinc-600">
      Validation split
      <span class="text-zinc-400">· 0 to disable</span>
    </span>
    <input
      type="number"
      bind:value={validationSplit}
      disabled={fieldsDisabled}
      min={MIN_VALIDATION_SPLIT}
      max={MAX_VALIDATION_SPLIT}
      step="0.01"
      inputmode="decimal"
      aria-invalid={validationSplitError ? true : undefined}
      aria-describedby={validationSplitError ? 'train-vs-error' : undefined}
      class={inputClass(!!validationSplitError)}
    />
    {#if validationSplitError}
      <p id="train-vs-error" class="mt-1 text-xs text-rose-700" role="alert">
        {validationSplitError}
      </p>
    {/if}
  </label>

  <label class="block sm:col-span-2">
    <span class="mb-1 block text-xs text-zinc-600">
      Seed
      <span class="text-zinc-400">· blank for daemon-picked entropy</span>
    </span>
    <input
      type="number"
      bind:value={seed}
      disabled={fieldsDisabled}
      min="0"
      step="1"
      inputmode="numeric"
      placeholder="(optional)"
      aria-invalid={seedError ? true : undefined}
      aria-describedby={seedError ? 'train-seed-error' : undefined}
      class={inputClass(!!seedError)}
    />
    {#if seedError}
      <p id="train-seed-error" class="mt-1 text-xs text-rose-700" role="alert">
        {seedError}
      </p>
    {/if}
  </label>
</div>
