<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import Modal from '$lib/components/ui/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import DownloadIcon from '$lib/components/ui/DownloadIcon.svelte';
  import { categories } from '$lib/stores/categories.svelte';
  import { slices } from '$lib/stores/slices.svelte';
  import { prettyCategoryName } from '$lib/components/category/labels';
  import {
    exportWorkspace,
    WorkspaceExportError,
    type WorkspaceExportProgress
  } from '$lib/api/workspace-export';
  import { errorCopy } from '$lib/utils/error-copy';
  import { formatBytes } from '$lib/utils/format';
  import type { HeadRecord, Uuid } from '$lib/api/types';

  // Unified workspace `.alpkg` export dialog.  Two-section
  // selector + one progress surface inside one modal:
  //
  //   selecting → operator picks categories AND heads in
  //                separate sections; Export kicks the unified
  //                pipeline.  All non-empty rows in both sections
  //                are selected by default.
  //   running   → progress copy + counts; Cancel aborts via
  //                signal.
  //
  // No `done` surface: a successful export triggers the browser's
  // SaveAs and we close the dialog the same task tick.  Failures
  // roll back to `selecting` with an inline banner above the
  // section list so the operator can adjust the selection and
  // retry.

  interface Props {
    open: boolean;
    workspaceId: Uuid;
    workspaceName: string;
    /// Heads list from the workspace detail.  Threaded as a prop
    /// (not read from a store) because the source of truth for
    /// the workspace's head set is `WorkspaceDetail.heads` on the
    /// /workspace/[id] page; introducing a heads store solely
    /// for this dialog would duplicate that single-consumer
    /// state.
    heads: readonly HeadRecord[];
    onclose: () => void;
  }
  let { open, workspaceId, workspaceName, heads, onclose }: Props = $props();

  // ── Store-derived state ────────────────────────────────────

  const allCategories = $derived(categories.for(workspaceId).entries);

  function sliceCountFor(name: string): number {
    return slices.countFor(workspaceId, name);
  }

  // ── Selection state ────────────────────────────────────────

  // Per-section selection sets.  SvelteSets (not bare Sets) for
  // the `.svelte` lint rule -- mutations stay reactive without
  // the clone-and-replace pattern.
  const selectedCategories = new SvelteSet<string>();
  const selectedHeadIds = new SvelteSet<Uuid>();

  // Dirty flag for the category selection.  Flips to `true` on
  // any manual operator toggle so the auto-top-up effect (below,
  // after `categoryRows` is defined) stops re-adding rows the
  // operator deliberately deselected.  Reset by the open-edge
  // effect on every fresh open.
  let selectionDirty = $state(false);

  // Reset on every open transition.  Without the guard the
  // effect would re-fire on every reactive read inside (e.g.
  // `heads`) and clobber operator selections.  Category seeding
  // is NOT done here -- it's owned by the auto-top-up effect
  // below, which keeps the selection in sync with the
  // (potentially still-hydrating) per-category slice counts.
  let lastOpenSeen = $state(false);
  $effect(() => {
    if (open && !lastOpenSeen) {
      lastOpenSeen = true;
      selectedCategories.clear();
      selectedHeadIds.clear();
      for (const head of heads) selectedHeadIds.add(head.head_id);
      selectionDirty = false;
      pipelineState = 'selecting';
      progress = null;
      errorMessage = null;
      errorCategory = null;
      errorHeadId = null;
      abortController = null;
    } else if (!open && lastOpenSeen) {
      lastOpenSeen = false;
      // Abort any in-flight export when the dialog dismisses
      // (Escape, backdrop, explicit close).  The branch only
      // runs on a transition open → !open so it never fires
      // gratuitously.
      if (abortController !== null) {
        abortController.abort();
        abortController = null;
      }
    }
  });

  type PipelineState = 'selecting' | 'running';
  let pipelineState = $state<PipelineState>('selecting');
  let progress = $state<WorkspaceExportProgress | null>(null);
  let errorMessage = $state<string | null>(null);
  let errorCategory = $state<string | null>(null);
  let errorHeadId = $state<Uuid | null>(null);
  let abortController = $state<AbortController | null>(null);

  // ── Section row derivations ────────────────────────────────

  interface CategoryRow {
    /// Wire-form name (the on-disk directory + selection key).
    /// Routed back into `selectedCategories` + the export pipeline
    /// verbatim so the archive's path layout matches what the
    /// daemon stores.
    name: string;
    /// Operator-facing display label.  For reserved synthetics
    /// (`_..._`) `prettyCategoryName` strips wrappers + title-
    /// cases (`_background_noise_` → "Background Noise"); for
    /// operator-typed names it's verbatim.  See
    /// [`../category/labels.ts`] for the full rule.
    display: string;
    count: number;
    disabled: boolean;
  }
  interface HeadRow {
    head_id: Uuid;
    short_id: string;
    n_classes: number;
    size_bytes: number;
    workspace_revision_id: number;
  }

  const categoryRows = $derived<CategoryRow[]>(
    allCategories.map((cat) => {
      const count = sliceCountFor(cat.name);
      return {
        name: cat.name,
        display: prettyCategoryName(cat.name),
        count,
        disabled: count === 0
      };
    })
  );

  const headRows = $derived<HeadRow[]>(
    heads.map((h) => ({
      head_id: h.head_id,
      // 8-hex-char chip -- same convention as the rest of the
      // app (head-row chip, training-history short id).  Enough
      // entropy for the operator to disambiguate adjacent rows.
      short_id: h.head_id.replace(/-/g, '').slice(0, 8),
      n_classes: h.n_classes,
      size_bytes: h.size_bytes,
      workspace_revision_id: h.workspace_revision.id
    }))
  );

  // Auto-top-up.  Categories' per-row slice counts hydrate
  // asynchronously: `slices.refreshForWorkspace` (kicked from
  // CategoryList on mount) walks IDB + the daemon per category,
  // so a dialog opened immediately after workspace navigation
  // can see every count as 0 (→ every row `disabled` → none
  // auto-selected) for the first tick.  This effect re-runs on
  // every `categoryRows` update and adds any non-disabled row
  // that isn't already in the selection.  It stops the moment
  // the operator manually touches the section (via either
  // `toggleCategory` or `toggleAllCategories`) so a deliberate
  // deselect isn't undone by a late-arriving count.
  //
  // `untrack` around the SvelteSet writes blocks the effect from
  // self-triggering on its own `.has` / `.add` reads; the outer
  // `categoryRows` read is the only intended trigger.
  $effect(() => {
    if (!open || selectionDirty) return;
    const rows = categoryRows;
    untrack(() => {
      for (const row of rows) {
        if (!row.disabled && !selectedCategories.has(row.name)) {
          selectedCategories.add(row.name);
        }
      }
    });
  });

  const selectableCategoryRows = $derived(categoryRows.filter((r) => !r.disabled));
  const selectedCategoryCount = $derived(
    selectableCategoryRows.filter((r) => selectedCategories.has(r.name)).length
  );
  const allCategoriesSelected = $derived(
    selectableCategoryRows.length > 0 && selectedCategoryCount === selectableCategoryRows.length
  );

  const selectedHeadCount = $derived(headRows.filter((r) => selectedHeadIds.has(r.head_id)).length);
  const allHeadsSelected = $derived(headRows.length > 0 && selectedHeadCount === headRows.length);

  // Combined "can export" gate.  At least one item across both
  // sections must be selected; both sections empty is the
  // workspace-mount edge case (no categories, no heads).
  const canExport = $derived(selectedCategoryCount > 0 || selectedHeadCount > 0);

  // Detect uncommitted slices in the selection so the operator
  // sees a quiet pre-flight hint -- the daemon-listed export
  // doesn't include pending/uploading/failed slices, so the
  // archive count may undercut the on-screen count.
  const hasPendingInSelection = $derived(
    categoryRows.some((r) => {
      if (!selectedCategories.has(r.name)) return false;
      const status = slices.syncStatusFor(workspaceId, r.name);
      return status === 'pending' || status === 'uploading' || status === 'failed';
    })
  );

  // ── Event handlers ────────────────────────────────────────

  function toggleAllCategories(): void {
    // Mark the section dirty so the auto-top-up effect leaves the
    // operator's choice intact when later slice counts arrive --
    // a deselect-all should stick even if a count hydrates after
    // the fact.
    selectionDirty = true;
    if (allCategoriesSelected) {
      selectedCategories.clear();
    } else {
      for (const r of selectableCategoryRows) selectedCategories.add(r.name);
    }
  }

  function toggleCategory(name: string): void {
    selectionDirty = true;
    if (selectedCategories.has(name)) selectedCategories.delete(name);
    else selectedCategories.add(name);
  }

  function toggleAllHeads(): void {
    if (allHeadsSelected) {
      selectedHeadIds.clear();
    } else {
      for (const r of headRows) selectedHeadIds.add(r.head_id);
    }
  }

  function toggleHead(id: Uuid): void {
    if (selectedHeadIds.has(id)) selectedHeadIds.delete(id);
    else selectedHeadIds.add(id);
  }

  async function startExport(): Promise<void> {
    if (pipelineState === 'running') return;
    if (!canExport) return;
    pipelineState = 'running';
    progress = { phase: 'preparing-datasets' };
    errorMessage = null;
    errorCategory = null;
    errorHeadId = null;
    const controller = new AbortController();
    abortController = controller;
    try {
      await exportWorkspace(
        {
          workspaceId,
          workspaceName,
          categories: Array.from(selectedCategories),
          heads: heads.filter((h) => selectedHeadIds.has(h.head_id))
        },
        {
          signal: controller.signal,
          onprogress: (p) => {
            progress = p;
          }
        }
      );
      onclose();
    } catch (e) {
      if (controller.signal.aborted) {
        // Operator-initiated abort: silent rollback to selecting.
        pipelineState = 'selecting';
        progress = null;
        return;
      }
      if (e instanceof WorkspaceExportError) {
        errorMessage = e.message;
        errorCategory = e.category;
        errorHeadId = e.headId;
      } else {
        errorMessage = errorCopy(e);
      }
      pipelineState = 'selecting';
      progress = null;
    } finally {
      if (abortController === controller) abortController = null;
    }
  }

  function cancelRunning(): void {
    if (pipelineState !== 'running') return;
    if (abortController !== null) abortController.abort();
  }

  // ── Progress copy + fill ──────────────────────────────────

  const progressCopy = $derived.by((): string => {
    if (progress === null) return '';
    switch (progress.phase) {
      case 'preparing-datasets':
        if (progress.subphase === 'fetching') {
          if (typeof progress.itemsTotal === 'number' && typeof progress.itemsDone === 'number') {
            return `Fetched ${progress.itemsDone} / ${progress.itemsTotal} slices…`;
          }
          return 'Fetching slices…';
        }
        return 'Listing slices…';
      case 'preparing-heads':
        if (typeof progress.itemsTotal === 'number' && typeof progress.itemsDone === 'number') {
          return `Validated ${progress.itemsDone} / ${progress.itemsTotal} heads…`;
        }
        return 'Validating heads…';
      case 'packing':
        return 'Packing archive…';
      case 'downloading':
        return 'Starting download…';
    }
  });

  const progressFraction = $derived.by((): number => {
    if (progress === null) return 0;
    const total = progress.itemsTotal ?? 0;
    const done = progress.itemsDone ?? 0;
    if (total <= 0) return 0;
    return Math.min(1, done / total);
  });

  // Headline used in the failure banner -- maps the offending
  // phase + optional context to a short copy.  Falls back to a
  // generic "Export failed" when nothing more specific applies.
  const errorHeadline = $derived.by((): string => {
    if (errorCategory !== null) {
      // Route through the same display formatter the category
      // rows use so the banner names the offender with the
      // label the operator just saw above, not the wire-form
      // (`_background_noise_` vs "Background Noise").
      return `Export failed in "${prettyCategoryName(errorCategory)}"`;
    }
    if (errorHeadId !== null) {
      const shortId = errorHeadId.replace(/-/g, '').slice(0, 8);
      return `Export failed for head ${shortId}`;
    }
    return 'Export failed';
  });
