<script lang="ts">
  import MetricsChart from './MetricsChart.svelte';
  import RunSummary from './RunSummary.svelte';
  import TrainLogs from './TrainLogs.svelte';
  import { STAGE_LABEL } from './labels';
  import type { TrackedTrainingJob } from '$lib/stores/training.svelte';
  import type { Stage, TrainingJobView } from '$lib/api/types';

  interface Props {
    // Always non-null when this component is rendered.  The
    // parent (TrainPane) gates on `training.activeFor(...) !==
    // null` so we can assume the job slot is live.
    job: TrackedTrainingJob;
  }
  let { job }: Props = $props();

  // Most surfaces below tolerate a null `view` (the first poll
  // hasn't landed yet).  We extract once via $derived rather
  // than re-pattern-match per access site.
  const view = $derived<TrainingJobView | null>(job.view);
  const phase = $derived<Stage>(view?.progress.phase ?? 'prepare');

  // Operator-facing label for the current phase.  Falls back to
  // the raw stage string on the (forward-compat) chance the
  // daemon ships a phase variant the frontend hasn't yet got a
  // label for; an unknown phase reads as engineering noise
  // rather than "undefined".
  const phaseLabel = $derived<string>(
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    STAGE_LABEL[phase] ?? phase
  );

  // Latest metrics snapshot (for the readout strip during
  // running runs).  Either the freshest tick's metrics OR the
  // last entry in the observed history -- the latter is
  // monotonic so it's safe to fall back to when a non-Train
  // stage tick comes in (e.g. Save).
  const latestMetrics = $derived(
    view?.progress.metrics ?? (job.epochs.length > 0 ? job.epochs[job.epochs.length - 1] : null)
  );

  // `validation_split = 0` → val_acc is NaN throughout the run;
  // the MetricsChart's val-line collapses and the readout swaps
  // "—" for the value.  We detect this from `latestMetrics`
  // because the form's value isn't passed through the store
  // (it's snapshot into the daemon's request body and not
  // echoed back on `JobView.progress`).
  const valDisabled = $derived(
    latestMetrics !== null &&
      (latestMetrics.val_acc === null || !Number.isFinite(latestMetrics.val_acc))
  );

  // Progress bar fill.  Falls back to an indeterminate animation
  // (zero-width but the wrapper still shows) when `total === 0`
  // -- the Prepare + Dataset-scan stages emit
  // `{current: 0, total: 0}` until the scan walks the dataset
  // and learns the example count.  For frozen terminal
  // views we suppress the indeterminate animation (no "live"
  // signal is appropriate on a finished card): completed →
  // 100%; failed / cancelled with no progress → 0% (a flat,
  // non-animated bar).
  const isTerminal = $derived(
    view !== null &&
      (view.state === 'completed' || view.state === 'failed' || view.state === 'cancelled')
  );
  const progressPct = $derived.by(() => {
    const total = view?.progress.total ?? 0;
    const current = view?.progress.current ?? 0;
    if (isTerminal && view?.state === 'completed') return 100;
    if (isTerminal) return total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0;
    if (total <= 0) return null;
    return Math.max(0, Math.min(100, (current / total) * 100));
  });

  // Format a number for the metrics readout.  Three decimal
  // places for losses (typical range 0.01–10), two decimal
  // places for accuracies (0–1).  NaN → em-dash so the readout
  // never shows "NaN" or "undefined".
  function fmtLoss(v: number | undefined | null): string {
    if (v === undefined || v === null || !Number.isFinite(v)) return '—';
    return v.toFixed(3);
  }
  function fmtAcc(v: number | undefined | null): string {
    if (v === undefined || v === null || !Number.isFinite(v)) return '—';
    return (v * 100).toFixed(1) + '%';
  }
</script>

