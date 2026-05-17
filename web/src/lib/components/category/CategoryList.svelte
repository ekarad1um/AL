<script lang="ts">
  import { untrack } from 'svelte';
  import CategoryRow from './CategoryRow.svelte';
  import AddCategoryDialog from './AddCategoryDialog.svelte';
  import DeleteCategoryDialog from './DeleteCategoryDialog.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import PlusIcon from '$lib/components/ui/PlusIcon.svelte';
  import LoadingRow from '$lib/components/LoadingRow.svelte';
  import ContextMenu, { type MenuSection } from '$lib/components/ui/ContextMenu.svelte';
  import { categories, type Category } from '$lib/stores/categories.svelte';
  import { slices } from '$lib/stores/slices.svelte';
  import { isMandatoryCategory } from './labels';
  import type { Uuid } from '$lib/api/types';

  // Workspace-scoped category accordion.  The detail page mounts
  // this; refresh is triggered here so the page doesn't have to
  // know about the categories store directly.
  //
  // Right-click context menu follows the B.1 convention:
  // - on a category row: Rename (deferred), Delete (unless mandatory).
  // - on empty list area: Add Category.
  // For B.2 we only expose Add / Delete; rename is deferred because
  // the daemon's mv-category isn't a one-call operation (it'd need
  // an end-to-end PUT-new + DELETE-old + revision-bump dance).
  interface Props {
    workspaceId: Uuid;
    // The daemon's current `workspace_revision.id` for this
    // workspace, threaded through from the page's loaded detail
    // (and updated by the poller's `onDetail` callback).
    // The slices store's Tier 1 short-circuit compares this
    // against the persisted `workspace_sync` record on bulk
    // mount; equality skips every per-category dataset GET.
    workspaceRevision: number;
    // Operator-facing workspace name, threaded through to the
    // Input Module's export filename.  Defaults to a generic
    // 'workspace' so the list can render even before the detail
    // fetch resolves -- the export filename suffix tracks the
    // current ws name when it's available.
    workspaceName?: string;
  }
  let { workspaceId, workspaceRevision, workspaceName = 'workspace' }: Props = $props();

  // Trigger a refresh on mount + whenever `workspaceId` changes.
  // The refresh call is wrapped in `untrack` so the reactive reads
  // inside `categories.refresh` (which writes to the same slice it
  // reads) don't accidentally invalidate this effect and re-queue
  // it -- the explicit dependencies are `workspaceId` plus the
  // workspace's stale flag.  The poller flips the stale bit on a
  // detected revision advance; the tracked read here re-fires
  // the effect, the untracked refresh below runs, and refresh's
  // own success branch clears stale -- one extra effect tick to
  // settle the dep, both refresh and the second pass short-
  // circuit.
  $effect(() => {
    const id = workspaceId;
    void categories.isStale(id);
    untrack(() => {
      void categories.refresh(id);
    });
  });

  const slice = $derived(categories.for(workspaceId));

  // Once the category list has resolved, fan out a single IDB
  // query that loads every slice in the workspace and partitions
  // them into the per-category map.  This populates the quantity
  // badges on collapsed rows (no need to expand each category to
  // see how many slices it has).  `refreshForWorkspace` also
  // auto-resumes any cross-reload pending uploads on first-load
  // (operator closed the tab mid-upload) -- co-located there so
  // re-triggers of this effect (e.g. a fresh category mutating
  // `slice.entries`) don't redundantly walk the pending set.
  //
  // The slices store guards `refreshForWorkspace` with its own
  // workspacesLoaded set, so this effect can re-fire freely; only
  // the first call actually walks IDB.
  //
  // `untrack` for the same reactive-loop reason documented on the
  // categories refresh -- the slices store's writes inside the
  // call shouldn't invalidate this effect.
  $effect(() => {
    const id = workspaceId;
    const cats = slice.entries;
    const rev = workspaceRevision;
    if (cats.length === 0) return;
    const names = cats.map((c) => c.name);
    untrack(() => {
      void slices.refreshForWorkspace(id, names, rev);
    });
  });

  let addOpen = $state(false);
  let deleteTarget = $state<Category | null>(null);

  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuSections = $state<MenuSection[]>([]);

  function onListContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('input, textarea')) return;
    const rowEl = target.closest<HTMLElement>('[data-category-name]');
    const name = rowEl?.dataset.categoryName ?? null;
    const cat = name ? (slice.entries.find((c) => c.name === name) ?? null) : null;
    const sections = buildMenu(cat);
    if (sections.length === 0) return;
    e.preventDefault();
    // Stop propagation so the workspace detail page's root
    // `oncontextmenu` (Rename / Delete this workspace / Back to
    // Workspaces) doesn't also open at the same cursor.  Inner
    // handlers always win: slice-grid right-click is consumed by
    // SlicePane, category-row right-click is consumed here, and
    // everything else (page header, metadata strip, heads
    // section) bubbles up to the page handler as intended.
    e.stopPropagation();
    menuX = e.clientX;
    menuY = e.clientY;
    menuSections = sections;
    menuOpen = true;
  }

  function buildMenu(cat: Category | null): MenuSection[] {
    if (cat) {
      const mandatory = isMandatoryCategory(cat.name);
      const deleting = slice.deleting.has(cat.name);
      return [
        {
          items: [
            {
              label: 'Delete',
              variant: 'destructive',
              disabled: mandatory || deleting,
              hint: mandatory ? 'required' : undefined,
              onclick: () => (deleteTarget = cat)
            }
          ]
        }
      ];
    }
    return [
      {
        items: [
          {
            label: 'Add category…',
            onclick: () => (addOpen = true)
          }
        ]
      }
    ];
  }
</script>

<section class="rounded-xl border border-zinc-200 bg-white px-5 pt-3.5 pb-5 shadow-sm">
  <!-- Header: title + description form a left-hand block; the Add
       Category button vertically centres against the whole block.
       `items-center` agrees the vertical midpoint of the two
       columns regardless of how the description wraps, and the
       `gap-3` keeps the CTA from crowding the description text
       on narrow viewports. -->
  <header class="mb-4 flex items-center justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-sm font-semibold text-zinc-900">Dataset</h2>
      <p class="mt-0.5 text-xs text-zinc-500">
        Each category becomes a class label the trainer learns. Background Noise is required.
      </p>
    </div>
    <Button onclick={() => (addOpen = true)} ariaLabel="Add category">
      <PlusIcon />
      Add category
    </Button>
  </header>

  {#if !slice.loaded}
    <LoadingRow size="section" label="loading categories…" />
  {:else if slice.error && slice.entries.length === 0}
    <div
      class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
      role="alert"
    >
      Couldn't load categories. {slice.error}
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div oncontextmenu={onListContextMenu}>
      <ul class="flex flex-col gap-2">
        {#each slice.entries as cat (cat.name)}
          <CategoryRow
            {workspaceId}
            {workspaceName}
            category={cat}
            expanded={slice.expandedName === cat.name}
            onDelete={isMandatoryCategory(cat.name) ? undefined : () => (deleteTarget = cat)}
          />
        {/each}
      </ul>
    </div>
  {/if}
</section>

<AddCategoryDialog open={addOpen} {workspaceId} onclose={() => (addOpen = false)} />

{#if deleteTarget}
  <DeleteCategoryDialog
    open={true}
    {workspaceId}
    categoryName={deleteTarget.name}
    origin={deleteTarget.origin}
    onclose={() => (deleteTarget = null)}
  />
{/if}

<ContextMenu
  open={menuOpen}
  x={menuX}
  y={menuY}
  sections={menuSections}
  onclose={() => (menuOpen = false)}
/>
