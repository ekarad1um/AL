<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import DownloadIcon from '$lib/components/ui/DownloadIcon.svelte';
  import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
  import Spinner from '$lib/components/Spinner.svelte';
  import { formatBytes } from '$lib/utils/format';
  import { formatRelative } from '$lib/utils/time';
  import type { HeadRecord, Uuid } from '$lib/api/types';

  interface Props {
    head: HeadRecord;
    // True ONLY for the most recently created head among those
    // matching the live workspace revision.  Drives the "Latest"
    // pill -- so a workspace with two heads at the same revision
    // shows the pill only on the newer one (operator's positive
    // scan target is "the most recent useful head", not "all heads
    // currently at the live rev").  Computed once at the list
    // level (HeadsTable) where the full heads array is in scope;
    // the row stays a pure renderer.
    isLatest: boolean;
    // True when this head is the runtime-active inference head AND
    // its source workspace matches the row's workspace.  Drives the
    // row's blue tint + the Deploy → Deployed button-label morph.
    // The daemon refuses to delete the active head; the right-click
    // menu reflects that constraint by disabling the Delete item
    // (HeadsTable.buildMenu).  No standalone "Deployed" pill on the
    // row: the chrome (border + bg) plus the button label are
    // enough -- a third indicator would be visual repetition.
    isDeployed: boolean;
    // Disabled while another head on this list is mid-mutation, so
    // the operator can't fire two destructive actions in parallel.
    busy?: boolean;
    // True iff THIS row is the one currently exporting.  Driven by
    // the parent's `exportingHeadId === head.head_id` so the
    // hover-revealed Export icon's spinner morph fires whether the
    // operator triggered export from the visible icon or the
    // right-click menu (both paths land at the same parent
    // `exportHeadAction`).  Local row state would have only
    // observed the icon-driven path.
    isExporting: boolean;
    ondeploy: (headId: Uuid) => Promise<void>;
    // Export the head as an `.alpkg` archive (zip-deflate container
    // carrying the manifest + .mpk weights).  Parent owns the
    // fetch / validate / pack / SaveAs pipeline; this row just
    // surfaces the click.  Not gated on `isDeployed`: an operator
    // may legitimately want to back up the currently-running head,
    // and the daemon's export path is read-only (no conflict with
    // the active swap).
    onexport: (head: HeadRecord) => void;
  }
  let {
    head,
    isLatest,
    isDeployed,
    busy = false,
    isExporting,
    ondeploy,
    onexport
  }: Props = $props();

  let deploying = $state(false);
  async function onDeployClick(): Promise<void> {
    if (deploying || isDeployed || busy || isExporting) return;
    deploying = true;
    try {
      await ondeploy(head.head_id);
    } finally {
      deploying = false;
    }
  }

  function onExportClick(): void {
    if (isExporting || deploying || busy) return;
    onexport(head);
  }
</script>

<!-- One head row.  Headline is the head's short id rendered in
     mono -- the head id names the trained-weight artifact uniquely,
     much the way a Git commit short hash names a commit; the
     truncated 8-char form keeps the resting display compact while
     the headline span's `title` attribute carries the full UUID for
     hover-reveal (debug + copy-paste context, not in the way at a
     glance).  A positive "Latest" pill sits next to the headline
     when this row is the single most-recently-created head matching
     the live workspace revision (parent HeadsTable picks the winner
     via `isLatest`); every other row -- older revisions or
     same-revision-but-not-newest -- carries no pill, so the
     operator's eye scans for one marker rather than auditing each
     row's freshness.

     The description line below carries the head's metadata in
     reading order: size · classes · rev · age.  Size + class
     count lead as the artifact's intrinsic facts -- the
     operator's first triage question is "does this head cover
     what I need?", which the class count answers most directly,
     so it sits adjacent to size at the head of the chain rather
     than tucked behind the rev token.  Rev then anchors the
     artifact to a specific workspace version, with age trailing
     as the recency signal.  Deployed rows tint blue to match
     the dashboard's Active Head card. -->
<!-- `data-head-id` is the parent HeadsTable's right-click hook:
     `onListContextMenu` walks `e.target.closest('[data-head-id]')`
     to identify which row the operator's cursor landed on, then
     opens the shared ContextMenu over that head with Export +
     Delete items.  No row-local context-menu state -- the parent
     owns the single menu instance per-list. -->
<li
  data-head-id={head.head_id}
  class="group/row flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5 transition-colors"
  class:border-blue-200={isDeployed}
  class:bg-blue-50={isDeployed}
  class:border-zinc-200={!isDeployed}
  class:bg-white={!isDeployed}
