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
  // ## Why the panel portals to document.body
  //
  // Two ancestor traps had to be solved:
  //
  // 1. `overflow: hidden` on the dataset accordion's CategoryRow
  //    (needed for the expand/collapse slide transition) clips
  //    any in-place absolute-positioned descendant that extends
  //    beyond the row's rounded border -- including the tips
  //    panel growing down from the icon.
  //
  // 2. `position: fixed` ALONE doesn't escape it, because the
  //    pane headers wrap Tips in a `<div class="flex
  //    translate-y-px ...">` (a per-pane optical-baseline
  //    correction).  Any ancestor with `transform`, `filter`, or
  //    `perspective` becomes the CONTAINING BLOCK for `position:
  //    fixed` descendants, instead of the viewport -- so a fixed
  //    panel inside such an ancestor anchors to it, and our
  //    viewport-relative `top`/`left` coords paint the panel at
  //    the wrong place (off by the transformed ancestor's
  //    viewport top).  An earlier revision of this component used
  //    in-place `position: fixed` and the panel rendered far
  //    enough off-position that operators reported it as "never
  //    shows up".
  //
  // The fix is a portal: a tiny Svelte action that moves the
  // panel node to `document.body` on mount and restores it on
  // unmount.  `document.body` has no transform / overflow
  // ancestors, so `position: fixed` against viewport coords
  // works as intended.  The trade-off is that the panel is no
  // longer a DOM descendant of the wrapper, so the wrapper's
  // `mouseleave` fires immediately when the cursor leaves the
  // icon -- the 120 ms close-timer + the panel's own
  // `mouseenter` (which cancels the timer) absorb the cursor's
  // sub-50 ms traversal across the 8 px breathing-room gap
  // between icon and panel.  Outside-tap dismissal and focusout
  // explicitly include the portaled panel as "inside" via
  // `panelEl?.contains(target)`.
  //
  // `z-40` puts the panel above the trim handles (`z-20`) and
  // playback cursor (`z-30`) but below the ContextMenu/Modal
  // tier (`z-50`) so a panel overlapping the waveform area
  // doesn't get clobbered by the seek grip.
  interface Props {
    label: string;
    children: Snippet;
  }
  let { label, children }: Props = $props();

  // Stable per-instance ID for the portaled panel.  Threaded into
  // the trigger button's `aria-controls` (scoped to `open`, see
  // below) so AT can follow the trigger → panel relationship
  // across the portal hop -- the panel is a child of
  // `document.body`, not of the wrapper, so there's no DOM
  // ancestor chain for an AT to walk.  `crypto.randomUUID`
  // (8-char slice) matches the convention used by `Modal.svelte`.
  const panelId = `tips-panel-${crypto.randomUUID().slice(0, 8)}`;

  let open = $state(false);
  let wrapper = $state<HTMLDivElement | undefined>();
  let panelEl = $state<HTMLDivElement | undefined>();
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  // Viewport-relative coordinates the panel anchors against.
  // Recomputed on open + on every ancestor scroll / window
  // resize.  Null while closed (the panel doesn't render).
  let anchor = $state<{ top: number; left: number } | null>(null);

  function refreshAnchor(): void {
    if (!wrapper) {
      anchor = null;
      return;
    }
    const rect = wrapper.getBoundingClientRect();
    anchor = { top: rect.bottom, left: rect.left };
  }

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
    refreshAnchor();
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

  // Portal action: hoists the element to `document.body` on
  // mount, restores on unmount.  See the docblock for the
  // overflow + transform-ancestor rationale.  `node.remove()`
  // in destroy is safe even if Svelte has already detached the
  // node (no-op when the node has no parent), so the cleanup
  // is idempotent regardless of teardown ordering.
  function portal(node: HTMLElement): { destroy: () => void } {
    document.body.appendChild(node);
    return {
      destroy(): void {
        node.remove();
      }
    };
  }

  // Outside-tap dismissal.  Only attached while open so the
  // closed state has zero event cost.  Includes the portaled
  // panel as "inside" (its DOM parent is `document.body` after
  // the portal, so a `wrapper.contains` check alone would treat
  // every panel click as "outside" and close the popover on the
  // first interaction).
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (wrapper?.contains(target)) return;
      if (panelEl?.contains(target)) return;
      closeNow();
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

  // Anchor sync.  `capture: true` on scroll catches scrolling
  // on ANY ancestor (a long workspace page, an inner pane
  // scroller); without capture, only direct window-level
  // scrolls would fire.  `passive: true` keeps the listener
  // off the scroll critical path.  Only active while open --
  // closed state has zero event cost.
  $effect(() => {
    if (!open) return;
    refreshAnchor();
    const update = (): void => refreshAnchor();
    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
    };
  });

  // Close when focus leaves both the trigger AND the panel
  // entirely (keyboard dismissal that doesn't rely on a separate
  // Escape press).  Tab traversal that hops between the trigger
  // and the portaled panel needs to count as "still inside",
  // hence the explicit `panelEl?.contains(next)` branch.
  function onFocusOut(e: FocusEvent): void {
    const next = e.relatedTarget as Node | null;
    if (next && (wrapper?.contains(next) || panelEl?.contains(next))) return;
    closeNow();
  }

  // Inline `top` / `left` for the portaled panel.  8 px below
  // the icon (replaces the prior `mt-2` -- margin on a fixed-
  // positioned element offsets the box, which works, but
  // encoding the gap as an additive `top` keeps the math
  // self-evident).  `null` anchor (pre-first-open or wrapper
  // unmounted mid-tick) hides the panel via `display: none`
  // so the first paint never lands at the viewport origin.
  const panelStyle = $derived(
    anchor === null ? 'display: none;' : `top: ${anchor.top + 8}px; left: ${anchor.left}px;`
  );
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
    aria-controls={open ? panelId : undefined}
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
</div>

{#if open}
  <!-- Portaled to `document.body` so neither the row's
       `overflow: hidden` nor the pane header's `transform`
       (translate-y-px) can intercept the panel.  Own
       `onmouseenter` / `onmouseleave` because the panel is no
       longer a DOM descendant of the wrapper -- the wrapper's
       hover handlers don't see cursor traffic on the panel.
       The 120 ms close-timer absorbs the cursor's traversal
       across the 8 px gap between icon and panel; sub-50 ms
       at any reasonable cursor speed.
       Compact card: `px-3 py-2` over the earlier `p-3` saves
       8 px of vertical space (12 → 8 each side) so the panel
       hugs the tip content; `leading-snug` (1.375) tightens
       line-height vs the looser default while still leaving
       the descenders / accents clear at 11 px text. -->
  <div
    bind:this={panelEl}
    use:portal
    id={panelId}
    role="dialog"
    aria-label={label}
    tabindex="-1"
    class="fixed z-40 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[11px] leading-snug text-zinc-600 shadow-lg"
    style={panelStyle}
    onmouseenter={openNow}
    onmouseleave={scheduleClose}
    onfocusout={onFocusOut}
  >
    {@render children()}
  </div>
{/if}
