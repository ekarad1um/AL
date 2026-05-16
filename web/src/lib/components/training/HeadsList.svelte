<script lang="ts">
  import { fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { config as configStore } from '$lib/stores/config.svelte';
  import { errorCopy } from '$lib/utils/error-copy';
  import HeadCard from './HeadCard.svelte';
  import DeleteHeadDialog from './DeleteHeadDialog.svelte';
  import type { HeadRecord, Uuid } from '$lib/api/types';

  // Heads section on the workspace detail page.  Owns the
  // activate / delete coordination; the workspace detail page
  // owns the actual workspace refresh after either mutation
  // via the `onchanged` callback (the daemon-side mutation
  // doesn't bump `workspace_revision` for head ops, so the
  // page-level $effect that re-derives `liveRevision` from
  // upload receipts is correct as-is; we just need a fresh
  // `heads[]` pull).

  interface Props {
    workspaceId: Uuid;
    heads: readonly HeadRecord[];
    liveRevision: number;
    // Fires after a successful Activate or Delete so the
    // parent can refresh the workspace detail (heads[] +
    // anything else that may have shifted on the daemon).
    onchanged: () => Promise<void> | void;
  }
  let { workspaceId, heads, liveRevision, onchanged }: Props = $props();

  const active = $derived(configStore.active);
  // The runtime-active head's id when origin = 'head'.  Null
  // when the default head is active OR `config.active` hasn't
  // landed yet.
  const activeHeadId = $derived<Uuid | null>(
    active?.origin === 'head' ? active.source_head_id : null
  );

  // Newest-first display order.  The detail response sorts
  // heads in some daemon-internal order (insertion / head_id
  // hash bucket); newest-first reads more naturally for the
  // operator and aligns with the workspace list's sort.
  // Strict-weak-order comparator: returns 0 on equal
  // `created_at` so the rendered row order stays stable
  // across reactive re-fires when two heads share a timestamp.
  const ordered = $derived(
    heads
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
  );

  // Per-head busy id (we serialise activate / delete clicks).
  // Even though the daemon admits these synchronously, the
  // sequencing keeps the UI honest about which row is mid-
  // mutation -- relevant if the operator double-clicks across
  // rows during a slow network blip.
  let busyHeadId = $state<Uuid | null>(null);

  let deleteOpen = $state(false);
  // Snapshot of the head being targeted so the dialog body
  // keeps painting the right identity after we clear the
  // selection.
  let deleteHead = $state<HeadRecord | null>(null);

  // Last failed activation, surfaced inline as a slim banner
  // below the list.  Cleared on the next activate click (so a
  // retry hides the stale verdict before the new attempt
  // resolves) and on operator dismissal.  Carries the headId
  // so the copy can name the head the operator was trying to
  // activate -- helps disambiguate when a slow daemon makes
  // the operator click a second row before the first fails.
  let activateError = $state<{ headId: Uuid; message: string } | null>(null);

  async function activate(headId: Uuid): Promise<void> {
    if (busyHeadId !== null) return;
    busyHeadId = headId;
    // Clear the prior failure before the new attempt -- so a
    // retry's pending UI isn't shadowed by a stale red banner
    // describing the previous click.
    activateError = null;
    try {
      // The config store's `activateHead` already routes through
      // `POST /api/v1/active` and updates `config.active` with
      // the daemon's response, so the per-card "Active" pill
      // updates reactively without a refetch.  We still call
      // `onchanged` so the parent can pick up any other detail
      // changes (none today, but the contract is forward-
      // compatible).
      await configStore.activateHead(workspaceId, headId);
      await onchanged();
    } catch (e) {
      // Surface the failure inline -- without this the
      // operator's only signal is the spinner stopping, which
      // reads as a successful no-op against an already-active
      // head.  The realistic failure modes are 409 (head
      // deleted between click and daemon lookup) and 404
      // (head missing from the cached index); both recoverable
      // by retry or by activating a different head.
      activateError = { headId, message: errorCopy(e) };
    } finally {
      if (busyHeadId === headId) busyHeadId = null;
    }
  }

  function dismissActivateError(): void {
    activateError = null;
  }

  function requestDelete(head: HeadRecord): void {
    if (busyHeadId !== null) return;
    deleteHead = head;
    deleteOpen = true;
  }

  function onDeleteClose(): void {
    deleteOpen = false;
    // Hold the dialog's head snapshot for a moment so the
    // dialog can finish its close animation against the right
    // identity; cleared on next open via the dialog's effect.
  }

  async function onDeleted(): Promise<void> {
    // Delete is synchronous; refresh the workspace detail so
    // the heads array drops the deleted record.  The active
    // head can't be deleted (the daemon refuses with 409 and
    // the per-card button is disabled), so `config.active`
    // doesn't need a refresh here.
    await onchanged();
  }
</script>

<section class="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
  <header class="mb-3 flex items-baseline justify-between">
    <h2 class="text-sm font-semibold text-zinc-900">Heads</h2>
    <span class="text-[11px] text-zinc-500">
      {heads.length}
      {heads.length === 1 ? 'head' : 'heads'}
    </span>
  </header>

  {#if heads.length === 0}
    <p class="text-xs text-zinc-500">
      No heads trained yet. Once Train completes, the head will appear here for activation.
    </p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each ordered as head (head.head_id)}
        <HeadCard
          {head}
          {liveRevision}
          isActive={activeHeadId === head.head_id}
          busy={busyHeadId !== null && busyHeadId !== head.head_id}
          onactivate={activate}
          ondelete={requestDelete}
        />
      {/each}
    </ul>
  {/if}

  <!-- Activation-failure banner.  Mirrors TrainPane's
       start-error slim alert (rose-50/rose-200, fade-only
       transitions, dismiss button) so the two destructive-
       adjacent failure surfaces feel like one family.  Sits
       below the list (not above) so a slow-network failure
       doesn't shove the still-correct heads down on appear.
       Names the head id so the operator can correlate the
       message with the row they clicked even after the
       spinner clears. -->
  {#if activateError}
    <div
      in:fade={{ duration: 200, easing: cubicOut }}
      out:fade={{ duration: 160, easing: cubicOut }}
      class="mt-3 flex items-start justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs"
      role="alert"
    >
      <div class="min-w-0">
        <p class="font-medium text-rose-900">
          Could not activate head
          <span class="font-mono text-[10px] text-rose-700" title={activateError.headId}>
            {activateError.headId.slice(0, 8)}…
          </span>
        </p>
        <p class="mt-0.5 wrap-break-word text-rose-800">{activateError.message}</p>
      </div>
      <button
        type="button"
        onclick={dismissActivateError}
        aria-label="Dismiss"
        class="-mt-1 -mr-1 shrink-0 rounded-md p-1 text-rose-500 transition hover:bg-white/60 hover:text-rose-900"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5" aria-hidden="true">
          <path
            fill-rule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L8 6.586l2.293-2.293a1 1 0 111.414 1.414L9.414 8l2.293 2.293a1 1 0 01-1.414 1.414L8 9.414l-2.293 2.293a1 1 0 01-1.414-1.414L6.586 8 4.293 5.707a1 1 0 010-1.414z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    </div>
  {/if}
</section>

<DeleteHeadDialog
  open={deleteOpen}
  {workspaceId}
  head={deleteHead}
  onclose={onDeleteClose}
  ondeleted={onDeleted}
/>
