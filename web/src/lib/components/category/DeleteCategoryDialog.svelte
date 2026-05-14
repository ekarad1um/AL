<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import TrashIcon from '$lib/components/ui/TrashIcon.svelte';
  import { categories, type CategoryOrigin } from '$lib/stores/categories.svelte';
  import { prettyCategoryName } from './labels';
  import type { Uuid } from '$lib/api/types';

  // Delete-category confirmation.  Two flavours hidden behind one
  // dialog:
  //
  // - origin === 'idb': the category lives only in this browser's
  //   IDB (no slices on disk yet).  Local-only removal; the daemon
  //   never sees the DELETE.  We close the dialog on confirm; the
  //   store's delete() resolves immediately.
  //
  // - origin === 'server': the category has slices on the daemon.
  //   Fire-and-forget through the global delete queue (same idiom
  //   as the B.1 workspace-delete dialog): close the dialog
  //   immediately on confirm and let the row in the list show its
  //   own "deleting" pill until SSE-terminal lands.  This avoids
  //   the modal hanging open for the few seconds the async drain
  //   takes.
  interface Props {
    open: boolean;
    workspaceId: Uuid;
    categoryName: string;
    origin: CategoryOrigin;
    onclose: () => void;
    ondeleted?: () => void;
  }
  let { open, workspaceId, categoryName, origin, onclose, ondeleted }: Props = $props();

  let submitting = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (open) {
      submitting = false;
      error = null;
    }
  });

  const display = $derived(prettyCategoryName(categoryName));
  const isServerSide = $derived(origin === 'server');

  async function confirm(): Promise<void> {
    if (submitting) return;
    submitting = true;
    if (isServerSide) {
      // Fire-and-forget: the store queue handles the full DELETE +
      // SSE-terminal lifecycle in the background, and the list
      // dims the row through the `deleting` pill while it runs.
      // Errors surface back through the store; the operator sees
      // them on the row, not on a dialog that's no longer open.
      void categories.delete(workspaceId, categoryName).catch(() => undefined);
      ondeleted?.();
      onclose();
      return;
    }
    // Local-only: await the IDB write inline, then close.  Errors
    // are rare (IDB schema mismatch); surface inline if they
    // happen.
    try {
      await categories.delete(workspaceId, categoryName);
      ondeleted?.();
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not delete the category.';
    } finally {
      submitting = false;
    }
  }
</script>

<Modal {open} title="Delete this category?" {onclose} closeOnBackdrop={!submitting}>
  <p
    class="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-900 wrap-break-word"
  >
    {display}
    <span class="ml-1 text-zinc-500">· {categoryName}</span>
  </p>
  <p class="text-xs text-zinc-600 wrap-break-word">
    {#if isServerSide}
      Removes the dataset folder and every slice inside it. Can't be undone.
    {:else}
      Removes this category from the local list. No slices were uploaded, so nothing on the daemon
      changes.
    {/if}
  </p>

  {#if error}
    <div
      class="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
      role="alert"
    >
      {error}
    </div>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={onclose} disabled={submitting}>Cancel</Button>
    <Button variant="destructive" onclick={confirm} loading={submitting}>
      {#if !submitting}<TrashIcon />{/if}
      Delete
    </Button>
  {/snippet}
</Modal>
