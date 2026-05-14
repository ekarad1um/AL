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

  // Unified row badge.  A single pill conveys quota + sync state.
  // The numeric count lives inside the expanded SlicePane; the
  // badge only labels the situation, not the exact tally -- the
  // operator can drill in for the count if they need it.  Tone +
  // text by combined state:
  //   - Enough samples AND synced      → emerald "✓ Synced"
  //   - Enough samples AND uploading   → blue    "Uploading"
  //   - Enough samples AND pending     → amber   "Pending"
  //   - Not enough samples + empty     → amber   "Not enough samples"
  //   - Not enough samples + state     → amber   "Not enough samples · State"
  //   - Any failed                     → rose    "Failed" or
  //                                              "Not enough samples · Failed"
  // Badge width is fully driven by its content (no `min-width`
  // floor) so every state has the same `px-2` visible padding
  // on the left and right of the pill's contents -- matching
  // the rest of the project's small status pills (sync chip,
  // deleting badge, socket pill).  Earlier we held a 80 px
  // floor to keep the row header from jiggling during a batch
  // upload, but the measurement-driven width transition (see
  // `textWidth` below) now interpolates between labels
  // smoothly, so the jiggle concern is handled at the
  // animation layer; a floor only bloated the visible padding
  // for short labels ("Failed" / "Synced") and made them look
  // inconsistent with the longer "Not enough samples" states.
  type BadgeTone = 'emerald' | 'amber' | 'rose';
  // The only visible icon is the "Synced" arrow/check.  All other
  // states are text-only -- a stationary "+" or "↑" on a moving
  // status pill amounted to visual chrome the operator didn't need,
  // and removing them lets the colour + text alone do the talking.
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
  <div
    role="button"
    tabindex={isDeleting ? -1 : 0}
    aria-expanded={expanded}
    aria-controls="category-body-{category.name}"
    aria-disabled={isDeleting}
    onclick={onHeaderClick}
    onkeydown={onHeaderKey}
    class="flex cursor-pointer items-center gap-3 px-4 py-3 transition select-none"
    class:cursor-not-allowed={isDeleting}
    class:pointer-events-none={isDeleting}
  >
    <!-- Disclosure chevron.  Rotation animates with the row's
         expansion so the affordance reads as one motion. -->
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      class="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-200"
      class:rotate-90={expanded}
    >
      <path
        fill-rule="evenodd"
        d="M7.21 5.23a.75.75 0 011.06.02L12 9l-3.73 3.71a.75.75 0 11-1.06-1.06L9.94 9 7.19 6.29a.75.75 0 01.02-1.06z"
        clip-rule="evenodd"
      />
    </svg>
    <!-- Name + delete-affordance cluster.  Grouping them in one
         flex container keeps the destructive action immediately
         adjacent to the name it targets (rather than across the
         row past the status badge), so the operator's eye reads
         "this is the thing, this is how to remove it" as one
         unit.  `flex-1 min-w-0` lets the h3 truncate while the
         button stays a fixed-size sibling on the right of the
         cluster; the badge then sits at the row's right edge as
         the only thing on that side. -->
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <h3 class="min-w-0 truncate text-sm font-medium text-zinc-900" title={category.name}>
        {display}
      </h3>
      <!-- Inline delete affordance, hover-revealed.  Sits to the
           right of the name (rather than past the status badge)
           so name + mutation control read as a single cluster
           on the left of the row.  `opacity-0` at rest with a
           200 ms ease-out fade-in on `group-hover/row` keeps
           the resting row chrome-free; `pointer-events-none`
           mirrors the opacity gate so the invisible target
           can't be clicked through before hover.
           `focus-visible:` reveals the button for keyboard
           users without depending on mouse hover, and the
           right-click context menu in CategoryList wires into
           the same DeleteCategoryDialog so the touch /
           keyboard / non-hover path is still served.
           Mandatory categories ( `_background_noise_` ) still
           render a `disabled` stub with a diagonal slash so
           the operator gets the same visual rhythm across rows
           on hover and learns the why (tooltip + slash). -->
      {#if !isDeleting}
        <button
          type="button"
          onclick={onDeleteClick}
          disabled={isMandatory}
          aria-disabled={isMandatory}
          class="pointer-events-none shrink-0 rounded-md p-1.5 opacity-0 transition duration-200 ease-out group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-rose-200 focus-visible:outline-none"
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
              <!-- Diagonal slash from top-left to bottom-right of
                   the icon's viewBox.  Drawn with a slight
                   `stroke-width` lift so the line reads as an
                   explicit prohibition mark rather than another
                   trash-can stroke.  No special start / end offset
                   -- the eye reads the through-line and the trash
                   silhouette together as "no delete". -->
              <line x1="3" y1="3" x2="21" y2="21" stroke-width="2.5" />
            {/if}
          </svg>
        </button>
      {/if}
    </div>
    <!-- Unified sync badge.  Single pill that conveys both quota
         (enough samples / not) and daemon-side sync state.  Only
         the "Synced" success state earns a leading icon -- a
         check -- so the eye can pick out done categories at a
         glance; every other state stays text-only to avoid
         signalling competing affordances on a small chip.
         Animation discipline:
           - The icon slot collapses to `w-0` (and drops its
             right margin) when the badge is in an iconless
             state, so the text is geometrically centered in the
             pill.  An always-reserved 10 px slot pushed every
             iconless label ~7 px right of the badge centre,
             which read as asymmetric horizontal padding -- the
             collapse fixes that.  Both `width` and `margin-
             right` transition at 200 ms ease-out so the badge
             widens / narrows smoothly when the check arrives
             or leaves; the snap that motivated the original
             always-on slot is now absorbed by this transition
             plus the text-wrapper's measurement-driven width
             transition, which compose into one shape change.
             Slot uses `overflow-hidden` so the icon is clipped
             as the slot expands / collapses, visibly emerging
             from (or retreating into) the slot's bounds rather
             than hovering over neighbouring chrome.  The slot's
             right gap rides as `mr-1` instead of the parent's
             `gap-1` so it collapses together with the slot
             width -- a parent gap would otherwise leave a 4 px
             stub between a zero-width slot and the text.
           - The text grid sits inside an explicit-width wrapper
             whose `width` is driven by an off-screen mirror
             (`measureEl`) of the current label.  CSS interpolates
             that width between labels so the pill glides between
             "Synced" (narrow) and "Not enough samples · Pending"
             (wide).  Without it the wrapper would snap to the
             wider label the moment the new span mounts (grow
             case) or stay at the wider label until the old
             span's out-fade completes and then snap inward
             (shrink case) -- both read as a jolt mid-transition.
             `justify-center` + `overflow-hidden` keep the
             clipping symmetric while old and new briefly co-
             occupy the cell.
           - In + out fade durations match (180 ms) and run in
             parallel so the swap reads as one crossfade -- not a
             sequenced out-then-in pair.
           - The icon keeps a scale-in (0.6 → 1, 240 ms) for the
             "completion arriving" feel; `transform: scale` is a
             paint-time transform so it doesn't perturb the
             badge's layout width while it animates.
           - Background + foreground colour cross-fade in 200 ms,
             a touch longer than the content swap so the tone
             change leads in slightly and the eye doesn't feel
             the colour land before the label.  Width transition
             matches at 200 ms so colour and shape settle
             together a hair after the text crossfade. -->
    {#if !isDeleting}
      <span
        class="hidden shrink-0 items-center justify-center overflow-hidden rounded-full px-2 py-0.5 text-[10px] font-medium transition-[background-color,color] duration-200 ease-out sm:inline-flex"
        class:bg-emerald-100={badge.tone === 'emerald'}
        class:text-emerald-800={badge.tone === 'emerald'}
        class:bg-amber-100={badge.tone === 'amber'}
        class:text-amber-800={badge.tone === 'amber'}
        class:bg-rose-100={badge.tone === 'rose'}
        class:text-rose-800={badge.tone === 'rose'}
        title={badge.title}
      >
        <!-- Icon slot.  Width + right-margin collapse to zero
             when no icon is shown so the text wrapper can sit
             flush at the centre of the badge; both properties
             transition at the same 200 ms ease-out as the text
             wrapper so the slot's collapse / expand composes
             with the wrapper's resize into one motion.
             `overflow-hidden` clips the icon while the slot is
             narrower than 10 px so the check visibly emerges
             from the slot's left edge rather than hovering
             outside of it. -->
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
        <!-- Animated-width text wrapper.  `style:width` carries
             the current label's measured width; the CSS
             `transition: width` interpolates between labels so
             the pill glides instead of snapping at the fade
             boundaries.  The inner grid still stacks outgoing
             and incoming spans in the same cell so they cross-
             fade in place. -->
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
      <!-- Off-screen mirror used to measure the next label's
           width for the wrapper's `transition: width`.  Fixed-
           position + `invisible` takes it out of layout flow;
           same `text-[10px] font-medium` as the visible label
           so its measured width matches what the visible
           wrapper would have at intrinsic size. -->
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
        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700 capitalize"
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
      class="border-t border-zinc-100 bg-zinc-50 px-4 py-4"
    >
      <!-- Two-pane layout: Input (B.3 + B.4) on the left, Slices
           (B.4 list, B.5 spectrogram cards) on the right.  At md+
           they sit side-by-side; below md they stack with the
           Input pane on top so a touch operator records / imports
           / slices first, then scrolls to see the slice list.
           Default `items-stretch` (grid's default cross-axis
           alignment) coupled with a stable `min-h-80` on the
           grid is what keeps the dataset accordion still when a
           freshly-sliced batch lands in the SlicePane: the
           InputPane no longer "ratchets up" to match a growing
           SlicePane because both panes already share the same
           baseline height.  SlicePane's grid scrolls internally
           past that baseline, so a 60-slice batch doesn't change
           the row height at all.
           Both panes carry their own `flex-1 min-h-0` discipline
           internally (the InputPane on its waveform row, the
           SlicePane on its `overflow-y-auto` slice grid) AND
           both carry `contain: size` on their outer container.
           The flex-1 pair lets internal chrome compress; the
           size containment is what stops their content from
           dragging the *grid track* taller than the floor in
           the first place.  In particular the InputPane's
           waveform `<canvas>` (DPR-sized via width/height attrs
           for a crisp render) would otherwise contribute a 2:1
           intrinsic aspect ratio to the track and lift the row
           by ~80 px the instant a recording / draft mounted.
           So the only thing that determines row height is this
           floor: every other piece of vertical chrome (status
           lines, error banners, the action button row, even an
           action row wrapped to 2-3 lines on a narrow pane) is
           absorbed by the flex-1 region's compression rather
           than pushing the row taller.  Sized at 320 px (20 rem)
           -- a 32 px trim from the prior 352 px floor.  In the
           InputPane this leaves the waveform with ~180 px in
           empty mode and ~90-110 px in error-heavy / imported-
           from modes (the flex-1 absorbs whatever fixed chrome
           is present).  The SlicePane gets ~250 px of grid
           scroll space, which still holds 3 full rows of 64 px
           cards plus gaps before the operator has to scroll.
           Cutting deeper would start compressing the waveform
           below visual readability or the slice grid to ≤ 2
           visible rows -- both noticeable. -->
      <div class="grid min-h-80 grid-cols-1 gap-3 md:grid-cols-2">
        <InputPane {workspaceId} {workspaceName} categoryName={category.name} />
        <SlicePane {workspaceId} categoryName={category.name} />
      </div>
    </div>
  {/if}
</li>
