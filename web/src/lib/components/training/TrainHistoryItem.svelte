<script lang="ts">
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import Button from '$lib/components/ui/Button.svelte';
  import JobProgress from './JobProgress.svelte';
  import { formatRelative } from '$lib/utils/time';
  import { STAGE_LABEL, TRAINING_STATE_LABEL } from './labels';
  import type { TrackedTrainingJob } from '$lib/stores/training.svelte';

  // One row in the training-history list.  Sized to look the
  // same expanded or collapsed across all four lifecycle states
  // (submitting → running → completed | failed | cancelled).
  // The job-identity stays stable across the active→terminal
  // transition because the container keys by `job.jobId` and
  // the live → terminal flip is one-and-the-same item — its
  // view object swaps under it without remount.
  //
  // ## Header visual hierarchy
  //
  // The header is intentionally lean: one colour signal (left
  // border accent, 4 px), one inline state word (coloured to
  // match), one timestamp, and a small trailing detail strip
  // (running progress hint OR final metric).  No per-row
  // Activate / dismiss affordances -- the heads list below
  // owns activation, and `Clear finished` at the section
  // header owns bulk delete.  Removing those two trailing
  // buttons reclaims the right gutter so the header reads as
  // pure run metadata rather than action+metadata cohabiting
  // one row.
  //
  // ## Header invariant
  //
  // The header is a single fixed-height row (with allowed wrap
  // on narrow viewports).  No element show/hide causes a
  // height jump bigger than one wrap line: state word,
  // timestamp, and trailing detail are present in every
  // state.  The chevron rotates rather than swapping glyphs.
  // The only right-side affordance is the live-only Cancel
  // button, which slot-collapses away on terminal transitions
  // without shifting the row's vertical rhythm.
  //
  // ## Body
  //
  // The expanded body unmounts when collapsed (Svelte `{#if}`
  // block, `transition:slide`).  The JobProgress component
  // inside is reused verbatim from the previous live-only
  // layout -- it already handles a terminal `view` correctly
  // (the per-phase strip lights all chips, the chart freezes
  // at the final epoch, the log scrollback shows the full
  // observed trace including the synthetic terminal summary
  // line).  Mounting JobProgress lazily keeps the cost of a
  // history list with N entries proportional to expanded-only.

  interface Props {
    job: TrackedTrainingJob;
    // True iff the operator currently has this item expanded.
    // Controlled by the parent (a SvelteSet of jobIds) so the
    // expansion state is preserved across the active→terminal
    // transition even when the item's source moves from
    // `store.active` to `store.history`.
    expanded: boolean;
    // Cancel handler for the live entry.  Omitted for
    // terminal entries.  Rendered as a small destructive
    // button on the right of the header.  Receiving this prop
    // means the parent already gates on "this is the live
    // entry" so we don't need to re-check `isLive` before
    // wiring the click.
    oncancel?: () => Promise<void>;
    // Notify the parent that the chevron / header was clicked
    // so it can toggle `expanded`.  We don't own that state
    // here; see the props doc above.
    ontoggle: () => void;
    // True when this entry is the currently-active run (the
    // top of the list).  Drives the pulsing affordance on the
    // state word and the Cancel button visibility.  The
    // active job's view may be null (pre-ack) or `view.state
    // === 'running'` (post-ack, pre-terminal).
    isLive: boolean;
  }
  let { job, expanded, oncancel, ontoggle, isLive }: Props = $props();

  // Display state.  `view === null` is the just-submitted, pre-
  // first-poll window -- treat it as 'submitting' rather than
  // forcing the operator to read "running" before any data
  // lands.
  type DisplayState = 'submitting' | 'running' | 'completed' | 'failed' | 'cancelled';
  const displayState = $derived<DisplayState>(job.view === null ? 'submitting' : job.view.state);
  // Label shown inside the state pill.  Kept distinct from
  // `displayState` because TS narrows `job.view` to non-null
  // only inside an explicit guard; pulling the lookup into a
  // single derived sidesteps a non-null assertion in markup.
  const stateLabel = $derived.by(() => {
    const v = job.view;
    if (v === null) return 'submitting';
    return TRAINING_STATE_LABEL[v.state];
  });

  // Single timestamp anchor.  Live runs show the start
  // (because that's what's still moving relative to "now");
  // terminal runs show the finish (because the start is now
  // ancient context the operator rarely cares about).  Full
  // timestamps live in the row's `title` for hover lookup.
  const timeLabel = $derived.by(() => {
    const v = job.view;
    if (!v) return `started ${formatRelative(new Date().toISOString())}`;
    if (v.state === 'running') return `started ${formatRelative(v.started_at)}`;
    if (v.finished_at) return formatRelative(v.finished_at);
    return `started ${formatRelative(v.started_at)}`;
  });
  const timeTitle = $derived.by(() => {
    const v = job.view;
    if (!v) return '';
    const parts = [`started ${v.started_at}`];
    if (v.finished_at) parts.push(`finished ${v.finished_at}`);
    return parts.join(' · ');
  });

  // Best val acc observed across the collected per-epoch
  // metrics.  Mirrors RunSummary's derivation so the header
  // surfaces the same "peak" the expanded card calls out.
  // Null when no val_acc was ever observed (validation_split
  // === 0, or a pre-train failure).
  const bestValAcc = $derived.by<number | null>(() => {
    let best: number | null = null;
    for (const e of job.epochs) {
      const v = e.val_acc;
      if (v === null || !Number.isFinite(v)) continue;
      if (best === null || v > best) best = v;
    }
    return best;
  });

  // Trailing detail tokens.  Renders as an inline " · "-style
  // gap-2 sequence in the header.  We build an array of strings
  // (rather than a single concatenated string) so the wrap
  // discipline holds: each token is `whitespace-nowrap` and the
  // flex wrapper line-breaks between tokens at narrow widths.
  //
  // Tokens deliberately exclude run duration AND epoch count --
  // both live in the expanded RunSummary tiles for operators
  // who need them.  Showing them inline-AND-expanded was
  // duplication; the header is for the *verdict* ("which run
  // produced the head shape I want to activate, and how good
  // was it?"), and the operator's typical scanning question is
  // about head identity (class count) and accuracy, not about
  // training mechanics.  Failed runs drop the inline error
  // copy too: the row's rose left-border signals failure at a
  // glance and the full diagnostic lives in the expanded
  // RunSummary + log scrollback.
  //
  //   running:    epoch 5/30
  //   submitting: (no tokens; left-border + state word carry
  //                the "in flight" signal)
  //   completed:  N classes · val Y.Y%   (or train acc
  //                fallback when valDisabled)
  //   failed:     stopped at <stage>
  //   cancelled:  stopped at <stage>
  //
  // Class count comes from `view.result.n_classes`, which is
  // populated only on `completed`.  Failed / cancelled rows
  // have no head to surface, so no class token is rendered --
  // the dataset's class count at submit time isn't a useful
  // verdict ("the run we attempted would have produced N
  // classes if it hadn't died") and threading it through the
  // store would add a code path with no operator question
  // behind it.
  const trailingDetail = $derived.by<readonly string[]>(() => {
    const v = job.view;
    if (!v) return [];
    if (v.state === 'running') {
      if (v.progress.phase === 'train' && v.progress.total > 0) {
        return [`epoch ${v.progress.current}/${v.progress.total}`];
      }
      return [STAGE_LABEL[v.progress.phase].toLowerCase()];
    }
    if (v.state === 'completed') {
      const tokens: string[] = [];
      const nClasses = v.result?.n_classes ?? 0;
      if (nClasses > 0) {
        tokens.push(`${nClasses} class${nClasses === 1 ? '' : 'es'}`);
      }
      if (bestValAcc !== null) {
        tokens.push(`val ${(bestValAcc * 100).toFixed(1)}%`);
      } else if (v.result && Number.isFinite(v.result.final_train_acc)) {
        tokens.push(`train ${(v.result.final_train_acc * 100).toFixed(1)}%`);
      }
      return tokens;
    }
    // Remaining narrowed state is `failed | cancelled` (the
    // four-variant TrainingJobState union has running /
    // completed exhausted above).  Both surface the same
    // "stopped at <stage>" verdict -- failure colour vs
    // operator-cancel colour is carried by the row's
    // left-border accent, so the header copy is identical.
    return [`stopped at ${STAGE_LABEL[v.progress.phase].toLowerCase()}`];
  });

  let cancelling = $state(false);
  async function onCancelClick(e: MouseEvent): Promise<void> {
    e.stopPropagation();
    if (!oncancel || cancelling || job.cancelling) return;
    cancelling = true;
    try {
      await oncancel();
    } finally {
      cancelling = false;
    }
  }
