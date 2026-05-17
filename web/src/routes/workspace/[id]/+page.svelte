<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { workspaces as wsApi } from '$lib/api/endpoints';
  import { workspaces as wsStore } from '$lib/stores/workspaces.svelte';
  import { errorCopy, isNotFound } from '$lib/utils/error-copy';
  import type { WorkspaceDetail } from '$lib/api/types';
  import LoadingRow from '$lib/components/LoadingRow.svelte';
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
  // Training surface (Slice C): submit + live progress + heads
  // management.  Lives below the dataset accordion so the
  // operator's eye flows top-to-bottom through the typical
  // workflow: record clips → trim + slice → train → activate.
  import TrainPane from '$lib/components/training/TrainPane.svelte';
  import HeadsList from '$lib/components/training/HeadsList.svelte';
  import { training as trainingStore } from '$lib/stores/training.svelte';

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
      // Training store carries workspace-scoped terminal slots
      // and may have stale state from a prior visit (e.g. the
      // operator navigated away after a failed run, then
      // returned).  Recovery picks up any actively-running job
      // for this workspace; the terminal slot stays as-is so
      // the operator sees their last verdict.  `recover` is
      // a no-op if the active slot is already bound.
      void trainingStore.recover(id);
      // Persistent history hydration: list the workspace's
      // `training_logs/` directory and replay the top
      // `INITIAL_VISIBLE` (=2) JSONL files into history
      // cards.  Idempotent across mount cycles; subsequent
      // calls for the same workspace short-circuit without a
      // network round-trip.  Fires concurrently with
      // `recover()`; the store's active-slot guard prevents
      // double-tracking a still-running job.
      void trainingStore.hydrateHistory(id);
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

  // Re-pull `detail` without restarting the poller.  Used by
  // Heads list actions (activate / delete) and by the
  // training store's terminal hook so the `heads[]` array
  // picks up the freshly-published head (or the deleted one
  // dropping off).  Errors are swallowed: a transient blip
  // recovers on the next poller tick.
  async function refreshDetail(): Promise<void> {
    const id = lastId;
    if (!id) return;
    try {
      const fresh = await wsApi.get(id);
      if (lastId === id) detail = fresh;
    } catch (e) {
      console.warn('[workspace] post-mutation refresh failed', e);
    }
  }

  // Training-terminal hook.  The store bumps `terminalSeq` on
  // every terminal landing across all workspaces; we filter to
  // this workspace's terminal slot (if any) and refresh only
  // when the slot is a `completed` for this workspace -- a
  // `failed` / `cancelled` doesn't change `heads[]` so a
  // refresh is wasted work.  The poller's 2 s tick would catch
  // up regardless; this is the faster path for the operator's
  // attention.
  //
  // `lastTerminalSeqSeen` is intentionally a plain `let`, not
  // `$state`: the effect both reads and writes it, and reactive
  // self-dependency would schedule an extra fire (which would
  // then return early via the equality guard) on every real
  // change.  No consumer outside this effect needs to track
  // its value, so non-reactive storage matches the actual
  // semantics.
  let lastTerminalSeqSeen = 0;
  $effect(() => {
    const seq = trainingStore.terminalSeq;
    if (seq === lastTerminalSeqSeen) return;
    lastTerminalSeqSeen = seq;
    if (!detail) return;
    const t = trainingStore.terminalFor(detail.id);
    if (t?.view?.state === 'completed') void refreshDetail();
  });

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
  <LoadingRow label="loading workspace…" />
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
    <header class="mb-6">
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
      <!-- Description strip: created · rev · modified, with the
           upload-receipt "live" badge trailing the modified
           timestamp it freshened.  Inline `·` separators match
           the HeadCard pattern; each timestamp keeps its own
           `title` so the absolute ISO is one hover away.  The
           `·` separators sit OUTSIDE every span so hovering a
           separator never fires an adjacent field's tooltip --
           hover-affordance maps 1:1 to the visible label. -->
      <p class="mt-1 text-[11px] text-zinc-500">
        <span title={detail.created_at}>created {formatRelative(detail.created_at)}</span>
        · rev {liveRevision} ·
        <span title={detail.workspace_revision.at}
          >modified {formatRelative(detail.workspace_revision.at)}</span
        >
        {#if revisionAdvanced}
          <span
            class="ml-1 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800"
            title="Advanced by recent upload(s); reload to refresh modified timestamp."
          >
            live
          </span>
        {/if}
      </p>
    </header>

    <!-- Dataset section.  CategoryList self-mounts: refreshes from
         the store and re-renders reactively on every mutation.
         Per-category sync state surfaces in each row's badge;
         CategoryList also auto-resumes any pending uploads on mount
         so a tab reload mid-batch picks up where it left off.
         `workspaceRevision` is threaded so the slices store's
         Tier 1 short-circuit can skip every per-category dataset
         GET when the persisted `workspace_sync` row already
         matches the daemon's current revision. -->
    <div class="mb-6">
      <CategoryList
        workspaceId={detail.id}
        workspaceRevision={detail.workspace_revision.id}
        workspaceName={detail.name}
      />
    </div>

    <!-- Training surface: submit + live progress + smart
         suggestion when a current head exists.  Lives above
         the heads list so the operator's typical action (start
         a run) is closer to the dataset they just edited. -->
    <div class="mb-6">
      <TrainPane workspaceId={detail.id} {liveRevision} heads={detail.heads} />
    </div>

    <!-- Heads section: per-head card with Activate + Delete
         actions.  `liveRevision` is the upload-receipt-promoted
         revision so a head trained at the previous rev flips
         to "stale" without waiting for the page poller. -->
    <HeadsList
      workspaceId={detail.id}
      heads={detail.heads}
      {liveRevision}
      onchanged={refreshDetail}
    />
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
