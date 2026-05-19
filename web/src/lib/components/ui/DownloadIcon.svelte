<script lang="ts">
  // Outline download glyph -- the down-arrow + tray pair is the
  // operator-recognisable "save to disk" idiom.  Stroke-based to
  // match TrashIcon's visual weight so the two hover-revealed
  // icons in HeadRow share one geometric family (same viewBox,
  // same stroke-width, same line-cap / join), letting the row
  // read as one action cluster instead of two icon vocabularies.
  interface Props {
    class?: string;
  }
  let { class: extraClass = 'h-3.5 w-3.5' }: Props = $props();
</script>

<svg
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={extraClass}
  aria-hidden="true"
>
  <path d="M12 4v12" />
  <path d="M7 11l5 5 5-5" />
  <path d="M5 20h14" />
</svg>