</script>

<!-- One row.  A 4 px coloured left border is the only edge
     signal that varies per state -- the rest of the card
     stays neutral so a vertical stack reads as a uniform
     stripe of edges (blue = in-flight, emerald = done,
     rose = failed, zinc = cancelled).  The earlier design
     also painted a filled state pill in the header; that's
     gone, and the state word inline carries the same colour
     in text form. -->
<li
  class="overflow-hidden rounded-md border border-zinc-200 border-l-4 bg-white transition-colors"
  class:border-l-blue-500={displayState === 'running' || displayState === 'submitting'}
  class:border-l-emerald-500={displayState === 'completed'}
  class:border-l-rose-500={displayState === 'failed'}
  class:border-l-zinc-400={displayState === 'cancelled'}
>
  <!-- Header.  Clicking anywhere on the header (excluding the
       live-only Cancel button) toggles `expanded` via the
       parent.  The chevron is a child of the toggle button so
       the entire header is one keyboard focus target. -->
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
    <button
      type="button"
      onclick={ontoggle}
      aria-expanded={expanded}
      class="flex min-w-0 flex-1 items-center gap-2.5 text-left"
    >
      <!-- Optical micro-alignment.  Two facts compound:
             1. The chevron path occupies y=5.23..12.71 of
                its 0-20 viewBox, putting its visual centre
                ~0.72 px ABOVE the SVG box centre.
             2. CSS rotate-90 (CW about box centre) flips
                the path's horizontal bias (x mid 9.6, i.e.
                0.28 px left of box centre in rendered px)
                into a vertical bias of +0.28 px BELOW box
                centre, AND simultaneously rotates the
                original vertical bias into a horizontal one.
                Net y-shift from rotation alone: +1 px
                downward of the visual centroid.
           So at items-center alignment:
             - Collapsed: chevron centroid 0.72 ABOVE text.
             - Expanded:  chevron centroid 0.28 BELOW text.
           A static `translate-y-px` (1 px down) corrects the
           collapsed case but compounds the rotated case to
           1.28 px below -- visibly off.  Gating the translate
           on `!expanded` lands BOTH states at 0.28 px below
           text -- sub-half-pixel, consistent direction,
           perceptually aligned.
           Why this composes cleanly: tailwind v4 emits the
           `rotate` and `translate` CSS properties separately
           (not the legacy `transform` shorthand), so the two
           don't fight; the conditional translate simply
           appears/disappears as the disclosure toggles, and
           the rotate animates independently. -->
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
        class="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-200"
        class:translate-y-px={!expanded}
        class:rotate-90={expanded}
      >
        <path
          fill-rule="evenodd"
          d="M7.21 5.23a.75.75 0 011.06.02L12 9l-3.73 3.71a.75.75 0 11-1.06-1.06L9.94 9 7.19 6.29a.75.75 0 01.02-1.06z"
          clip-rule="evenodd"
        />
      </svg>

      <!-- Inline header line.  Three slots:
             {state}  {time} · {trailing detail tokens}
           A faint zinc-300 middot separates the trailing detail
           cluster from the {state, time} pair so the eye reads
           "what + when" first, then "how much".  Inside the
           trailing cluster the gap-2 wrapper handles spacing
           without further separators.  The state word is the
           only coloured element; the timestamp + trailing
           detail stay neutral so a row never reads as a colour
           stripe.  `animate-pulse` rides on the state word for
           live entries (no separate dot element). -->
      <span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <span
          class="shrink-0 font-medium capitalize"
          class:text-blue-700={displayState === 'running' || displayState === 'submitting'}
          class:animate-pulse={isLive}
          class:text-emerald-700={displayState === 'completed'}
          class:text-rose-700={displayState === 'failed'}
          class:text-zinc-600={displayState === 'cancelled'}
        >
          {stateLabel}
        </span>
        <span class="shrink-0 text-zinc-500" title={timeTitle}>
          {timeLabel}
        </span>
        {#if trailingDetail.length > 0}
          <span aria-hidden="true" class="shrink-0 text-zinc-300">·</span>
        {/if}
        {#each trailingDetail as token (token)}
          <span class="shrink-0 font-mono text-[11px] tabular-nums text-zinc-500">
            {token}
          </span>
        {/each}
      </span>
    </button>

    <!-- Live-only Cancel button.  Stops propagation so the
         click doesn't toggle the disclosure underneath.  This
         is the only right-side affordance any state of the
         row exposes — Activate moved to the Heads section
         below and per-row delete folded into the "Clear
         finished" section header action. -->
    {#if isLive && oncancel}
      <div class="flex shrink-0 items-center">
        <Button
          size="sm"
          variant="destructive"
          onclick={onCancelClick}
          loading={cancelling || job.cancelling}
          disabled={job.view === null}
          title="Cancel this training job at the next checkpoint."
        >
          {cancelling || job.cancelling ? 'Cancelling…' : 'Cancel'}
        </Button>
      </div>
    {/if}
  </div>

  <!-- Expanded body: the existing JobProgress component (phase
       strip, progress bar, metrics chart, readout, log
       scrollback).  Slide is fast (220 ms) so a quick browse
       through a stack of expanded items doesn't feel sluggish.
       The body remounts on every expand so the chart re-runs
       its initial measurement -- cheap for the typical
       handful of epochs.  Background switches to a faint tint
       of the state colour so the body reads as belonging to
       the header's verdict. -->
  {#if expanded}
    <div
      transition:slide={{ duration: 220, easing: cubicOut }}
      class="border-t border-zinc-200 bg-zinc-50/60 px-3 py-3"
    >
      <JobProgress {job} />
    </div>
  {/if}
</li>
