<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { workspaces, MAX_WORKSPACES } from '$lib/stores/workspaces.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import LoadingRow from '$lib/components/LoadingRow.svelte';
  import PlusIcon from '$lib/components/ui/PlusIcon.svelte';
  import TrashIcon from '$lib/components/ui/TrashIcon.svelte';
  import ContextMenu, { type MenuSection } from '$lib/components/ui/ContextMenu.svelte';
  import CreateWorkspaceDialog from '$lib/components/workspace/CreateWorkspaceDialog.svelte';
  import DeleteWorkspaceDialog from '$lib/components/workspace/DeleteWorkspaceDialog.svelte';
  import BulkDeleteWorkspacesDialog from '$lib/components/workspace/BulkDeleteWorkspacesDialog.svelte';
  import WorkspaceCard from '$lib/components/workspace/WorkspaceCard.svelte';
  import type { WorkspaceListEntry, WorkspaceMutationResp, Uuid } from '$lib/api/types';

  // Refresh on every visit -- the list could have changed via
  // another tab, the CLI, or an in-flight delete completing.
  $effect(() => {
    void workspaces.refresh();
  });

  let createOpen = $state(false);
  let editingId = $state<Uuid | null>(null);
  let deleteTarget = $state<WorkspaceListEntry | null>(null);
  let bulkOpen = $state(false);
  let bulkTargets = $state<WorkspaceListEntry[]>([]);

  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuSections = $state<MenuSection[]>([]);

  const mode = $derived(workspaces.mode);
  const selectableCount = $derived(
    workspaces.entries.filter((w) => !workspaces.deleting.has(w.id)).length
  );
  const isAllSelected = $derived(
    selectableCount > 0 && workspaces.selected.size >= selectableCount
  );
  const atCapacity = $derived(workspaces.entries.length >= MAX_WORKSPACES);
  const overlayActive = $derived(
    createOpen || deleteTarget !== null || bulkOpen || menuOpen || editingId !== null
  );

  function onCreated(resp: WorkspaceMutationResp): void {
    void goto(resolve(`/workspace/${resp.id}`));
  }

  function openCreate(): void {
    if (atCapacity) return;
    createOpen = true;
  }

  function openBulkDelete(): void {
    bulkTargets = workspaces.selectedEntries.slice();
    if (bulkTargets.length === 0) return;
    bulkOpen = true;
  }

  function startInlineEdit(ws: WorkspaceListEntry): void {
    if (workspaces.deleting.has(ws.id)) return;
    editingId = ws.id;
  }

  $effect(() => {
    if (mode !== 'selecting') return;
    if (overlayActive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        workspaces.exitSelecting();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  function onPageContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('input, textarea')) return;
    const cardEl = target.closest<HTMLElement>('[data-workspace-id]');
    const id = cardEl?.dataset.workspaceId ?? null;
    const ws = id ? (workspaces.entries.find((w) => w.id === id) ?? null) : null;
    const sections = buildMenu(ws);
    if (sections.length === 0) return;
    e.preventDefault();
    menuX = e.clientX;
    menuY = e.clientY;
    menuSections = sections;
    menuOpen = true;
  }

  function buildMenu(ws: WorkspaceListEntry | null): MenuSection[] {
    if (ws) {
      const isSelected = workspaces.selected.has(ws.id);
      const isDeleting = workspaces.deleting.has(ws.id);
      const sections: MenuSection[] = [];
      sections.push({
        items: [
          {
            label: 'Open',
            disabled: isDeleting,
            onclick: () => void goto(resolve(`/workspace/${ws.id}`))
          },
          {
            label: 'Rename',
            disabled: isDeleting,
            onclick: () => startInlineEdit(ws)
          },
          {
            label: 'Delete',
            variant: 'destructive',
            disabled: isDeleting,
            onclick: () => (deleteTarget = ws)
          }
        ]
      });
      if (mode === 'selecting') {
        sections.push({
          items: [
            {
              label: isSelected ? 'Deselect' : 'Select',
              disabled: isDeleting,
              onclick: () => workspaces.toggleSelect(ws.id)
            },
            {
              label: 'Done (exit selection)',
              onclick: () => workspaces.exitSelecting()
            }
          ]
        });
      } else {
        sections.push({
          items: [
            {
              label: 'Select workspaces…',
              disabled: isDeleting,
              onclick: () => {
                workspaces.enterSelecting();
                workspaces.toggleSelect(ws.id);
              }
            }
          ]
        });
      }
      return sections;
    }
    const items = [];
    items.push({
      label: atCapacity ? `New workspace (at ${MAX_WORKSPACES} cap)` : 'New workspace',
      disabled: atCapacity,
      onclick: () => (createOpen = true)
    });
    if (mode === 'normal' && workspaces.entries.length > 0) {
      items.push({
        label: 'Select workspaces…',
        onclick: () => workspaces.enterSelecting()
      });
    }
    if (mode === 'selecting') {
      items.push({
        label: isAllSelected ? 'Deselect all' : 'Select all',
        disabled: selectableCount === 0,
        onclick: () => (isAllSelected ? workspaces.clearSelection() : workspaces.selectAllVisible())
      });
      items.push({
        label: 'Done (exit selection)',
        onclick: () => workspaces.exitSelecting()
      });
    }
    return items.length > 0 ? [{ items }] : [];
  }
</script>

<header class="mb-5 flex flex-wrap items-center justify-between gap-3">
  <div>
    <h1 class="text-base font-semibold text-zinc-900">Workspaces</h1>
    <p class="mt-0.5 text-xs text-zinc-500">
      {#if atCapacity}
        Reached the {MAX_WORKSPACES} workspace limit. Delete one before creating another.
      {:else}
        Each workspace holds a labeled dataset and any heads trained from it.
      {/if}
    </p>
  </div>
  {#if workspaces.loaded && workspaces.entries.length > 0}
    <!-- Single right-side action group.  Selecting mode fits three
         buttons (Select-all toggle, Done, bulk Delete) so we don't
         need a separate toolbar -- removes the slide-in animation
         and the layout shift that came with it.  An `sr-only`
         live region carries the selection-count announcement that
         the visible toolbar used to provide. -->
    <span class="sr-only" aria-live="polite">
      {mode === 'selecting' ? `${workspaces.selected.size} selected` : ''}
    </span>
    <div class="flex items-center gap-2">
      {#if mode === 'selecting'}
        <Button
          variant="secondary"
          onclick={() =>
            isAllSelected ? workspaces.clearSelection() : workspaces.selectAllVisible()}
          disabled={selectableCount === 0}
        >
          {isAllSelected ? 'Deselect all' : 'Select all'}
        </Button>
        <Button variant="secondary" onclick={() => workspaces.exitSelecting()}>Done</Button>
        <Button
          variant="destructive"
          onclick={openBulkDelete}
          disabled={workspaces.selected.size === 0}
          ariaLabel={workspaces.selected.size > 0
            ? `Delete ${workspaces.selected.size} workspaces`
            : 'Delete selected workspaces'}
        >
          <TrashIcon />
          Delete{workspaces.selected.size > 0 ? ` ${workspaces.selected.size}` : ''}
        </Button>
      {:else}
        <Button variant="secondary" onclick={() => workspaces.enterSelecting()}>Select</Button>
        <Button
          onclick={openCreate}
          disabled={atCapacity}
          ariaLabel="New workspace"
          title={atCapacity ? `Limit reached. Delete one workspace first.` : undefined}
        >
          {#if atCapacity}
            At cap · {workspaces.entries.length}/{MAX_WORKSPACES}
          {:else}
            <PlusIcon />
            New workspace
          {/if}
        </Button>
      {/if}
    </div>
  {/if}
</header>

{#if !workspaces.loaded}
  <LoadingRow label="loading workspaces…" />
{:else if workspaces.error && workspaces.entries.length === 0}
  <div
    class="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      class="h-4 w-4 shrink-0 animate-spin text-amber-700"
      aria-hidden="true"
    >
      <path d="M12 3a9 9 0 109 9" stroke-linecap="round" />
    </svg>
    <div class="min-w-0">
      <p class="font-medium text-amber-900">Daemon unavailable</p>
      <p class="mt-0.5 truncate text-amber-800">{workspaces.error}</p>
    </div>
  </div>
{:else if workspaces.entries.length === 0}
  <EmptyState
    title="No workspaces yet"
    description="Workspaces are where recordings, labeled samples, and trained heads live. Create one to get started."
  >
    {#snippet action()}
      <Button onclick={openCreate}>
        <PlusIcon />
        New workspace
      </Button>
    {/snippet}
  </EmptyState>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div oncontextmenu={onPageContextMenu}>
    <ul class="flex flex-col gap-2">
      {#each workspaces.entries as ws (ws.id)}
        <WorkspaceCard
          workspace={ws}
          editing={editingId === ws.id}
          onendedit={() => (editingId = null)}
        />
      {/each}
    </ul>
  </div>
{/if}

<CreateWorkspaceDialog
  open={createOpen}
  onclose={() => (createOpen = false)}
  oncreated={onCreated}
/>

{#if deleteTarget}
  <DeleteWorkspaceDialog
    open={true}
    workspaceId={deleteTarget.id}
    workspaceName={deleteTarget.name}
    onclose={() => (deleteTarget = null)}
  />
{/if}

{#if bulkOpen}
  <BulkDeleteWorkspacesDialog
    open={true}
    targets={bulkTargets}
    onclose={() => (bulkOpen = false)}
  />
{/if}

<ContextMenu
  open={menuOpen}
  x={menuX}
  y={menuY}
  sections={menuSections}
  onclose={() => (menuOpen = false)}
/>
