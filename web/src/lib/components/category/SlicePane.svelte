<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { slices } from '$lib/stores/slices.svelte';
  import { getSliceBlob } from '$lib/audio/slice-fetch';
  import { thresholdFor } from './labels';
  import SliceCard from './SliceCard.svelte';
  import Spinner from '$lib/components/Spinner.svelte';
  import Tips from '$lib/components/ui/Tips.svelte';
  import ContextMenu, {
    type MenuItem,
    type MenuSection
  } from '$lib/components/ui/ContextMenu.svelte';
  import type { Uuid } from '$lib/api/types';
  import type { SliceRecord } from '$lib/idb/db';

  // Slice Management pane.  Grid of `SliceCard`s backed by
  // pre-rendered spectrogram thumbnails; sits in the right pane of
  // the expanded category row alongside `InputPane`.
  //
  // Playback: one shared `AudioContext`, lazily constructed.  A
  // card click decodes its WAV blob and plays via a fresh
  // `AudioBufferSourceNode`; clicking another card stops the
  // prior source first.  `playingId` drives the active card's ring.
  //
  // Delete paths -- every entry point fires immediately, no
  // confirmation modal:
  //   Single -- hover trash or single-slice context menu; one click
  //     drops one 1 s clip (Finder hover-trash precedent).
  //   Batch  -- toolbar "Delete N", Del/Backspace on the focused
  //     grid, "Delete N slices" context entry; one click drops the
  //     captured selection.  Targets are snapshotted at click time
  //     so a background upload appending mid-`deleteMany` doesn't
  //     poison the batch.
  //
  // Why no confirm dialog on the batch path: selecting mode is
  // already an explicit opt-in (Ctrl/Cmd-click, Cmd/Ctrl+A,
  // right-click "Select"); the operator has then deliberately
  // ticked specific cards; the destructive rose toolbar pill
  // (`Delete N`) is the visible commitment.  Stacking a modal
  // on top is a duplicate "are you sure?" beat over intent the
  // operator has already expressed three times -- and it diverges
  // from the single-card path that already deletes immediately.
  // The toolbar's "Deleting N…" spinner + the per-card greyed-out
  // chrome give live feedback as the batch drains; failed targets
  // re-enter the selection on terminal so the operator can retry
  // without rebuilding it.  Workspaces' bulk delete keeps its
  // modal because its blast radius (whole dataset + heads + logs)
  // is a different magnitude from a 1 s clip.
  //
  // Selection FSM (`mode: 'normal' | 'selecting'`) mirrors the
  // workspaces list.  Normal mode = bare click plays; entry into
  // selecting via Ctrl/Cmd-click, the right-click menu, or
  // Cmd/Ctrl+A.  Selecting mode = checkbox per card, bare click
  // toggles selection, header shows the Select all / Done /
  // Delete N toolbar.  FSM is pane-local because selection scope
  // is already (workspace, category)-bound; mutators call
  // `enterSelecting()` (idempotent) so callers don't branch on
  // current mode.  Slice-specific tweaks vs workspace's FSM:
  // no idle "Select" CTA in the header (space-cramped, entry paths
  // suffice); single-card right-click "Delete" stays available in
  // selecting mode for the stray-drop case; "Retry failed in
  // selection" is a conditional tail item (no equivalent on
  // workspace -- no failure state to retry there).
  //
  // In-flight delete protection: `slices.deletingIds` is the
  // source of truth for "row is mid-`delete()`".  Set on entry,
  // cleared in `try/finally`; the store's `delete()` early-returns
  // when the id is already present so a keyboard-Enter or stale
  // queue can't double-fire.  This pane gates on `deletingIds`
  // in every interactive surface:
  //   - SliceCard `deleting` prop (gray + `pointer-events-none` +
  //     `aria-busy` wrapper, every descendant `disabled`);
  //   - toolbar "Delete N" label-swaps to "Deleting N…" with one
  //     centralised spinner while `deletingIds.size > 0`
  //     (vs per-card spinners that ran 30 CSS animations for a
  //     30-slice batch);
  //   - `allSelected` excludes deleting rows so the
  //     select-all/deselect-all label flips correctly;
  //   - selection mutators (`selectAll`, `toggleSelection`,
  //     `selectRange`) skip deleting rows;
  //   - `play()` / `retryUpload()` bail (defence vs keyboard
  //     activation on a focused button);
  //   - `bulkDelete` and `onGridContextMenu` bail entirely
  //     while a batch is draining.
  //
  // Page-close mid-batch is self-healing: `deletingIds` is
  // in-memory only, the daemon's delete jobs continue past tab
  // death, and the next mount's `refresh()` GCs orphan IDB rows
  // (committed-state rows whose filename is absent from the
  // daemon listing).  See the comment on `slices.refresh` for
  // the full reconciliation rules.
  //
  // Slice cap (`MAX_SLICES_PER_CATEGORY` = 200) is enforced
  // preventively at InputPane's Slice button -- nothing to do
  // here.  Pre-existing over-cap categories (e.g. dataset
  // imported via the daemon CLI) render normally; operator
  // deletes back down to the cap to resume slicing.
  interface Props {
    workspaceId: Uuid;
    categoryName: string;
  }
  let { workspaceId, categoryName }: Props = $props();

  // Per-category refresh on mount.  Wrapped in `untrack` for the
  // same reactive-loop reason documented in NOTES.md §"$effect +
  // refresh() reactive-loop trap" -- the store's refresh reads
  // and writes the slice the effect would otherwise track.
  //
  // Note: CategoryList also fires `refreshForWorkspace` for the
  // bulk-load path that powers the quantity badges on collapsed
  // rows.  Once that resolves, this per-category `refresh()`
  // short-circuits on `loaded: true`.  The dual call is
  // intentional -- the per-category refresh covers the case
  // where a category is added after the workspace bulk-load
  // (e.g. operator adds "cat" mid-session), or when the bulk
  // load failed.
  $effect(() => {
    const id = workspaceId;
    const name = categoryName;
    // Track the per-category stale flag.  The poller flips it
    // on a detected workspace-revision advance; the effect re-
    // fires, the untracked `refresh` runs, and refresh's own
    // success branch clears stale -- one settle pass, both
    // refresh entries short-circuit on the second tick.  The
    // bulk `refreshForWorkspace` (CategoryList) populates the
    // count badge; this `refresh` is the per-row reconcile that
    // covers the expanded slice grid.
    void slices.isStale(id, name);
    untrack(() => {
      void slices.refresh(id, name);
    });
  });

  const list = $derived(slices.for(workspaceId, categoryName));
  const threshold = $derived(thresholdFor(categoryName));
  const count = $derived(list.entries.length);
  const satisfiesQuota = $derived(count >= threshold);

  // ── Playback (B.5) ───────────────────────────────────────────
  //
  // One shared AudioContext.  Created lazily on first play (the
  // pane probably mounts collapsed, and we don't want to hold an
  // audio device for every expanded category).  `playingId`
  // drives the active card's visual ring; transitions on play
  // start, on play end (`onended`), and on explicit stop.

  let audioCtx: AudioContext | null = null;
  let activeSource: AudioBufferSourceNode | null = null;
  let playingId = $state<string | null>(null);

  async function play(slice: SliceRecord): Promise<void> {
    // Refuse to play a row that's mid-`delete()`.  The card's
    // wrapper has `pointer-events-none` so a mouse click can't
    // reach the button, but a keyboard Enter on a focused button
    // would still fire `onclick` (pointer-events doesn't block
    // keyboard activation) -- and an in-flight delete that's
    // past its daemon SSE-terminal but before `idbDeleteSlice`
    // would race against a fresh `getSliceBlob` -> AudioBuffer
    // pipeline that's about to read from a row that's about to
    // be gone.  Bailing here is the defence-in-depth gate; the
    // visual + store-level gates handle the rest.
    if (slices.deletingIds.has(slice.id)) return;
    audioCtx ??= new AudioContext();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    // Stop any prior playback first.  Clicking a different card
    // (or the same card twice) restarts cleanly.
    stopPlayback();
    let buffer: AudioBuffer;
    try {
      // `getSliceBlob` resolves to the local blob when it exists
      // (freshly produced / mid-upload / failed slices keep the
      // blob in IDB), or lazy-fetches from the daemon's `GET
      // /assets/datasets/<class>/<filename>` for committed slices
      // whose IDB row dropped the blob to free quota.  The fetch
      // result is cached per-id so a second play of the same
      // slice doesn't re-fetch.  The decode is cheap (~5 ms) at
      // our 1 s / 88 KB clip size; we don't cache the
      // AudioBuffer (memory cost adds up at 100s of slices).
      const blob = await getSliceBlob(slice);
      const arrayBuffer = await blob.arrayBuffer();
      buffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
      console.warn(`[slice ${slice.id}] play decode failed`, e);
      return;
    }
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start(0);
    activeSource = source;
    playingId = slice.id;
    source.onended = (): void => {
      if (activeSource === source) {
        activeSource = null;
        playingId = null;
      }
    };
  }

  function stopPlayback(): void {
    if (activeSource) {
      activeSource.onended = null;
      try {
        activeSource.stop();
      } catch {
        /* deliberate: source may already be stopped */
      }
      activeSource = null;
      playingId = null;
    }
  }

  onDestroy(() => {
    stopPlayback();
    if (audioCtx) {
      audioCtx.close().catch(() => undefined);
      audioCtx = null;
    }
  });

  // ── Delete + retry + right-click context menu ───────────────

  async function deleteSlice(record: SliceRecord): Promise<void> {
    // If the slice being deleted is currently playing, stop
    // playback first so the visual state stays consistent.
    if (playingId === record.id) stopPlayback();
    try {
      await slices.delete(record);
    } catch (e) {
      console.error('[slices] delete failed', e);
    }
  }

  // Retry a failed upload.  The slice's `state` flips
  // `failed → uploading` inside the store's pipeline; the card
  // re-renders against the new state automatically.
  function retryUpload(record: SliceRecord): void {
    // Don't queue an upload against a row that's about to vanish.
    // The store's `delete()` already aborts in-flight uploads up
    // front, but a *fresh* enqueueUpload that lands between the
    // abort and `idbDeleteSlice` would slip past that abort and
    // PUT to a row IDB is about to drop.  `runUpload`'s
    // `findSliceById` re-check is the last line of defence; this
    // gate stops the race from happening in the first place.
    if (slices.deletingIds.has(record.id)) return;
    void slices.enqueueUpload(record.id);
  }

  // ── Multi-selection ──────────────────────────────────────────
  //
  // Selection state lives at the pane scope so a freshly-rendered
  // SliceCard (e.g. an in-flight upload that just promoted from
  // `local` → `uploading`) reads its `selected` prop from the
  // single source of truth.  The set holds slice ids, not records,
  // so a slice swap inside the store doesn't invalidate the
  // selection.
  //
  // A SvelteSet is the right primitive here: `add` / `delete` /
  // `clear` are tracked as reactive mutations, so `selectedIds`
  // reads in `$derived` recompute without ceremony.  An anchor id
  // backs shift-range extension; we drop it as soon as the
  // selection is cleared so a subsequent shift-click doesn't
  // resurrect a stale range across deletes.
  const selectedIds = new SvelteSet<string>();
  let selectionAnchor = $state<string | null>(null);
  const selectionCount = $derived(selectedIds.size);
  const hasSelection = $derived(selectionCount > 0);
  // True when every *selectable* entry currently in the grid is in
  // the selection set.  "Selectable" excludes mid-delete rows --
  // the slices store exposes `deletingIds` while a `delete()` is in
  // flight (set at delete entry, cleared in `try/finally`), and the
  // selection mutators below filter against the same set, so an
  // operator who has clicked "Select all" with one slice mid-delete
  // ends up with everything-except-that-row in the selection.
  // Comparing `allSelected` against the eligible subset rather than
  // raw `entries` makes the toolbar's `select all` / `deselect all`
  // label flip correctly in that state -- without the filter, the
  // label would stay stuck on "Select all" because the deleting
  // row is necessarily absent from the selection.
  const allSelected = $derived.by(() => {
    const eligible = list.entries.filter((s) => !slices.deletingIds.has(s.id));
    return eligible.length > 0 && eligible.every((s) => selectedIds.has(s.id));
  });

  // Centralised "any delete in flight" signal for the toolbar's
  // Delete button.  Reads from the slices store's `deletingIds`
  // set so the count covers BOTH the batch path (operator clicked
  // the toolbar `Delete N` / hit Del-Bksp / picked the "Delete N
  // slices" right-click entry) AND any concurrent single-card
  // delete (right-click "Delete" inside selecting mode lands here
  // too).  That's deliberate: from the operator's perspective,
  // "Deleting N…" semantically means "N rows are disappearing
  // right now"; the path that triggered each one is a detail.
  //
  // Driving the toolbar spinner from this one set -- instead of
  // per-card animations -- is the performance call.  A 30-slice
  // batch previously rendered 30 simultaneous `animate-spin`
  // overlays (one per grayed card); centralising to a single
  // toolbar spinner cuts the running-animation count to one
  // regardless of batch size, and the cards still telegraph
  // "I'm going away" via the wrapper's static `opacity-50`.
  // See `SliceCard`'s deleting block for the matching rationale.
  const isAnyDeleting = $derived(slices.deletingIds.size > 0);
  const inflightDeleteCount = $derived(slices.deletingIds.size);

  // Explicit pane-mode FSM.  Mirrors the workspaces list's
  // `mode: 'normal' | 'selecting'` so the selection chrome reads
  // as the same primitive across the app -- the header swaps to a
  // three-button toolbar (`Select all / Deselect all`, `Done`,
  // `Delete N`), card surfaces switch their bare-click behaviour
  // from "play" to "toggle in/out of selection", and the
  // always-visible top-right checkbox replaces the hover trash.
  //
  // The mode is pane-local (not store-level like workspaces') for
  // the same reason `selectedIds` is pane-local: a SlicePane is
  // already scoped to one (workspace, category) and there's no
  // cross-pane coordination to do.  Promoting the FSM to the
  // slices store would add a per-key map without buying any
  // reactivity we don't already get from local `$state`.
  //
  // `enterSelecting` is idempotent so selection mutators
  // (toggleSelection, selectRange, selectAll) can call it
  // unconditionally and bare-click handlers don't need to branch
  // on whether the operator already flipped into mode.
  // `exitSelecting` is what `Done` and `Esc` route through; it
  // clears the selection because a stale set carried across a
  // mode boundary would surprise the operator on re-entry.
  let mode = $state<'normal' | 'selecting'>('normal');

  function enterSelecting(): void {
    if (mode !== 'selecting') mode = 'selecting';
  }

  function exitSelecting(): void {
    if (mode === 'selecting') {
      mode = 'normal';
      // Selection is meaningless once the operator leaves selecting
      // mode -- a fresh entry should start from empty rather than
      // inheriting whatever was checked last time.  Mirrors the
      // workspaces store's `exitSelecting` for the same reason.
      selectedIds.clear();
      selectionAnchor = null;
    }
  }

  // Auto-exit when the grid empties (e.g. operator just deleted
  // every row).  Without this, the header would keep rendering the
  // selecting toolbar over an empty-state body, which reads as
  // dead chrome.  Co-located with the prune effect below because
  // they share their dependency on `list.entries`.
  $effect(() => {
    if (list.entries.length === 0 && mode === 'selecting') {
      exitSelecting();
    }
  });

  // Prune ids whose underlying slice has been removed (deleted by
  // anyone -- including a batch we just kicked off).  Reading
  // `list.entries` makes this effect depend on the slice list,
  // so a record disappearing from the store automatically prunes
  // its id from the selection.  The check is a fast pass over the
  // entries array; selection sets are bounded by the on-screen
  // grid so size is small in practice.
  $effect(() => {
    const entries = list.entries;
    if (selectedIds.size === 0) return;
    const live = new Set(entries.map((s) => s.id));
    let mutated = false;
    for (const id of selectedIds) {
      if (!live.has(id)) {
        selectedIds.delete(id);
        mutated = true;
      }
    }
    if (mutated && selectionAnchor !== null && !live.has(selectionAnchor)) {
      selectionAnchor = null;
    }
  });

  // Empty the selection set in place WITHOUT leaving selecting
  // mode.  This is what the toolbar's "Deselect all" routes through;
  // the mode stays active so the operator can immediately re-pick
  // a different subset without a normal-mode round-trip.  `Done`
  // (which DOES leave the mode) calls `exitSelecting` instead --
  // see above.
  function clearSelection(): void {
    selectedIds.clear();
    selectionAnchor = null;
  }

  // Add every visible entry to the selection set.  Auto-enters
  // selecting mode so a "Select all" entry in the normal-mode
  // right-click menu flips the pane into the toolbar shape
  // without the caller having to plumb the mode transition.
  // Anchored at the first entry so a subsequent shift-click range
  // extends from the top of the grid (matches the platform-
  // standard "Select all, then shift-click somewhere lower to
  // whittle the range" pattern operators reach for after a bulk
  // select).
  function selectAll(): void {
    if (list.entries.length === 0) return;
    enterSelecting();
    // Skip mid-delete rows.  An in-flight delete will drop the row
    // from `entries` once its `delete()` lifecycle completes, so
    // adding it to the selection now would just leave the operator
    // with a "selected" ghost that they can't actually act on.
    // The first non-deleting row anchors the range so a follow-up
    // shift-click extends from a real, interactable card.
    let anchor: string | null = null;
    for (const s of list.entries) {
      if (slices.deletingIds.has(s.id)) continue;
      selectedIds.add(s.id);
      anchor ??= s.id;
    }
    selectionAnchor = anchor;
  }

  // Toggle: full selection ⇄ empty selection.  When the toggle
  // fires from a partial-selection state ("3 of 12 selected"), the
  // first click promotes to "all selected"; a second clears.  This
  // is the same two-state pattern as the workspaces toolbar's
  // "Select all / Deselect all" label-swap, so an operator who's
  // learned that flow doesn't have to re-learn a tri-state here.
  // Neither branch leaves selecting mode -- this is a same-mode
  // toggle, not a mode-exit.
  function toggleSelectAll(): void {
    if (allSelected) clearSelection();
    else selectAll();
  }

  function toggleSelection(id: string): void {
    // Belt-and-braces: SliceCard's `pointer-events-none` blocks the
    // click that would normally reach `onCardClick` -> `onPick` ->
    // `toggleSelection`, so a deleting row's id never gets here in
    // the happy path.  The guard covers the right-click-menu path
    // (the menu's "Select" item bypasses the card's pointer block)
    // and any keyboard / shortcut path that might reach this fn
    // with a stale id.
    if (slices.deletingIds.has(id)) return;
    // Auto-enter mode on the *add* branch so a Ctrl/Cmd-click on a
    // card in normal mode flips the pane into selecting (mirrors
    // workspaces' "Select workspaces…" right-click entry).  The
    // *delete* branch only fires from in-mode actions (the card
    // already shows a checkbox) so it doesn't need to enter.
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      if (selectionAnchor === id) selectionAnchor = null;
    } else {
      enterSelecting();
      selectedIds.add(id);
      selectionAnchor = id;
    }
  }

  // Range-select from `selectionAnchor` (or, if no anchor, the
  // first currently-selected id; or, failing that, the just-
  // clicked id).  Operates on the visible order of `list.entries`
  // so the operator's intuition about "everything between these
  // two" lines up with what they see in the grid.
  function selectRange(toId: string): void {
    const entries = list.entries;
    const toIdx = entries.findIndex((s) => s.id === toId);
    if (toIdx < 0) return;
    let fromId = selectionAnchor;
    if (fromId === null) {
      const firstSelected = entries.find((s) => selectedIds.has(s.id));
      fromId = firstSelected?.id ?? toId;
    }
    const fromIdx = entries.findIndex((s) => s.id === fromId);
    if (fromIdx < 0) {
      // Anchor went stale before the prune effect ran; fall back
      // to a single toggle.
      toggleSelection(toId);
      return;
    }
    // Range select is a selection mutator -- enter selecting mode
    // so a Shift-click in normal mode promotes the pane the same
    // way Ctrl/Cmd-click does, instead of needing a prior selection.
    enterSelecting();
    const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    for (let i = lo; i <= hi; i++) {
      // Skip mid-delete rows in the range, same as `selectAll`.
      if (slices.deletingIds.has(entries[i].id)) continue;
      selectedIds.add(entries[i].id);
    }
    selectionAnchor = toId;
  }

  function onPick(slice: SliceRecord, mods: { toggle: boolean; range: boolean }): void {
    if (mods.range) {
      selectRange(slice.id);
    } else if (mods.toggle) {
      toggleSelection(slice.id);
    }
  }

  // Batch delete -- single click fires `slices.deleteMany` against
  // a snapshot of the current selection.  Handles every entry point
  // for the multi-target path (header Delete button, Del / Backspace
  // on the focused grid, right-click "Delete N slices"); single-card
  // deletes (hover trash, single-slice context-menu Delete) keep
  // their own immediate path.  No confirmation modal -- see the
  // pane-level "Delete paths" comment for the rationale.
  //
  // Snapshot semantics: targets are captured synchronously at click
  // time (the `.filter` runs before any `await`), so a background
  // upload appending mid-`deleteMany` or a concurrent single-card
  // delete dropping a row out of `list.entries` doesn't shift the
  // batch.  Selection clears immediately so a second toolbar click
  // (or held Backspace) lands on an empty selection and no-ops.
  function bulkDelete(): void {
    if (selectedIds.size === 0) return;
    // Refuse while *any* delete is in flight -- the operator gets a
    // disabled-styled Delete button + a no-op Del / Backspace until
    // the batch drains.  `slices.delete()` populates `deletingIds`
    // synchronously at entry (before the first await) and
    // `clearSelection()` below empties `selectedIds` before the
    // pipeline starts; either gate alone would close the rapid-replay
    // race, both together cover the corner case where another
    // single-card delete is the in-flight party.
    if (slices.deletingIds.size > 0) return;
    // Filter out any rows that just landed in `deletingIds` between
    // the gate above and this read (window measured in microseconds,
    // but the filter is a no-cost SvelteSet lookup).
    const targets = list.entries.filter(
      (s) => selectedIds.has(s.id) && !slices.deletingIds.has(s.id)
    );
    if (targets.length === 0) return;
    // Stop playback only if the currently-playing slice is targeted.
    // `slices.delete()` doesn't cut audio itself (the AudioBuffer is
    // detached from the IDB row by the time playback starts), so the
    // pane is the right layer.  Leaving non-targeted playback alone
    // is the courtesy: an operator who's auditioning one clip and
    // batch-deleting others doesn't lose their listening context.
    if (playingId !== null && targets.some((s) => s.id === playingId)) {
      stopPlayback();
    }
    // Clear selection before kicking the pipeline so a follow-up
    // click on the toolbar (or a held-down Backspace) sees an empty
    // selection and bails at the early-return above.  The captured
    // `targets` array is the source of truth for the actual delete.
    clearSelection();
    void runBulkDelete(targets);
  }

  // Drains the captured target list through `slices.deleteMany` and
  // surfaces failures back into the selection so the operator can
  // retry without rebuilding the batch.  No global toast surface
  // exists yet; re-selection (+ keeping the pane in selecting mode)
  // is the visible feedback.  Failure-path mirrors the workspaces
  // store's `deleteSelected` outcome handling for cross-module
  // consistency.
  async function runBulkDelete(targets: SliceRecord[]): Promise<void> {
    const outcome = await slices.deleteMany(targets);
    for (const f of outcome.failed) selectedIds.add(f.id);
    if (outcome.failed.length > 0) enterSelecting();
  }

  // Retry every failed slice in the selection.  Non-failed
  // entries are ignored so a mixed selection retries only the
  // members that actually need it.
  function retrySelected(): void {
    const targets = list.entries.filter((s) => selectedIds.has(s.id) && s.state === 'failed');
    for (const record of targets) {
      retryUpload(record);
    }
  }

  // Grid-scoped keyboard shortcuts.  Listener is bound to the grid
  // element (not the window) so a Backspace inside a form input in
  // another pane never fires a destructive slice action.  All three
  // shortcuts gate on the actual `<input>` / `<textarea>` /
  // `contenteditable` target check below too, as belt-and-braces
  // against a future grid-internal text editor.
  //
  // Shortcut table:
  //   - Cmd/Ctrl + A  -> toggle select-all on the visible grid.
  //                      Mirrors the platform-standard "select
  //                      everything" accelerator.  Preventing the
  //                      default also suppresses the browser's
  //                      "select all text" behaviour inside the
  //                      grid focus, which would otherwise highlight
  //                      the card chrome (a visually noisy no-op).
  //   - Esc           -> clear selection (only when one exists; we
  //                      let Esc pass through to the closest open
  //                      menu / dialog otherwise so a stacked Esc
  //                      sequence still dismisses correctly).
  //   - Del / Bksp    -> fire `bulkDelete()` against the current
  //                      selection.  Single-card deletes (hover
  //                      trash, single-slice menu) have their own
  //                      immediate path -- this shortcut is the
  //                      multi-select trigger.
  let gridEl = $state<HTMLDivElement | undefined>();
  function onGridKey(e: KeyboardEvent): void {
    // Don't fire if the operator is mid-edit in a text field.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
      if (list.entries.length === 0) return;
      e.preventDefault();
      toggleSelectAll();
      return;
    }
    if (e.key === 'Escape' && mode === 'selecting') {
      e.preventDefault();
      exitSelecting();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection && !isAnyDeleting) {
      // `isAnyDeleting` mirrors the toolbar Delete button's gate:
      // refuse the keystroke while a batch is draining so a held-
      // down Backspace can't re-fire `bulkDelete` over its own
      // in-flight drain.  The visible button is disabled + spinner-
      // loaded in that state; the silent no-op here matches that
      // affordance.  `bulkDelete` repeats the same guard internally
      // as defence in depth.
      e.preventDefault();
      bulkDelete();
    }
  }

  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuSections = $state<MenuSection[]>([]);

  function onGridContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const cardEl = target.closest<HTMLElement>('[data-slice-id]');
    const id = cardEl?.dataset.sliceId ?? null;
    const slice = id ? (list.entries.find((s) => s.id === id) ?? null) : null;
    if (!slice) return;
    // Cards in mid-delete are non-interactive: their wrapper has
    // `pointer-events-none`, which routes contextmenu away from
    // the card and onto the grid div below.  The walk above can
    // still resolve `data-slice-id` if the event was triggered on
    // a different element (e.g. via keyboard chord), so a literal
    // gate sits here too -- we never want to open a per-card
    // menu over a row the operator can't act on anyway.
    if (slices.deletingIds.has(slice.id)) return;
    e.preventDefault();
    // Stop here so the event doesn't bubble to the enclosing
    // CategoryList wrapper (which would otherwise open the
    // category-row context menu) or the workspace detail page's
    // root wrapper (which would otherwise open the page-level
    // Rename/Delete menu).  Without this, a right-click on a
    // slice card would stack three context menus at the cursor;
    // closing any one of them would leave the other two orphaned
    // until an outside click fired their dismissal listeners.
    e.stopPropagation();
    menuX = e.clientX;
    menuY = e.clientY;
    menuSections = buildSliceMenu(slice);
    menuOpen = true;
  }

  // Unified per-card right-click menu.  Mirrors the workspaces
  // `buildMenu(ws)` shape: a fixed section of per-card actions
  // (Play, Retry, Delete) anchors the menu, then a mode-aware
  // section of selection-shape controls trails it.
  //
  // Normal mode tail -- entry into selecting:
  //   - Select          (Ctrl/Cmd-click)   ⇒ adds this card, flips
  //                                          the pane into the
  //                                          three-button toolbar.
  //   - Select all      (Cmd/Ctrl+A)       ⇒ same flip, scope all.
  //                                          Omitted on a single-row
  //                                          grid (the "Select" item
  //                                          above already covers it).
  //
  // Selecting mode tail -- in-mode toggles + exit:
  //   - Select / Deselect (this card)       ⇒ flips its checkbox.
  //   - Select all / Deselect all toggle    ⇒ same as toolbar's left
  //                                          button.
  //   - Done (exit selection)               ⇒ same as toolbar's
  //                                          middle button + Esc.
  //
  // The destructive section at the foot of the menu branches by
  // context: in-selection + selecting mode shows the batch
  // "Delete N slices" (fires `bulkDelete` immediately).  Every
  // other case shows a single-card "Delete" that fires immediately
  // -- including selecting mode + a click on an unselected card,
  // where the operator clearly meant "this specific card" and
  // forcing them through select-then-toolbar would be busywork.
  function buildSliceMenu(slice: SliceRecord): MenuSection[] {
    const isInSelection = selectedIds.has(slice.id);
    const isPlaying = playingId === slice.id;

    const cardItems: MenuItem[] = [
      {
        label: isPlaying ? 'Stop' : 'Play',
        onclick: (): void => {
          if (isPlaying) stopPlayback();
          else void play(slice);
        }
      }
    ];
    if (slice.state === 'failed') {
      cardItems.push({ label: 'Retry upload', onclick: () => retryUpload(slice) });
    }

    const selItems: MenuItem[] = [];
    if (mode === 'selecting') {
      selItems.push({
        label: isInSelection ? 'Deselect' : 'Select',
        onclick: () => toggleSelection(slice.id)
      });
      selItems.push({
        label: allSelected ? 'Deselect all' : 'Select all',
        hint: 'Cmd/Ctrl+A',
        onclick: toggleSelectAll
      });
      selItems.push({
        label: 'Done (exit selection)',
        hint: 'Esc',
        onclick: exitSelecting
      });
      // "Retry failed in selection" piggybacks on the selecting-
      // mode tail so an operator who's already curated a batch
      // (e.g. selected every red-ringed card after a network blip)
      // can fire the recoveries together.  Conditional on at least
      // one failed entry in the current selection -- otherwise the
      // item would be a no-op clutter.
      const anyFailedInSelection = list.entries.some(
        (s) => selectedIds.has(s.id) && s.state === 'failed'
      );
      if (anyFailedInSelection) {
        selItems.push({
          label: 'Retry failed in selection',
          onclick: retrySelected
        });
      }
    } else {
      selItems.push({
        label: 'Select',
        hint: 'Ctrl/Cmd-click',
        onclick: () => toggleSelection(slice.id)
      });
      if (list.entries.length > 1) {
        selItems.push({
          label: 'Select all',
          hint: 'Cmd/Ctrl+A',
          onclick: selectAll
        });
      }
    }

    const isBatchDelete = mode === 'selecting' && isInSelection && hasSelection;
    const destItem: MenuItem = isBatchDelete
      ? {
          label: `Delete ${selectionCount} ${selectionCount === 1 ? 'slice' : 'slices'}`,
          hint: 'Del / Backspace',
          variant: 'destructive',
          onclick: bulkDelete
        }
      : {
          label: 'Delete',
          variant: 'destructive',
          onclick: () => void deleteSlice(slice)
        };

    return [{ items: cardItems }, { items: selItems }, { items: [destItem] }];
  }
