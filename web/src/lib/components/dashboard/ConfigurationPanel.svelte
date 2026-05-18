<script lang="ts">
  import { config } from '$lib/stores/config.svelte';
  import ConfigurationControls from './ConfigurationControls.svelte';

  // Dashboard wrapper: section frame + title + transient error chip.
  // The form body lives in `ConfigurationControls` so the workspace
  // deploy module can compose the same controls inside its
  // collapsed-by-default disclosure without nesting cards.
  let unavailable = $derived<boolean>(
    (config.mic === null || config.inference === null) && config.error !== null
  );
</script>

<section class="rounded-xl border border-zinc-200 bg-white px-5 pt-3.5 pb-5 shadow-sm">
  <header class="mb-4 flex items-baseline justify-between">
    <h2 class="text-sm font-semibold text-zinc-900">Configuration</h2>
    {#if config.error && !unavailable}
      <span class="truncate text-xs text-rose-700">{config.error}</span>
    {/if}
  </header>

  <ConfigurationControls />
</section>
