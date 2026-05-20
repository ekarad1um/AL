<script lang="ts">
  // Outline upload glyph -- the up-arrow + tray pair is the
  // operator-recognisable "load from disk" idiom (vertical
  // mirror of DownloadIcon, so the two icons read as a matched
  // pair in the workspace tool-island).
  //
  // Geometry is a strict mirror of DownloadIcon's path:
  //
  //   DownloadIcon                       UploadIcon
  //   shaft (12,4)→(12,16)               shaft (12,4)→(12,16)
  //   chevron ⌄ apex at (12,16)          chevron ⌃ apex at (12,4)
  //                                       (legs at y=9, mirrored
  //                                        from download's y=11)
  //   tray y=20                          tray y=20
  //
  // Both icons keep the tray at y=20 and leave a 4 px gap
  // between the arrow's near-end (download: chevron tip / upload:
  // shaft base) and the tray, so the negative space inside the
  // 24×24 viewBox reads identical between the pair.  An earlier
  // draft put the shaft from y=8 to y=20 — visually unbalanced
  // because the shaft intersected the tray rather than sitting
  // above it.
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
  <path d="M7 9l5-5 5 5" />
  <path d="M5 20h14" />
</svg>
