<script lang="ts">
  import { tick } from 'svelte';
  import { STAGE_LABEL } from './labels';
  import type { TrainingLogLine } from '$lib/stores/training.svelte';

  // Rolling progress-message log surface.  Reads from the training
  // store's per-job `logLines` (built up across poll ticks; see
  // [stores/training.svelte.ts] §"rolling progress-message log").
  // The daemon does not retain message history, so this client-
  // synthesised log is the only place an operator can re-read the
  // trace of a run.
  //
  // ## Visual treatment
  //
  // Each line is a two-column row: a left tabular-nums time
  // column + the free-form message text.  The phase chip that
  // earlier revisions rendered between the two -- `[loading]`,
  // `[feature_extract]`, `[train]` -- has been dropped: the
  // stage strip at the top of the JobProgress body already
  // names the current stage at a glance, and bracketed tags
  // in every row competed with the message content (which is
  // what the operator actually wants to read).  The phase is
  // still attached to each row's `title` for hover lookup, so
  // power users with a tooltip on the time column see the
  // stage without spending header real estate on it.
  //
  // ## Consistency live vs. frozen
  //
  // The component is identical between an in-flight job (new
  // lines stream in, auto-tail keeps the floor in view) and a
  // terminated job (the array is frozen at the synthesised
  // terminal-summary line).  Same chrome, same density, same
  // typography.  An operator looking at a recent terminal in
  // the history list reads the trace the same way they read
  // it during the run -- no jarring visual shift.
  //
  // ## Auto-tail discipline
  //
  // Scroll to bottom on every new line only when the operator
  // is already pinned at the bottom (within STICK_PX of the
  // floor).  If they've scrolled up to inspect earlier output,
  // leave the scroll position alone so a fresh tick doesn't
  // yank them back to the bottom mid-read.  The bottom-anchor
  // check runs against the pre-update scroll state captured
  // before the lines reactive re-render so the discipline
  // holds even when the new line is the same height as a
  // sibling.

  interface Props {
    lines: readonly TrainingLogLine[];
    // Height (px) of the scrollback viewport.  Default sized to
    // ~7 lines at the project's `text-[10px]` mono cadence;
    // matches the JobProgress metrics-strip + chart proportion
    // so the log feels like a sibling surface, not a detour.
    height?: number;
  }
  let { lines, height = 144 }: Props = $props();

  // Threshold (px) below `scrollHeight - clientHeight` within
  // which we consider the operator pinned at the floor.  A small
  // buffer absorbs sub-pixel rounding from device pixel ratios.
  const STICK_PX = 4;

  let scrollEl: HTMLDivElement | undefined = $state();
  // Tracks the operator's intent: are they reading the tail
  // (true), or have they scrolled up (false)?  Initially true so
  // a freshly-mounted log auto-scrolls to its bottom on first
  // paint.
  let stuckToBottom = $state(true);

  function onScroll(): void {
    const el = scrollEl;
    if (!el) return;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    stuckToBottom = distance <= STICK_PX;
  }

  // Auto-tail on new lines.  We depend on `lines.length` rather
  // than the array reference so a no-op tick (store returns the
  // same array) doesn't fire the effect.  `await tick()` waits
  // for the DOM to reflect the new lines before we read
  // `scrollHeight` -- otherwise the scrollTop assignment lands
  // before the new node mounts and the tail snaps short.
  $effect(() => {
    void lines.length;
    if (!stuckToBottom) return;
    const el = scrollEl;
    if (!el) return;
    void tick().then(() => {
      el.scrollTop = el.scrollHeight;
    });
  });

  function fmtTime(at: string): string {
    // Parse defensively; the daemon hands back RFC 3339 but a
    // synthetic line (e.g. the "submitted; waiting for daemon
    // ack" seeded entry) uses `new Date().toISOString()` and
    // both round-trip through `Date` cleanly.
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return d.toLocaleTimeString([], { hour12: false });
  }
</script>

<!-- Mini-console scrollback.  Fixed height + internal scroll so
     the log can't drive the surrounding card taller as messages
     accumulate.  The header strip names the surface; the count
     hints at scrollback depth so the operator knows whether
     anything's been clipped at the cap (MAX_LOG_LINES = 500).
     Card chrome matches the metrics readout strip
     (`border-zinc-200 bg-zinc-50 rounded-md`) so the two siblings
     read as the same primitive. -->
<div class="overflow-hidden rounded-md border border-zinc-200 bg-zinc-50">
  <div class="flex items-baseline justify-between border-b border-zinc-200 bg-white px-3 py-1.5">
    <span class="text-[10px] font-medium text-zinc-500">Logs</span>
    <span class="font-mono text-[10px] text-zinc-400 tabular-nums">
      {lines.length}
      {lines.length === 1 ? 'entry' : 'entries'}
    </span>
  </div>
  <div
    bind:this={scrollEl}
    onscroll={onScroll}
    class="overflow-y-auto px-3 py-2 text-[11px]"
    style="height: {height}px;"
    role="log"
    aria-live="polite"
    aria-relevant="additions"
  >
    {#if lines.length === 0}
      <p class="font-mono text-[10px] text-zinc-400">Waiting for the first message…</p>
    {:else}
      <!-- Key by `line.seq` so a cap-driven shift (oldest dropped,
           newest appended at MAX_LOG_LINES) recycles unchanged
           rows in place instead of re-rendering every node at
           its new index.  The daemon's seq is monotonic per job
           and the store's synthetic seed uses seq=-1, which is
           unique per active slot, so collisions can't happen. -->
      <ol class="flex flex-col gap-0.5 font-mono leading-snug">
        {#each lines as line (line.seq)}
          <li class="flex gap-2 text-zinc-700">
            <!-- Time column.  `title` carries the full ISO
                 timestamp + the originating stage so a hover
                 still surfaces the per-line phase the bracket
                 tag used to display inline. -->
            <span
              class="shrink-0 text-zinc-400 tabular-nums"
              title="{line.at} · {STAGE_LABEL[line.phase]}"
            >
              {fmtTime(line.at)}
            </span>
            <span class="break-words whitespace-pre-wrap text-zinc-800">{line.message}</span>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</div>