</script>

<Modal
  {open}
  title="Export workspace"
  onclose={() => {
    if (pipelineState === 'running') cancelRunning();
    onclose();
  }}
  closeOnBackdrop={pipelineState !== 'running'}
  class="max-w-lg"
>
  {#if errorMessage !== null}
    <div
      class="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
      role="alert"
    >
      <p class="font-medium">{errorHeadline}</p>
      <p class="mt-0.5">{errorMessage}</p>
    </div>
  {/if}

  {#if categoryRows.length === 0 && headRows.length === 0}
    <p class="text-xs text-zinc-500">
      This workspace has no categories and no heads yet — nothing to export.
    </p>
  {/if}

  <!-- ── Datasets section ───────────────────────────────────── -->
  {#if categoryRows.length > 0}
    <section class="flex flex-col gap-2">
      <!-- Section header.  Small-caps treatment mirrors the
           train/converter history "History" sub-section
           heading.  Right side: selection counter + clickable
           "Select all" toggle so the operator can flip the
           whole section in one click without scanning each
           row. -->
      <header class="flex items-center justify-between">
        <h3 class="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Datasets</h3>
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-zinc-500">
            {selectedCategoryCount} / {selectableCategoryRows.length}
          </span>
          {#if selectableCategoryRows.length > 1}
            <button
              type="button"
              onclick={toggleAllCategories}
              disabled={pipelineState === 'running'}
              class="text-[11px] font-medium text-zinc-600 transition hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {allCategoriesSelected ? 'Deselect all' : 'Select all'}
            </button>
          {/if}
        </div>
      </header>

      <ul class="flex flex-col gap-1.5">
        {#each categoryRows as row (row.name)}
          <li>
            <label
              class="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-50"
              class:opacity-60={row.disabled}
              class:cursor-not-allowed={row.disabled || pipelineState === 'running'}
            >
              <span class="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedCategories.has(row.name)}
                  disabled={row.disabled || pipelineState === 'running'}
                  onchange={() => toggleCategory(row.name)}
                  class="h-3.5 w-3.5 shrink-0 cursor-pointer accent-blue-500 disabled:cursor-not-allowed"
                />
                <!-- Visible label uses the operator-facing
                     display form; `title` keeps the wire-form
                     name on hover so the operator can reconcile
                     the row against the archive's on-disk path
                     (`datasets/<wire-name>/`) without leaving
                     the dialog. -->
                <span class="truncate text-zinc-800" title={row.name}>{row.display}</span>
              </span>
              <span class="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">
                {#if row.disabled}
                  empty
                {:else}
                  {row.count} {row.count === 1 ? 'slice' : 'slices'}
                {/if}
              </span>
            </label>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <!-- ── Heads section ──────────────────────────────────────── -->
  {#if headRows.length > 0}
    <section class="flex flex-col gap-2">
      <header class="flex items-center justify-between">
        <h3 class="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Heads</h3>
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-zinc-500">
            {selectedHeadCount} / {headRows.length}
          </span>
          {#if headRows.length > 1}
            <button
              type="button"
              onclick={toggleAllHeads}
              disabled={pipelineState === 'running'}
              class="text-[11px] font-medium text-zinc-600 transition hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {allHeadsSelected ? 'Deselect all' : 'Select all'}
            </button>
          {/if}
        </div>
      </header>

      <ul class="flex flex-col gap-1.5">
        {#each headRows as row (row.head_id)}
          <li>
            <label
              class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-50"
              class:cursor-not-allowed={pipelineState === 'running'}
            >
              <span class="flex shrink-0 items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedHeadIds.has(row.head_id)}
                  disabled={pipelineState === 'running'}
                  onchange={() => toggleHead(row.head_id)}
                  class="h-3.5 w-3.5 shrink-0 cursor-pointer accent-blue-500 disabled:cursor-not-allowed"
                />
                <!-- Head-id chip.  Lowercase hex (no `uppercase`
                     class) so the chip text matches the UUID's
                     wire-form casing -- copy-pasting from the
                     `title` tooltip then reads identically to
                     what the operator just clicked. -->
                <span
                  class="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-zinc-700"
                  title={row.head_id}
                >
                  {row.short_id}
                </span>
              </span>
              <!-- Right-side meta strip.  rev · classes · size in
                   one `text-[10px] font-mono tabular-nums` line
                   (matching the train-history / converter-history
                   meta-strip vocabulary).  Visual order rev →
                   classes → size: the operator's primary
                   disambiguator when picking from a same-
                   workspace head list is the rev (newest
                   training run vs older), then class makeup, then
                   artefact footprint.
                   ## Overflow discipline
                   `dir="rtl"` on the flex container packs items
                   right-to-left and routes overflow clipping to
                   the LEFT edge.  Markup order is REVERSED (size
                   first → rev last) so the visual order stays
                   rev → classes → size.  On a narrow viewport
                   the leftmost token (rev) clips off first, then
                   the dot, then classes, while size stays
                   visible at the right -- the operator's most
                   identifying physical fact survives the
                   squeeze.  Inner `dir="ltr"` on each text span
                   keeps the character order of "rev 4" / "3
                   classes" / "1.2 MiB" reading correctly inside
                   the RTL container.  Full string is on `title`
                   for hover lookup when truncated. -->
              <span
                class="ml-auto flex min-w-0 items-center gap-2 overflow-hidden font-mono text-[10px] tabular-nums text-zinc-500"
                dir="rtl"
                title={`rev ${row.workspace_revision_id} · ${row.n_classes} ${row.n_classes === 1 ? 'class' : 'classes'} · ${formatBytes(row.size_bytes)}`}
              >
                <span class="shrink-0" dir="ltr">{formatBytes(row.size_bytes)}</span>
                <span aria-hidden="true" class="shrink-0 text-zinc-300">·</span>
                <span class="shrink-0" dir="ltr">
                  {row.n_classes}
                  {row.n_classes === 1 ? 'class' : 'classes'}
                </span>
                <span aria-hidden="true" class="shrink-0 text-zinc-300">·</span>
                <span class="shrink-0" dir="ltr">rev {row.workspace_revision_id}</span>
              </span>
            </label>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if hasPendingInSelection && pipelineState === 'selecting'}
    <p class="text-[11px] text-zinc-500">
      Slices still uploading or pending in the selection will be excluded — only on-disk slices
      ship.
    </p>
  {/if}

  {#if pipelineState === 'running'}
    <div class="flex flex-col gap-1.5">
      <p class="text-xs text-zinc-700">{progressCopy}</p>
      <div class="h-1 overflow-hidden rounded-full bg-zinc-100">
        <div
          class="h-full bg-blue-500 transition-[width] duration-200"
          style="width: {Math.round(progressFraction * 100)}%"
          aria-hidden="true"
        ></div>
      </div>
    </div>
  {/if}

  {#snippet footer()}
    {#if pipelineState === 'running'}
      <Button variant="secondary" onclick={cancelRunning}>Cancel</Button>
      <Button disabled loading>Exporting…</Button>
    {:else}
      <Button variant="secondary" onclick={onclose}>Cancel</Button>
      <Button
        onclick={() => void startExport()}
        disabled={!canExport}
        ariaLabel="Export selected items"
      >
        <DownloadIcon />
        Export
      </Button>
    {/if}
  {/snippet}
</Modal>
