<script lang="ts">
  // Standard "spinner + label" inflight row.  Used wherever a page
  // or pane is fetching its primary content and we want to indicate
  // progress without committing to a full skeleton.
  //
  // All variants centre the spinner+label on the main axis
  // (`justify-center`) so the loader reads as a deliberate wait
  // state rather than a stray top-left line.  `size` picks the
  // cross-axis geometry:
  //   - 'page'    → min-h-[60vh].  Top-of-route loading state;
  //                  the body has no other content yet so we carry
  //                  ~60 vh and let `items-center` park the
  //                  spinner ~30 vh into the band.  Combined with
  //                  the global header (h-14 = 3.5 rem) and the
  //                  per-page header above, the spinner lands
  //                  visually near viewport-middle on typical
  //                  desktop + mobile heights without restructuring
  //                  callers as flex columns.
  //   - 'section' → py-6.  Inside a panel/card whose header has
  //                  already rendered above; the tight vertical
  //                  band matches the panel's rhythm and centring
  //                  keeps the loader balanced against the
  //                  panel header's left/right justified layout.
  //   - 'fill'    → flex-1.  Fills a flex column so the placeholder
  //                  occupies the same vertical real estate as the
  //                  eventual content (e.g. the slice grid); the
  //                  added `justify-center` also centres on the
  //                  main axis, matching the empty-state placard
  //                  the same column may render in another branch.
  //
  // `role="status"` + `aria-live="polite"` lets AT announce the
  // label when the row mounts; the spinner SVG is `aria-hidden` so
  // the announcement is the bare label, not "graphic loading…".
  import Spinner from './Spinner.svelte';

  interface Props {
    label: string;
    size?: 'page' | 'section' | 'fill';
  }
  let { label, size = 'page' }: Props = $props();

  const sizeClass = $derived(
    size === 'page' ? 'min-h-[60vh]' : size === 'section' ? 'py-6' : 'flex-1'
  );
</script>

<div
  role="status"
  aria-live="polite"
  class="flex items-center justify-center gap-2 text-xs text-zinc-500 {sizeClass}"
>
  <Spinner />
  <span>{label}</span>
</div>
