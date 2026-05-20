<script lang="ts">
  import PencilIcon from '$lib/components/ui/PencilIcon.svelte';
  import DownloadIcon from '$lib/components/ui/DownloadIcon.svelte';
  import UploadIcon from '$lib/components/ui/UploadIcon.svelte';

  // Workspace-level action cluster.  Renders the three primary
  // workspace operations (rename / export / import) as icon-only
  // buttons inside a pill-shaped container that sits to the right
  // of the workspace title on `/workspace/[id]`.  Replaces the
  // inline rename pencil that used to live beside the workspace
  // name -- centralising rename + export + import into one
  // affordance gives operators a single visual anchor for
  // "things you do to this workspace" rather than three icons
  // scattered across the page.
  //
  // Visual: pill-shaped (`rounded-full`) with a 1 px zinc-200
  // border + subtle shadow + zero-padding outer; each inner
  // button has its own `rounded-full` and hover background so the
  // hit targets read as distinct chips inside the island.
  //
  // Icons share the same `h-3.5 w-3.5` size + 2 px stroke weight
  // (see `PencilIcon` / `DownloadIcon` / `UploadIcon` docblocks)
  // so the three glyphs land at one consistent visual weight.

  interface Props {
    /// Fires on the rename button click.  Caller opens the
    /// `RenameWorkspaceDialog` (the rename popup that replaced
    /// the inline-edit affordance the title row used to carry).
    onrename: () => void;
    /// Fires on the export button click.  Caller opens the
    /// unified `WorkspaceExportDialog`.
    onexport: () => void;
    /// Fires on the import button click.  Currently disabled --
    /// the import flow is deferred to a later slice; the icon
    /// stays visible so the affordance's place is reserved
    /// against operator muscle-memory drift when the feature
    /// lands.
    onimport?: () => void;
  }
  let { onrename, onexport, onimport }: Props = $props();
</script>

<!-- `role="toolbar"` lets screen readers announce the cluster as
     one group; `aria-label` names its purpose since the buttons
     are icon-only.  `gap-0.5` keeps the chips visually
     differentiated without crowding (each chip's own padding
     does the spacing). -->
<div
  role="toolbar"
  aria-label="Workspace actions"
  class="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-zinc-200 bg-white p-1 shadow-sm"
>
  <button
    type="button"
    onclick={onrename}
    aria-label="Rename workspace"
    title="Rename workspace"
    class="rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
  >
    <PencilIcon />
  </button>
  <button
    type="button"
    onclick={onexport}
    aria-label="Export workspace"
    title="Export workspace (datasets + heads)"
    class="rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
  >
    <DownloadIcon />
  </button>
  <!-- Import is hardcoded `disabled` in this slice (feature is
       deferred); the visible-but-inert placeholder reserves the
       slot so muscle memory doesn't drift when the feature lands. -->
  <button
    type="button"
    onclick={onimport}
    disabled
    aria-label="Import workspace"
    title="Import workspace — coming soon"
    class="rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
  >
    <UploadIcon />
  </button>
</div>
