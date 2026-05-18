<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
  import TrashIcon from '$lib/components/ui/TrashIcon.svelte';
  import { formatBytes } from '$lib/utils/format';
  import { formatRelative } from '$lib/utils/time';
  import type { HeadRecord, Uuid } from '$lib/api/types';

  interface Props {
    head: HeadRecord;
    // True ONLY for the most recently created head among those
    // matching the live workspace revision.  Drives the "Latest"
    // pill -- so a workspace with two heads at the same revision
    // shows the pill only on the newer one (operator's positive
    // scan target is "the most recent useful head", not "all heads
    // currently at the live rev").  Computed once at the list
    // level (HeadsTable) where the full heads array is in scope;
    // the row stays a pure renderer.
    isLatest: boolean;
    // True when this head is the runtime-active inference head AND
    // its source workspace matches the row's workspace.  Drives the
    // row's blue tint, the Deploy → Deployed button-label morph,
    // and disables the Deploy + Delete buttons (the daemon refuses
    // to delete the runtime-active head).  No standalone "Deployed"
    // pill: the row's chrome (border + bg) plus the button label
    // are enough -- a third indicator would be visual repetition.
    isDeployed: boolean;
    // Disabled while another head on this list is mid-mutation, so
    // the operator can't fire two destructive actions in parallel.
    busy?: boolean;
    ondeploy: (headId: Uuid) => Promise<void>;
    ondelete: (head: HeadRecord) => void;
  }
  let { head, isLatest, isDeployed, busy = false, ondeploy, ondelete }: Props = $props();

  let deploying = $state(false);
  async function onDeployClick(): Promise<void> {
    if (deploying || isDeployed || busy) return;
    deploying = true;
    try {
      await ondeploy(head.head_id);
    } finally {
      deploying = false;
    }
  }

  const interactionDisabled = $derived(busy || deploying);
</script>

<!-- One head row.  Headline is the head's short id rendered in
     mono -- the head id names the trained-weight artifact uniquely,
     much the way a Git commit short hash names a commit; the
     truncated 8-char form keeps the resting display compact while
     the headline span's `title` attribute carries the full UUID for
     hover-reveal (debug + copy-paste context, not in the way at a
     glance).  A positive "Latest" pill sits next to the headline
     when this row is the single most-recently-created head matching
     the live workspace revision (parent HeadsTable picks the winner
     via `isLatest`); every other row -- older revisions or
     same-revision-but-not-newest -- carries no pill, so the
     operator's eye scans for one marker rather than auditing each
     row's freshness.

     The description line below carries the head's metadata in
     reading order: size · rev · classes · age.  Size + rev lead
     with the artifact-on-disk facts; classes count sits adjacent
     to age so the pair reads as a single phrase ("learned N
     categories, X ago") at the right edge of the row, where the
     eye naturally lands after the headline.  Deployed rows tint
     blue to match the dashboard's Active Head card. -->
<li
  class="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5 transition-colors"
  class:border-blue-200={isDeployed}
  class:bg-blue-50={isDeployed}
  class:border-zinc-200={!isDeployed}
  class:bg-white={!isDeployed}
>
  <div class="min-w-0 flex-1">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <!-- Headline.  `font-mono` matches the rest of the codebase's
           "this is an opaque identifier" convention (see the
           training-history short-id chip, the deploy-error message's
           short-id mention, etc.).  `title` carries the full UUID for
           hover-reveal; the 8-char prefix is the typical short form
           operators use to disambiguate across a workspace's heads. -->
      <p class="font-mono text-sm font-semibold text-zinc-900" title={head.head_id}>
        {head.head_id.slice(0, 8)}…
      </p>
      {#if isLatest}
        <!-- Latest pill: conditional, mounts only on the single
             newest head at the live revision.  Other heads at
             older revisions -- AND additional same-revision heads
             trained earlier than the chosen one -- carry no pill,
             so the operator's positive scan target is "find the
             Latest" rather than "audit each row's freshness".
             StatusBadge's root in:fade / out:fade carries the
             appearance + disappearance, so a freshly trained head's
             pill materialises smoothly and the previous holder's
             pill dissolves on the same tick. -->
        <StatusBadge
          size="xs"
          label="Latest"
          tone="bg-emerald-100 text-emerald-800"
          title="Most recent head trained on the workspace's current revision."
        />
      {/if}
    </div>
    <p class="mt-1 text-[11px] text-zinc-500">
      {formatBytes(head.size_bytes)} · rev {head.workspace_revision.id} · {head.n_classes}
      {head.n_classes === 1 ? 'class' : 'classes'} ·
      <span class="text-zinc-400" title={head.created_at}>{formatRelative(head.created_at)}</span>
    </p>
  </div>

  <div class="flex shrink-0 items-center gap-2">
    <!-- Tooltip on a wrapper span so the explanation surfaces in
         Firefox as well: a disabled <button> doesn't fire pointer
         events in Firefox, so its native `title` tooltip stays
         hidden -- visible only in Chrome / Safari.  The span
         receives the hover, shows its own title, and the operator
         hovering the inactive "Deployed" or "Can't delete" button
         sees the same hint cross-browser. -->
    <span
      class="inline-flex shrink-0"
      title={isDeployed
        ? 'This head is already deployed'
        : 'Hot-swap this head into the inference pipeline'}
    >
      <Button
        size="sm"
        variant={isDeployed ? 'secondary' : 'primary'}
        onclick={onDeployClick}
        disabled={isDeployed || interactionDisabled}
        loading={deploying}
      >
        {#if isDeployed}Deployed{:else}Deploy{/if}
      </Button>
    </span>
    <span
      class="inline-flex shrink-0"
      title={isDeployed
        ? "Can't delete the deployed head. Deploy another head or revert to default first."
        : 'Delete this head'}
    >
      <button
        type="button"
        onclick={() => ondelete(head)}
        disabled={isDeployed || interactionDisabled}
        aria-label="Delete head"
        class="inline-flex shrink-0 items-center justify-center gap-1 rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-500 transition disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-300 enabled:hover:border-rose-200 enabled:hover:bg-rose-50 enabled:hover:text-rose-700"
      >
        <TrashIcon />
      </button>
    </span>
  </div>
</li>
