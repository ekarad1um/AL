<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import TrainHistoryItem from './TrainHistoryItem.svelte';
  import {
    training as trainingStore,
    TRAINING_HISTORY_MAX_PER_WS,
    TRAINING_HISTORY_PAGE_SIZE
  } from '$lib/stores/training.svelte';
  import type { TrackedTrainingJob } from '$lib/stores/training.svelte';
  import type { Uuid } from '$lib/api/types';

  // Workspace-scoped training-history list.  Renders the live
  // job (if any, at the top, auto-expanded) followed by an
  // eager tier of the most-recent terminal runs and an
  // expandable "older runs" section paged from the durable
  // JSONL backstop.
  //
  // ## Visibility tiers (since the persistent-history hydration
  //    landed in 2026-05)
  //
  // The list is split into three regions so the operator's
  // typical question ("what did I just run") answers at the
  // lowest possible cost on mount, while the rest of the
  // backend's keep-last-N retention window is a click away:
  //
  //   - **Eager tier** (top, always visible):
  //       active card (if any, auto-expanded) +
  //       top `INITIAL_VISIBLE` non-hidden history rows.
  //       Costs 1 directory listing + 2 JSONL fetches on mount.
  //   - **Older disclosure** (below the eager tier, collapsed
  //     by default):
  //       "▾ Show N older runs" — total non-hidden runs
  //       beyond the eager tier (loaded or not).  Expanding
  //       triggers a re-list of the directory so N reflects
  //       the backend's current keep-last-N state, not the
  //       mount-time snapshot the producer's retention has
  //       since drifted past.
  //   - **Older list** (inside the disclosure, when expanded):
  //       every history row past the eager tier, plus a "Load
  //       N more ↓" pagination button when more remain
  //       undiscovered.  Each "Load more" click fetches up to
  //       `TRAINING_HISTORY_PAGE_SIZE` JSONLs in parallel
  //       (bounded so the burst stays cheap on eMMC); the
  //       first expand auto-fires one batch so the operator
  //       sees content immediately.
  //
  // ## Loading + empty state choreography
  //
  // The skeleton placeholder shows ONLY while
  // `trainingStore.hydratingFor(workspaceId)` is true and the
  // eager tier is empty -- prevents the "no past training
  // runs yet" empty state from flashing during a fast
  // hydration.  After hydration completes, the empty state
  // surfaces only if there are truly zero discovered runs
  // and zero session-observed terminals.
  //
  // ## Why a single list (vs. live + history sections)
  //
  // The layout invariant the redesign is built on: an
  // operator's eye should never re-anchor when a run
  // terminates.  Keying the `{#each}` on `job.jobId` makes the
  // active→terminal transition a same-DOM-node update: the
  // item slides from `store.active` into `store.history`'s
  // index-0 slot but its component instance, expansion state,
  // and DOM position stay put.
  //
  // ## Expansion state ownership
  //
  // Per-item expansion lives here (a `SvelteSet<Uuid>`), not
  // on the items.  Items are stateless collapsible cards
  // driven by `expanded={...}` + `ontoggle`.  Live entries
  // auto-add to the set on first observation; manual collapse
  // sticks across the active→terminal transition.
  //
  // The "older runs" accordion expansion lives on the store
  // (`olderExpandedFor`) so it survives TrainPane remounts
  // within the session.

  interface Props {
    workspaceId: Uuid;
  }
  let { workspaceId }: Props = $props();

  // ── Store-derived state ─────────────────────────────────────

  const active = $derived(trainingStore.activeFor(workspaceId));
  const eagerHistory = $derived(trainingStore.eagerHistoryFor(workspaceId));
  const olderHistory = $derived(trainingStore.olderHistoryFor(workspaceId));
  const hydrating = $derived(trainingStore.hydratingFor(workspaceId));
  const loadingMore = $derived(trainingStore.loadingMoreFor(workspaceId));
  const olderExpanded = $derived(trainingStore.olderExpandedFor(workspaceId));
  const loadableOlder = $derived(trainingStore.loadableOlderCountFor(workspaceId));

  // Visible eager-tier items: active (if any) + the top
  // `INITIAL_VISIBLE` history rows.  Keyed by jobId so the
  // active→terminal transition preserves expansion + DOM
  // identity.
  const eagerItems = $derived<TrackedTrainingJob[]>(
    active ? [active, ...eagerHistory] : [...eagerHistory]
  );

  // Count of "older runs" still accessible to the operator
  // (loaded into history beyond the eager tier + still
  // discoverable but not yet loaded).  Drives the "Show N
  // older runs" disclosure button when collapsed.
  const olderTotal = $derived(olderHistory.length + loadableOlder);

  // True when this surface has nothing to render and nothing
  // to fetch -- distinct from "loading", which renders
  // skeletons.  Shows the "no past runs" empty state.
  const isEmpty = $derived(
    !hydrating &&
      !active &&
      eagerHistory.length === 0 &&
      olderHistory.length === 0 &&
      loadableOlder === 0
  );

  // True when the eager tier has zero rendered cards AND
  // hydration is still in flight -- skeletons stand in for
  // the about-to-arrive cards so the layout below them
  // (older disclosure, hyperparameter section, heads list)
  // doesn't jump on first paint.
  const showEagerSkeletons = $derived(hydrating && eagerItems.length === 0);

  // ── Expansion bookkeeping (per-item, ephemeral) ─────────────

  const expanded = new SvelteSet<Uuid>();
  const autoExpandedSeen = new SvelteSet<Uuid>();
  // Job ids we've already observed in the older tier.  Used to
  // detect the eager→older transition exactly once per id so a
  // run that was expanded while in the eager tier (typically
  // because it was the live job that just terminated) auto-
  // collapses the first time it gets pushed past
  // `INITIAL_VISIBLE`.  Subsequent shifts within older don't
  // re-collapse a manually re-expanded row.
  const seenInOlder = new SvelteSet<Uuid>();

  // Workspace-navigation reset.  The three sets above are
  // component-instance scoped and survive `[id]` param changes
  // because SvelteKit re-uses `+page.svelte` across workspace
  // navigation (no `{#key}` wrapper).  Without this reset,
  // stale jobId entries accumulate across visits -- and
  // `expanded` / `autoExpandedSeen` / `seenInOlder` from
  // workspace A could (in the astronomical UUID-collision
  // case) interfere with workspace B's auto-expand and
  // auto-collapse decisions.  Plain `let` for the cursor
  // because no consumer outside this effect needs to track
  // it; writes shouldn't drive reactivity.
  //
  // Placed BEFORE the auto-expand effect so a workspace flip
  // clears first; then the auto-expand re-populates for the
  // new workspace's active job in the same tick.  Effect
  // declaration order is the run order in Svelte 5.
  let lastWorkspaceIdSeen: Uuid | null = null;
  $effect(() => {
    const ws = workspaceId;
    if (lastWorkspaceIdSeen === ws) return;
    lastWorkspaceIdSeen = ws;
    expanded.clear();
    autoExpandedSeen.clear();
    seenInOlder.clear();
  });

  $effect(() => {
    const a = active;
    if (!a) return;
    if (autoExpandedSeen.has(a.jobId)) return;
    autoExpandedSeen.add(a.jobId);
    expanded.add(a.jobId);
  });

  // Auto-collapse on eager→older transition.  The user's typical
  // mental model puts the eager tier in active focus (live + the
  // last couple of finished runs); rows that drop into the older
  // section have moved out of that focus and stale expansion just
  // bloats the section's height when the operator opens "Show
  // older runs" later.  We collapse exactly once per id (gated by
  // `seenInOlder`) so the operator can still manually re-expand
  // and have it stick.
  $effect(() => {
    for (const job of olderHistory) {
      if (seenInOlder.has(job.jobId)) continue;
      seenInOlder.add(job.jobId);
      expanded.delete(job.jobId);
    }
  });

  function toggle(jobId: Uuid): void {
    if (expanded.has(jobId)) expanded.delete(jobId);
    else expanded.add(jobId);
  }

  // ── Action handlers ─────────────────────────────────────────
  //
  // Cancel is intentionally NOT routed through here.  The
  // TrainPane header's primary button morphs to Cancel on the
  // running state (variant=destructive, single canonical
  // action surface for the run lifecycle), so duplicating the
  // affordance per-row would render two red Cancel buttons on
  // screen at the same time -- competing for attention and
  // splitting the operator's mental model of "where do I stop
  // this run."  The header is also the slot the operator
  // already used to start the job, so the eye doesn't need to
  // re-anchor when the action flips polarity.

  function onToggleOlder(): void {
    trainingStore.setOlderExpanded(workspaceId, !olderExpanded);
  }

  async function onLoadMore(): Promise<void> {
    await trainingStore.loadMoreHistory(workspaceId);
  }

  // ── Render helpers ──────────────────────────────────────────

  // Plural-safe label fragment ("run" vs. "runs").  Inlined
  // here rather than as a top-level export because every
  // call site is in this file.
  function runWord(n: number): string {
    return n === 1 ? 'run' : 'runs';
  }
