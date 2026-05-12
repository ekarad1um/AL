<script lang="ts">
  import { onMount } from 'svelte';
  import { inputClass } from '$lib/components/ui/inputClass';
  import { validateWorkspaceName } from '$lib/components/workspace/name-validate';
  import { errorCopy } from '$lib/utils/error-copy';
  import Spinner from '$lib/components/Spinner.svelte';

  // Inline-editable name input.  Used in place of a modal Rename
  // dialog -- the operator clicks the pencil affordance on a card
  // (or the detail-page header), the label collapses, this input
  // takes its place, and on Enter / blur the change commits via
  // the owner's `onsave` callback.
  //
  // Validation mirrors the modal path -- live, `$derived` from the
  // current draft, drives the input's red-border state and the
  // inline error message.  An invalid blur reverts; only a valid
  // changed draft commits.
  interface Props {
    value: string;
    // Text-size tier: matches the surrounding label so the input
    // doesn't visually jump on toggle.  `sm` for cards, `lg` for
    // the detail page h1, `md` for general-purpose forms.
    size?: 'sm' | 'md' | 'lg';
    // Optional placeholder when the input is empty.  We rarely
    // start empty (inline edit seeds from the current name) but
    // a defensive placeholder makes the empty-blur cancel path
    // visually unambiguous.
    placeholder?: string;
    // Hint surfaced to screen readers when the visual context
    // (a card name on hover) isn't enough on its own.
    ariaLabel?: string;
    // Called with the trimmed, validated, changed draft.  May
    // throw -- the error is caught and surfaced inline; the
    // component stays in edit mode so the operator can amend.
    onsave: (newValue: string) => Promise<void>;
    // Called when the operator dismisses without committing
    // (Escape, invalid-then-blur, empty-then-blur, unchanged-
    // then-blur).  Owners typically toggle the edit-mode flag
    // off so this component unmounts.
    oncancel: () => void;
  }
  let { value, size = 'sm', placeholder, ariaLabel, onsave, oncancel }: Props = $props();

  // Seed `draft` from `value` on mount only.  Initialising `$state`
  // directly from a prop warns about capturing only the initial
  // value, but capture-once is what we want here -- subsequent
  // value-prop changes (an external rename, say) shouldn't blow
  // away the operator's in-progress draft.
  let draft = $state('');
  onMount(() => {
    draft = value;
  });

  let saving = $state(false);
  let backendError = $state<string | null>(null);
  // Set by the Escape path so the trailing blur (focus left the
  // input as part of Esc handling) doesn't commit the discard.
  let cancelled = $state(false);

  // Live validation derived from the draft.  Empty / unchanged
  // strings aren't errors -- they just become no-op cancels on
  // blur -- so the visual error only triggers when the operator
  // typed something that won't pass the daemon's rules.
  const trimmed = $derived(draft.trim());
  const unchanged = $derived(trimmed === value);
  const localError = $derived(
    trimmed.length > 0 && !unchanged ? validateWorkspaceName(trimmed) : null
  );

  let inputEl = $state<HTMLInputElement | undefined>();
  $effect(() => {
    if (!inputEl) return;
    const el = inputEl;
    queueMicrotask(() => {
      el.focus();
      el.select();
    });
  });

  async function commit(): Promise<void> {
    if (cancelled || saving) return;
    if (trimmed.length === 0 || unchanged) {
      // Empty or unchanged drafts are dismissals, not commits.
      // The daemon doesn't need to hear about them.
      oncancel();
      return;
    }
    if (localError) {
      // Stay in edit mode; the red border + inline message
      // already tell the operator why.
      return;
    }
    saving = true;
    backendError = null;
    try {
      await onsave(trimmed);
      // Success: the owner unmounts us by flipping the edit flag.
    } catch (e) {
      backendError = errorCopy(e);
      // Re-focus so the operator can amend without an extra click.
      queueMicrotask(() => {
        inputEl?.focus();
        inputEl?.select();
      });
    } finally {
      saving = false;
    }
  }

  function cancel(): void {
    cancelled = true;
    draft = value;
    oncancel();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    }
  }

  function onBlur(): void {
    if (saving || cancelled) return;
    if (trimmed.length === 0 || unchanged || localError) {
      // Blurring with an unsavable draft reverts -- the Notion
      // pattern.  Only an explicit, valid, changed blur commits.
      cancel();
      return;
    }
    void commit();
  }

  const SIZE_TEXT: Readonly<Record<NonNullable<Props['size']>, string>> = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg font-semibold'
  };
</script>

<div class="flex flex-col gap-1">
  <input
    bind:this={inputEl}
    type="text"
    bind:value={draft}
    onkeydown={onKey}
    onblur={onBlur}
    disabled={saving}
    autocomplete="off"
    spellcheck="false"
    maxlength="128"
    {placeholder}
    aria-label={ariaLabel}
    aria-invalid={localError ? true : undefined}
    class="{inputClass(!!localError)} {SIZE_TEXT[size]}"
  />
  {#if localError}
    <p class="text-xs text-rose-700" role="alert">{localError}</p>
  {:else if backendError}
    <p class="text-xs text-rose-700" role="alert">{backendError}</p>
  {:else if saving}
    <p class="flex items-center gap-1 text-xs text-zinc-500">
      <Spinner class="h-3 w-3 text-zinc-500" />
      <span>saving…</span>
    </p>
  {/if}
</div>
