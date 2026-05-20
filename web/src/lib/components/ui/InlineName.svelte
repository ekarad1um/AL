<script lang="ts">
  import { onMount } from 'svelte';
  import { validateWorkspaceName } from '$lib/components/workspace/name-validate';

  // Inline-editable name input.  Replaces a card's static `<h2>`
  // when the operator picks "Rename" from the row's right-click
  // menu.
  //
  // ## Layout-stable design
  //
  // The input + outer wrapper combine to occupy the SAME 44-px
  // row height as the static `<h2>` it replaces.  Keys:
  //
  //   * Input is `h-7` (28 px, box-sizing border-box default)
  //     with `px-2 py-1` so the typed text sits inside a small
  //     "input field" pill with breathing room around it rather
  //     than reading as raw inline text.  Border is included
  //     in the box, so the always-present 1-px border never
  //     grows or shrinks it across the valid<->invalid swap.
  //   * The owning card flips its outer padding from `py-3`
  //     (the static row's 12+12 = 24 px) to `py-2` (the edit
  //     row's 8+8 = 16 px), which exactly cancels the 8-px
  //     growth from `h-5` (the bare line box) to `h-7` (the
  //     padded pill).  Net row height stays at 44 px on toggle.
  //   * Border is `border-transparent` by default and flips
  //     `border-rose-500` on policy violation -- the Tailwind
  //     utility is what paints when the input isn't focused
  //     (briefly during save, when `disabled` removes focus).
  //     The valid<->invalid transition is a 0-px layout swap
  //     because the 1-px border slot is always reserved.
  //   * The focused-state rose border + rose halo (the actual
  //     `:focus-visible` paint, which is the only state the
  //     operator sees once typing starts) come from the global
  //     `input[aria-invalid='true']:focus-visible` rule in
  //     `app.css`, gated by the `aria-invalid={hasError}`
  //     attribute on the element below.  Doing it in the
  //     global rule (unlayered) is load-bearing: Tailwind
  //     utilities sit in `@layer utilities` and would lose to
  //     the unlayered blue-focus rule via cascade-layer
  //     precedence regardless of selector specificity.  See
  //     the app.css comment block for the full cascade
  //     reasoning.
  //   * `bg-zinc-50` (lifted to `bg-zinc-100` while saving)
  //     gives the input a faint fill so the padding the
  //     operator just claimed is visible -- otherwise the
  //     `px-2 py-1` would read as wasted whitespace.
  //   * `font-semibold` matches the `<h2>` so the typed
  //     character widths and glyph weight render identically.
  //
  // ## No inline message line
  //
  // The component intentionally renders NO error / saving text.
  // The red border is the only validation signal; for an unclear
  // rejection the operator's recourse is Escape (revert) or
  // moving to the detail-page modal (`RenameWorkspaceDialog`)
  // where full error chrome lives.  The trade-off chosen here
  // is simplicity + no layout shift over richer in-place
  // diagnostics -- the inline path is the "quick rename"
  // affordance, not the explanatory one.
  //
  // ## Backend-reject handling
  //
  // A rare backend reject (name conflict, workspace-deleted
  // race) stamps the same red border as a client-side validation
  // failure.  The input stays mounted + refocused so the
  // operator can amend without losing their typed draft.
  // Typing anything clears the backend-error stamp so the
  // border returns to transparent the moment they react.
  //
  // ## Save-in-flight feedback
  //
  // While `onsave` is pending the input is `disabled` (browser
  // adds the cursor-wait pointer) and the background steps from
  // `bg-zinc-50` to `bg-zinc-100`.  No spinner, no text -- the
  // disabled + deeper tint is the entire feedback.
  interface Props {
    value: string;
    placeholder?: string;
    ariaLabel?: string;
    // Called with the trimmed, validated, changed draft.  May
    // throw -- the error stamps a red border + keeps the input
    // mounted so the operator can amend.
    onsave: (newValue: string) => Promise<void>;
    // Called when the operator dismisses without committing
    // (Escape, invalid-then-blur, empty-then-blur, unchanged-
    // then-blur).  Owners typically toggle the edit-mode flag
    // off so this component unmounts.
    oncancel: () => void;
  }
  let { value, placeholder, ariaLabel, onsave, oncancel }: Props = $props();

  // Seed `draft` from `value` on mount only.  Initialising
  // `$state` directly from a prop warns about capturing only
  // the initial value, but capture-once is what we want here --
  // subsequent value-prop changes (an external rename, say)
  // shouldn't blow away the operator's in-progress draft.
  let draft = $state('');
  onMount(() => {
    draft = value;
  });

  let saving = $state(false);
  let backendError = $state(false);
  // Set by the Escape path so the trailing blur (focus left the
  // input as part of Esc handling) doesn't commit the discard.
  let cancelled = $state(false);

  // Live validation derived from the draft.  Empty / unchanged
  // drafts aren't errors -- they're no-op cancels on blur -- so
  // the visual error only triggers when the operator typed
  // something that won't pass the daemon's rules.
  const trimmed = $derived(draft.trim());
  const unchanged = $derived(trimmed === value);
  const localError = $derived(
    trimmed.length > 0 && !unchanged ? validateWorkspaceName(trimmed) : null
  );
  // Single border-colour gate: client validation OR backend
  // reject.  Either flips the same red border.
  const hasError = $derived(localError !== null || backendError);

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
    if (localError !== null) {
      // Stay in edit mode; the red border already tells the
      // operator the draft can't commit.
      return;
    }
    saving = true;
    backendError = false;
    try {
      await onsave(trimmed);
      // Success: the owner unmounts us by flipping the edit flag.
    } catch {
      // Backend reject (name conflict, daemon error).  Flip the
      // same red border the client validator uses and refocus
      // so the operator can edit + retry without losing their
      // draft.  Specific error copy is intentionally not
      // surfaced here -- the inline path stays minimal; the
      // detail-page modal is where rich errors live.
      backendError = true;
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
    if (trimmed.length === 0 || unchanged || localError !== null) {
      // Blurring with an unsavable draft reverts -- the Notion
      // pattern.  Only an explicit, valid, changed blur commits.
      cancel();
      return;
    }
    void commit();
  }

  // Clear the backend-error stamp on any keystroke -- the
  // operator is actively amending, so the stale rejection
  // shouldn't keep colouring the border.  `localError` will
  // re-light immediately if their amend introduces a client-
  // side violation, so the visual signal stays load-bearing.
  function onInput(): void {
    if (backendError) backendError = false;
  }
</script>

<input
  bind:this={inputEl}
  type="text"
  bind:value={draft}
  oninput={onInput}
  onkeydown={onKey}
  onblur={onBlur}
  disabled={saving}
  autocomplete="off"
  spellcheck="false"
  maxlength="128"
  {placeholder}
  aria-label={ariaLabel}
  aria-invalid={hasError ? true : undefined}
  class="block h-7 w-full rounded-md border bg-zinc-50 px-2 py-1 text-sm font-semibold text-zinc-900 outline-none disabled:cursor-wait disabled:bg-zinc-100 {hasError
    ? 'border-rose-500'
    : 'border-transparent'}"
/>