</script>

<!-- Section header.  No "Clear finished" affordance: the
     daemon enforces a keep-last-N cap per workspace per log
     tree at every producer open
     (`modules/file_mgr/log_retention.rs`,
     `LOG_RETENTION_KEEP_COUNT`).  A manual clear-all path
     was redundant — and the previous per-entry fan-out
     tripped the daemon's `max_delete_jobs = 1` admission
     slot, so the operator thought they'd cleared all rows
     but only one disk file actually got deleted.
     Producer-side retention is the right layer for this
     policy; the right side of the header carries a muted
     retention hint so an operator wondering "where did my
     (N+1)th-newest run go?" has the answer in peripheral
     vision rather than having to dig through daemon docs.
     The visible `N` interpolates `TRAINING_HISTORY_MAX_PER_WS`
     (the store's mirror of the daemon constant), so the UI
     copy stays single-sourced against the gate; the daemon ↔
     frontend coupling is the only place that still has to
     move in lockstep. -->
<div class="flex flex-col gap-2">
  <div class="flex items-baseline justify-between">
    <h3 class="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">History</h3>
    {#if eagerHistory.length + olderHistory.length + loadableOlder > 0}
      <!-- Retention hint.  Non-interactive, one notch lighter
           than the section title (zinc-400 vs zinc-500) so it
           reads as auxiliary metadata, not an action.  Sits
           in the slot the Clear finished button used to
           occupy so the header geometry stays balanced and
           operators who learned to look right for "history
           controls" find the explanation there.  The full
           policy lives in the `title` tooltip for operators
           who hover; the visible copy is just the headline
           number so the visual cost is one short phrase. -->
      <span
        class="text-[10px] text-zinc-400"
        title="The daemon keeps the {TRAINING_HISTORY_MAX_PER_WS} most recent training-log files per workspace; older JSONL traces are pruned when a new run opens. The published head record (in the Heads section below) is unaffected — only the JSONL trace is pruned."
      >
        Keeps last {TRAINING_HISTORY_MAX_PER_WS} runs
      </span>
    {/if}
  </div>

  {#if isEmpty}
    <!-- Empty state.  Sized to roughly the visual weight of a
         single collapsed history item so the section's height
         is stable between "no runs" and "one run" -- the
         first-ever submit doesn't shift the heads list below
         by half a card. -->
    <div
      class="flex items-center gap-2 rounded-md border border-dashed border-zinc-200 bg-zinc-50/60 px-3 py-3 text-[11px] text-zinc-500"
    >
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
        class="h-4 w-4 shrink-0 text-zinc-400"
      >
        <path
          fill-rule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .2.08.39.22.53l3 3a.75.75 0 101.06-1.06l-2.78-2.78V5z"
          clip-rule="evenodd"
        />
      </svg>
      <span>No training runs yet for this workspace. Click <b>Train head</b> to start one.</span>
    </div>
  {:else}
    <!-- Eager tier: active + top INITIAL_VISIBLE non-hidden
         history rows.  `gap-2` matches the heads-list rhythm
         so the two stacked sections (this list + the heads
         list below) read as the same primitive. -->
    <ul class="flex flex-col gap-2">
      {#each eagerItems as job (job.jobId)}
        <TrainHistoryItem
          {job}
          isLive={active?.jobId === job.jobId}
          expanded={expanded.has(job.jobId)}
          ontoggle={() => toggle(job.jobId)}
        />
      {/each}
      {#if showEagerSkeletons}
        <!-- Two skeleton rows matching INITIAL_VISIBLE.  Sized
             to a collapsed-card footprint (h-10 = 40 px) so
             the layout below this region doesn't jump as the
             real cards land. -->
        <li
          aria-hidden="true"
          class="h-10 animate-pulse overflow-hidden rounded-md border border-zinc-200 border-l-4 border-l-zinc-200 bg-white"
        >
          <div class="flex items-center gap-x-3 px-3 py-2.5">
            <span class="h-3 w-3 shrink-0 rounded-full bg-zinc-200"></span>
            <span class="h-3 w-16 shrink-0 rounded bg-zinc-200"></span>
            <span class="h-3 w-20 shrink-0 rounded bg-zinc-200"></span>
            <span class="h-3 w-12 shrink-0 rounded bg-zinc-200"></span>
          </div>
        </li>
        <li
          aria-hidden="true"
          class="h-10 animate-pulse overflow-hidden rounded-md border border-zinc-200 border-l-4 border-l-zinc-200 bg-white"
        >
          <div class="flex items-center gap-x-3 px-3 py-2.5">
            <span class="h-3 w-3 shrink-0 rounded-full bg-zinc-200"></span>
            <span class="h-3 w-14 shrink-0 rounded bg-zinc-200"></span>
            <span class="h-3 w-24 shrink-0 rounded bg-zinc-200"></span>
            <span class="h-3 w-10 shrink-0 rounded bg-zinc-200"></span>
          </div>
        </li>
      {/if}
    </ul>

    {#if olderTotal > 0}
      <!-- Older-runs disclosure.  Closed by default; opening
           kicks off `loadMoreHistory` if no older rows are
           loaded yet (handled by the store's
           `setOlderExpanded`).  Mirrors the Hyperparameters
           disclosure pattern in TrainPane so the two surfaces
           feel like one primitive. -->
      <div class="flex flex-col gap-2">
        <!-- Center-aligned section-transition affordance.
             Reads as a pagination gate ("you are here ⇄ older
             runs"), not as an action glued to the column above.
             The verb in the label ("Show" / "Hide") carries
             the disclosure affordance on its own; the earlier
             rotating chevron was redundant with the centered
             framing.
             ## Why hairline rules instead of middots
             An earlier pass used `·  label  ·` -- middots as
             decorative bookends inside the button.  The middot
             is a *punctuation separator* (we already use it
             that way in card subtitles like "16 KiB · rev 542
             · 3 h ago"), so reusing the glyph for a *section
             divider* role asks the operator's eye to do double
             duty.  Hairline rules (`h-px w-6 bg-zinc-200`)
             express "divider" graphically: they share the
             card-border colour so they read as the section's
             own structural language, not as bookend
             punctuation.
             ## Why outside the button, not inside
             The rules belong to the section, not the button.
             Keeping them as sibling spans:
               - Keeps the click target the verb only.
               - Lets the button's hover bg pill stay a clean
                 rectangle around the label; the rules stay
                 neutral on hover.
               - Lets the rules extend visually beyond what
                 the click target should ever include.
             `-mt-1` and the conditional `-mb-X` margins on the
             wrapper tighten the spacing around the toggle to
             4 / 4 around the hover bg pill (was 8 / 8 -- this
             pager is a navigation hint, not an action that
             warrants its own breathing room).  The top is
             uniform: `-mt-1` pulls 4 px out of the parent
             flex-col's `gap-2` (8 px), leaving 4 px above the
             bg pill.  The bottom branches:
               - Collapsed (`-mb-4`): wrapper is the last visible
                 element of the Train section, so the 16 px pull
                 combines with the section's 20 px bottom padding
                 (`p-5`) to leave 4 px visible below the bg pill.
               - Expanded (`-mb-1`): wrapper is followed by the
                 older-runs container, so a 4 px pull reduces
                 the parent's 8 px `gap-2` to 4 px visible.
             Unconditional `-mb-4` would overlap the toggle with
             the first older card when expanded, hence the
             class:directive split. -->
        <div
          class="-mt-1 flex items-center justify-center gap-2.5"
          class:-mb-4={!olderExpanded}
          class:-mb-1={olderExpanded}
        >
          <span class="h-px w-6 bg-zinc-200" aria-hidden="true"></span>
          <button
            type="button"
            onclick={onToggleOlder}
            aria-expanded={olderExpanded}
            class="rounded-md px-2 py-0.5 text-[11px] text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
            title={olderExpanded
              ? 'Collapse the older runs section back to the recent two.'
              : 'Reveal older training runs for this workspace, paged in batches of 5.'}
          >
            {#if olderExpanded}
              Hide older runs
            {:else}
              Show <span class="font-mono tabular-nums">{olderTotal}</span>
              older {runWord(olderTotal)}
            {/if}
          </button>
          <span class="h-px w-6 bg-zinc-200" aria-hidden="true"></span>
        </div>

        {#if olderExpanded}
          <div in:fade={{ duration: 200, easing: cubicOut }} class="flex flex-col gap-2">
            {#if olderHistory.length > 0}
              <ul class="flex flex-col gap-2">
                {#each olderHistory as job (job.jobId)}
                  <TrainHistoryItem
                    {job}
                    isLive={false}
                    expanded={expanded.has(job.jobId)}
                    ontoggle={() => toggle(job.jobId)}
                  />
                {/each}
              </ul>
            {/if}

            {#if loadingMore}
              <!-- One skeleton row while the next page is in
                   flight.  A single row is enough to convey
                   "more incoming" without dominating the
                   layout. -->
              <div
                aria-hidden="true"
                class="h-10 animate-pulse overflow-hidden rounded-md border border-zinc-200 border-l-4 border-l-zinc-200 bg-white"
              >
                <div class="flex items-center gap-x-3 px-3 py-2.5">
                  <span class="h-3 w-3 shrink-0 rounded-full bg-zinc-200"></span>
                  <span class="h-3 w-16 shrink-0 rounded bg-zinc-200"></span>
                  <span class="h-3 w-24 shrink-0 rounded bg-zinc-200"></span>
                </div>
              </div>
            {/if}

            {#if loadableOlder > 0 && !loadingMore}
              <!-- "Load N more" pagination control.  Same
                   center-aligned, hairline-rule-framed
                   treatment as the parent "Show N older runs"
                   toggle -- both controls read as section-
                   transition affordances (pagination gates)
                   rather than actions attached to the column
                   above.  Tone stays one step lighter
                   (zinc-500 vs the parent's zinc-600) so the
                   visual hierarchy reads as primary → content
                   → auxiliary by colour alone; matching
                   footprint (px-2 py-1, text-[11px], same
                   hairline framing) keeps the two siblings.
                   `-mt-1` + `-mb-4` on the wrapper balance the
                   y-axis on hover at the tighter 4 / 4 budget
                   (matching the parent "Show N older runs"
                   toggle above): top pulls 4 px out of the
                   parent flex-col's 8 px `gap-2`, and bottom
                   pulls 16 px out of the section's 20 px `p-5`
                   bottom padding -- both leaving 4 px visible
                   around the hover bg pill. -->
              <div class="-mt-1 -mb-4 flex items-center justify-center gap-2.5">
                <span class="h-px w-6 bg-zinc-200" aria-hidden="true"></span>
                <button
                  type="button"
                  onclick={() => void onLoadMore()}
                  class="rounded-md px-2 py-0.5 text-[11px] text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
                  title="Fetch the next batch of older training runs from the daemon."
                >
                  Load <span class="font-mono tabular-nums"
                    >{Math.min(loadableOlder, TRAINING_HISTORY_PAGE_SIZE)}</span
                  >
                  more
                </button>
                <span class="h-px w-6 bg-zinc-200" aria-hidden="true"></span>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>
