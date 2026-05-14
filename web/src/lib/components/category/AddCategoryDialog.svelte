<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import PlusIcon from '$lib/components/ui/PlusIcon.svelte';
  import { inputClass } from '$lib/components/ui/inputClass';
  import { categories } from '$lib/stores/categories.svelte';
  import { validateCategoryName, findCaseInsensitiveDuplicate } from './name-validate';
  import { isMandatoryCategory } from './labels';
  import { errorCopy } from '$lib/utils/error-copy';
  import type { Uuid } from '$lib/api/types';

  // Per-workspace category creation dialog.  Mirrors the B.1
  // CreateWorkspaceDialog shape (live validation, inline error
  // banner under the form, native <dialog> top-layer) so the two
  // surfaces read as one primitive applied to different data.
  interface Props {
    open: boolean;
    workspaceId: Uuid;
    onclose: () => void;
    oncreated?: (name: string) => void;
  }
  let { open, workspaceId, onclose, oncreated }: Props = $props();

  let name = $state('');
  let submitting = $state(false);
  // Backend / network error surfaced beneath the form.  Native
  // <dialog> sits in the browser top-layer above any z-index'd
  // surface; a future toast layer (Slice E) would be hidden by the
  // backdrop while this dialog is open.
  let backendError = $state<string | null>(null);

  const trimmedName = $derived(name.trim());

  // Live validation derived from the draft.  Empty input shows no
  // error (the disabled submit button is signal enough); the
  // moment the operator types something disallowed, the input
  // border + inline message react.  Mirrors the daemon's
  // AssetPath shape so the operator sees the same verdict locally
  // without a round-trip.
  const localError = $derived.by((): string | null => {
    if (trimmedName.length === 0) return null;
    const shape = validateCategoryName(trimmedName);
    if (shape) return shape;
    if (isMandatoryCategory(trimmedName)) {
      return 'Background Noise is the mandatory default; no need to add it.';
    }
    const existing = categories.for(workspaceId).entries.map((c) => c.name);
    const dup = findCaseInsensitiveDuplicate(trimmedName, existing);
    if (dup) {
      // Distinguish exact match from case-insensitive collision so
      // the operator understands why "Cat" is blocked when "cat"
      // already exists.
      return dup === trimmedName
        ? 'A category with this name already exists.'
        : `Conflicts with existing "${dup}" (names are case-insensitive on most filesystems).`;
    }
    return null;
  });

  const canSubmit = $derived(!submitting && trimmedName.length > 0 && !localError);

  // Reset on every open transition so a re-opened dialog doesn't
  // carry stale state from a prior attempt.
  $effect(() => {
    if (open) {
      name = '';
      backendError = null;
      submitting = false;
    }
  });

  let nameInputEl = $state<HTMLInputElement | undefined>();
  $effect(() => {
    if (!open || !nameInputEl) return;
    const el = nameInputEl;
    // Defer focus a tick so we don't race the dialog's own
    // auto-focus behaviour.
    queueMicrotask(() => el.focus());
  });

  async function submit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (!canSubmit) return;
    submitting = true;
    backendError = null;
    try {
      await categories.create(workspaceId, trimmedName);
      oncreated?.(trimmedName);
      onclose();
    } catch (e) {
      backendError = errorCopy(e);
    } finally {
      submitting = false;
    }
  }
</script>

<Modal {open} title="Add category" {onclose} closeOnBackdrop={!submitting}>
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
        maxlength="255"
        placeholder="e.g. cat"
        aria-invalid={localError ? true : undefined}
        aria-describedby={localError ? 'add-category-error' : undefined}
        class={inputClass(!!localError)}
      />
    </label>

    {#if localError}
      <p id="add-category-error" class="-mt-1 text-xs text-rose-700" role="alert">
        {localError}
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
      Letters, digits, dots, hyphens, and underscores. The name doubles as the on-disk directory
      name (e.g. <code class="font-mono">datasets/cat/</code>) and as the class label the trainer
      uses.
    </p>
  </form>

  {#snippet footer()}
    <Button variant="secondary" onclick={onclose} disabled={submitting}>Cancel</Button>
    <Button onclick={submit} loading={submitting} disabled={!canSubmit}>
      {#if !submitting}<PlusIcon />{/if}
      Add
    </Button>
  {/snippet}
</Modal>