<div class="flex flex-col gap-2">
  {#if isTerminal && view !== null}
    <!-- Terminal layout.  Drop the progress bar (its 100% / 0%
         frozen state is pure noise on a finished card) and the
         per-epoch readout strip (its "latest metrics" reading
         is misleading for a completed run that published the
         best-val-epoch head rather than the last-epoch head).
         RunSummary replaces both, surfacing the verdict
         (duration, epochs, best-val, classes / failure reason /
         cancel stage) in a stable 2x2 tile grid.  The earlier
         6-chip stage strip is gone too: on completed runs every
         chip read green and conveyed only "all phases ran",
         which the green left-border + state pill already say;
         on failed / cancelled runs the RunSummary card carries
         the "Stopped at <stage>" prose, so the strip duplicated
         what's now an in-card sentence. -->
    <RunSummary {view} epochs={job.epochs} />
  {:else}
    <!-- Running layout: progress bar + phase caption + jobId
         chip.  The earlier state pill ("running") is dropped --
         this layout branch only renders when `state === running`,
         so the pill duplicates a fact the surrounding chrome
         (card left-border, header pill) already encodes.  In its
         place we surface the current phase name (Preparing,
         Scanning dataset, Training, ...), which is what the
         operator actually wants to know about a live run that no
         longer has a chip strip overhead. -->
    <div class="space-y-1">
      <div class="relative h-1.5 overflow-hidden rounded-full bg-zinc-100">
        {#if progressPct !== null}
          <div
            class="absolute inset-y-0 left-0 bg-blue-500 transition-[width] duration-150 ease-out"
            style="width: {progressPct}%"
          ></div>
        {:else}
          <!-- Indeterminate animation: a 30%-wide bar sweeps the
               track.  Pure CSS keyframes (declared inline below)
               keep the bar's lifecycle scoped to this template. -->
          <div class="absolute inset-y-0 indeterminate-bar bg-blue-500"></div>
        {/if}
      </div>
      <p class="flex items-baseline justify-between gap-2 text-[11px] text-zinc-500">
        <span class="min-w-0 truncate">
          {#if view === null}
            <span class="text-zinc-400">Submitting…</span>
          {:else}
            <span class="font-medium text-zinc-700">{phaseLabel}</span>
            {#if view.progress.total > 0}
              <span class="ml-1.5 font-mono tabular-nums text-zinc-500">
                {view.progress.current} / {view.progress.total}
              </span>
            {/if}
          {/if}
        </span>
        <span class="shrink-0 font-mono text-[10px] text-zinc-400" title={job.jobId}>
          job {job.jobId.slice(0, 8)}…
        </span>
      </p>
    </div>
  {/if}

  <!-- Metrics chart -- visible during the Train stage (and the
       stages that come after, since the chart is monotonic).
       During Prepare / Dataset-scan / Feature-extract we
       render a placeholder inside the chart that telegraphs
       "waiting for first epoch".  The chart now carries
       axis tick labels, a best-val-epoch marker, and a
       pointer-hover crosshair + tooltip -- useful both during
       a run (scrubbing through observed epochs without waiting
       for the readout to update) and on a frozen terminal
       (the head that published is the best-val epoch, so the
       marker calls out the exact epoch operators would
       otherwise have to find by squinting at the val line). -->
  <MetricsChart epochs={job.epochs} {valDisabled} />

  <!-- Per-epoch readout strip during running runs.  Three stat
       cells (loss / train acc / val acc) mirroring the
       dashboard ActiveHeadCard's stat-tile pattern.  Hidden on
       terminal cards because the RunSummary above carries the
       verdict-level numbers (best val, final train, etc.) and
       the chart's hover tooltip surfaces per-epoch readings on
       demand; a stale "latest tick" readout on a frozen card
       was misleading where the published head was an earlier
       best-val epoch. -->
  {#if !isTerminal}
    <dl
      class="grid grid-cols-3 gap-x-3 gap-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs"
    >
      <div>
        <dt class="text-[10px] uppercase tracking-wider text-zinc-500">train loss</dt>
        <dd class="mt-0.5 font-mono text-sm tabular-nums text-zinc-900">
          {fmtLoss(latestMetrics?.train_loss)}
        </dd>
      </div>
      <div>
        <dt class="text-[10px] uppercase tracking-wider text-zinc-500">train acc</dt>
        <dd class="mt-0.5 font-mono text-sm tabular-nums text-zinc-900">
          {fmtAcc(latestMetrics?.train_acc)}
        </dd>
      </div>
      <div>
        <dt class="text-[10px] uppercase tracking-wider text-zinc-500">
          {#if valDisabled}val acc · disabled{:else}val acc{/if}
        </dt>
        <dd class="mt-0.5 font-mono text-sm tabular-nums text-zinc-900">
          {fmtAcc(valDisabled ? undefined : latestMetrics?.val_acc)}
        </dd>
      </div>
    </dl>
  {/if}

  <!-- Rolling progress-message log.  Built up across poll ticks
       from `view.progress.message` deltas (the daemon retains no
       message history, so this client-synthesised scrollback is
       the only place an operator can re-read the trace of an
       in-flight or just-finished run).  Sits at the bottom of
       the body so the visual rhythm is: stage strip → live or
       summary block → chart → numbers (running only) → trace
       -- coarse-to-fine, with the most-recent action at the
       bottom of the scroll. -->
  <TrainLogs lines={job.logLines} />
</div>

<style>
  /* Indeterminate progress-bar sweep.  Keyframes scoped to
     this component so a sibling progress bar can't accidentally
     inherit the timing.  Width fixed at 30 % to balance the
     "fast enough to feel live" cue against "long enough that
     the bar is recognisable as a progress affordance". */
  .indeterminate-bar {
    width: 30%;
    animation: indeterminate 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
  @keyframes indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(370%);
    }
  }
</style>
