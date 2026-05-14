<script lang="ts">
  import { streams } from '$lib/stores/streams.svelte';
  // Shared helper -- the dataset accordion's row header uses the same
  // function, so a class called `cat` in the dataset shows up as
  // `Cat` here too.  The raw token still appears in the inspector
  // via the `<span title>` so engineers debugging a label mismatch
  // can read the on-wire identifier verbatim.
  import { prettyCategoryName } from '$lib/components/category/labels';

  let rows = $derived(streams.latestTopK);
</script>

<div class="space-y-2">
  {#if rows.length === 0}
    <p class="text-sm text-zinc-400">awaiting first inference frame…</p>
  {:else}
    {#each rows as row (row.class_idx)}
      {@const pct = Math.max(0, Math.min(1, row.prob))}
      <div class="grid grid-cols-[7rem_1fr_3rem] items-center gap-3">
        <span class="truncate text-sm font-medium text-zinc-700" title={row.label}
          >{prettyCategoryName(row.label)}</span
        >
        <!-- overflow-hidden on the rounded container clips the inner fill
             into the pill shape, so tiny values render as a thin sliver
             instead of the inner `rounded-full` collapsing into a circle. -->
        <div class="relative h-2 overflow-hidden rounded-full bg-zinc-100">
          <div
            class="absolute inset-y-0 left-0 bg-blue-500 transition-[width] duration-150"
            style="width: {pct * 100}%"
          ></div>
        </div>
        <span class="text-right font-mono text-xs text-zinc-500">{(pct * 100).toFixed(1)}%</span>
      </div>
    {/each}
  {/if}
</div>
