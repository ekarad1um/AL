<script lang="ts">
  // Outline pencil glyph used for in-place rename affordances.
  // Same visual family as `TrashIcon` / `DownloadIcon`: stroke-
  // based with 2 px weight + round caps so the three workspace-
  // tool-island buttons read as one icon vocabulary.  Originally
  // inlined in `/workspace/[id]/+page.svelte` next to the
  // workspace name; extracted here so the tool-island reuses
  // the exact same path data.
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
  <path d="M12 20h9" />
  <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
</svg>
