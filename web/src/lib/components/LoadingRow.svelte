<script lang="ts">
  // Standard "spinner + label" inflight row.  Used wherever a page
  // or pane is fetching its primary content and we want to indicate
  // progress without committing to a full skeleton.
  //
  // `size` selects vertical geometry:
  //   - 'page'    → px-1 py-12, top-of-route loading state (the
  //                  body has no other content yet so the loader
  //                  carries the full vertical breathing room).
  //   - 'section' → px-1 py-6, inside a panel/card whose header
  //                  has already rendered above.
  //   - 'fill'    → flex-1, fills a flex column so the placeholder
  //                  occupies the same vertical real estate as the
  //                  eventual content (e.g. the slice grid).
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
    size === 'page' ? 'px-1 py-12' : size === 'section' ? 'px-1 py-6' : 'flex-1'
  );
</script>

<div
  role="status"
  aria-live="polite"
  class="flex items-center gap-2 text-xs text-zinc-500 {sizeClass}"
>
  <Spinner />
  <span>{label}</span>
</div>
