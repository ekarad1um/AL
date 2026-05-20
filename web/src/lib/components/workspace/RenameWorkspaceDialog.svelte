<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { inputClass } from '$lib/components/ui/inputClass';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import type { Uuid, WorkspaceMutationResp } from '$lib/api/types';
  import { validateWorkspaceName } from './name-validate';
  import { errorCopy } from '$lib/utils/error-copy';

  // Workspace-rename popup.  Sibling of `CreateWorkspaceDialog`
  // (same Modal envelope, same live-validation rhythm, same
  // submit pipe through `workspaces.patch`).  Replaces the
  // in-place `InlineName` editor that used to sit under the
  // workspace title -- centralising rename into a modal matches
  // the create flow, gives the operator more room to read a
  // long name, and frees the title row to always render as an
  // immutable `<h1>` with the tool-island counterweight.
  //
  // PATCH semantics: the daemon's PATCH-on-metadata (name /
  // tags) does NOT advance `workspace_revision`, so a rename
  // does not invalidate any of the workspace-keyed caches
  // (categories, slices, training history); the only state
  // that needs to flow back to the caller is the new `name`.
  // The dialog returns the full `WorkspaceMutationResp` via
  // `onsaved` so a future caller that also displays `tags`
  // doesn't need to refetch.

  interface Props {
    open: boolean;
    workspaceId: Uuid;
    /// The current name -- pre-filled into the input on open so
    /// the operator can edit in place rather than retype from
    /// scratch.  Read once per open transition (via the reset
    /// `$effect`); changes mid-open don't clobber the operator's
    /// in-flight edit.
    currentName: string;
    onclose: () => void;
    /// Fires after a successful PATCH lands.  Caller is
    /// expected to update its local `detail.name` from the
    /// response so the surrounding `<h1>` re-renders without
    /// another GET.
    onsaved?: (resp: WorkspaceMutationResp) => void;
  }
  let { open, workspaceId, currentName, onclose, onsaved }: Props = $props();

  let name = $state('');
  let submitting = $state(false);
  // Backend / network error surfaced beneath the form.  Same
  // rose-50 / rose-900 chrome as `CreateWorkspaceDialog`.
  let backendError = $state<string | null>(null);

  const trimmedName = $derived(name.trim());

  // Live validation mirrors the daemon's `validate_workspace_name`
  // rules.  Empty input shows no error (the disabled submit
  // button is signal enough); the moment the operator types
  // something disallowed, the input border + inline message
  // react.
  const nameError = $derived(trimmedName.length > 0 ? validateWorkspaceName(trimmedName) : null);

  // No-op gate: if the trimmed input matches the current name,
  // the submit button is disabled so the operator can't
  // accidentally fire a redundant PATCH (the daemon would
  // succeed but the round-trip is wasted).  An operator who
  // wants to confirm-without-change can just press Cancel.
  const isUnchanged = $derived(trimmedName === currentName);

  const canSubmit = $derived(!submitting && trimmedName.length > 0 && !nameError && !isUnchanged);

  // Reset on every open transition.  Without the guard the
  // effect would re-fire on every reactive read inside (e.g.
  // `currentName`) and clobber the operator's in-flight edit.
  let lastOpenSeen = $state(false);
  $effect(() => {
    if (open && !lastOpenSeen) {
      lastOpenSeen = true;
      name = currentName;
      backendError = null;
      submitting = false;
    } else if (!open && lastOpenSeen) {
      lastOpenSeen = false;
    }
  });

  let nameInputEl = $state<HTMLInputElement | undefined>();
  // Autofocus + select-all on open so the operator can type a
  // fresh name without first pressing Cmd-A.  Defer a tick so
  // we don't race the native `<dialog>` auto-focus.
  $effect(() => {
    if (!open || !nameInputEl) return;
    const el = nameInputEl;
    queueMicrotask(() => {
      el.focus();
      el.select();
    });
  });

  async function submit(e?: Event): Promise<void> {
    e?.preventDefault();
    // Guard against Enter-in-input bypassing the disabled
    // button; mirrors `CreateWorkspaceDialog`'s defensive
    // early-return.
    if (!canSubmit) return;
    submitting = true;
    backendError = null;
    try {
      const resp = await workspaces.patch(workspaceId, { name: trimmedName });
      onsaved?.(resp);
      onclose();
    } catch (e) {
      backendError = errorCopy(e);
    } finally {
      submitting = false;
    }
  }
</script>

<Modal {open} title="Rename workspace" {onclose} closeOnBackdrop={!submitting}>
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
        aria-invalid={nameError ? true : undefined}
        aria-describedby={nameError ? 'rename-workspace-error' : undefined}
        class={inputClass(!!nameError)}
      />
    </label>

    {#if nameError}
      <p id="rename-workspace-error" class="-mt-1 text-xs text-rose-700" role="alert">
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
      Up to 128 characters. No slashes or control characters. Renaming does not advance the
      workspace revision — categories, slices, and heads stay as they are.
    </p>
  </form>

  {#snippet footer()}
    <Button variant="secondary" onclick={onclose} disabled={submitting}>Cancel</Button>
    <Button onclick={submit} loading={submitting} disabled={!canSubmit}>Save</Button>
  {/snippet}
</Modal>
