<script lang="ts">
  import { slide, fade, scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { categories, type Category } from '$lib/stores/categories.svelte';
  import { slices, type CategorySyncStatus } from '$lib/stores/slices.svelte';
  import { isMandatoryCategory, prettyCategoryName, thresholdFor } from './labels';
  import InputPane from './InputPane.svelte';
  import SlicePane from './SlicePane.svelte';
  import Spinner from '$lib/components/Spinner.svelte';
  import type { Uuid } from '$lib/api/types';

  // One row in the per-workspace category accordion.  Header (always
  // visible) carries the disclosure chevron, display name, and the
  // AssetPath form as a secondary mono tag for the operator who
  // wants to verify the on-disk shape.  Body (visible only when
  // `expanded`) hosts the per-category Input Module (B.3, left
  // pane) and Slice Management (B.5, right pane).  Slice
  // Management is a placeholder until B.5 ships.
  //
  // Single-expand UX: clicking the header tells the store to toggle;
  // the store collapses any other expanded row in the same workspace.
  // The parent doesn't need to coordinate state across rows.
  //
  // `workspaceName` flows down for the export filename pattern
  // (`<workspace>-<category>-<rfc3339>.wav`).  The parent owns it
  // because the workspace detail page already has the workspace's
  // `name` field; threading through the row keeps the InputPane
  // self-contained.
  interface Props {
    workspaceId: Uuid;
    workspaceName: string;
    category: Category;
    expanded: boolean;
    // Inline delete callback.  The CategoryList owns the dialog
    // + store-level lifecycle (it already wires the right-click
    // menu through the same dialog); this prop just gives the
    // operator a discoverable affordance without forcing the
    // right-click flow.  Mandatory `_background_noise_` receives
    // `undefined`; the button still renders for that row but with
    // a slashed icon + `disabled`, giving the row the same visual
    // rhythm without the destructive affordance.
    onDelete?: () => void;
  }
  let { workspaceId, workspaceName, category, expanded, onDelete }: Props = $props();
  const isMandatory = $derived(isMandatoryCategory(category.name));

  const slice = $derived(categories.for(workspaceId));
  const isDeleting = $derived(slice.deleting.has(category.name));
  const display = $derived(prettyCategoryName(category.name));

  // Quota: per-category training-ready threshold (20 for
  // `_background_noise_`, 10 elsewhere).  Counts come from the
  // bulk `slices.refreshForWorkspace` triggered by CategoryList.
  const sliceCount = $derived(slices.countFor(workspaceId, category.name));
  const threshold = $derived(thresholdFor(category.name));
  const syncStatus = $derived(slices.syncStatusFor(workspaceId, category.name));

  // Unified row badge.  Tone + text by combined (quota, sync) state:
  //   satisfied + synced     → emerald "✓ Synced"
  //   satisfied + uploading  → amber   "Uploading"
  //   satisfied + pending    → amber   "Pending"
  //   short + empty          → amber   "Not enough samples"
  //   short + non-empty      → amber   "Not enough samples · <state>"
  //   any failed             → rose    "Failed" (or "… · Failed")
  // Width is content-driven; the measurement transition on
  // `textWidth` smooths the cross-label glide so a min-width floor
  // is not needed.  Chip footprint `px-1.5 py-0.5 text-[10px]`
  // matches the TrainPane summary chips so every small pill in the
  // app shares one padding rhythm; colour + weight diverge because
  // this badge carries status, not data.
  type BadgeTone = 'emerald' | 'amber' | 'rose';
  // Only "Synced" carries an icon (check).  Other states are
  // text-only — a stationary glyph on a status pill is chrome.
  type BadgeIcon = 'check' | null;
  interface Badge {
    tone: BadgeTone;
    icon: BadgeIcon;
    text: string;
    title: string;
  }

  function computeBadge(count: number, N: number, status: CategorySyncStatus): Badge {
    const satisfied = count >= N;
    const tally = `${count}/${N}`;
    if (status === 'failed') {
      return {
        tone: 'rose',
        icon: null,
        text: satisfied ? 'Failed' : 'Not enough samples · Failed',
        title: `${tally} slices; at least one upload failed. Retry from the slice card or discard the failed rows.`
      };
    }
    if (satisfied) {
      if (status === 'synced') {
        return {
          tone: 'emerald',
          icon: 'check',
          text: 'Synced',
          title: `${tally} slices uploaded to the daemon -- training-ready.`
        };
      }
      if (status === 'uploading') {
        return {
          tone: 'amber',
          icon: null,
          text: 'Uploading',
          title: `${tally} slices; some are still uploading to the daemon.`
        };
      }
      // status === 'pending' (satisfied + has local-only slices)
      return {
        tone: 'amber',
        icon: null,
        text: 'Pending',
        title: `${tally} slices ready but not yet uploaded to the daemon.`
      };
    }
    // ── Not satisfied ─────────────────────────────────────────
    if (status === 'empty') {
      return {
        tone: 'amber',
        icon: null,
        text: 'Not enough samples',
        title: `Add ${N - count} more slices to satisfy the per-category quota (${tally}).`
      };
    }
    const statusLabel =
      status === 'synced' ? 'Synced' : status === 'uploading' ? 'Uploading' : 'Pending';
    return {
      tone: 'amber',
      icon: null,
      text: `Not enough samples · ${statusLabel}`,
      title:
        status === 'synced'
          ? `${tally} slices uploaded; add ${N - count} more to satisfy the per-category quota.`
          : status === 'uploading'
            ? `${tally} slices; some are still uploading. Need ${N - count} more once they finish.`
            : `${tally} slices queued locally; need ${N - count} more.`
    };
  }

  const badge = $derived(computeBadge(sliceCount, threshold, syncStatus));

  // Badge text-width measurement.  An off-screen mirror renders
  // the *current* label at the badge's font + weight; on every
  // change we read its measured width and apply it to the visible
  // text wrapper as an inline `width`.  CSS then interpolates the
  // wrapper between labels so the pill glides between "Synced"
  // (narrow) and "Not enough samples · Pending" (wide) instead of
  // snapping.  Without this the `inline-grid grid-cols-1` cell
  // sizes to `max(old, new)` for the lifetime of the {#key} swap,
  // which jumps to the wider label the instant the new span
  // mounts (grow case) and snaps back to the narrower label the
  // instant the old span finishes its out-fade (shrink case) --
  // a visible jolt either way.
  let measureEl: HTMLSpanElement | undefined = $state();
  let textWidth: number | null = $state(null);
  $effect(() => {
    void badge.text;
    if (!measureEl) return;
    textWidth = measureEl.getBoundingClientRect().width;
  });

  function onHeaderClick(): void {
    if (isDeleting) return;
    categories.toggleExpand(workspaceId, category.name);
  }

  function onHeaderKey(e: KeyboardEvent): void {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onHeaderClick();
  }

  function onDeleteClick(e: MouseEvent): void {
    // Stop propagation so the click on the trash icon doesn't
    // also toggle the row's expanded state.  preventDefault is
    // unnecessary -- a <button> has no default action.
    e.stopPropagation();
    if (isDeleting || isMandatory) return;
    onDelete?.();
  }
</script>

<li
  data-category-name={category.name}
  class="group/row overflow-hidden rounded-lg border bg-white transition hover:shadow-sm {expanded
    ? 'border-zinc-300'
    : 'border-zinc-200 hover:border-zinc-300'}"
  class:opacity-60={isDeleting}