</script>

<!-- `contain: size` keeps the parent CategoryRow grid row welded
     to its `min-h-80` floor — without it, the inner slice grid's
     max-content height (walked past `overflow-y-auto`) would lift
     the row above the InputPane's natural height and leave an
     empty band on the Input side.  Outer padding `px-3 pt-1.5
     pb-3` + header `mb-1.5` mirrors InputPane so the two heading
     bottoms line up at the same y. -->
<section
  class="flex h-full min-h-0 flex-col rounded-md border border-zinc-200 bg-white px-3 pt-1.5 pb-3 contain-size"
>
  <header class="mb-1.5 flex min-h-4.75 items-center justify-between gap-1.5">
    <!-- `min-h-4.75` (19 px) matches InputPane's header so both
         headings sit in identical-height boxes — load-bearing in
         selecting mode where the toolbar pills are ~1 px shorter
         than the quota pill and the header would otherwise jiggle
         on mode switch.
         Header swaps on the pane's mode FSM:
           Normal: "Slices" + Tips.  Selection entry is via
           Ctrl/Cmd-click or the right-click ContextMenu.
           Selecting: Select all / Done / Delete N, all sharing
           one pill shape (`px-1.5 py-0.5 text-[10px] font-medium`)
           — destructive accent comes from rose colour, not from
           a different container.  No "N selected" counter on the
           left: count is baked into the Delete N label and the
           toolbar flush-left anchors the mode.
         The quota chip stays right-aligned across both modes. -->
    {#if mode === 'selecting'}
      <div class="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onclick={toggleSelectAll}
          class="inline-flex items-center rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 transition duration-200 ease-out hover:border-zinc-300 hover:bg-zinc-50"
          title={allSelected
            ? 'Deselect all slices (Cmd/Ctrl+A)'
            : 'Select all slices (Cmd/Ctrl+A)'}
        >
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
        <button
          type="button"
          onclick={exitSelecting}
          class="inline-flex items-center rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 transition duration-200 ease-out hover:border-zinc-300 hover:bg-zinc-50"
          title="Exit selection (Esc)"
        >
          Done
        </button>
        <button
          type="button"
          onclick={bulkDelete}
          disabled={!hasSelection || isAnyDeleting}
          class="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 transition duration-200 ease-out hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-50 disabled:text-zinc-400"
          title={isAnyDeleting
            ? `Deleting ${inflightDeleteCount} ${inflightDeleteCount === 1 ? 'slice' : 'slices'}…`
            : hasSelection
              ? 'Delete the selected slices (Del / Backspace)'
              : 'Select at least one slice to delete'}
          aria-label={isAnyDeleting
            ? `Deleting ${inflightDeleteCount} ${inflightDeleteCount === 1 ? 'slice' : 'slices'}`
            : hasSelection
              ? `Delete ${selectionCount} selected ${selectionCount === 1 ? 'slice' : 'slices'}`
              : 'Delete selected slices'}
          aria-live="polite"
        >
          <!-- Spinner while any delete is in flight; trash glyph
               otherwise.  One animation per batch instead of N
               per-card spinners (see SliceCard for the paint-cost
               rationale). -->
          {#if isAnyDeleting}
            <Spinner class="h-2.5 w-2.5" />
          {:else}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="h-2.5 w-2.5"
              aria-hidden="true"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M19 6l-1 14H6L5 6" />
            </svg>
          {/if}
          {#if isAnyDeleting}
            Deleting {inflightDeleteCount}…
          {:else}
            Delete{hasSelection ? ` ${selectionCount}` : ''}
          {/if}
        </button>
      </div>
    {:else}
      <!-- Heading + Tips clustered so the popover trigger reads
           as part of the title.  Tips is hidden in selecting mode
           (where the toolbar replaces the heading) to avoid
           competing with the Delete / Select buttons. -->
      <div class="flex items-center gap-1.5">
        <h4 class="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Slices</h4>
        <Tips label="Slice module tips">
          <ul class="space-y-1.5">
            <li>
              <strong class="font-medium text-zinc-900"
                >Audition every slice before training.</strong
              >
              A mislabeled row biases the whole class -- click cards to play, discard liberally.
            </li>
            <li>
              <strong class="font-medium text-zinc-900">Diversity beats quantity.</strong>
              Ten varied takes (distance, angle, background) train better than thirty near-identical copies.
            </li>
          </ul>
        </Tips>
      </div>
    {/if}
    <!-- Quota chip: emerald at/above threshold, amber below.
         Tally `count/threshold` carried in `font-mono tabular-nums`
         so the width is stable while count animates.  No leading
         icon — colour tone alone signals the state, and a check
         here would compete with the CategoryRow's "Synced" badge.
         Chip footprint matches the CategoryRow badge + TrainPane
         summary chips — one padding rhythm across the app. -->
    <span
      class="inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums transition-colors"
      class:bg-emerald-100={satisfiesQuota}
      class:text-emerald-800={satisfiesQuota}
      class:bg-amber-100={!satisfiesQuota}
      class:text-amber-800={!satisfiesQuota}
      title={satisfiesQuota
        ? `Above the ${threshold}-slice minimum for training.`
        : `Below the ${threshold}-slice minimum for training.  Slice more to satisfy the quota.`}
    >
      {count}/{threshold}
    </span>
  </header>

  {#if !list.loaded}
    <div class="flex flex-1 items-center gap-2 text-xs text-zinc-500">
      <Spinner />
      <span>loading slices…</span>
    </div>
  {:else if list.error && list.entries.length === 0}
    <div
      class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
      role="alert"
    >
      Couldn't load slices. {list.error}
    </div>
  {:else if list.entries.length === 0}
    <div
      class="flex flex-1 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-zinc-200 bg-zinc-50 p-3 text-center"
    >
      <p class="text-[11px] text-zinc-500">
        No slices yet. Trim the clip in the Input pane and click
        <span class="font-medium">Slice</span> to fill this grid.
      </p>
    </div>
  {:else}
    <!-- Grid contract: `auto-fill` columns at `minmax(96px, 1fr)`,
         `gap-3`.  Cells are ≥ 96 px and stretch via 1fr so a full
         row's widths sum exactly to the pane width — no right-edge
         dead band.  The SliceCard inside is `w-full aspect-3/2`
         so its height tracks cell width on the canonical 3:2
         spectrogram ratio.
         Column-count math: with gap G = 12, N = floor((W+G)/(96+G))
         columns of width w = (W − (N−1)·G) / N.  Realistic widths:
           W=330 → 3 × 102 px;  W=440 → 4 × 101 px;
           W=600 → 5 × 110 px;  W=800 → 7 × 104 px;
           W=1200 → 11 × 98 px.
         All upscales sit at 2-15 %, well inside the band where
         the browser's bilinear/bicubic path is perceptually clean
         on the 96 × 64 PNG.
         `auto-fill` (not `auto-fit`): empty tracks must reserve
         space instead of collapsing — otherwise `minmax(96px,
         1fr)` would balloon a lone slice to fill the pane.  Card
         width stays predictable whether there's 1 slice or 100.
         `minmax(96px, 1fr)` (not the prior fixed `96px`): absorbs
         the right-edge band that previously jittered on resize.
         The dead band now only appears on partial last rows.
         `aspect-3/2` (not `w-full h-16`): horizontal-only stretch
         would squash the spectrogram's time axis, so a "1 s clip"
         would read different durations at different pane widths.
         The aspect-locked card preserves the time-per-pixel scale
         across pane widths.
         `content-start` is load-bearing — implicit row tracks
         are `grid-auto-rows: auto` and the spec's `normal`
         align-content stretches them, which would balloon the
         vertical gap between rows from `gap-3` to whatever
         absorbs the leftover height (e.g. ~188 px for a 2-row
         layout in a 500 px container).  `align-content: start`
         pins tracks at the aspect-derived height and dumps the
         leftover below the last row, where `overflow-y-auto`
         absorbs it.
         `scrollbar-gutter: stable` reserves the scrollbar width
         up front; without it, a fresh batch pushing the grid into
         overflow would yank horizontal space from under the
         existing cards and reflow the column count.
         `tabindex=0` scopes the Del/Backspace bulk-delete shortcut
         to focus inside this grid. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      bind:this={gridEl}
      tabindex="0"
      class="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(96px,1fr))] content-start gap-3 overflow-y-auto rounded-sm scrollbar-gutter-stable focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
      oncontextmenu={onGridContextMenu}
      onkeydown={onGridKey}
    >
      {#each list.entries as slice (slice.id)}
        <SliceCard
          {slice}
          playing={playingId === slice.id}
          selected={selectedIds.has(slice.id)}
          multiSelectActive={mode === 'selecting'}
          deleting={slices.deletingIds.has(slice.id)}
          onPlay={() => void play(slice)}
          onPick={(mods: { toggle: boolean; range: boolean }) => onPick(slice, mods)}
          onDelete={() => void deleteSlice(slice)}
          onRetry={() => retryUpload(slice)}
        />
      {/each}
    </div>
  {/if}
</section>

<ContextMenu
  open={menuOpen}
  x={menuX}
  y={menuY}
  sections={menuSections}
  onclose={() => (menuOpen = false)}
/>
