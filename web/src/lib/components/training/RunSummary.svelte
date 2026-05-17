<script lang="ts">
  import { formatDurationHuman } from '$lib/utils/format';
  import { STAGE_LABEL } from './labels';
  import type { EpochMetrics, TrainingJobView } from '$lib/api/types';

  // Structured terminal-run summary card.  Renders the
  // load-bearing facts about a finished run -- duration, epochs
  // observed, best val epoch, head identity, or a failure /
  // cancellation reason -- as a stable 2x2 (or 1-col) tile grid.
  //
  // ## Why a dedicated card (vs. inline metrics readout)
  //
  // The existing 3-cell readout strip (train loss / train acc /
  // val acc) renders the *latest observed* epoch metrics.  For a
  // running job that's the freshest data; for a terminal job
  // it's misleading -- a 30-epoch run with best val acc at epoch
  // 14 still flashes the epoch-30 numbers, even though epoch 14
  // is the head that actually got published (when
  // `validation_split > 0`).  The summary instead spotlights the
  // run's *verdict*: how long it took, how many epochs landed,
  // where val peaked, what the final head describes.
  //
  // ## Visual treatment
  //
  // The card matches the existing readout strip's chrome
  // (`rounded-md border-zinc-200 bg-zinc-50`) so it reads as a
  // sibling primitive.  Two-column grid (responsive to one on
  // narrow) keeps the optical density at 4 cells comfortable.
  // Failure / cancellation variants collapse the grid to a
  // single column with a tone-coloured leading icon strip so a
  // glance reads the verdict before the prose -- the same
  // "colour signal first, prose second" rule the surrounding
  // history row uses.

  interface Props {
    // Always terminal (`completed | failed | cancelled`).  Parent
    // gates on `isTerminal` before mounting.
    view: TrainingJobView;
    // Per-epoch metrics collected during the run.  Drives the
    // best-val-epoch derivation and the "epochs observed" cell.
    // Empty array is valid -- a run that fails in Prepare /
    // Dataset-scan / Feature-extract before the train loop
    // emits any epoch metric.
    epochs: readonly EpochMetrics[];
  }
  let { view, epochs }: Props = $props();

  // Duration: end timestamp (or now() when finished_at is
  // somehow absent on a terminal view) minus start.  Defensive
  // clamp at 0 because clock skew between daemon and tab can
  // produce a slight negative for sub-second runs -- "0:00" is
  // less surprising than "-0:00".
  const durationMs = $derived.by(() => {
    const start = Date.parse(view.started_at);
    const finish = view.finished_at ? Date.parse(view.finished_at) : Date.now();
    if (Number.isNaN(start) || Number.isNaN(finish)) return 0;
    return Math.max(0, finish - start);
  });

  // Best val epoch -- argmax over the observed val_acc series.
  // Skips null entries (validation_split === 0 or pre-train
  // stages); null when no val_acc was ever observed.  The
  // daemon's `best_val_acc` field on each EpochMetrics is
  // monotonic-upward but doesn't include the *epoch index* the
  // peak landed at, so we re-derive locally.
  const bestVal = $derived.by(() => {
    let best: EpochMetrics | null = null;
    let bestAcc = -Infinity;
    for (const e of epochs) {
      const v = e.val_acc;
      if (v === null || !Number.isFinite(v)) continue;
      if (v > bestAcc) {
        bestAcc = v;
        best = e;
      }
    }
    return best;
  });

  // Epoch progress observed.  `epochsRun` is the last-seen epoch
  // index (1-indexed); `epochsTotal` is the operator-chosen run
  // length echoed back by every EpochMetrics tick.  Both are 0
  // when no epochs landed (early-failure runs).
  const epochsRun = $derived(epochs.length > 0 ? epochs[epochs.length - 1].epoch : 0);
  const epochsTotal = $derived(epochs.length > 0 ? epochs[epochs.length - 1].epochs : 0);

  // Stage the run stopped at, for failure / cancellation copy.
  // The daemon freezes `progress.phase` at the terminal moment,
  // so this is "where it died" verbatim.
  const stageLabel = $derived(STAGE_LABEL[view.progress.phase]);

  // Failure / cancellation reason copy.  The poller surfaces a
  // free-form `error` on failed terminals (set by the daemon
  // from the typed `TrainEvent::JobFailed.error` string) and a
  // trailing `progress.message` on cancelled ones (the daemon
  // doesn't emit a separate cancel reason in the polled view --
  // that lives in the JSONL backstop's `job_cancelled` event,
  // which we don't read here).  Both fall back to a generic
  // line when blank.
  const reason = $derived.by(() => {
    if (view.state === 'failed') {
      const err = (view.error?.trim() ?? '') || view.progress.message.trim();
      return err || 'No diagnostic surfaced. Check daemon logs for details.';
    }
    if (view.state === 'cancelled') {
      // The progress.message at cancel time is whatever the last
      // pre-checkpoint tick wrote; useful but rarely conclusive.
      // We surface a brief generic line and let the trace
      // scrollback below carry any specifics.
      return 'Stopped at the next training checkpoint.';
    }
    return '';
  });

  function fmtAcc(v: number | null | undefined): string {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return `${(v * 100).toFixed(1)}%`;
  }