>
  <div class="min-w-0 flex-1">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <!-- Headline.  `font-mono` matches the rest of the codebase's
           "this is an opaque identifier" convention (see the
           training-history short-id chip, the deploy-error message's
           short-id mention, etc.).  `title` carries the full UUID for
           hover-reveal; the 8-char prefix is the typical short form
           operators use to disambiguate across a workspace's heads. -->
      <p class="font-mono text-sm font-semibold text-zinc-900" title={head.head_id}>
        {head.head_id.slice(0, 8)}…
      </p>
      {#if isLatest}
        <!-- Latest pill: conditional, mounts only on the single
             newest head at the live revision.  Other heads at
             older revisions -- AND additional same-revision heads
             trained earlier than the chosen one -- carry no pill,
             so the operator's positive scan target is "find the
             Latest" rather than "audit each row's freshness".
             StatusBadge's root in:fade / out:fade carries the
             appearance + disappearance, so a freshly trained head's
             pill materialises smoothly and the previous holder's
             pill dissolves on the same tick. -->
        <StatusBadge
          size="xs"
          label="Latest"
          tone="bg-emerald-100 text-emerald-800"
          title="Most recent head trained on the workspace's current revision."
        />
      {/if}
    </div>
    <p class="mt-1 text-[11px] text-zinc-500">
      {formatBytes(head.size_bytes)} · {head.n_classes}
      {head.n_classes === 1 ? 'class' : 'classes'} · rev {head.workspace_revision.id} ·
      <span class="text-zinc-400" title={head.created_at}>{formatRelative(head.created_at)}</span>
    </p>
  </div>

  <!-- Actions cluster.  Two slots LEFT → RIGHT: Export (hover-
       revealed icon), Deploy (always-visible primary CTA).  Delete
       lives in the right-click ContextMenu owned by the parent
       HeadsTable -- pulling it out of the resting chrome keeps
       this row reading as "Deploy this head, that's the action".
       The Export icon stays visible because operators frequently
       want to archive a head without first activating it, and the
       gesture chain `right-click → Export` is more friction than
       a single click on the visible glyph.
       Same hover-reveal idiom as CategoryRow's per-row delete
       (see CategoryRow.svelte:251-303): the button is in flow (so
       the layout doesn't reflow on hover and the Deploy CTA holds
       a stable position) but visually hidden via `opacity-0
       pointer-events-none`; `group-hover/row`, `focus-visible`,
       and `pointer-coarse` selectors restore opacity +
       interactivity for hover, keyboard, and touch respectively.
       Border-less to match CategoryRow's chrome-free affordance --
       the row already has its own border, and a nested border
       around a hover-revealed icon would read as visual
       repetition.  Tooltips live on the wrapper spans so the
       explanation surfaces in Firefox too: a disabled <button>
       doesn't fire pointer events in Firefox, so its native
       `title` stays hidden -- visible only in Chrome / Safari.
       The span receives the hover and shows its own title cross-
       browser; the operator hovering the inactive "Deployed"
       affordance sees the same hint on every engine. -->
  <div class="flex shrink-0 items-center gap-2">
    <span
      class="inline-flex shrink-0"
      title={isExporting ? 'Exporting…' : 'Export this head as a .alpkg archive'}
    >
      <!-- During export the button stays visible regardless of
           hover state (the `class:!opacity-100` /
           `class:!pointer-events-auto` overrides) so the spinner
           is legible the moment the operator's cursor moves off
           the row.  Blue hover wash telegraphs the non-destructive
           "download" intent and distinguishes this icon from any
           destructive accent the right-click menu's Delete item
           uses.
           Hover-wash tone is row-state-aware: the button has no
           rendered border, so the wash IS the button's visible
           edge at rest+hover.  On a non-deployed row (`bg-white`)
           a `bg-blue-50` wash reads as a crisp tinted pad.  On a
           deployed row (`bg-blue-50`) the same wash would render
           as a continuous surface with the row backdrop -- the
           operator's hover affordance vanishes mid-action.  The
           `class:` pair below steps the wash one tonal level
           deeper (`bg-blue-100`) on deployed rows so the pad reads
           as a distinct hover state in either context; on a
           non-deployed row the original `bg-blue-50` wash holds.
           Icon hover (`text-blue-600`) and focus ring
           (`ring-blue-200`) still contrast against `bg-blue-100`
           so no other tokens need to move. -->
      <button
        type="button"
        onclick={onExportClick}
        disabled={deploying || busy}
        aria-label={isExporting
          ? `Exporting head ${head.head_id.slice(0, 8)}…`
          : `Export head ${head.head_id.slice(0, 8)}…`}
        class="pointer-events-none inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-zinc-300 opacity-0 transition duration-200 ease-out group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:outline-none enabled:hover:text-blue-600 disabled:cursor-not-allowed disabled:text-zinc-200 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
        class:enabled:hover:bg-blue-50={!isDeployed}
        class:enabled:hover:bg-blue-100={isDeployed}
        class:!opacity-100={isExporting}
        class:!pointer-events-auto={isExporting}
      >
        {#if isExporting}
          <Spinner class="h-3.5 w-3.5 text-blue-500" />
        {:else}
          <DownloadIcon />
        {/if}
      </button>
    </span>
    <span
      class="inline-flex shrink-0"
      title={isDeployed
        ? 'This head is already deployed'
        : 'Hot-swap this head into the inference pipeline'}
    >
      <Button
        size="sm"
        variant={isDeployed ? 'secondary' : 'primary'}
        onclick={onDeployClick}
        disabled={isDeployed || busy || deploying || isExporting}
        loading={deploying}
      >
        {#if isDeployed}Deployed{:else}Deploy{/if}
      </Button>
    </span>
  </div>
</li>
