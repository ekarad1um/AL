<script lang="ts">
  import type { Snippet } from 'svelte';

  // Thin wrapper over the native `<dialog>`.  Native dialog buys us:
  //   * focus trap inside the modal,
  //   * Escape to close,
  //   * top-of-stack rendering above any z-index,
  //   * automatic inert background.
  // We layer on top: open-prop binding, backdrop-click dismissal,
  // title slot, footer slot, and the visible card styling.
  interface Props {
    open: boolean;
    title?: string;
    // Owner-facing close signal.  Fires for Escape, backdrop click,
    // and any `<form method="dialog">` submission inside.  The owner
    // is expected to set `open = false` in response.
    onclose?: () => void;
    // When true (default), clicking the dialog's backdrop closes.
    // Set false for destructive flows where an accidental dismissal
    // would be high-cost (we still expose Escape and the in-modal
    // Cancel button).
    closeOnBackdrop?: boolean;
    children?: Snippet;
    footer?: Snippet;
    // Owner-supplied accessibility hint when no `title` is provided
    // (e.g. an entirely custom header rendered via the body snippet).
    ariaLabel?: string;
    // Width cap.  Defaults sized for short forms; longer wizards
    // can override with e.g. `max-w-2xl`.
    class?: string;
  }
  let {
    open,
    title,
    onclose,
    closeOnBackdrop = true,
    children,
    footer,
    ariaLabel,
    class: sizeClass = 'max-w-md'
  }: Props = $props();

  let dialogEl = $state<HTMLDialogElement | undefined>();

  // Drive the native open/close based on the `open` prop.  Using
  // showModal() (not show()) keeps the focus trap + backdrop active.
  // Guarding against double-call avoids the InvalidStateError
  // browsers throw if you call showModal() while already open.
  $effect(() => {
    const d = dialogEl;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  });

  function onBackdropClick(e: MouseEvent): void {
    if (!closeOnBackdrop || !dialogEl) return;
    // We can't rely on `e.target === dialogEl` to detect a
    // backdrop click: that condition is *also* true for clicks
    // that land on the dialog's own padding or on the gap between
    // its flex children (header / body / footer), because those
    // pixels belong to the dialog element itself, not to any
    // descendant.  An operator clicking in the dialog's whitespace
    // -- e.g. above an input -- would close the modal and lose
    // their typed input.  Use a bounding-rect check instead: a
    // click is a backdrop click only if its viewport coordinates
    // fall OUTSIDE the dialog's visible rect.  The native
    // `::backdrop` pseudo lives outside that rect by construction.
    const rect = dialogEl.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) onclose?.();
  }

  // The native `close` event fires for Escape, programmatic close(),
  // and form[method=dialog] submission -- all the dismissal paths.
  function onNativeClose(): void {
    if (open) onclose?.();
  }

  // Generated once per mount.  Putting `crypto.randomUUID()` inside
  // a $derived would re-roll the id on every dependency tick and
  // break the aria-labelledby <-> <h2 id=...> binding mid-render,
  // so we always allocate an id and let the template decide whether
  // to render it.  Costs eight bytes per modal mount; pays back in
  // simpler reactivity.
  const titleId = `modal-title-${crypto.randomUUID().slice(0, 8)}`;
</script>

<!-- The dialog is the card.  Layout utilities are gated on `open:`
     so the UA's default `dialog:not([open]) { display: none }` is
     not overridden when closed -- otherwise an unopened dialog
     would still occupy layout space (display: flex applies to
     :not([open]) too if specificity wins).  `m-auto` centres on the
     viewport via the UA's `inset: 0`; `max-h-[90vh] overflow-auto`
     keeps the card scrollable when content overflows. -->
<dialog
  bind:this={dialogEl}
  onclick={onBackdropClick}
  onclose={onNativeClose}
  aria-labelledby={title ? titleId : undefined}
  aria-label={title ? undefined : ariaLabel}
  class="m-auto w-full rounded-xl border border-zinc-200 bg-white shadow-xl backdrop:bg-zinc-900/50 backdrop:backdrop-blur-[2px] open:flex open:max-h-[90vh] open:flex-col open:gap-4 open:overflow-auto open:p-5 {sizeClass}"
>
  {#if title}
    <header class="flex items-baseline justify-between">
      <h2 id={titleId} class="text-sm font-semibold text-zinc-900">{title}</h2>
    </header>
  {/if}
  <div class="flex flex-col gap-3 text-sm text-zinc-700">
    {@render children?.()}
  </div>
  {#if footer}
    <footer class="mt-1 flex justify-end gap-2">
      {@render footer()}
    </footer>
  {/if}
</dialog>