</script>

<!-- Completed: a four-tile grid -- the "verdict-at-a-glance"
     surface.  Mirrors the dashboard's ActiveHeadCard tile pattern
     (small uppercase label + larger mono value) and the
     JobProgress readout strip's `border-zinc-200 bg-zinc-50`
     chrome so the three surfaces read as siblings.

     ## Even-spacing discipline

     The grid uses equal-width columns and `text-center` per
     tile so each label / value stack centers within its
     column.  Visually the row reads as four evenly-spaced
     groups at 1/8, 3/8, 5/8, 7/8 of the row width -- the
     "evenly spaced" geometry the layout promises.  A
     `flex justify-between` alternative was rejected because
     the actual content widths (~255 px total) inside a
     typical card width (~700-800 px) would push the
     inter-tile gaps to 150+ px, making the four tiles read
     as orphaned chips rather than a stat row.  Left-aligned
     content (the prior shape) cued the eye to the column's
     left edge and made the row feel left-heavy -- especially
     stark for a 1-char value like Classes "2", which left
     ~80% of its column visually empty on its right side. -->
{#if view.state === 'completed'}
  <dl
    class="grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-emerald-200 bg-emerald-50/50 p-3 text-xs sm:grid-cols-4"
    aria-label="Completed run summary"
  >
    <div class="text-center">
      <dt class="text-[10px] uppercase tracking-wider text-zinc-500">Duration</dt>
      <dd class="mt-0.5 font-mono text-sm tabular-nums text-zinc-900">
        {formatDurationHuman(durationMs)}
      </dd>
    </div>
    <div class="text-center">
      <dt class="text-[10px] uppercase tracking-wider text-zinc-500">Epochs</dt>
      <dd
        class="mt-0.5 font-mono text-sm tabular-nums text-zinc-900"
        title={epochsRun === epochsTotal && epochsRun > 0
          ? 'Ran the full configured epoch count.'
          : 'Observed epochs vs. configured epoch count.'}
      >
        {epochsRun}/{epochsTotal || epochsRun || '—'}
      </dd>
    </div>
    <div class="text-center">
      <dt class="text-[10px] uppercase tracking-wider text-zinc-500">
        {#if bestVal}Best val @ {bestVal.epoch}{:else}Final train acc{/if}
      </dt>
      <dd class="mt-0.5 font-mono text-sm tabular-nums text-zinc-900">
        {#if bestVal}
          {fmtAcc(bestVal.val_acc)}
        {:else}
          {fmtAcc(view.result?.final_train_acc)}
        {/if}
      </dd>
    </div>
    <div class="text-center">
      <dt class="text-[10px] uppercase tracking-wider text-zinc-500">Classes</dt>
      <dd class="mt-0.5 font-mono text-sm tabular-nums text-zinc-900">
        {view.result?.n_classes ?? '—'}
      </dd>
    </div>
  </dl>
{:else if view.state === 'failed'}
  <!-- Failed: single column with a coloured leading rule.  The
       row-level left-border (rose) already telegraphs failure;
       this card carries the *reason* without re-painting another
       large colour stripe.  Tone tints are intentionally subtle
       (`bg-rose-50/40`) so a glance lands on the prose, not on
       the background.  Stage at failure is the lead because it
       answers "where did this die" before "why" -- operators
       diagnose top-down. -->
  <div
    class="space-y-1.5 rounded-md border border-rose-200 bg-rose-50/40 p-3 text-xs"
    aria-label="Failed run summary"
  >
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span class="text-[10px] uppercase tracking-wider text-rose-700">Stopped at</span>
      <span class="font-medium text-zinc-900">{stageLabel}</span>
      {#if epochsRun > 0 && epochsTotal > 0 && view.progress.phase === 'train'}
        <span class="font-mono text-[11px] tabular-nums text-zinc-500">
          after {epochsRun}/{epochsTotal} epochs
        </span>
      {/if}
      <span class="ml-auto font-mono text-[10px] tabular-nums text-zinc-400">
        {formatDurationHuman(durationMs)}
      </span>
    </div>
    <p class="wrap-break-word text-rose-900">{reason}</p>
  </div>
{:else if view.state === 'cancelled'}
  <!-- Cancelled: same single-column shape as failed but neutral
       zinc tone -- a cancellation is operator intent, not a
       defect, so it doesn't deserve rose-50.  Includes the
       partial-progress reading so the operator can decide
       whether to resubmit identical or tweak first. -->
  <div
    class="space-y-1.5 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs"
    aria-label="Cancelled run summary"
  >
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span class="text-[10px] uppercase tracking-wider text-zinc-500">Cancelled at</span>
      <span class="font-medium text-zinc-900">{stageLabel}</span>
      {#if epochsRun > 0 && epochsTotal > 0 && view.progress.phase === 'train'}
        <span class="font-mono text-[11px] tabular-nums text-zinc-500">
          after {epochsRun}/{epochsTotal} epochs
        </span>
      {/if}
      <span class="ml-auto font-mono text-[10px] tabular-nums text-zinc-400">
        {formatDurationHuman(durationMs)}
      </span>
    </div>
    <p class="text-zinc-700">{reason}</p>
  </div>
{/if}
