<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { workspaces as wsApi } from '$lib/api/endpoints';
  import { workspaces as wsStore } from '$lib/stores/workspaces.svelte';
  import { errorCopy, isNotFound } from '$lib/utils/error-copy';
  import type { WorkspaceDetail } from '$lib/api/types';
  import Spinner from '$lib/components/Spinner.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import InlineName from '$lib/components/ui/InlineName.svelte';
  import ContextMenu, { type MenuSection } from '$lib/components/ui/ContextMenu.svelte';
  import DeleteWorkspaceDialog from '$lib/components/workspace/DeleteWorkspaceDialog.svelte';
  import { formatRelative } from '$lib/utils/time';
  // Dataset Management surface per [ARCHITECTURE.md] §A.4
  // "Extra Notes": per-workspace category accordion with per-category
  // Input Module + Slice Management; backend slice sync.
  import CategoryList from '$lib/components/category/CategoryList.svelte';
  import { slices } from '$lib/stores/slices.svelte';
  import { WorkspacePoller } from '$lib/stores/workspace-poller';

  // Local state.  No dedicated store yet -- B.1 has a single
  // consumer for detail data, and the rename/delete mutations flow
  // through the list store which also keeps this page consistent
  // on revisit.
  let detail = $state<WorkspaceDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  // True when the daemon returned 404 -- we render an EmptyState
  // instead of an alarming banner because the recovery is just
  // "go back to the list".
  let notFound = $state(false);
  // Track the most recent id we fetched so we can re-fetch when the
  // route parameter changes (e.g. operator clicks a different
  // workspace from a tab + back-button history).
  let lastId = $state<string | null>(null);

  // One poller per page instance.  Started on first successful
  // load, restarted on workspace swap, stopped on destroy / 404.
  // The poller drives revision-driven cache invalidation in the
  // categories + slices stores (lazy refresh fires on expand);
  // here it just keeps `detail` live so the rev chip, heads
  // section, and name stay in sync without forcing the operator
  // to navigate away and back.
  const poller = new WorkspacePoller();

  async function load(id: string): Promise<void> {
    loading = true;
    error = null;
    notFound = false;
    // Stop any prior poller before the await so a stale tick
    // can't land on the new workspace's `detail` mid-swap.
    poller.stop();
    try {
      detail = await wsApi.get(id);
      lastId = id;
      // Begin polling for this workspace.  Detail re-binds on
      // every successful tick; `liveRevision` derives from it +
      // the slices store, so the chip updates automatically.
      poller.start(detail, {
        onDetail: (fresh) => {
          // Defensive: only adopt the polled detail if we're
          // still on this workspace.  A late-arriving tick after
          // route swap is otherwise filtered by the poller, but
          // an extra guard here costs nothing.
          if (lastId === fresh.id) detail = fresh;
        },
        onGone: () => {
          // Workspace deleted out from under us (this tab,
          // another tab, or the daemon CLI).  Surface the same
          // "not found" empty state the initial 404 path uses;
          // the operator clicks Back to workspaces to escape.
          //
          // Deliberately keep `lastId` pointing at the now-gone
          // workspace.  The `$effect` below tracks both
          // `page.params.id` and `lastId`; resetting `lastId` to
          // null while we're still on the same URL would re-fire
          // the effect, re-enter `load()`, and burn a redundant
          // 404 GET to arrive at the same EmptyState.  Component
          // unmount on route change still tears everything down.
          detail = null;
          notFound = true;
        },
        onError: (e) => {
          // Transient -- the next tick recovers.  Log so
          // engineers can see persistent breakage in devtools
          // without surfacing per-tick noise on the operator's
          // screen.
          console.warn('[workspace-poller] tick failed', e);
        }
      });
    } catch (e) {
      detail = null;
      notFound = isNotFound(e);
      error = errorCopy(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const id = page.params.id;
    if (id && id !== lastId) void load(id);
  });

  onDestroy(() => {
    poller.stop();
  });

  // Defensive lifecycle cleanup: a route param change (browser
  // back / forward, or a programmatic `goto` to a sibling
  // workspace) keeps this component instance alive while the
  // detail re-fetches.  Any context menu that was open before
  // the swap would otherwise re-render at the stale (x, y) anchor
  // against the new workspace's state.  Closing it on id change
  // means the menu can't survive a workspace transition.
  $effect(() => {
    void page.params.id;
    menuOpen = false;
  });

  // The revision chip can advance ahead of the loaded detail as
  // uploads commit -- the slices store stashes each receipt's
  // `workspace_revision_id` so we can promote the chip without a
  // detail re-fetch.  `revisionAdvanced` drives the `live` badge.
  const sliceLatestRevision = $derived(detail ? slices.latestRevisionFor(detail.id) : null);
  const liveRevision = $derived(
    detail ? Math.max(detail.workspace_revision.id, sliceLatestRevision ?? 0) : 0
  );
  const revisionAdvanced = $derived(
    detail !== null &&
      sliceLatestRevision !== null &&
      sliceLatestRevision > detail.workspace_revision.id
  );

  let editingName = $state(false);
  let deleteOpen = $state(false);
  // Right-click menu for the detail page.  The top-right Delete
  // button used to live here; we hid it because deletion from
  // *inside* a workspace is the wrong default footprint (high-cost
  // undo) -- the operator must opt in deliberately via this menu
  // or back out to the list.
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuSections = $state<MenuSection[]>([]);

  function backToList(): void {
    void goto(resolve('/workspace'));
  }

  async function saveName(newValue: string): Promise<void> {
    if (!detail) return;
    // Daemon docs: PATCH on metadata (name / tags) does NOT advance
    // workspace_revision -- only `name` needs to flow back here.
    const resp = await wsStore.patch(detail.id, { name: newValue });
    detail.name = resp.name;
    editingName = false;
  }

  function onPageContextMenu(e: MouseEvent): void {
    if (!detail) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea')) return;
    e.preventDefault();
    menuX = e.clientX;
    menuY = e.clientY;
    menuSections = [
      {
        items: [
          {
            label: 'Rename',
            onclick: () => (editingName = true)
          },
          {
            label: 'Delete this workspace…',
            variant: 'destructive',
            onclick: () => (deleteOpen = true)
          }
        ]
      },
      {
        items: [
          {
            label: 'Back to Workspaces',
            onclick: backToList
          }
        ]
      }
    ];
    menuOpen = true;
  }
</script>

<nav class="mb-4 text-xs text-zinc-500">
  <a href={resolve('/workspace')} class="transition hover:text-zinc-900">← Workspaces</a>
</nav>

{#if loading && !detail}
  <div class="flex items-center gap-2 px-1 py-12 text-xs text-zinc-500">
    <Spinner />
    <span>loading workspace…</span>
  </div>
{:else if notFound}
  <EmptyState
    title="Workspace not found"
    description="It may have been deleted in another tab or via the daemon directly. Head back to the list to see what's still around."
  >
    {#snippet action()}
      <Button onclick={backToList}>Back to workspaces</Button>
    {/snippet}
  </EmptyState>
{:else if error && !detail}
  <div
    class="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs"
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
      <p class="font-medium text-amber-900">Couldn't load this workspace</p>
      <p class="mt-0.5 text-amber-800">{error}</p>
    </div>
  </div>
{:else if detail}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div oncontextmenu={onPageContextMenu}>
    <header class="mb-5">
      {#if editingName}
        <InlineName
          value={detail.name}
          size="lg"
          ariaLabel="Rename workspace"
          onsave={saveName}
          oncancel={() => (editingName = false)}
        />
      {:else}
        <!-- `translate-y-0.5` (2 px down) is an optical-centre
             correction: text x-height sits ~1.4 px below the line
             box centre at text-lg, and the pencil SVG is top-heavy
             (tip at y=3.5, eraser at y=20).  Net ~1.7 px, rounded
             to the nearest integer-px landing. -->
        <div class="flex items-center gap-2">
          <h1
            class="truncate text-lg leading-tight font-semibold text-zinc-900"
            title={detail.name}
          >
            {detail.name}
          </h1>
          <button
            type="button"
            class="shrink-0 translate-y-0.5 rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900"
            title="Rename"
            aria-label="Rename workspace"
            onclick={() => (editingName = true)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
          </button>
        </div>
      {/if}
      <p class="mt-1 text-[11px] text-zinc-500" title={detail.created_at}>
        created {formatRelative(detail.created_at)}
      </p>
    </header>

    <!-- Metadata strip: revision + id.  `font-mono text-[10px]` echoes
         the Active Head card on Dashboard -- the project's idiom for
         opaque technical identifiers. -->
    <section
      class="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm sm:grid-cols-2"
    >
      <div>
        <h3 class="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Revision</h3>
        <p class="mt-1 font-mono text-xs text-zinc-700">
          rev {liveRevision}
          <span class="text-zinc-400">· at {formatRelative(detail.workspace_revision.at)}</span>
          {#if revisionAdvanced}
            <span
              class="ml-1 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800"
              title="Advanced by recent upload(s); reload to refresh `at` timestamp."
            >
              live
            </span>
          {/if}
        </p>
      </div>
      <div class="min-w-0">
        <h3 class="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">ID</h3>
        <p class="mt-1 truncate font-mono text-[10px] text-zinc-700" title={detail.id}>
          {detail.id}
        </p>
      </div>
    </section>

    <!-- Dataset section.  CategoryList self-mounts: refreshes from
         the store and re-renders reactively on every mutation.
         Per-category sync state surfaces in each row's badge;
         CategoryList also auto-resumes any pending uploads on mount
         so a tab reload mid-batch picks up where it left off. -->
    <div class="mb-6">
      <CategoryList workspaceId={detail.id} workspaceName={detail.name} />
    </div>

    <!-- Heads section.  B.1 ships the read-only listing; Slice C
         layers Train / Activate / Delete affordances on top.  Empty
         state intentionally telegraphs the upcoming work. -->
    <section class="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      <header class="mb-3 flex items-baseline justify-between">
        <h2 class="text-sm font-semibold text-zinc-900">Heads</h2>
        <span class="text-[11px] text-zinc-500">
          {detail.heads.length}
          {detail.heads.length === 1 ? 'head' : 'heads'}
        </span>
      </header>

      {#if detail.heads.length === 0}
        <p class="text-xs text-zinc-500">
          No heads trained yet. Recording + training will arrive with the next sub-slices.
        </p>
      {:else}
        <ul class="divide-y divide-zinc-100">
          {#each detail.heads as head (head.head_id)}
            <li class="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
              <div class="min-w-0">
                <p class="truncate font-mono text-[10px] text-zinc-700" title={head.head_id}>
                  {head.head_id.slice(0, 8)}…
                </p>
                <p class="mt-0.5 text-[11px] text-zinc-500">
                  {head.n_classes} classes ·
                  {(head.size_bytes / 1024).toFixed(1)} KiB · rev {head.workspace_revision.id}
                </p>
              </div>
              <span
                class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize transition-colors"
                class:bg-emerald-100={head.status === 'current'}
                class:text-emerald-800={head.status === 'current'}
                class:bg-amber-100={head.status === 'stale'}
                class:text-amber-800={head.status === 'stale'}
              >
                {head.status}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  <DeleteWorkspaceDialog
    open={deleteOpen}
    workspaceId={detail.id}
    workspaceName={detail.name}
    onclose={() => (deleteOpen = false)}
    ondeleted={backToList}
  />

  <ContextMenu
    open={menuOpen}
    x={menuX}
    y={menuY}
    sections={menuSections}
    onclose={() => (menuOpen = false)}
  />
{/if}
