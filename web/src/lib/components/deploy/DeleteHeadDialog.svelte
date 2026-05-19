<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import TrashIcon from '$lib/components/ui/TrashIcon.svelte';
  import { heads as headsApi } from '$lib/api/endpoints';
  import { errorCopy } from '$lib/utils/error-copy';
  import { formatBytes } from '$lib/utils/format';
  import type { HeadRecord, Uuid } from '$lib/api/types';

  interface Props {
    open: boolean;
    workspaceId: Uuid;
    // Null while transitioning open → closed.  Snapshot held by
    // the parent so the dialog body keeps painting the right
    // head's identity even after the parent clears its
    // selection ref.
    head: HeadRecord | null;
    onclose: () => void;
    // Fires after a successful DELETE ack so the parent can
    // refresh the workspace detail; the dialog itself stays
    // open in `submitting` state until the parent closes it
    // (typically immediately, no spinner needed since the
    // daemon delete is synchronous).
    ondeleted?: (deletedHeadId: Uuid) => void;
  }
  let { open, workspaceId, head, onclose, ondeleted }: Props = $props();

  let submitting = $state(false);
  let backendError = $state<string | null>(null);

  // Reset on each open transition so re-opening for a different
  // head doesn't show a stale error from a prior attempt.
  $effect(() => {
    if (open) {
      submitting = false;
      backendError = null;
    }
  });

  async function confirm(): Promise<void> {
    if (submitting || !head) return;
    submitting = true;
    backendError = null;
    try {
      const resp = await headsApi.delete(workspaceId, head.head_id);
      ondeleted?.(resp.deleted_head_id);
      onclose();
    } catch (e) {
      backendError = errorCopy(e);
      submitting = false;
    }
  }
</script>

<Modal {open} title="Delete this head?" {onclose} closeOnBackdrop={!submitting}>
  <!-- Identity strip mirrors the HeadRow's identity exactly so the
       confirmation reads as "yes, this is the row you just clicked":
       mono short head id as the headline (with full UUID on hover via
       `title`), and the row's meta line below (size · classes · rev).
       Mirrors the workspace-delete dialog's identity strip so the
       two destructive surfaces feel like a family. -->
  {#if head}
    <div
      class="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-900 wrap-break-word"
    >
      <p class="font-mono text-sm font-semibold text-zinc-900" title={head.head_id}>
        {head.head_id.slice(0, 8)}…
      </p>
      <p class="mt-0.5 text-[11px] text-zinc-500">
        {formatBytes(head.size_bytes)} · {head.n_classes}
        {head.n_classes === 1 ? 'class' : 'classes'} · rev {head.workspace_revision.id}
      </p>
    </div>
  {/if}
  <p class="text-xs text-zinc-600 wrap-break-word">
    Removes the trained head bytes and its manifest. The dataset and any other heads stay. Can't be
    undone.
  </p>

  {#if backendError}
    <div
      class="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
      role="alert"
    >
      {backendError}
    </div>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={onclose} disabled={submitting}>Cancel</Button>
    <Button variant="destructive" onclick={confirm} loading={submitting} disabled={!head}>
      {#if !submitting}<TrashIcon />{/if}
      Delete
    </Button>
  {/snippet}
</Modal>
