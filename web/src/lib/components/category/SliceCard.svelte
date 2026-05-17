<script lang="ts">
  import { untrack } from 'svelte';
  import { getSliceSpectrogramUrl } from '$lib/audio/spectrogram';
  import { sliceFilename } from '$lib/idb/db';
  import type { SliceRecord } from '$lib/idb/db';

  // One slice rendered as a rectangular card with its spectrogram
  // PNG as the background.  Architecture spec
  // ([ARCHITECTURE.md §A.4 item 4.1]): "rendering slices as
  // rectangular card elements, using their Spectrogram image as
  // the background fill."
  //
  // Card is fluid-sized: `w-full aspect-3/2`.  The PNG is drawn
  // at the canonical 96 × 64 at the asset layer; the rendered
  // card width is driven by SlicePane's grid track (`minmax(96px,
  // 1fr)`).  `aspect-3/2` preserves the 96:64 ratio so width AND
  // height grow together — the time-per-pixel scale stays
  // constant across pane widths.  Horizontal-only stretch would
  // visibly squash the time axis and a "1 s clip" would read
  // shorter on a narrower pane than a wider one.  Typical upscale
  // at realistic pane widths is 2-15 % via the browser's default
  // bilinear/bicubic path, well below the band where blur is
  // perceptible.
  //
  // Interaction model (mirrors the architecture spec + B.1
  // ContextMenu idiom):
  //   * Click            -> play the slice via the parent's
  //                         AudioContext (delegated to onPlay).
  //   * Right-click      -> the parent SlicePane handles the
  //                         `contextmenu` event on the wrapping
  //                         `<div>` and shows the ContextMenu.
  //                         We surface `data-slice-id` so the
  //                         parent's walk picks us up.
  //   * Hover trash icon -> click-through-friendly delete (the
  //                         icon's onclick stops propagation so a
  //                         click on it isn't also a play).
  //
  // Deleting state: the slices store keeps a `deletingIds` set
  // populated for the duration of each `delete()` lifecycle (set
  // on entry, cleared in try/finally).  When the parent passes
  // `deleting={true}` the card greys out, a centred dark-veil +
  // spinner overlay covers the spectrogram, and the wrapper's
  // `pointer-events-none` blocks all interactions -- the row is
  // visibly "on its way out" and structurally non-interactable.
  // Single-card and bulk delete paths both flow through the same
  // store method, so the chrome is consistent regardless of how
  // the deletion was triggered.
  //
  // The spectrogram URL is fetched lazily on mount.  When the
  // request resolves, the `<img>` swaps in.  Failures (e.g.
  // OffscreenCanvas missing on a very old Safari) fall back to a
  // neutral zinc placeholder -- the card is still clickable and
  // deletable, just not visually distinguished.
  // Modifier flags for the parent's click discrimination: bare
  // click → play; ctrl/cmd-click → toggle selection; shift-click →
  // range-select from the last anchor.  Keeping the parent in
  // charge of selection state (and routing here through one
  // callback) means SliceCard remains stateless and the SlicePane
  // can maintain a single source of truth for the `Set<string>`.
  interface PickModifiers {
    toggle: boolean;
    range: boolean;
  }
  interface Props {
    slice: SliceRecord;
    playing: boolean;
    selected: boolean;
    // SlicePane is in selecting-FSM mode (persists across
    // `Deselect all` until `Done` / Esc exits).  Swaps the hover
    // trash for a checkbox and re-routes bare clicks to selection.
    // Mirrors WorkspaceCard's pane-local FSM; selection scope is
    // already (workspace, category)-bound.
    multiSelectActive: boolean;
    // Mid-`slices.delete()` (`deletingIds` set on entry, cleared
    // in finally).  Pane-driven, not derived from `slice.state`,
    // because every state (`local` / `uploading` / `committed` /
    // `failed`) can enter `delete()` and we need the in-flight
    // signal, not the record's persisted state.
    deleting: boolean;
    onPlay: () => void;
    onPick: (mods: PickModifiers) => void;
    onDelete: () => void;
    // Manual retry path for `state === 'failed'` slices.  The
    // SlicePane wires this to `slices.enqueueUpload(id)`.
    onRetry: () => void;
    // True when the parent's IntersectionObserver reports
    // this card's `data-slice-id` element as intersecting the
    // grid viewport (or its `rootMargin`-extended buffer).
    // Drives the lazy spectrogram fetch -- the WAV download +
    // FFT only fires when the operator has the card in view
    // for the debounce window.  Out-of-view cards never burn
    // network or CPU.
    visible: boolean;
  }
  let {
    slice,
    playing,
    selected,
    multiSelectActive,
    deleting,
    visible,
    onPlay,
    onPick,
    onDelete,
    onRetry
  }: Props = $props();

  // Per-state visual chrome.  `local` and `committed` render as
  // the neutral default; `uploading` overlays a progress bar at
  // the bottom + a soft blue tint; `failed` renders a red ring
  // around the card and a tiny refresh icon at the corner.
  const isUploading = $derived(slice.state === 'uploading');
  const isFailed = $derived(slice.state === 'failed');
  const isLocal = $derived(slice.state === 'local');
  const progressPct = $derived(
    isUploading ? Math.round(Math.max(0, Math.min(1, slice.upload_progress ?? 0)) * 100) : 0
  );
  // Daemon-facing filename derived from the content-addressed
  // id (`<sha256>.wav`).  Used in aria labels + screen-reader
  // copy so the operator hears a meaningful identifier
  // referenced by name.
  const filename = $derived(sliceFilename(slice.id));

  let url = $state<string | null>(null);
  // `pending` starts false -- a card that never becomes
  // visible never enters the loading state.  Flipped to true
  // when the debounce timer actually fires the fetch.
  let pending = $state(false);

  // Viewport-gated + debounced spectrogram fetch.
  //
  // Trigger conditions:
  //   * `visible` is true (IntersectionObserver in SlicePane
  //     reports the card's `data-slice-id` element as
  //     intersecting the grid's viewport + rootMargin).
  //   * `url` is null (we don't already have a rendered URL).
  //
  // Debounce: 150 ms after the card enters view.  Fast-scroll
  // transits (card visible <150 ms) clear the timer in the
  // effect cleanup and never trigger a fetch -- saves the
  // network + FFT work for cards the operator never paused
  // on.  150 ms also covers the IntersectionObserver's
  // initial-frame fire so the first paint isn't blocked.
  //
  // Cache layers (read inside `getSliceSpectrogramUrl`):
  //   1. In-memory `urlCache` (per-tab session).
  //   2. IDB-persisted `spectrograms` row (cross-session).
  //   3. Cold render: fetch WAV bytes -> FFT -> PNG.  Network
  //      cost only here.
  //
  // Effect re-fires when `visible` or `slice.id` change.  The
  // `slice` reference (read inside `untrack`) may flip
  // identity from a SvelteMap mutation in the parent (e.g. an
  // upload-progress patch); we don't re-fetch in that case
  // because `slice.id` is stable across patches.
  //
  // Error handling: failed fetch leaves `url = null`; the card
  // renders without a spectrogram (still playable + deletable).
  // Scrolling away + back re-fires this effect (via
  // visibleIds churn); since the failed render never cached
  // anything, the retry attempt fires fresh.
  const sliceId = $derived(slice.id);
  $effect(() => {
    const id = sliceId;
    const inView = visible;
    if (!inView) return;
    if (url !== null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      pending = true;
      untrack(() => {
        void getSliceSpectrogramUrl(slice)
          .then((u) => {
            if (cancelled) return;
            url = u;
          })
          .catch((e: unknown) => {
            if (cancelled) return;
            console.warn(`[slice ${id}] spectrogram render failed`, e);
            url = null;
          })
          .finally(() => {
            if (cancelled) return;
            pending = false;
          });
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Reset `pending` so a card whose fetch was cancelled
      // mid-flight (visibility flipped to false after the
      // debounce fired but before the fetch resolved) doesn't
      // leave its spinner stuck.  The `.finally` callback
      // bails on `cancelled` and never clears it on its own.
      pending = false;
    };
  });

  function onDeleteClick(e: MouseEvent): void {
    // Stop propagation so the click doesn't also fire the card's
    // Play handler.  preventDefault is unnecessary -- the button
    // has no default action.
    e.stopPropagation();
    onDelete();
  }

  function onRetryClick(e: MouseEvent): void {
    e.stopPropagation();
    onRetry();
  }

  // Discriminate "play" vs "select" by modifier + mode state:
  //   * ctrl/cmd toggles the slice in the parent's selection set.
  //   * shift extends the selection from the last anchor.
  //   * In multi-select mode (any selection live), bare click
  //     toggles instead of playing -- so once the operator has
  //     started selecting, they can keep adding or removing items
  //     by single click without holding a modifier the whole way
  //     through a 30-slice batch.  This matches the platform-
  //     standard pattern from native file managers (Finder,
  //     Windows Explorer) where bare clicks during an active
  //     selection extend the selection.  Exit the mode by hitting
  //     Esc / clearing selection in the header; then bare click
  //     reverts to "play".
  //   * Otherwise bare click plays the slice.
  // Keeping this branch in the card -- not the parent -- means the
  // modifier read happens on the same event that fired the click
  // handler.
  function onCardClick(e: MouseEvent): void {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      onPick({ toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
      return;
    }
    if (multiSelectActive) {
      e.preventDefault();
      onPick({ toggle: true, range: false });
      return;
    }
    onPlay();
  }

  function onSelectClick(e: MouseEvent): void {
    e.stopPropagation();
    onPick({ toggle: true, range: false });
  }
</script>

<!-- `relative + group` for the absolute-positioned trash hover.
     `data-slice-id` is what the parent's contextmenu handler walks
     `closest()` on.  When `deleting`:
       * `opacity-50` + `aria-busy` signal state visually + to SR.
       * `pointer-events-none` blocks mouse paths (contextmenu still
         bubbles to the grid, but the target walks past the
         `data-slice-id` so no menu opens; the handler also gates
         on `deletingIds`).
       * Descendant `<button>`s carry their own `disabled={deleting}`
         because `pointer-events-none` does NOT block keyboard
         activation on a focused descendant.  The pane-side `play()`
         / `toggleSelection()` / `retryUpload()` and the store-side
         `delete()` all gate on `deletingIds` independently. -->
<div
  class="group relative transition-opacity duration-200 ease-out"
  class:opacity-50={deleting}
  class:pointer-events-none={deleting}
  data-slice-id={slice.id}
  aria-selected={selected}
  aria-busy={deleting}
>
  <!-- Border-only state indicator: at rest, playing, failed, and
       selected all share `border-2` so the card's content box is
       the same 92×60 in every state -- no `ring-*` shadow that
       would visually overflow into the neighbouring grid cell.
       Selected overrides the resting border colour but yields to
       playing / failed so the audio + upload state stay primary. -->
  <button
    type="button"
    disabled={deleting}
    class="block aspect-3/2 w-full overflow-hidden rounded-md border-2 bg-zinc-100 transition duration-200 ease-out focus:outline-none"
    class:border-zinc-200={!playing && !isFailed && !selected}
    class:border-blue-400={selected && !playing && !isFailed}
    class:border-blue-500={playing}
    class:border-rose-400={isFailed}
    class:bg-blue-50={selected && !playing && !isFailed}
    class:hover:border-zinc-400={!playing && !isFailed && !selected}
    onclick={onCardClick}
    aria-label={multiSelectActive
      ? `${selected ? 'Deselect' : 'Select'} slice ${filename}`
      : `Play slice ${filename}`}
    title={isFailed
      ? `Upload failed: ${slice.last_error ?? 'unknown error'}.  Right-click to retry.`
      : isUploading
        ? `Uploading… ${progressPct}%`
        : isLocal
          ? 'Local -- awaiting upload'
          : multiSelectActive
            ? selected
              ? 'Click to deselect (Esc exits selection)'
              : 'Click to add to selection (Esc exits selection)'
            : playing
              ? 'Playing -- click to restart'
              : 'Click to play (Ctrl/Cmd-click to select)'}
  >
    {#if url}
      <!-- `decoding="async"` lets the browser decode off the main
           thread; `loading="eager"` is the default and what we
           want (the URL is in-tab data, not network). -->
      <img src={url} alt="" width="96" height="64" decoding="async" class="block h-full w-full" />
    {:else if pending}
      <!-- Static placeholder during render — same N-spinner paint
           cost the delete state opts out of (see below).  Cache
           hits resolve in a microtask, fresh renders in ~10-50 ms,
           so the missing affordance is below the operator's
           "is this loading?" threshold. -->
      <div class="h-full w-full bg-zinc-100" aria-hidden="true"></div>
    {:else}
      <!-- Failed-render fallback.  `bg-zinc-200` + wave icon
           distinguishes it from the pending state's `bg-zinc-100`
           so mixed grids read at a glance. -->
      <div class="flex h-full w-full items-center justify-center bg-zinc-200">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-4 w-4 text-zinc-400"
          aria-hidden="true"
        >
          <path d="M3 12h2l3-8 4 16 3-8h2" />
        </svg>
      </div>
    {/if}
  </button>

  <!-- Hover play affordance.  White fill + dark drop-shadow gives
       the silhouette two contrast signals so it reads against
       either end of the grayscale ramp (light-on-dark for the
       near-black peak bands, shadow-on-light for the near-white
       silence regions).
       `pointer-events-none` keeps the underlying `<button>` as the
       hit target.  Hidden when another state already owns the
       card: `multiSelectActive` (click toggles selection),
       `playing` (blue border already signals it), `isUploading` /
       `isFailed` (bottom-anchored chrome would clash), `deleting`. -->
  {#if !multiSelectActive && !playing && !isUploading && !isFailed && !deleting}
    <div
      class="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100"
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" class="h-7 w-7 fill-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.55)]">
        <path d="M8 5v14l11-7z" />
      </svg>
    </div>
  {/if}

  <!-- No per-card spinner during delete.  N simultaneous
       `animate-spin` cards in a bulk delete burned ~N transform
       recalcs + compositor layers per frame against the dashboard's
       live-audio RAF loop; the spinner moved to the toolbar's
       Delete button (one regardless of batch size).  Per-card
       feedback compresses to `opacity-50` + `pointer-events-none`
       + `aria-busy` on the wrapper, plus the `sr-only` phrase
       below for screen readers. -->
  {#if deleting}
    <span class="sr-only">Deleting slice {filename}</span>
  {/if}

  <!-- Upload progress overlay.  Visible only while `state ===
       'uploading'`.  Bottom-anchored bar leaves the spectrogram
       readable; the percentage is encoded in the bar width.
       `pointer-events-none` so it doesn't block clicks. -->
  {#if isUploading}
    <div
      class="pointer-events-none absolute right-0 bottom-0 left-0 h-1.5 bg-zinc-900/40"
      aria-hidden="true"
    >
      <div
        class="h-full bg-blue-500 transition-[width] duration-150"
        style:width="{progressPct}%"
      ></div>
    </div>
    <span class="sr-only">Uploading {progressPct}%</span>
  {/if}

  <!-- Failed-state corner badge.  Click to retry.  Always
       visible (not hover-gated) because the operator needs to
       see at-a-glance which slices need attention. -->
  {#if isFailed}
    <button
      type="button"
      disabled={deleting}
      class="absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded-md bg-rose-100 px-1 py-0.5 text-[9px] font-medium text-rose-800 transition duration-200 ease-out hover:bg-rose-200"
      onclick={onRetryClick}
      aria-label="Retry upload for slice {filename}"
      title={slice.last_error
        ? `Upload failed: ${slice.last_error}.  Click to retry.`
        : 'Upload failed.  Click to retry.'}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-2.5 w-2.5"
        aria-hidden="true"
      >
        <path d="M3 12a9 9 0 0115-6.7L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
      retry
    </button>
  {/if}

  <!-- Top-right affordance — checkbox in selecting mode, hover
       trash otherwise.  Both branches share the same 20×20 hit
       area + anchor so the mouse target doesn't shift on a mode
       flip.  Checkbox routes through `onPick(toggle)` so the
       SlicePane keeps one selection set; trash uses
       `pointer-events-none` at rest so the card's bare-click play
       handler is unblocked. -->
  {#if multiSelectActive}
    <button
      type="button"
      disabled={deleting}
      onclick={onSelectClick}
      class="absolute top-1.5 right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-md shadow-sm transition duration-200 ease-out"
      class:bg-blue-500={selected}
      class:text-white={selected}
      class:hover:bg-blue-600={selected}
      class:bg-white={!selected}
      class:ring-1={!selected}
      class:ring-inset={!selected}
      class:ring-zinc-300={!selected}
      class:hover:ring-blue-400={!selected}
      class:hover:bg-blue-50={!selected}
      aria-label={selected ? `Deselect slice ${filename}` : `Select slice ${filename}`}
      title={selected ? 'Deselect' : 'Select'}
    >
      {#if selected}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="3"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-3 w-3"
          aria-hidden="true"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      {/if}
    </button>
  {:else}
    <button
      type="button"
      disabled={deleting}
      class="pointer-events-none absolute top-1.5 right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-md bg-white text-rose-700 opacity-0 shadow-sm transition duration-200 ease-out group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:bg-rose-50"
      onclick={onDeleteClick}
      aria-label="Delete slice {filename}"
      title="Delete slice"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-3 w-3"
        aria-hidden="true"
      >
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="M19 6l-1 14H6L5 6" />
      </svg>
    </button>
  {/if}
</div>
