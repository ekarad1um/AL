<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import Button from '$lib/components/ui/Button.svelte';
  import { training as trainingStore } from '$lib/stores/training.svelte';
  import { categories } from '$lib/stores/categories.svelte';
  import { slices } from '$lib/stores/slices.svelte';
  import {
    isMandatoryCategory,
    MANDATORY_BACKGROUND_NOISE,
    thresholdFor
  } from '$lib/components/category/labels';
  import { formatRelative } from '$lib/utils/time';
  import TrainForm from './TrainForm.svelte';
  import TrainHistory from './TrainHistory.svelte';
  import {
    DEFAULT_BATCH_SIZE,
    DEFAULT_EPOCHS,
    DEFAULT_LEARNING_RATE,
    DEFAULT_VALIDATION_SPLIT
  } from './labels';
  import type { HeadRecord, TrainingCfg, Uuid } from '$lib/api/types';

  // Workspace-detail-scoped training surface.  Lays out as
  //
  //   ┌─ Train ────────────────────────────────────────────────┐
  //   │ <title + concise subtitle>                  <button>   │
  //   │                                                         │
  //   │ <start-error (slim, fade-only)>                         │
  //   │                                                         │
  //   │ <Hyperparameters disclosure (closed by default)>        │
  //   │                                                         │
  //   │ <Training history list (always-present)>                │
  //   │   - live run on top, auto-expanded                      │
  //   │   - terminal runs below, collapsed by default           │
  //   └─────────────────────────────────────────────────────────┘
  //
  // ## Why no overlay banners / suggestion banners
  //
  // Earlier iterations of this pane stacked three banners
  // around the body:
  //   1. A floating "Last run completed | failed" terminal
  //      overlay, dismissable, position:absolute against the
  //      body region.
  //   2. An inline "A trained head already matches this dataset
  //      · Activate" blue suggestion banner with a CTA.
  //   3. Inline readiness / busy notice paragraphs that
  //      appeared on dataset-state transitions.
  //
  // The triplet had two unrelated UX failures:
  //   - The floating overlay appeared AFTER training and the
  //     suggestion banner appeared INLINE.  An operator's eye
  //     had to re-anchor twice on terminal: once for the
  //     overlay materialising at top-right, and again for the
  //     post-training suggestion banner pushing the
  //     hyperparameter disclosure down beneath their cursor.
  //   - JobProgress (~500 px) collapsed back to the idle stack
  //     (~150 px) on terminal, animated by a slide.  The body
  //     height nearly tripled in the run-up to that slide and
  //     halved on terminate.  Together with the banners
  //     popping in/out, the post-training moment was visually
  //     chaotic.
  //
  // The redesign collapses all three banners into one
  // always-present primitive: the training-history list.  The
  // live run is just the top card (auto-expanded), and on
  // terminal the same card stays in place -- only its state
  // word morphs.  Activation is owned by the Heads section
  // below; no per-row Activate affordance lives inside the
  // train history (avoids duplicating the heads-list action
  // and keeps the history rows purely observational).
  // Readiness / busy state is folded into the subtitle (a
  // single, stable line under the title).  Start errors get
  // a slim inline alert above the disclosure -- visible long
  // enough to read, then dismissable; rare enough that its
  // one-row layout pop is acceptable.

  interface Props {
    workspaceId: Uuid;
    // Live workspace revision (max of detail.workspace_revision.id
    // and any upload receipt the slices store has seen).  Used
    // for the smart subtitle and the "Re-train" button-label
    // morph when a head already matches this revision.
    // Activation lives in the Heads section below; no per-row
    // Activate affordance is exposed inside the train history.
    workspaceRevision: number;
    heads: readonly HeadRecord[];
  }
  let { workspaceId, workspaceRevision, heads }: Props = $props();

  // ── Training slot status ─────────────────────────────────────

  const active = $derived(trainingStore.activeFor(workspaceId));
  const trainSlotHeld = $derived(trainingStore.active !== null);
  const otherWorkspaceRunning = $derived(
    trainingStore.active !== null && trainingStore.active.workspaceId !== workspaceId
  );

  // ── Smart-suggestion derivation (subtitle hint only) ─────────
  //
  // Earlier this drove an inline banner; now we use it only to
  // morph the primary button label from "Train head" to "Re-train"
  // when a current head already exists.  Activation itself is
  // owned by the Heads section below the pane.

  const currentHead = $derived.by(() => {
    if (heads.length === 0) return null;
    const matches = heads.filter((h) => h.workspace_revision.id === workspaceRevision);
    if (matches.length === 0) return null;
    // Strict-weak-order comparator: returns 0 on equal
    // `created_at` so `Array#sort`'s stability guarantees hold
    // and the picked head doesn't shuffle between renders when
    // two heads share a timestamp (rare but possible on
    // sub-second back-to-back trains in test fixtures).
    return matches
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))[0];
  });

  // ── Dataset readiness ────────────────────────────────────────
  //
  // Same gate as before -- the daemon refuses < 2 non-empty
  // categories and the per-category UX thresholds (20 bg / 10
  // fg) hold the operator to the bar the dataset module uses
  // for its "Synced" badge.

  function committedCountFor(name: string): number {
    let n = 0;
    for (const s of slices.for(workspaceId, name).entries) {
      if (s.state === 'committed') n++;
    }
    return n;
  }

  const datasetLoaded = $derived(categories.for(workspaceId).loaded);
  const categoryEntries = $derived(categories.for(workspaceId).entries);

  type Readiness =
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'no_categories' }
    | { kind: 'background_short'; have: number; need: number }
    | { kind: 'foreground_short' };

  const readiness = $derived.by<Readiness>(() => {
    if (!datasetLoaded) return { kind: 'loading' };
    const cats = categoryEntries;
    if (cats.length < 2) return { kind: 'no_categories' };
    const bgHave = committedCountFor(MANDATORY_BACKGROUND_NOISE);
    const bgNeed = thresholdFor(MANDATORY_BACKGROUND_NOISE);
    if (bgHave < bgNeed) return { kind: 'background_short', have: bgHave, need: bgNeed };
    const foregroundReady = cats
      .filter((c) => !isMandatoryCategory(c.name))
      .some((c) => committedCountFor(c.name) >= thresholdFor(c.name));
    if (!foregroundReady) return { kind: 'foreground_short' };
    return { kind: 'ready' };
  });

  function readinessReason(r: Readiness): string {
    switch (r.kind) {
      case 'loading':
        return 'Loading dataset…';
      case 'no_categories':
        return 'Add a foreground class with uploaded slices to start training.';
      case 'background_short':
        return `Background Noise needs ${r.need - r.have} more uploaded slice${
          r.need - r.have === 1 ? '' : 's'
        } to start training.`;
      case 'foreground_short':
        return 'At least one foreground class needs 10 uploaded slices to start training.';
      case 'ready':
        return '';
    }
  }

  // ── Form state (lifted from TrainForm via bind:) ─────────────

  let cfg = $state<TrainingCfg | null>(null);
  let hasFieldErrors = $state(false);

  // ── Hyperparameter disclosure ────────────────────────────────
  //
  // Closed by default.  Force-open on validation error so the
  // operator can see WHICH field is wrong instead of staring at
  // a disabled button with no on-screen reason.  Manual toggle
  // still works after the force-open clears.
  let settingsOpen = $state(false);
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (hasFieldErrors) settingsOpen = true;
  });

  const summaryChips = $derived.by(() => {
    const c = cfg;
    const epochs = c?.epochs ?? DEFAULT_EPOCHS;
    const batch = c?.batch_size ?? DEFAULT_BATCH_SIZE;
    const lr = c?.learning_rate ?? DEFAULT_LEARNING_RATE;
    const vs = c?.validation_split ?? DEFAULT_VALIDATION_SPLIT;
    return [
      `${epochs} epochs`,
      `batch ${batch}`,
      `lr ${lr.toExponential(0).replace('e+0', '').replace('e-0', 'e-')}`,
      vs === 0 ? 'no holdout' : `val ${Math.round(vs * 100)}%`
    ];
  });

  // ── Primary action state machine ─────────────────────────────
  //
  // Same precedence cascade as before.  See the long comment in
  // the previous revision for rationale; the short version is:
  // running > starting > loading > not-ready > busy > trained
  // > ready.  The label morphs accordingly and the variant
  // flips to destructive on `running` (Cancel).

  type ButtonStateKind =
    | 'idle_ready'
    | 'idle_not_ready'
    | 'idle_trained'
    | 'idle_busy'
    | 'idle_loading'
    | 'starting'
    | 'running'
    | 'cancelling';

  const MIN_STARTING_MS = 350;
  let startingPin = $state(false);
  let startingPinTimer: ReturnType<typeof setTimeout> | null = null;

  function pinStarting(): void {
    startingPin = true;
    if (startingPinTimer !== null) clearTimeout(startingPinTimer);
    startingPinTimer = setTimeout(() => {
      startingPin = false;
      startingPinTimer = null;
    }, MIN_STARTING_MS);
  }

  const buttonStateKind = $derived.by<ButtonStateKind>(() => {
    if (active) {
      if (active.cancelling) return 'cancelling';
      if (startingPin) return 'starting';
      return 'running';
    }
    if (trainingStore.starting || startingPin) return 'starting';
    if (readiness.kind === 'loading') return 'idle_loading';
    if (readiness.kind !== 'ready') return 'idle_not_ready';
    if (otherWorkspaceRunning) return 'idle_busy';
    if (currentHead !== null) return 'idle_trained';
    return 'idle_ready';
  });

  const buttonLabel = $derived.by(() => {
    switch (buttonStateKind) {
      case 'starting':
        return 'Starting…';
      case 'running':
        return 'Cancel';
      case 'cancelling':
        return 'Cancelling…';
      case 'idle_trained':
        return 'Re-train';
      default:
        return 'Train head';
    }
  });

  const buttonVariant = $derived.by(() => {
    return buttonStateKind === 'running' || buttonStateKind === 'cancelling'
      ? 'destructive'
      : 'primary';
  });

  const buttonLoading = $derived(
    buttonStateKind === 'starting' || buttonStateKind === 'cancelling'
  );

  const buttonDisabled = $derived.by(() => {
    if (buttonStateKind === 'idle_ready' || buttonStateKind === 'idle_trained') {
      return cfg === null || hasFieldErrors;
    }
    if (buttonStateKind === 'running') return false;
    return true;
  });

  const buttonTitle = $derived.by(() => {
    switch (buttonStateKind) {
      case 'idle_loading':
        return 'Loading dataset…';
      case 'idle_not_ready':
        return readinessReason(readiness);
      case 'idle_trained':
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (cfg === null || hasFieldErrors) {
          return 'Fix the highlighted hyperparameter fields to enable training.';
        }
        return 'A head already matches this revision -- re-train to try different hyperparameters or a different random seed. Activate any head from the Heads section below.';
      case 'idle_busy':
        return 'Another workspace is training; only one job runs at a time.';
      case 'idle_ready':
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (cfg === null || hasFieldErrors) {
          return 'Fix the highlighted hyperparameter fields to enable training.';
        }
        return 'Train a head on this workspace dataset.';
      case 'starting':
        return 'Submitting the training request…';
      case 'running':
        return 'Cancel the running training job.';
      case 'cancelling':
        return 'Cancelling…';
    }
  });

  // ── Subtitle ─────────────────────────────────────────────────
  //
  // Single line under the title.  Morphs by precedence to
  // describe the pane's current invariant.  Same precedence as
  // the button state so the subtitle and the action are
  // describing the same situation.  Width is intentionally
  // capped at the title's column so a long readiness reason
  // wraps onto a second line WITHIN the title's slot rather
  // than running under the right-side action button.

  const subtitle = $derived.by(() => {
    if (active?.view?.state === 'running') {
      const startedAt = active.view.started_at;
      return `Training in progress · started ${formatRelative(startedAt)}`;
    }
    if (active) return 'Submitting training request…';
    if (otherWorkspaceRunning) {
      return 'Another workspace is training; only one job runs at a time.';
    }
    if (readiness.kind === 'loading') {
      return "Tune a head on this workspace's dataset, then activate it for live inference.";
    }
    if (readiness.kind !== 'ready') {
      return readinessReason(readiness);
    }
    return "Tune a head on this workspace's dataset, then activate it for live inference.";
  });

  // Tone for the subtitle.  Amber when surfacing a readiness /
  // busy obstacle; default zinc otherwise.  The colour echoes
  // the disabled state of the primary button without an extra
  // affordance.
  const subtitleTone = $derived.by<'zinc' | 'amber' | 'blue'>(() => {
    if (active) return 'blue';
    if (otherWorkspaceRunning) return 'amber';
    if (readiness.kind === 'loading' || readiness.kind === 'ready') return 'zinc';
    return 'amber';
  });

  async function onPrimaryClick(): Promise<void> {
    if (buttonStateKind === 'running') {
      try {
        await trainingStore.cancel();
      } catch {
        // Store logs the failure; the button re-enables itself.
      }
      return;
    }
    if (buttonStateKind !== 'idle_ready' && buttonStateKind !== 'idle_trained') return;
    if (cfg === null || hasFieldErrors) return;
    pinStarting();
    try {
      await trainingStore.start(workspaceId, cfg);
    } catch {
      if (startingPinTimer !== null) {
        clearTimeout(startingPinTimer);
        startingPinTimer = null;
      }
      startingPin = false;
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  onMount(() => {
    void trainingStore.recover(workspaceId);
  });

  onDestroy(() => {
    if (startingPinTimer !== null) clearTimeout(startingPinTimer);
  });

  function dismissStartError(): void {
    trainingStore.startError = null;
  }
</script>

<section class="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
  <!-- Header.  Title block on the left (with subtitle that
       morphs to carry readiness / busy / running state),
       primary action on the right.  The header's geometry is
       independent of the body below: the body's height changes
       drive no layout in this row.  `items-center` anchors the
       button to the title block's vertical centroid so it
       remains visually balanced with both the title and the
       subtitle when the subtitle wraps to two or more lines. -->
  <header class="mb-4 flex items-center justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-sm font-semibold text-zinc-900">Train</h2>
      <p
        class="mt-0.5 text-xs"
        class:text-zinc-500={subtitleTone === 'zinc'}
        class:text-amber-700={subtitleTone === 'amber'}
        class:text-blue-700={subtitleTone === 'blue'}
      >
        {subtitle}
      </p>
    </div>
    <Button
      variant={buttonVariant}
      disabled={buttonDisabled}
      loading={buttonLoading}
      onclick={onPrimaryClick}
      title={buttonTitle}
      ariaLabel={buttonLabel}
    >
      <span class="relative inline-grid grid-cols-1 grid-rows-1 items-center">
        {#key buttonLabel}
          <span
            in:fade={{ duration: 150, easing: cubicOut }}
            out:fade={{ duration: 120, easing: cubicOut }}
            class="col-start-1 row-start-1 whitespace-nowrap"
          >
            {buttonLabel}
          </span>
        {/key}
      </span>
    </Button>
  </header>

  <!-- Start-error inline alert.  Rare (operator submits, daemon
       rejects with a typed reason) and transient -- clears on
       next submit or on operator dismiss.  Fade-only so the
       one-row appearance/disappearance is visually quiet.
       Above the disclosure so the operator's eye lands on it
       coming back from the form's submit button. -->
  {#if trainingStore.startError}
    <div
      in:fade={{ duration: 200, easing: cubicOut }}
      out:fade={{ duration: 160, easing: cubicOut }}
      class="mb-3 flex items-start justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs"
      role="alert"
    >
      <div class="min-w-0">
        <p class="font-medium text-rose-900">Could not start training</p>
        <p class="mt-0.5 wrap-break-word text-rose-800">{trainingStore.startError}</p>
      </div>
      <button
        type="button"
        onclick={dismissStartError}
        aria-label="Dismiss"
        class="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-rose-500 transition hover:bg-white/60 hover:text-rose-900"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5" aria-hidden="true">
          <path
            fill-rule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L8 6.586l2.293-2.293a1 1 0 111.414 1.414L9.414 8l2.293 2.293a1 1 0 01-1.414 1.414L8 9.414l-2.293 2.293a1 1 0 01-1.414-1.414L6.586 8 4.293 5.707a1 1 0 010-1.414z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    </div>
  {/if}

  <!-- Hyperparameter disclosure.  Closed by default; the
       button row + (when collapsed) summary chips read as a
       single primitive ("here's what you'd submit; click to
       override").  Same `grid-template-rows: 0fr ↔ 1fr` trick
       so the form panel mounts once and animates open/close
       without losing operator-typed values. -->
  <div class="mb-4 rounded-md border border-zinc-200 bg-zinc-50/60">
    <button
      type="button"
      onclick={() => (settingsOpen = !settingsOpen)}
      aria-expanded={settingsOpen}
      aria-controls="train-settings-panel"
      class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-zinc-50"
    >
      <span class="flex min-w-0 items-center gap-2">
        <!-- Optical micro-alignment.  Same chevron path + rotation
             pattern as the training-history rows; see the long
             rationale on TrainHistoryItem's chevron for the
             geometry.  TL;DR: the path's visual centroid sits
             0.72 px above its SVG box centre in the unrotated
             state, and CSS rotate-90 (CW about box centre)
             shifts the centroid 1 px down -- so a static
             translate fixes one state and breaks the other.
             Gating `translate-y-px` on `!settingsOpen` lands
             BOTH states at the same ~0.3 px residual offset
             below the "Hyperparameters" label's optical
             centre, so the chevron never appears to hop
             during the disclosure animation. -->
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          class="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-200"
          class:translate-y-px={!settingsOpen}
          class:rotate-90={settingsOpen}
        >
          <path
            fill-rule="evenodd"
            d="M7.21 5.23a.75.75 0 011.06.02L12 9l-3.73 3.71a.75.75 0 11-1.06-1.06L9.94 9 7.19 6.29a.75.75 0 01.02-1.06z"
            clip-rule="evenodd"
          />
        </svg>
        <span class="text-xs font-medium text-zinc-700">Hyperparameters</span>
      </span>
      {#if !settingsOpen}
        <span
          in:fade={{ duration: 180, easing: cubicOut }}
          class="hidden shrink-0 flex-wrap items-center justify-end gap-1 sm:flex"
          aria-hidden="true"
        >
          {#each summaryChips as chip (chip)}
            <span
              class="inline-flex items-center rounded-full bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 ring-1 ring-zinc-200"
            >
              {chip}
            </span>
          {/each}
        </span>
      {/if}
    </button>
    <div
      id="train-settings-panel"
      class="grid transition-[grid-template-rows] duration-200 ease-out"
      class:grid-rows-[1fr]={settingsOpen}
      class:grid-rows-[0fr]={!settingsOpen}
    >
      <div class="min-h-0 overflow-hidden" inert={!settingsOpen} aria-hidden={!settingsOpen}>
        <div class="border-t border-zinc-200 bg-white px-3 py-3">
          <TrainForm disabled={trainSlotHeld} bind:cfg bind:hasFieldErrors />
        </div>
      </div>
    </div>
  </div>

  <!-- Training history.  Always present; renders the live
       run as the top item (auto-expanded) and the workspace's
       terminal history below (newest-first, collapsed by
       default).  This is the load-bearing piece of the
       redesign: the layout below the header is stable across
       idle, running, and just-finished states because the
       history list is always rendered. -->
  <TrainHistory {workspaceId} />
</section>