>
  <!-- Header and expanded body share `px-3` so the chevron's
       x-offset matches the pane border below it (a mismatched
       `px-4` body would leave a 4 px kink at the boundary).  The
       same `px-3` is used by the train module's accordion family
       (TrainHistoryItem, TrainPane "Hyperparameters", TrainLogs)
       so disclosure rows across both modules share one
       chevron-to-edge geometry.  `py-1.5` runs tighter than the
       train accordions' `py-2` because the dataset surface has
       more rows per pane; TrainLogs matches at `py-1.5`. -->
  <div
    role="button"
    tabindex={isDeleting ? -1 : 0}
    aria-expanded={expanded}
    aria-controls="category-body-{category.name}"
    aria-disabled={isDeleting}
    onclick={onHeaderClick}
    onkeydown={onHeaderKey}
    class="flex cursor-pointer items-center gap-2 px-3 py-1.5 transition select-none"
    class:cursor-not-allowed={isDeleting}
    class:pointer-events-none={isDeleting}
  >
    <!-- Disclosure chevron.  Rotation animates with the row's
         expansion so the affordance reads as one motion.
         Optical micro-alignment: the path's filled mass occupies
         y=5.23..12.71 in a 0..20 viewBox -- ~1 px above box centre.
         At `items-center` the collapsed chevron therefore sits ~1
         px above the text mid-line; rotate-90 swings the bias into
         the horizontal axis, so the expanded chevron lands near
         text centre on its own.  `translate-y-px` only when
         collapsed nudges the resting state down to match.  Same
         trick the TrainHistoryItem / TrainPane chevrons use, so
         the dataset and train accordions stay mechanically
         identical. -->
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      class="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-200"
      class:translate-y-px={!expanded}
      class:rotate-90={expanded}
    >
      <path
        fill-rule="evenodd"
        d="M7.21 5.23a.75.75 0 011.06.02L12 9l-3.73 3.71a.75.75 0 11-1.06-1.06L9.94 9 7.19 6.29a.75.75 0 01.02-1.06z"
        clip-rule="evenodd"
      />
    </svg>
    <!-- Name fills the row.  `flex-1 min-w-0` lets it truncate
         while the delete button + status badge stay shrink-0 at
         the right edge -- the two together form one
         actions-and-status cluster, so delete keeps a predictable
         position relative to the always-visible badge instead of
         floating mid-row next to a variable-width title. -->
    <h3
      class="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900"
      title={category.name}
    >
      {display}
    </h3>
    <!-- Hover-revealed delete, right-aligned just left of the
         status badge.  `opacity-0 + pointer-events-none` at rest
         with a 200 ms fade-in on `group-hover/row` /
         `focus-visible` keeps the resting row chrome-free without
         losing the keyboard path.  On coarse-pointer devices
         (touch screens) hover never fires and the right-click
         ContextMenu in CategoryList isn't reachable either, so
         `pointer-coarse:` pins the button visible + interactive
         there -- otherwise touch operators have no affordance to
         delete a category at all.  Mandatory categories
         (`_background_noise_`) render a disabled stub with a
         diagonal slash so the rhythm survives and the tooltip
         explains why. -->
    {#if !isDeleting}
      <button
        type="button"
        onclick={onDeleteClick}
        disabled={isMandatory}
        aria-disabled={isMandatory}
        class="pointer-events-none inline-flex shrink-0 items-center justify-center rounded-md p-1 opacity-0 transition duration-200 ease-out group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-rose-200 focus-visible:outline-none pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
        class:cursor-not-allowed={isMandatory}
        class:text-zinc-200={isMandatory}
        class:text-zinc-300={!isMandatory}
        class:hover:bg-rose-50={!isMandatory}
        class:hover:text-rose-600={!isMandatory}
        aria-label={isMandatory
          ? `${display} is required and cannot be deleted`
          : `Delete category ${display}`}
        title={isMandatory
          ? 'Background Noise is required and cannot be deleted'
          : 'Delete category'}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
          {#if isMandatory}
            <!-- Prohibition slash over the trash glyph; the
                 thicker stroke distinguishes it from the can's
                 own strokes. -->
            <line x1="3" y1="3" x2="21" y2="21" stroke-width="2.5" />
          {/if}
        </svg>
      </button>
    {/if}
    <!-- Sync badge.  Animation discipline:
           * Icon slot collapses width + right-margin to zero in the
             iconless states, transitioning at 200 ms so the badge
             widens/narrows in one motion; `overflow-hidden` clips
             the check during the collapse so it emerges from the
             slot, not the neighbouring chrome.  `mr-1` (instead of
             the parent `gap-1`) so the gap collapses with the slot.
           * Text wrapper carries an explicit width measured off-
             screen from `measureEl`; the CSS width transition glides
             between labels so the pill never snaps to the longest
             label mid-swap.  `justify-center` + `overflow-hidden`
             keep clipping symmetric while old/new spans co-occupy.
           * Fade in/out match at 180 ms (single crossfade), check
             scales 0.6→1 over 240 ms (paint-time transform, doesn't
             perturb layout), colour cross-fades over 200 ms (leads
             the content swap so tone settles with shape). -->
    {#if !isDeleting}
      <span
        class="hidden shrink-0 items-center justify-center overflow-hidden rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-[background-color,color] duration-200 ease-out sm:inline-flex"
        class:bg-emerald-100={badge.tone === 'emerald'}
        class:text-emerald-800={badge.tone === 'emerald'}
        class:bg-amber-100={badge.tone === 'amber'}
        class:text-amber-800={badge.tone === 'amber'}
        class:bg-rose-100={badge.tone === 'rose'}
        class:text-rose-800={badge.tone === 'rose'}
        title={badge.title}
      >
        <span
          class="inline-flex h-2.5 shrink-0 items-center justify-center overflow-hidden transition-[width,margin] duration-200 ease-out"
          class:w-2.5={badge.icon === 'check'}
          class:mr-1={badge.icon === 'check'}
          class:w-0={badge.icon !== 'check'}
          aria-hidden="true"
        >
          {#if badge.icon === 'check'}
            <span
              in:scale={{ duration: 240, start: 0.6, easing: cubicOut }}
              out:scale={{ duration: 180, start: 0.6, easing: cubicOut }}
              class="inline-flex"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="h-2.5 w-2.5"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </span>
          {/if}
        </span>
        <span
          class="inline-flex items-center justify-center overflow-hidden transition-[width] duration-200 ease-out"
          style:width={textWidth !== null ? `${textWidth}px` : 'auto'}
        >
          <span class="inline-grid grid-cols-1 grid-rows-1 items-center">
            {#key badge.text}
              <span
                in:fade={{ duration: 180, easing: cubicOut }}
                out:fade={{ duration: 180, easing: cubicOut }}
                class="col-start-1 row-start-1 whitespace-nowrap"
              >
                {badge.text}
              </span>
            {/key}
          </span>
        </span>
      </span>
      <!-- Off-screen mirror feeding `textWidth`.  Fixed + invisible
           takes it out of flow; the typography MUST match the
           visible label so the measured width is correct. -->
      <span
        bind:this={measureEl}
        aria-hidden="true"
        class="pointer-events-none invisible fixed top-0 left-0 whitespace-nowrap text-[10px] font-medium"
      >
        {badge.text}
      </span>
    {/if}
    {#if isDeleting}
      <span
        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 capitalize"
      >
        <Spinner class="h-2.5 w-2.5 text-rose-700" />
        deleting
      </span>
    {/if}
  </div>

  {#if expanded}
    <!-- Single body region.  Slide transition gives the
         expand/collapse a tactile feel without animating the row's
         border (which would jitter against the parent gap).  Easing
         matches WorkspaceCard's `cubic-bezier(0.333,1,0.667,1)` (the
         literal `cubicOut`) so the dataset accordion feels like the
         same primitive as the workspace list's selecting-mode shift. -->
    <div
      id="category-body-{category.name}"
      transition:slide={{ duration: 200, easing: cubicOut }}
      class="border-t border-zinc-100 bg-zinc-50 px-3 py-3"
    >
      <!-- Two-pane layout (Input left, Slices right at md+; stacked
           below md).  Fixed grid floor (`min-h-80` = 320 px) +
           default `items-stretch` welds both panes to the same
           baseline so a freshly-sliced batch never ratchets the row
           taller -- the SlicePane scrolls internally instead.  The
           panes' own `contain: size` is what enforces that:
           without it, the waveform `<canvas>`'s 2:1 intrinsic
           aspect ratio would lift the track ~80 px on every record
           / draft state change.  320 px gives ~180 px of waveform
           in empty mode and ~250 px of slice grid (3 rows of 64 px
           cards + gaps); deeper cuts compress either past
           readability.
           Below md the panes stack and `min-h-80` alone would
           split between two `auto` rows -- both panes carry
           `contain: size` (intrinsic height zeroed to defeat the
           canvas's 2:1 lift), so grid sees 0-content rows and
           `align-content: normal` stretches the 320 px floor
           into ~154 px per pane after the `gap-3`.  That drops
           the waveform under the finger-trim threshold (handles
           stop landing reliably) and the slice grid down to ~1
           card row above the action chrome.  Pin each stacked
           row to a `minmax(16rem, 1fr)` floor instead: 256 px
           per pane (+66 % vs. the broken ~154 px, 80 % of the
           desktop 320 px).  Sized for one-thumb-scroll mobile
           ergonomics over maximum drag area: both panes fit on
           a typical 600-700 px phone viewport at once (524 px
           total inc. `gap-3`), so the operator can trim →
           slice → eyeball the slice grid without paging up and
           down between the two halves of the workflow.  ~166 px
           of waveform after chrome stays inside the finger-trim
           band, and the slice grid still shows ~2 card rows.
           `md:grid-rows-1` collapses back to a single row at
           md+, where the original `min-h-80` floor takes over
           for the side-by-side track. -->
      <div
        class="grid min-h-80 grid-cols-1 grid-rows-[minmax(16rem,1fr)_minmax(16rem,1fr)] gap-3 md:grid-cols-2 md:grid-rows-1"
      >
        <InputPane {workspaceId} {workspaceName} categoryName={category.name} />
        <SlicePane {workspaceId} categoryName={category.name} />
      </div>
    </div>
  {/if}
</li>
