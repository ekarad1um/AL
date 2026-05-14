<script lang="ts">
  import type { Snippet } from 'svelte';

  // Module-level tips popover.  Renders a subtle ⓘ icon adjacent to
  // a module heading; opens a small panel on hover (mouse), click
  // (touch + mouse), or focus (keyboard) to surface domain-specific
  // guidance -- dataset-quality tips, workflow recommendations,
  // common pitfalls -- that supplement the inline affordances
  // without crowding the heading at rest.
  //
  // The popover's open / close model mirrors `HealthBadge`
  // (hover-open + click-toggle + outside-tap + Escape + focusout)
  // so the project keeps a single popover idiom rather than a
  // second slightly-different one.  Tip BODIES flow in via a
  // `children` snippet -- each consumer keeps its tips inline with
  // its module source, which (a) makes the tips part of the
  // module's documentation surface rather than a buried content
  // registry, and (b) makes revisions cheap as the recommended
  // workflow evolves.
  //
  // Positioning: the panel anchors `left: 0; top: 100%` from the
  // inline wrapper, so it grows down-and-right from the icon.
  // Tested for both panes in the dataset accordion: the InputPane
  // heading sits ~60 px from the pane's left edge, the SlicePane
  // similarly, and a 288 px panel fits within the ~498 px content
  // area of each pane.  `z-40` puts the panel above the trim
  // handles (`z-20`) and playback cursor (`z-30`) but below the
  // ContextMenu/Modal tier (`z-50`) so a panel overlapping the
  // waveform area doesn't get clobbered by the seek grip.
  interface Props {
    label: string;
    children: Snippet;
  }
  let { label, children }: Props = $props();

  let open = $state(false);
  let wrapper = $state<HTMLDivElement | undefined>();
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelClose(): void {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }
  function scheduleClose(): void {
    cancelClose();
    closeTimer = setTimeout(() => {
      open = false;
      closeTimer = null;
    }, 120);
  }
  function openNow(): void {
    cancelClose();
    open = true;
  }
  function closeNow(): void {
    cancelClose();
    open = false;
  }
  function toggle(): void {
    if (open) closeNow();
    else openNow();
  }

  // Outside-tap dismissal.  Only attached while open so the
  // closed state has zero event cost.
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const root = wrapper;
      if (!root) return;
      if (!root.contains(e.target as Node | null)) closeNow();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
    };
  });

  // Escape key dismissal.
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeNow();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  });

  // Clear any pending close timer on unmount.
  $effect(() => {
    return () => cancelClose();
  });

  // Close when focus leaves the wrapper entirely (keyboard
  // dismissal that doesn't rely on a separate Escape press).
  function onFocusOut(e: FocusEvent): void {
    const next = e.relatedTarget as Node | null;
    if (!next || !wrapper?.contains(next)) closeNow();
  }
</script>

<div
  bind:this={wrapper}
  class="relative inline-flex"
  role="group"
  aria-label={label}
  onmouseenter={openNow}
  onmouseleave={scheduleClose}
  onfocusout={onFocusOut}
>
  <!-- Icon sized to sit just above the heading's cap-line: the
       module headings are `text-[11px]` uppercase (cap height
       ~8 px) and a 12 px ⓘ kept the icon visually dominating the
       heading at rest.  Dropping to 10 px (`h-2.5`) makes the
       glyph read as a small, decorative annotation rather than
       a competing element.  The stroke widens to 2.25 so the
       smaller circle stays legible without smearing into a dot.
       Hit area: the parent wrapper is `inline-flex` (no padding)
       and the button itself fills the same 10 px box.  Tight,
       but adequate for hover + keyboard; touch users get the
       click-toggle path -- a 10 px target is below the 24 px
       WCAG ideal, but Tips are a soft-discovery affordance,
       not a critical control, and matching the heading scale
       wins over a chunky target that visually shouts.  Colour
       softens to zinc-400 → zinc-600 on hover so the glyph
       doesn't darken to near-black on mouseover. -->
  <button
    type="button"
    class="inline-flex h-2.5 w-2.5 items-center justify-center rounded-full text-zinc-400 transition hover:text-zinc-600 focus-visible:text-zinc-700 focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:outline-none"
    aria-label={label}
    aria-expanded={open}
    aria-haspopup="dialog"
    onclick={toggle}
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.25"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-2.5 w-2.5"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  </button>

  {#if open}
    <!-- Transparent bridge spans the 8 px gap between trigger and
         panel so the hover scope stays contiguous (otherwise the
         cursor falls into dead space mid-traverse and starts the
         close timer). -->
    <div
      aria-hidden="true"
      class="absolute top-full left-0 z-40 h-2 w-72 max-w-[calc(100vw-2rem)]"
    ></div>
    <!-- Compact card: `px-3 py-2` over the earlier `p-3` saves
         8 px of vertical space (12 → 8 each side) so the panel
         hugs the tip content; `leading-snug` (1.375) tightens
         line-height vs the looser default while still leaving
         the descenders / accents clear at 11 px text. -->
    <div
      role="dialog"
      aria-label={label}
      tabindex="-1"
      class="absolute left-0 z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[11px] leading-snug text-zinc-600 shadow-lg"
    >
      {@render children()}
    </div>
  {/if}
</div>
