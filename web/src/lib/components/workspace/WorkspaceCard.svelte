<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { resolve } from '$app/paths';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { formatRelative } from '$lib/utils/time';
  import InlineName from '$lib/components/ui/InlineName.svelte';
  import Spinner from '$lib/components/Spinner.svelte';
  import type { WorkspaceListEntry } from '$lib/api/types';

  // Only `editing` is per-card state; `mode`, `selected`, and
  // `deleting` come from the singleton store.  Rename and delete
  // are reached only via the right-click menu (delete also via
  // selecting mode), so the row stays uncluttered by hover icons.
  // The parent owns the context-menu event (single `oncontextmenu`
  // listener on the wrapping `<div>` reaches every card via bubbling).
  interface Props {
    workspace: WorkspaceListEntry;
    editing: boolean;
    onendedit: () => void;
  }
  let { workspace, editing, onendedit }: Props = $props();

  const isDeleting = $derived(workspaces.deleting.has(workspace.id));
  const isSelected = $derived(workspaces.selected.has(workspace.id));
  const mode = $derived(workspaces.mode);

  const detailHref = $derived(resolve(`/workspace/${workspace.id}`));

  function onLinkClick(e: MouseEvent): void {
    if (mode === 'selecting') {
      e.preventDefault();
      if (!isDeleting) workspaces.toggleSelect(workspace.id);
      return;
    }
    if (isDeleting) e.preventDefault();
  }

  async function saveName(newValue: string): Promise<void> {
    await workspaces.patch(workspace.id, { name: newValue });
    onendedit();
  }
</script>

<!-- `pl-12` reserves checkbox room in selecting mode; `pr-28`
     reserves the deleting-badge slot while a delete job is in
     flight. -->
<li
  data-workspace-id={workspace.id}
  class="relative rounded-lg border bg-white transition hover:shadow-sm {isSelected
    ? 'border-blue-300 hover:border-blue-400'
    : 'border-zinc-200 hover:border-zinc-300'}"
  class:opacity-60={isDeleting}
>
  {#if editing}
    <!-- Edit row: `py-2` (8+8 = 16 px) outer padding instead of
         the static `<a>`'s `py-3` (12+12 = 24 px), so the 8-px
         growth from `InlineName`'s `h-7` padded pill (vs the
         static `<h2>`'s 20-px line box) exactly cancels and the
         total row height stays pinned at 44 px on toggle.  See
         InlineName's docblock for the full layout contract.
         `min-w-0 flex-1` lets the input claim the same
         horizontal slot the `<h2>` does and keeps the trailing
         `created ...` strip pinned to the right. -->
    <div class="flex items-center gap-3 px-4 py-2">
      <div class="min-w-0 flex-1">
        <InlineName
          value={workspace.name}
          ariaLabel="Rename workspace {workspace.name}"
          onsave={saveName}
          oncancel={onendedit}
        />
      </div>
      <span
        class="hidden shrink-0 text-[11px] text-zinc-500 sm:inline"
        title={workspace.created_at}
      >
        created {formatRelative(workspace.created_at)}
      </span>
    </div>
  {:else}
    <!-- Easing must equal Svelte's `cubicOut` (the default for the
         checkbox's `transition:fly` below); Tailwind's `ease-out`
         is a different bezier and desyncs the padding shift from
         the checkbox slide. -->
    <a
      href={detailHref}
      aria-disabled={isDeleting}
      class="flex items-center gap-3 px-4 py-3 transition-all duration-150 ease-[cubic-bezier(0.333,1,0.667,1)]"
      class:pl-12={mode === 'selecting'}
      class:pr-28={isDeleting}
      class:pointer-events-none={isDeleting}
      onclick={onLinkClick}
    >
      <h2
        class="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900"
        title={workspace.name}
      >
        {workspace.name}
      </h2>
      <span
        class="hidden shrink-0 text-[11px] text-zinc-500 sm:inline"
        title={workspace.created_at}
      >
        created {formatRelative(workspace.created_at)}
      </span>
    </a>

    {#if mode === 'selecting'}
      <!-- `fly` with x=-32 slides the checkbox in lock-step with
           the name's 32 px padding shift (a plain `fade` would let
           the name pass through the half-opaque checkbox).  The
           `-translate-y-1/2` utility compiles to Tailwind v4's
           `translate` CSS property, which is independent of
           `transform`; Svelte's fly writes `transform: translate(...)`
           inline and the two properties stack, so vertical centring
           survives without a wrapper element. -->
      <label
        transition:fly={{ x: -32, duration: 150 }}
        class="absolute top-1/2 left-2.5 flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md transition hover:bg-zinc-100"
        class:cursor-not-allowed={isDeleting}
      >
        <input
          type="checkbox"
          class="h-4 w-4 cursor-pointer rounded border-zinc-300 accent-blue-500"
          checked={isSelected}
          disabled={isDeleting}
          onchange={() => workspaces.toggleSelect(workspace.id)}
          aria-label="Select {workspace.name}"
        />
      </label>
    {/if}

    {#if isDeleting}
      <span
        transition:fade={{ duration: 150 }}
        class="absolute top-1/2 right-3 inline-flex -translate-y-1/2 shrink-0 items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700 capitalize"
      >
        <Spinner class="h-2.5 w-2.5 text-rose-700" />
        deleting
      </span>
    {/if}
  {/if}
</li>
