<script lang="ts">
  import { fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  // Animated status pill.  Mirrors the dataset sync badge's
  // motion discipline (see [CategoryRow.svelte] line ~315) so every
  // animated status surface in the app reads as one motion family:
  //
  //   * Text content cross-fades in place (NOT a slot-machine
  //     vertical fly).  An out:fade and in:fade on the keyed inner
  //     span overlap in a single grid cell so old and new labels
  //     bleed into each other across 180 ms.  The eye reads this
  //     as the badge "morphing" rather than "switching" -- exactly
  //     the smooth, fluent, continuous feel a frequently-changing
  //     indicator needs.
  //
  //   * Pill width glides between labels via a JS-measured target
  //     width.  An off-screen `fixed top-0 left-0` mirror renders
  //     the current label at the same typography as the visible
  //     pill; an `$effect` reads `getBoundingClientRect().width`
  //     after every label change and writes the value to the
  //     visible text wrapper as an inline `width`.  CSS then
  //     interpolates the wrapper across 200 ms so the badge
  //     glides between "Standby" (narrow) and "Detached" (narrow)
  //     and the tighter "Default" without snapping to the larger
  //     of the two mid-transition.  This is the load-bearing
  //     difference vs. the implicit grid-cell sizing: that
  //     approach snaps width when the outgoing span unmounts;
  //     measured width interpolates continuously across the entire
  //     transition.
  //
  //   * Background + text colour morph independently across 200 ms
  //     via `transition-[background-color,color]`.  Same duration
  //     as the width transition so colour and shape settle together
  //     -- avoids the layered feel where text reads as new but the
  //     pill still looks like the previous state, or vice versa.
  //
  //   * Mount / unmount of the pill itself (the parent's `{#if}`
  //     toggling a conditional badge on/off) plays a brief
  //     root-level fade so the badge appears / disappears
  //     gracefully too.  Exit is snappier (140 ms) than entrance
  //     (180 ms): a disappearing pill should clear quickly so the
  //     eye doesn't linger on a "ghost" of state that no longer
  //     applies, while an arriving pill benefits from the extra
  //     ~40 ms to settle its colour against the surrounding chrome.
  //
  // ## Timing summary
  //   t = 0   ms  background colour starts morphing,
  //              wrapper width starts gliding,
  //              outgoing text starts fading,
  //              incoming text starts fading
  //   t = 180 ms  both text fades complete
  //   t = 200 ms  width + colour both complete
  //
  // The 20 ms tail (text done, shape + colour still settling) is
  // the small final "polish" the eye feels as the badge "lands".
  //
  // ## Easing
  // `cubicOut` everywhere: starts fast, decelerates into rest.
  // Status changes are events (user clicked Deploy / a poller landed
  // a new active record), not continuous animations, so the "arrival"
  // is the meaningful moment.  Easing out gives that arrival weight.
  //
  // ## Why measure rather than use grid cell sizing
  // The grid cell `max(out.width, in.width)` approach (Svelte's
  // common pattern) sizes the cell to the larger of the two while
  // both spans are present, then snaps to the new size when the
  // outgoing span's out: finishes.  The snap is visible whenever
  // out.width ≠ in.width.  Measuring the new label's natural width
  // up front and animating to it sidesteps the snap entirely.

  type Size = 'xs' | 'sm';

  interface Props {
    /** Visible label.  Changing this triggers the crossfade + width glide. */
    label: string;
    /**
     * Tailwind background + text colour classes, e.g.
     * `'bg-blue-100 text-blue-800'`.  Passed as a single space-
     * separated string so the parent owns the full palette mapping
     * (different states use different colour pairs); the badge
     * itself stays palette-agnostic.
     */
    tone: string;
    /**
     * Tooltip surfaced on hover.  Status pills abbreviate the state
     * to one word; the long-form explanation lives here so the
     * operator hovering an unfamiliar word always has the full
     * sentence one beat away.
     */
    title?: string;
    /**
     * Type-scale preset:
     *   - 'sm' (default, 11 px) for top-level pills (panel headers).
     *   - 'xs' (10 px) for compact row pills inside lists.
     * Two presets cover every use site today; resist adding more --
     * a custom size invites drift away from the badge's load-bearing
     * 4 px / 8 px padding rhythm.
     */
    size?: Size;
  }
  let { label, tone, title, size = 'sm' }: Props = $props();

  // Type-scale presets.  Padding is held constant across sizes (the
  // outer pill's chrome rhythm is more legible when the gap from
  // text to pill edge stays the same regardless of font size);
  // tweaking padding per size is the explicit opt-out and should be
  // justified at the call site, not encoded as a default here.
  const TEXT_SIZE: Readonly<Record<Size, string>> = {
    xs: 'text-[10px]',
    sm: 'text-[11px]'
  };
  const PAD = 'px-2 py-0.5';

  // CRITICAL: `TEXT_CLS` (typography only, no padding) is shared by
  // the visible inner text wrapper AND the off-screen mirror.  The
  // outer pill composes `TEXT_CLS` with `PAD` separately.  If `PAD`
  // ever leaks into the mirror's class string, the mirror's
  // `getBoundingClientRect().width` returns `padding + text +
  // padding` rather than the bare text width; the visible text
  // wrapper (which has NO padding of its own) then receives that
  // inflated width and `justify-center` splits the surplus equally
  // on both sides, producing an apparent doubled horizontal padding
  // INSIDE the pill.  Keep typography and chrome separated to
  // prevent that regression.  Mirrors the dataset sync badge's
  // discipline (the mirror at CategoryRow.svelte:374-379 carries
  // `text-[10px] font-medium whitespace-nowrap` -- typography only,
  // no `px-*`).
  const TEXT_CLS = $derived(
    `${TEXT_SIZE[size]} font-medium capitalize tracking-wide whitespace-nowrap`
  );

  // Off-screen mirror feeding the measured `textWidth`.  Lives at
  // `fixed top-0 left-0 invisible` so it's out of normal flow and
  // never repaints anything visible; `whitespace-nowrap` plus
  // matching typography (font weight + size + capitalize +
  // tracking) means the bounding-rect width matches what the
  // visible pill will paint to a sub-pixel.
  let measureEl: HTMLSpanElement | undefined = $state();
  let textWidth: number | null = $state(null);

  // Track both `label` and `size` so the effect re-runs when either
  // changes (size changes the mirror's font-size → its width →
  // visible pill's target width).  `tone` doesn't affect typography
  // and isn't tracked.  `getBoundingClientRect()` returns a float;
  // we keep it floating-point so the width transition is sub-pixel
  // smooth on Retina (rounding to integer pixels would cause a
  // 0.5 px jitter on every transition that crossed a half-pixel
  // boundary).
  $effect(() => {
    void label;
    void size;
    if (!measureEl) return;
    textWidth = measureEl.getBoundingClientRect().width;
  });
</script>

<span
  in:fade={{ duration: 180, easing: cubicOut }}
  out:fade={{ duration: 140, easing: cubicOut }}
  class="inline-flex items-center justify-center overflow-hidden rounded-full transition-[background-color,color] duration-200 ease-out {TEXT_CLS} {PAD} {tone}"
  {title}
>
  <!-- Width wrapper.  `style:width` is driven by the measured mirror
       below; CSS interpolates between consecutive measurements over
       200 ms so the pill glides instead of snapping.  Initial render
       uses `auto` because `textWidth` is null until the first effect
       run -- the natural width matches what the explicit pixel value
       will become after the first measure, so the snap from `auto`
       to that pixel value is visually identical and imperceptible. -->
  <span
    class="inline-flex items-center justify-center overflow-hidden transition-[width] duration-200 ease-out"
    style:width={textWidth !== null ? `${textWidth}px` : 'auto'}
  >
    <!-- Single-cell grid that overlaps outgoing and incoming spans.
         `grid-cols-1 grid-rows-1` + `col-start-1 row-start-1` on
         both inner spans means they share one cell -- old and new
         labels co-occupy the cell during the crossfade.  The
         WIDTH wrapper above is what carries the inter-label glide;
         the grid is purely the crossfade substrate.  Matches the
         dataset sync badge's structure verbatim. -->
    <span class="inline-grid grid-cols-1 grid-rows-1 items-center">
      {#key label}
        <span
          in:fade={{ duration: 180, easing: cubicOut }}
          out:fade={{ duration: 180, easing: cubicOut }}
          class="col-start-1 row-start-1"
        >
          {label}
        </span>
      {/key}
    </span>
  </span>
</span>

<!-- Off-screen mirror.  Typography MUST match the visible inner
     text exactly so the measured width is correct -- but the pill's
     `PAD` is deliberately ABSENT here (see the comment on `TEXT_CLS`
     above for why padding leakage produces the doubled-horizontal-
     padding regression).  `fixed top-0 left-0` takes the element
     out of flow; `pointer-events-none invisible` guarantees it
     never intercepts interaction or paints visible ink.  The
     bind:this anchors a reference for the effect's
     `getBoundingClientRect()` read. -->
<span
  bind:this={measureEl}
  aria-hidden="true"
  class="pointer-events-none invisible fixed top-0 left-0 {TEXT_CLS}"
>
  {label}
</span>
