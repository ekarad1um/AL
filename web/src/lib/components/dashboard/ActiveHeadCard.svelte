<script lang="ts">
  import { streams } from '$lib/stores/streams.svelte';
  import { config } from '$lib/stores/config.svelte';

  // Prefer the runtime head version from the latest inference frame --
  // atomic with the running weights.  The UUID head id stays out of the
  // body text (noise > signal) and is exposed as a `title` tooltip on
  // the version cell for power users.
  let liveVersion = $derived<number | null>(streams.head.head_version);
  let liveId = $derived<string | null>(
    streams.head.head_id ?? config.active?.runtime_head_id ?? null
  );
  let hasFrame = $derived<boolean>(liveId !== null || config.active !== null);

  let origin = $derived(config.active?.origin ?? null);
  let nClasses = $derived(config.active?.n_classes ?? null);
  let orphaned = $derived(
    config.active?.origin === 'head' && !config.active.source_workspace_alive
  );
</script>

<aside
  class="rounded-lg border p-3.5"
  class:border-amber-200={orphaned}
  class:bg-amber-50={orphaned}
  class:border-zinc-200={!orphaned}
  class:bg-zinc-50={!orphaned}
>
  <header class="mb-3 flex items-center justify-between">
    <h4 class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Active head</h4>
    {#if origin}
      <span
        class="rounded-full px-2 py-0.5 text-[11px] font-medium capitalize tracking-wide transition-colors duration-200"
        class:bg-zinc-200={origin === 'default'}
        class:text-zinc-700={origin === 'default'}
        class:bg-blue-100={origin === 'head'}
        class:text-blue-800={origin === 'head'}>{origin}</span
      >
    {/if}
  </header>

  {#if !hasFrame}
    <p class="text-xs text-zinc-400">waiting for first inference frame…</p>
  {:else}
    <!-- Stat-tile pair: 2× value-to-label size ratio (text-xl over
         text-[10px]) makes it read as a stat block, not a label list.
         Divider colour tracks the aside palette so orphan amber stays
         tonally coherent. -->
    <div
      class="grid grid-cols-2 divide-x"
      class:divide-amber-200={orphaned}
      class:divide-zinc-200={!orphaned}
    >
      <div class="pr-3 text-center" title={liveId ?? undefined}>
        <div class="font-mono text-xl font-semibold text-zinc-900 tabular-nums">
          {#if liveVersion !== null}v{liveVersion}{:else}<span class="text-zinc-400">—</span>{/if}
        </div>
        <div class="mt-1 text-[10px] text-zinc-400">version</div>
      </div>
      <div class="pl-3 text-center">
        <div class="font-mono text-xl font-semibold text-zinc-900 tabular-nums">
          {#if nClasses !== null}{nClasses}{:else}<span class="text-zinc-400">—</span>{/if}
        </div>
        <div class="mt-1 text-[10px] text-zinc-400">classes</div>
      </div>
    </div>

    {#if config.active?.origin === 'head'}
      <dl
        class="mt-3 grid grid-cols-[4.5rem_1fr] items-baseline gap-x-3 gap-y-1.5 border-t pt-3 text-xs"
        class:border-amber-200={orphaned}
        class:border-zinc-200={!orphaned}
      >
        <dt class="text-zinc-500">workspace</dt>
        <dd
          class="truncate font-mono text-[10px] text-zinc-800"
          title={config.active.source_workspace_id}
        >
          {config.active.source_workspace_id.slice(0, 8)}<span class="text-zinc-400">…</span>
        </dd>

        <dt class="text-zinc-500">revision</dt>
        <dd class="truncate font-mono text-[10px] text-zinc-800">
          {config.active.source_workspace_revision.id}
        </dd>
      </dl>
    {/if}

    {#if orphaned}
      <p class="mt-3 text-[11px] text-amber-800">
        source workspace was deleted; inference continues on the orphaned activation.
      </p>
    {/if}
  {/if}
</aside>
