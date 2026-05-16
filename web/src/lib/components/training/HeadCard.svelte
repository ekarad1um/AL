<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import TrashIcon from '$lib/components/ui/TrashIcon.svelte';
  import { formatBytes } from '$lib/utils/format';
  import { formatRelative } from '$lib/utils/time';
  import type { HeadRecord, Uuid } from '$lib/api/types';

  interface Props {
    head: HeadRecord;
    // Live workspace revision (max of detail.workspace_revision.id
    // and any upload receipt the slices store has seen).  Used to
    // re-derive `current` / `stale` locally because the daemon's
    // `head.status` is captured at workspace-fetch time and a
    // recent slice upload could have advanced the revision past
    // that snapshot.
    liveRevision: number;
    // True when this head is the runtime-active inference head.
    // Drives the "Active" pill + disables the Activate button.
    // The parent computes this from `config.active.origin === 'head'
    // && config.active.source_head_id === head.head_id`.
    isActive: boolean;
    // Disabled while another head on this card list is mid-
    // mutation (activating or deleting) so the operator can't
    // fire two destructive actions in parallel.  Per-card busy
    // state is the parent's responsibility.
    busy?: boolean;
    onactivate: (headId: Uuid) => Promise<void>;
    ondelete: (head: HeadRecord) => void;
  }
  let { head, liveRevision, isActive, busy = false, onactivate, ondelete }: Props = $props();

  // Re-derived locally (see prop doc).  `current` when the head
  // was trained on the workspace's current revision.
  const isCurrent = $derived(head.workspace_revision.id === liveRevision);

  let activating = $state(false);
  async function onActivateClick(): Promise<void> {
    if (activating || isActive || busy) return;
    activating = true;
    try {
      await onactivate(head.head_id);
    } finally {
      activating = false;
    }
  }

  const interactionDisabled = $derived(busy || activating);
</script>

<!-- One row in the heads list.  Padded denser than top-level
     panels (`p-3` vs `p-5`) because heads list inside the
     Heads section, which is itself padded; matching the
     panel's `p-5` would feel cavernous.  Border / bg shift to
     a faint blue when this is the active head -- the visual
     pairs with the dashboard's Active Head card. -->
<li
  class="flex flex-wrap items-baseline justify-between gap-3 rounded-md border px-3 py-2.5 transition-colors"
  class:border-blue-200={isActive}
  class:bg-blue-50={isActive}
  class:border-zinc-200={!isActive}
  class:bg-white={!isActive}
>
  <div class="min-w-0 flex-1">
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <p class="font-mono text-[10px] text-zinc-800" title={head.head_id}>
        {head.head_id.slice(0, 8)}…
      </p>
      <!-- Status pill ("current" emerald / "stale" amber) -->
      <span
        class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize transition-colors duration-200"
        class:bg-emerald-100={isCurrent}
        class:text-emerald-800={isCurrent}
        class:bg-amber-100={!isCurrent}
        class:text-amber-800={!isCurrent}
      >
        {isCurrent ? 'current' : 'stale'}
      </span>
      {#if isActive}
        <span
          class="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium capitalize text-blue-800 transition-colors duration-200"
        >
          active
        </span>
      {/if}
    </div>
    <p class="mt-1 text-[11px] text-zinc-500">
      {head.n_classes}
      {head.n_classes === 1 ? 'class' : 'classes'} · {formatBytes(head.size_bytes)} · rev {head
        .workspace_revision.id}
      <span class="text-zinc-400" title={head.created_at}>· {formatRelative(head.created_at)}</span>
    </p>
  </div>

  <div class="flex shrink-0 items-center gap-2">
    <Button
      size="sm"
      variant="secondary"
      onclick={onActivateClick}
      disabled={isActive || interactionDisabled}
      loading={activating}
      title={isActive ? 'Already the active head' : 'Hot-swap this head into the inference engine'}
    >
      {#if isActive}Active{:else}Activate{/if}
    </Button>
    <button
      type="button"
      onclick={() => ondelete(head)}
      disabled={isActive || interactionDisabled}
      title={isActive
        ? "Can't delete the active head. Activate another head or revert to default first."
        : 'Delete this head'}
      aria-label="Delete head"
      class="inline-flex shrink-0 items-center justify-center gap-1 rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-500 transition disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-300 enabled:hover:border-rose-200 enabled:hover:bg-rose-50 enabled:hover:text-rose-700"
    >
      <TrashIcon />
    </button>
  </div>
</li>
