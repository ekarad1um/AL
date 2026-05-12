<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import TrashIcon from '$lib/components/ui/TrashIcon.svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import type { WorkspaceListEntry } from '$lib/api/types';

  interface Props {
    open: boolean;
    // Snapshot of the workspaces the operator selected at the moment
    // the dialog opened.  We capture this from the page so the
    // dialog's prose stays stable even if the store's selection
    // changes during the confirm step (e.g. the operator nudges a
    // checkbox in the background).
    targets: WorkspaceListEntry[];
    onclose: () => void;
  }
  let { open, targets, onclose }: Props = $props();

  let submitting = $state(false);

  $effect(() => {
    if (open) submitting = false;
  });

  function confirm(): void {
    if (submitting) return;
    submitting = true;
    // Fire-and-forget against the snapshot.  Passing `targets`
    // explicitly insulates the run from any background nudge to
    // the store's selection between open and confirm.  The store's
    // queue serializes through the daemon's single delete-family
    // slot; we close immediately so the operator watches cards
    // drain through the list's `deleting` state instead of a spinner.
    void workspaces.deleteSelected(targets);
    onclose();
  }
</script>

<Modal
  {open}
  title="Delete {targets.length} workspace{targets.length === 1 ? '' : 's'}?"
  {onclose}
  closeOnBackdrop={!submitting}
>
  <!-- One mono block per name; `max-h-60 overflow-y-auto` keeps the
       dialog viewport-sized when the operator selected many.  Tight
       single-line warning -- the active-inference fallback and
       per-card progress detail belong in docs, not the confirm. -->
  <ul class="max-h-60 space-y-1.5 overflow-y-auto">
    {#each targets as t (t.id)}
      <li
        class="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-900 wrap-break-word"
      >
        {t.name}
      </li>
    {/each}
  </ul>
  <p class="text-xs text-zinc-600 wrap-break-word">
    Removes each workspace's dataset, trained heads, and logs. Can't be undone.
  </p>

  {#snippet footer()}
    <Button variant="secondary" onclick={onclose} disabled={submitting}>Cancel</Button>
    <Button variant="destructive" onclick={confirm} loading={submitting}>
      {#if !submitting}<TrashIcon />{/if}
      Delete {targets.length}
    </Button>
  {/snippet}
</Modal>
