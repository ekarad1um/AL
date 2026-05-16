<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import TrainHistoryItem from './TrainHistoryItem.svelte';
  import {
    training as trainingStore,
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
  // The list is split into three regions so a workspace with
  // 50 past runs doesn't bake 50 HTTP requests into every
  // mount, but the operator's typical question ("what did I
  // just run") still answers at the lowest possible cost:
  //
  //   - **Eager tier** (top, always visible):
  //       active card (if any, auto-expanded) +
  //       top `INITIAL_VISIBLE` non-hidden history rows.
  //       Costs 1 directory listing + 2 JSONL fetches on mount.
  //   - **Older disclosure** (below the eager tier, collapsed
  //     by default):
  //       "▾ Show N older runs" — total non-hidden runs
  //       beyond the eager tier (loaded or not).
  //   - **Older list** (inside the disclosure, when expanded):
  //       every history row past the eager tier, plus a "Load
  //       N more ↓" pagination button when more remain
  //       undiscovered.  Each "Load more" fetches PAGE_SIZE
  //       JSONLs in parallel.
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

  async function onCancelActive(): Promise<void> {
    try {
      await trainingStore.cancel();
    } catch {
      // Store logs the failure; the item re-enables itself.
    }
  }

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
     daemon's storage reaper auto-prunes per-workspace JSONL
     logs older than 30 days (`storage_reaper.rs`,
     `LOG_AGE_THRESHOLD = 30 * 24 * 3600`, swept hourly).  A
     manual clear-all path was redundant — and the previous
     per-entry fan-out tripped the daemon's
     `max_delete_jobs = 1` admission slot, so the operator
     thought they'd cleared all rows but only one disk file
     actually got deleted.  Auto-rotation is the right layer
     for this policy; the right side of the header carries a
     muted retention hint so an operator wondering "where did
     my run from 2 months ago go?" has the answer in
     peripheral vision rather than having to dig through
     daemon docs. -->
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
        title="The daemon automatically removes per-workspace training-log files older than 30 days. The published head record (in the Heads section below) is unaffected — only the JSONL trace is pruned."
      >
        Auto-rotated after 30 days
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
          oncancel={active?.jobId === job.jobId ? onCancelActive : undefined}
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
             `-mb-3` lives on the WRAPPER (not the button)
             because the wrapper is the flex-column child now.
             It applies ONLY when the disclosure is collapsed:
             in that branch the wrapper is the last visible
             element of the Train section, so the same y-axis
             imbalance the pager fixes (8 px gap-2 above, 20
             px section `p-5` below) would otherwise show up
             here on hover.  Pulling the section's bottom
             inward by 12 px gives a symmetric 8 / 8 around the
             hover bg pill.  When the disclosure is OPEN the
             wrapper is followed by the expanded content
             (gap-2 below), so applying `-mb-3` unconditionally
             would overlap the toggle with the first older
             card -- the class:directive gates it on
             `!olderExpanded`. -->
        <div class="flex items-center justify-center gap-2.5" class:-mb-3={!olderExpanded}>
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
                   `-mb-3` on the wrapper balances the y-axis
                   on hover without sacrificing compactness:
                   the wrapper keeps its tight 8 px gap-2
                   above and pulls the section's 20 px `p-5`
                   bottom inward by 12 px, so the visible gap
                   below the bg pill collapses to 8 px too.
                   Symmetric 8 / 8 in the hovered state, and
                   the section is 12 px shorter overall
                   (compactness preserved) -- the earlier
                   `mt-3` fix balanced by ADDING 12 px above,
                   which got us to 20 / 20 at the cost of
                   vertical bloat. -->
              <div class="-mb-3 flex items-center justify-center gap-2.5">
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
