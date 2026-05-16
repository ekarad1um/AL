<script lang="ts">
  import { untrack } from 'svelte';
  import { getSliceSpectrogramUrl } from '$lib/audio/spectrogram';
  import type { SliceRecord } from '$lib/idb/db';

  // One slice rendered as a rectangular card with its spectrogram
  // PNG as the background.  Architecture spec
  // ([ARCHITECTURE.md §A.4 item 4.1]): "rendering slices as
  // rectangular card elements, using their Spectrogram image as
  // the background fill."
  //
  // Card size matches the spectrogram engine's canvas (96 × 64 px)
  // so the `<img>` renders 1:1 -- no in-browser scaling, crisp
  // pixels.  The parent `SlicePane` lays cards out in a
  // `grid-cols-[repeat(auto-fit,96px)] justify-evenly gap-2` grid:
  // fixed 96 px tracks (so the cell width matches the card and
  // the inter-card distance is the only horizontal variable),
  // `justify-evenly` distributes leftover width into equal slots
  // across edges + gaps, and `gap-2` holds the floor at 8 px so
  // cards never touch.  At the typical workspace width that flows
  // 8-12 cards per row.
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
    // True while the parent SlicePane is in its selecting FSM mode
    // (regardless of whether the selection set is currently empty
    // -- the mode persists across `Deselect all` until `Done` /
    // Esc exits).  In selecting mode the hover-revealed trash icon
    // swaps for an always-visible checkbox at the same top-right
    // anchor, the card's bare-click handler toggles selection
    // instead of playing, and the chrome telegraphs "you're
    // curating a batch" at a glance.  Mirrors the workspaces
    // WorkspaceCard's `mode === 'selecting'` reads from the
    // workspaces store -- slice uses pane-local state for the
    // same FSM because the selection scope is already
    // (workspace, category)-bound.
    multiSelectActive: boolean;
    // True while this slice is mid-`slices.delete()` (set by the
    // store's `deletingIds` set on entry to the delete lifecycle
    // and cleared in its try/finally).  When true the card is
    // grayed out + non-interactive + carries a centred spinner
    // overlay -- the operator should treat it as "in the process
    // of disappearing, hands off."  Mirrors `WorkspaceCard`'s
    // `isDeleting` read from `workspaces.deleting`.  The flag is
    // pane-driven (not derived from the slice's `state` field)
    // because all four record states (`local` / `uploading` /
    // `committed` / `failed`) can route into `delete()`, so the
    // store's mid-flight set is the only honest "is this row
    // being deleted RIGHT NOW" signal.
    deleting: boolean;
    onPlay: () => void;
    onPick: (mods: PickModifiers) => void;
    onDelete: () => void;
    // Manual retry path for `state === 'failed'` slices.  The
    // SlicePane wires this to `slices.enqueueUpload(id)`.
    onRetry: () => void;
  }
  let {
    slice,
    playing,
    selected,
    multiSelectActive,
    deleting,
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

  let url = $state<string | null>(null);
  let pending = $state(true);

  // Lazy fetch the spectrogram URL.  The id is captured via a
  // `$derived` so the effect tracks ONLY the id (not the full
  // `slice` prop reference), and the slice itself is read inside
  // `untrack` so upload-progress patches that swap the slice
  // reference don't re-fire this effect.  Cache hits in
  // `getSliceSpectrogramUrl` would make the re-fires cheap, but
  // the Promise + microtask churn adds up across a 30-slice batch
  // mid-upload.  Component remount on real id change is still
  // guaranteed by the parent's `{#each}` key.
  const sliceId = $derived(slice.id);
  $effect(() => {
    const id = sliceId;
    let cancelled = false;
    pending = true;
    untrack(() => {
      void getSliceSpectrogramUrl(slice)
        .then((u) => {
          if (cancelled) return;
          url = u;
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          // Spectrogram failure is decorative -- log to console and
          // leave the card without an image.  The operator can
          // still click to play / right-click to delete.
          console.warn(`[slice ${id}] spectrogram render failed`, e);
          url = null;
        })
        .finally(() => {
          if (cancelled) return;
          pending = false;
        });
    });
    return () => {
      cancelled = true;
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

<!-- Wrapper is `position: relative` for the absolutely-positioned
     trash icon; `group` so the icon can use `group-hover` to fade
     in.  `data-slice-id` is what the parent's contextmenu handler
     walks `closest()` to identify which slice was right-clicked.
     `aria-selected` so screen readers + automated tests can read
     the multi-select state without relying on the visual badge.
     When `deleting` is true:
       - `opacity-50` greys the card so the operator sees at a
         glance that it's on its way out, distinct from the
         resting / selected / playing states.
       - `pointer-events-none` blocks every mouse click + hover +
         right-click on the card surface.  The grid div's
         `contextmenu` handler still receives the event by event
         bubbling, but the `event.target` walks past
         `[data-slice-id]` -- the parent SlicePane treats that as
         "no slice clicked" and no menu opens (also a defensive
         `deletingIds.has(id)` gate sits in the handler).
       - `pointer-events-none` does NOT block keyboard activation
         on a focused descendant button, so the inner card button
         + the trash / checkbox button below also carry their own
         `disabled={deleting}` so keyboard Enter / Space on a
         focused deleting card cannot re-fire play / select /
         delete handlers.  The pane-side `play()` / `toggleSelection()`
         / `retryUpload()` and the store-side `delete()` all gate
         on `deletingIds` too -- belt-and-braces; one of those is
         enough on its own, all three guarantee the race never
         lands regardless of the entry path.
       - `aria-busy` makes the state legible to screen readers
         without relying on the visual gray; an `sr-only` literal
         phrase (rendered below) reinforces it for the live-region
         path. -->
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
    class="block h-16 w-24 overflow-hidden rounded-md border-2 bg-zinc-100 transition duration-200 ease-out focus:outline-none"
    class:border-zinc-200={!playing && !isFailed && !selected}
    class:border-blue-400={selected && !playing && !isFailed}
    class:border-blue-500={playing}
    class:border-rose-400={isFailed}
    class:bg-blue-50={selected && !playing && !isFailed}
    class:hover:border-zinc-400={!playing && !isFailed && !selected}
    onclick={onCardClick}
    aria-label={multiSelectActive
      ? `${selected ? 'Deselect' : 'Select'} slice ${slice.filename}`
      : `Play slice ${slice.filename}`}
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
      <!-- STATIC placeholder during spectrogram generation -- no
           animation.  An earlier draft rendered an `animate-spin`
           Spinner here, but a cold expand of a 200-slice category
           lit 200 spinning SVGs simultaneously: 200 transform
           recalcs and 200 compositor layers per frame, on top of
           the live dashboard's RAF loop, producing visible jank.
           Same trade-off the author already made for the *delete*
           state (see the block comment further down: "NO per-card
           overlay or animation").  The card just renders an empty
           zinc fill until the spectrogram URL resolves; the image
           then pops into place via the `<img>` branch.  The
           transition is short (cache hits resolve in a microtask;
           fresh renders in ~10-50 ms) so the missing affordance
           costs the operator nothing -- they don't have time to
           ask "is this still loading?" before the image lands. -->
      <div class="h-full w-full bg-zinc-100" aria-hidden="true"></div>
    {:else}
      <!-- Neutral fallback for failed spectrogram render.  Looks
           visually muted but the card is still functional.  The
           bg-zinc-200 + wave icon distinguishes this from the
           pending state's plain bg-zinc-100, so an operator who
           glances at a grid of mixed pending / failed cards can
           tell which ones gave up vs which ones are still in
           flight. -->
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

  <!-- Hover-revealed play affordance.  A white play triangle
       centred over the spectrogram with a soft drop shadow --
       no opaque backdrop, no border, just the silhouette.  The
       symbol fades in on `group-hover` so the operator sees
       exactly what their cursor is about to do (click → play).
       Why white-fill-plus-shadow rather than a chip + icon: the
       plasma colormap runs from dark purple (low energy) through
       magenta + orange to bright yellow (high energy).  A solid
       coloured chip would clash with whichever end of the ramp
       dominates the card.  A bare white fill alone disappears
       against the yellow peaks; a bare dark fill alone disappears
       against the purple troughs.  White fill + a subtle dark
       drop shadow gives the silhouette two contrast signals at
       once (fill against dark regions, shadow against light) so
       it reads cleanly on any slice's spectrogram without
       caring what the actual frequencies happen to look like.
       `pointer-events-none` so the icon doesn't intercept the
       click -- the underlying `<button>` is still the hit target,
       and the existing onCardClick flow runs unchanged.
       Hidden by `{#if}`:
         - `multiSelectActive`: bare click toggles selection in
           selecting mode, not playback.  A play triangle here
           would lie about what the click does.
         - `playing`: the active card already telegraphs playback
           via its blue border ring; a stationary triangle on top
           would compete with that signal and read as "you can
           start playback" while the card is in fact already
           playing.
         - `isUploading` / `isFailed`: those states get their own
           bottom-anchored chrome (progress bar / retry badge);
           an overlapping centred play icon would crowd a card
           that's already telegraphing a more important state. -->
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

  <!-- Deleting state: NO per-card overlay or animation.
       An earlier draft layered a centred dark veil + an
       `animate-spin` SVG on every card mid-`delete()`, but for a
       30-slice batch that meant 30 simultaneous spinners painting
       every frame -- 30 transform recalcs + 30 compositor layers
       on top of the live-audio RAF loop on the dashboard side.
       The animated chrome moved to the toolbar's Delete button
       (one spinner, regardless of how many rows are in flight),
       so per-card feedback compresses to the static
       `opacity-50` + `pointer-events-none` + `aria-busy` set on
       the wrapper.  Operators still see WHICH rows are draining
       (greyed-out) and HOW MANY are draining (the toolbar's
       "Deleting N…" counter); they just don't pay 30x the paint
       cost to learn each of those facts independently.  An
       `sr-only` literal phrase under the wrapper keeps the
       state legible to screen readers without depending on the
       visual gray. -->
  {#if deleting}
    <span class="sr-only">Deleting slice {slice.filename}</span>
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
      aria-label="Retry upload for slice {slice.filename}"
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

  <!-- Top-right affordance.  Two distinct states share an
       identical 20×20 hit area, `top-1.5 right-1.5` anchor, and
       `rounded-md` + `shadow-sm` chrome -- so the visual rhythm
       across the grid is preserved when the pane shifts between
       modes:
         * Multi-select mode (any slice selected anywhere on the
           pane): always-visible checkbox.  Filled blue + white
           check when this card is selected, white-over-zinc-300
           outline when not.  Clicking the checkbox toggles
           through the same `onPick(toggle)` path that the card
           surface uses, so the SlicePane has one source of truth
           for the selection set.
         * Default mode (no selection live): hover-revealed trash
           icon.  Single-click delete for ad-hoc removals without
           dropping into the selection workflow.  `pointer-events-
           none` at rest stops the wrapper from blocking the
           card's bare-click play handler.
       Both branches use `h-5 w-5` + a centered SVG so the button
       footprint is identical regardless of mode (operator's mouse
       doesn't have to re-target the corner on a mode flip). -->
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
      aria-label={selected ? `Deselect slice ${slice.filename}` : `Select slice ${slice.filename}`}
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
      aria-label="Delete slice {slice.filename}"
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
