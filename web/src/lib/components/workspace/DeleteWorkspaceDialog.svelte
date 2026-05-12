<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import TrashIcon from '$lib/components/ui/TrashIcon.svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import type { Uuid } from '$lib/api/types';

  interface Props {
    open: boolean;
    workspaceId: Uuid;
    workspaceName: string;
    onclose: () => void;
    // Fires immediately on confirm, before the daemon ack (this
    // dialog is fire-and-forget; the store's queue tracks the
    // SSE-terminal lifecycle in the background).  Detail page
    // uses it to navigate back to the list; list page ignores it.
    ondeleted?: () => void;
  }
  let { open, workspaceId, workspaceName, onclose, ondeleted }: Props = $props();

  let submitting = $state(false);

  $effect(() => {
    if (open) submitting = false;
  });

  function confirm(): void {
    if (submitting) return;
    submitting = true;
    // Fire-and-forget: the store's queue handles the full DELETE +
    // SSE-terminal lifecycle in the background.  Closing the dialog
    // immediately lets the operator see the card transition through
    // the list's `deleting` state instead of staring at a spinner
    // for the few seconds the SSE terminal takes to land.
    void workspaces.delete(workspaceId);
    ondeleted?.();
    onclose();
  }
</script>

<Modal {open} title="Delete this workspace?" {onclose} closeOnBackdrop={!submitting}>
  <!-- One mono block for the name (`wrap-break-word` handles long
       names with no natural break opportunity), one tight sentence
       for the consequences.  Earlier copy spilled across three
       paragraphs with details (active-inference fallback, in-flight
       semantics) that belong in docs, not a confirm. -->
  <p
    class="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-900 wrap-break-word"
  >
    {workspaceName}
  </p>
  <p class="text-xs text-zinc-600 wrap-break-word">
    Removes the dataset, any trained heads, and logs. Can't be undone.
  </p>

  {#snippet footer()}
    <Button variant="secondary" onclick={onclose} disabled={submitting}>Cancel</Button>
    <Button variant="destructive" onclick={confirm} loading={submitting}>
      {#if !submitting}<TrashIcon />{/if}
      Delete
    </Button>
  {/snippet}
</Modal>
