<script lang="ts">
  // Minimal inline SVG spinner.  Two paths: the dim ring is the
  // "track" the head spins around; the bright arc is the rotating
  // head -- animated via the global `animate-spin` utility (1 s
  // linear).  Class names default tuned for the inline status
  // spinner next to section headings (12 px, blue-500); callers
  // override `class` for other contexts.
  interface Props {
    class?: string;
  }
  let { class: cls = 'h-3 w-3 text-blue-500' }: Props = $props();
</script>

<svg
  class="animate-spin {cls}"
  xmlns="http://www.w3.org/2000/svg"
  fill="none"
  viewBox="0 0 24 24"
  aria-hidden="true"
>
  <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" class="opacity-25"></circle>
  <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"
  ></path>
</svg>
