<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import PlusIcon from '$lib/components/ui/PlusIcon.svelte';
  import { inputClass } from '$lib/components/ui/inputClass';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import type { WorkspaceMutationResp } from '$lib/api/types';
  import { validateWorkspaceName } from './name-validate';
  import { errorCopy } from '$lib/utils/error-copy';

  interface Props {
    open: boolean;
    onclose: () => void;
    oncreated?: (resp: WorkspaceMutationResp) => void;
  }
  let { open, onclose, oncreated }: Props = $props();

  let name = $state('');
  let submitting = $state(false);
  // Backend / network error, surfaced inline beneath the form.
  // Native `<dialog>` sits in the browser top-layer above any
  // fixed-position surface, so any future toast layer (Slice E)
  // would be hidden behind the backdrop while this dialog is open.
  let backendError = $state<string | null>(null);

  // Live validation derived from `name`.  Returns null while the
  // input is empty (don't yell on the initial state -- the disabled
  // submit button already telegraphs "more input required") and
  // returns the structured error message the moment the operator
  // types something that won't pass the daemon's rules.  Mirrors
  // the backend's `validate_workspace_name` so the operator sees
  // the same verdict locally without a round-trip.
  const trimmedName = $derived(name.trim());
  const nameError = $derived(trimmedName.length > 0 ? validateWorkspaceName(trimmedName) : null);
  const canSubmit = $derived(!submitting && trimmedName.length > 0 && !nameError);

  // Reset on open transitions so re-opening doesn't show stale
  // state from a previous attempt.  $effect with `open` as the
  // dependency fires on every open->close and close->open flip.
  $effect(() => {
    if (open) {
      name = '';
      backendError = null;
      submitting = false;
    }
  });

  let nameInputEl = $state<HTMLInputElement | undefined>();
  // Autofocus on open.  Defer a tick so we don't race the dialog's
  // native auto-focus, which would clobber an immediate `.focus()`.
  $effect(() => {
    if (!open || !nameInputEl) return;
    const el = nameInputEl;
    queueMicrotask(() => el.focus());
  });

  async function submit(e?: Event): Promise<void> {
    e?.preventDefault();
    // The derived `canSubmit` already gates `disabled` on the
    // button; the early-return here defends against pressing Enter
    // inside the input field, which bypasses the button's disabled
    // state but still fires `submit` on the form.
    if (!canSubmit) return;
    submitting = true;
    backendError = null;
    try {
      const resp = await workspaces.create({ name: trimmedName });
      oncreated?.(resp);
      onclose();
    } catch (e) {
      backendError = errorCopy(e);
    } finally {
      submitting = false;
    }
  }
</script>

<Modal {open} title="New workspace" {onclose} closeOnBackdrop={!submitting}>
  <form onsubmit={submit} class="flex flex-col gap-3">
    <label class="block">
      <span class="mb-1 block text-xs text-zinc-600">Name</span>
      <input
        bind:this={nameInputEl}
        type="text"
        bind:value={name}
        disabled={submitting}
        autocomplete="off"
        spellcheck="false"
        maxlength="128"
        placeholder="my-workspace"
        aria-invalid={nameError ? true : undefined}
        aria-describedby={nameError ? 'create-workspace-error' : undefined}
        class={inputClass(!!nameError)}
      />
    </label>

    {#if nameError}
      <p id="create-workspace-error" class="-mt-1 text-xs text-rose-700" role="alert">
        {nameError}
      </p>
    {/if}

    {#if backendError}
      <div
        class="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
        role="alert"
      >
        {backendError}
      </div>
    {/if}

    <p class="text-[11px] text-zinc-500">
      Up to 128 characters. No slashes or control characters. The name is the only visible
      identifier, so pick something memorable.
    </p>
  </form>

  {#snippet footer()}
    <Button variant="secondary" onclick={onclose} disabled={submitting}>Cancel</Button>
    <Button onclick={submit} loading={submitting} disabled={!canSubmit}>
      {#if !submitting}<PlusIcon />{/if}
      Create
    </Button>
  {/snippet}
</Modal>
