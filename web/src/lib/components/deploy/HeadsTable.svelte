<script lang="ts">
  import { fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import Button from '$lib/components/ui/Button.svelte';
  import ContextMenu, { type MenuSection } from '$lib/components/ui/ContextMenu.svelte';
  import { config as configStore } from '$lib/stores/config.svelte';
  import { errorCopy } from '$lib/utils/error-copy';
  import { exportHead } from '$lib/api/heads-export';
  import HeadRow from './HeadRow.svelte';
  import DeleteHeadDialog from './DeleteHeadDialog.svelte';
  import type { ActiveResp, HeadRecord, Uuid } from '$lib/api/types';

  // Heads listing for one workspace.  Surfaces every trained head
  // with a Deploy / Delete action cluster per row; a daemon-default
  // fallback row sits at the end so the operator always has an
  // escape hatch when every workspace head is stale, broken, or
  // not relevant.  Revert-to-prior is handled here too -- a small
  // affordance above the list re-deploys whatever was running
  // before the most recent deploy click landed.
  //
  // Mutation coordination: this component owns the deploy / delete
  // ack flow.  The parent supplies `onchanged` so it can refresh
  // the workspace detail after either lands (the daemon-side
  // mutation doesn't bump `workspace_revision` for head ops, so
  // the page's `liveRevision` derivation is correct as-is; the
  // parent just needs a fresh `heads[]` pull).
  //
  // `onchanged` contract: MUST NOT throw.  `deployHead`,
  // `deployDefault`, and `revert` each wrap `activateHead +
  // onchanged` in a single try/catch that clears `previousActive`
  // on any throw -- treating any failure as "deploy didn't land,
  // nothing to revert to".  If `onchanged` ever started throwing,
  // a successful daemon-side deploy followed by a refresh failure
  // would erroneously clear the revert target (the daemon state
  // DID change; the prior is still meaningful).  The workspace
  // page's `refreshDetail` honours this contract by wrapping its
  // fetch in try/catch and only console-warning on failure.

  interface Props {
    workspaceId: Uuid;
    /// Workspace's human-readable name, threaded through purely
    /// to seed the alpkg export's filename slug (`<ws>-head-<id8>
    /// .alpkg`) and the package manifest's `source.workspace_name`
    /// lookup hint.  Not load-bearing for any other surface in
    /// this component -- a missing name would only produce a
    /// `head-<id8>.alpkg` fallback filename via
    /// `safeFilenameSlug`'s empty-input branch.
    workspaceName: string;
    heads: readonly HeadRecord[];
    liveRevision: number;
    onchanged: () => Promise<void> | void;
  }
  let { workspaceId, workspaceName, heads, liveRevision, onchanged }: Props = $props();

  // Frontend mirror of the daemon's `MAX_HEADS_PER_WORKSPACE`
  // (modules/common/workspace.rs).  Surfaced inline next to the
  // heads count so the operator sees the sliding-window rotation
  // cap without diving into docs ("3 heads, latest 3 retained").
  // No API endpoint exposes this cap today, so it's hard-coded
  // here -- bump in lockstep if the daemon's cap ever changes.
  const HEAD_HISTORY_CAP = 3;

  const active = $derived(configStore.active);
  // Active head id when origin = 'head' AND the source workspace is
  // *this* workspace.  Drives the row's blue tint + the row's button-
  // label morph ("Deploy" → "Deployed" when isDeployed).  When the
  // active head belongs to a different workspace, no row in this
  // table is highlighted; the operator sees a "Standby" badge in
  // the parent DeployPane's header pill instead.
  const deployedHeadId = $derived<Uuid | null>(
    active?.origin === 'head' && active.source_workspace_id === workspaceId
      ? active.source_head_id
      : null
  );
  const defaultDeployed = $derived(active?.origin === 'default');

  // Newest-first display order.  Strict-weak-order comparator so
  // the rendered row order stays stable across reactive re-fires
  // when two heads share a `created_at`.
  const ordered = $derived(
    heads
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
  );

  // The single head-id that should wear the "Latest" pill.  Among
  // heads at the live workspace revision, only the most recently
  // created one qualifies -- so a workspace where the operator
  // trained twice without intermediate slice changes (both heads
  // at the same revision) shows the pill only on the newer head.
  // Heads at older revisions never qualify regardless of
  // created_at.  Iterates `ordered` (sorted newest-first) and
  // returns the first match: the newest-first sort means the
  // first matching head IS the newest at the live revision, so
  // the linear scan resolves correctly in one pass and tie-breaks
  // to the sort's stable order.
  const latestHeadId = $derived.by<Uuid | null>(() => {
    for (const h of ordered) {
      if (h.workspace_revision.id === liveRevision) return h.head_id;
    }
    return null;
  });

  // Per-list busy id: serialise deploy / delete / export across
  // rows so the operator can't fire two heavy actions in parallel
  // during a slow network blip.  Deploy and export both use this
  // slot; delete uses its own dialog-driven flow.
  let busyHeadId = $state<Uuid | null>(null);
  // True while the daemon-default fallback row is mid-deploy.  The
  // workspace-head rows have a per-row spinner; the default row
  // gets a separate flag because it doesn't carry a `head_id`.
  let deployingDefault = $state(false);
  // Mirror of `busyHeadId` for the export pipeline.  Two slots
  // (rather than one shared "busy" id with a `kind` discriminator)
  // keeps each handler's reset logic local and avoids a typo
  // where the deploy chain forgets to clear the export id (or
  // vice versa).  Both feed `interactionBlocked` so a row that's
  // mid-export disables Deploy / Delete on every sibling row.
  let exportingHeadId = $state<Uuid | null>(null);

  let deleteOpen = $state(false);
  let deleteHead = $state<HeadRecord | null>(null);

  // Last failed action attempt, surfaced inline below the list.
  // `kind` discriminates the three action shapes so the banner's
  // title can name the failed target ("Could not deploy head
  // <id>" / "Could not deploy default head" / "Could not export
  // head <id>").  Cleared at the start of the next action so a
  // retry's pending UI isn't shadowed by a stale rose banner.
  type ActionError =
    | { kind: 'deploy-head'; headId: Uuid; message: string }
    | { kind: 'deploy-default'; message: string }
    | { kind: 'export-head'; headId: Uuid; message: string };
  let actionError = $state<ActionError | null>(null);

  // Revert-to-prior: stash the runtime active record from before
  // the most recent successful deploy so the operator can roll
  // back without scrolling.  Two-element history is enough -- a
  // longer trail would invite "undo three steps" expectations the
  // current API doesn't support (active is single-slot at the
  // daemon).  Lives in component state; clears on workspace swap
  // because the parent keys this component by `workspaceId`.
  //
  // Stored as the wire shape (`ActiveResp`) so the re-deploy
  // dispatch reads `origin`, `source_workspace_id`, and
  // `source_head_id` directly without re-resolving against the
  // current `heads[]` array (which may have shifted since).
  let previousActive = $state<ActiveResp | null>(null);

  // Snapshot the *current* active record before the operator's
  // requested deploy lands, but only if the deploy will actually
  // change the runtime state -- a redundant deploy on the already-
  // deployed head shouldn't be recorded as the "previous".  The
  // caller passes its intent so this guard runs without consulting
  // the (already-updated) store after the call.
  function recordPrevious(intent: { kind: 'head'; headId: Uuid } | { kind: 'default' }): void {
    const cur = configStore.active;
    if (cur === null) return;
    if (intent.kind === 'head') {
      if (cur.origin === 'head' && cur.source_head_id === intent.headId) return;
    } else if (cur.origin === 'default') {
      return;
    }
    previousActive = cur;
  }

  async function deployHead(headId: Uuid): Promise<void> {
    if (interactionBlocked) return;
    busyHeadId = headId;
    actionError = null;
    try {
      recordPrevious({ kind: 'head', headId });
      await configStore.activateHead(workspaceId, headId);
      await onchanged();
    } catch (e) {
      previousActive = null;
      actionError = { kind: 'deploy-head', headId, message: errorCopy(e) };
    } finally {
      if (busyHeadId === headId) busyHeadId = null;
    }
  }

  async function deployDefault(): Promise<void> {
    if (interactionBlocked) return;
    deployingDefault = true;
    actionError = null;
    try {
      recordPrevious({ kind: 'default' });
      await configStore.activateDefault();
      await onchanged();
    } catch (e) {
      previousActive = null;
      actionError = { kind: 'deploy-default', message: errorCopy(e) };
    } finally {
      deployingDefault = false;
    }
  }

  // Revert dispatches against the stashed prior active.  When the
  // prior was a workspace head, re-resolve the workspace id from
  // the record itself (not from this component's `workspaceId`)
  // because a stashed prior could in principle reference a
  // different workspace -- today it always matches because the
  // history is wiped on workspace swap, but reading from the
  // record keeps the dispatch correct if the lifecycle ever
  // changes.
  async function revert(): Promise<void> {
    const prev = previousActive;
    if (prev === null) return;
    if (interactionBlocked) return;
    if (prev.origin === 'head') {
      const headId = prev.source_head_id;
      const wsId = prev.source_workspace_id;
      busyHeadId = headId;
      actionError = null;
      try {
        previousActive = configStore.active;
        await configStore.activateHead(wsId, headId);
        await onchanged();
      } catch (e) {
        previousActive = prev;
        actionError = { kind: 'deploy-head', headId, message: errorCopy(e) };
      } finally {
        if (busyHeadId === headId) busyHeadId = null;
      }
    } else {
      deployingDefault = true;
      actionError = null;
      try {
        previousActive = configStore.active;
        await configStore.activateDefault();
        await onchanged();
      } catch (e) {
        previousActive = prev;
        actionError = { kind: 'deploy-default', message: errorCopy(e) };
      } finally {
        deployingDefault = false;
      }
    }
  }

  // Drive the alpkg export pipeline for a single head row.  The
  // orchestrator owns fetch / validate / pack / SaveAs; this
  // handler just gates concurrency against the deploy chain
  // (via `interactionBlocked`) and routes any typed failure into
  // the shared `actionError` banner so the operator sees one
  // alert surface for every action shape on this list.
  //
  // Read-only at the daemon level -- a stuck export does NOT
  // block deploy/delete on the daemon side; the gate is purely
  // a client-side guardrail to avoid two concurrent in-flight
  // alpkg downloads stomping over the SaveAs dialog.
  async function exportHeadAction(head: HeadRecord): Promise<void> {
    if (interactionBlocked) return;
    exportingHeadId = head.head_id;
    actionError = null;
    try {
      await exportHead({ workspaceId, workspaceName, head });
    } catch (e) {
      actionError = { kind: 'export-head', headId: head.head_id, message: errorCopy(e) };
    } finally {
      if (exportingHeadId === head.head_id) exportingHeadId = null;
    }
  }

  // Human label for the revert button.  The previous state was
  // either a specific workspace head (name it by short id +
  // classes count) or the default head.
  const revertLabel = $derived<string | null>(
    previousActive === null
      ? null
      : previousActive.origin === 'default'
        ? 'Revert to default'
        : `Revert to ${previousActive.source_head_id.slice(0, 8)}…`
  );

  // Hide the revert affordance when it would re-deploy the
  // currently active record (nothing to roll back to).  Mirrors
  // `recordPrevious`'s no-op guard.
  const showRevert = $derived.by(() => {
    if (previousActive === null) return false;
    const cur = configStore.active;
    if (cur === null) return true;
    if (previousActive.origin === 'default') return cur.origin !== 'default';
    return !(
      cur.origin === 'head' &&
      cur.source_head_id === previousActive.source_head_id &&
      cur.source_workspace_id === previousActive.source_workspace_id
    );
  });

  function dismissActionError(): void {
    actionError = null;
  }

  function requestDelete(head: HeadRecord): void {
    if (interactionBlocked) return;
    deleteHead = head;
    deleteOpen = true;
  }

  function onDeleteClose(): void {
    deleteOpen = false;
  }

  async function onDeleted(deletedId: Uuid): Promise<void> {
    // If the deleted head was the stashed revert target, clear it
    // so the affordance can't suggest a head that no longer
    // exists.  The daemon-side guard already forbids deleting the
    // currently deployed head (the row's Delete button is
    // disabled when `isDeployed`), so the active record itself
    // never references a missing head.
    if (
      previousActive !== null &&
      previousActive.origin === 'head' &&
      previousActive.source_head_id === deletedId
    ) {
      previousActive = null;
    }
    await onchanged();
  }

  // Any in-flight action across deploy / default-deploy / export
  // blocks every sibling action until terminal.  The handlers
  // each guard on this derived AND clear it in `finally` so a
  // throw before the awaited daemon call can't strand the slot.
  const interactionBlocked = $derived(
    busyHeadId !== null || deployingDefault || exportingHeadId !== null
  );

  // Right-click ContextMenu.  Same pattern as the workspace list +
  // CategoryList: parent owns a single menu instance, the list
  // wrapper captures `oncontextmenu` and walks `data-head-id` to
  // identify which row the cursor landed on, and the menu's items
  // call the same handlers the visible Deploy/Export buttons use.
  // Empty-area right-clicks (cursor lands outside any head row,
  // e.g. on the dashed Default fallback or in the scroller gutter)
  // get no menu -- the early-return below leaves `preventDefault`
  // un-called so the workspace detail page's own context menu
  // (Rename / Delete this workspace / …) takes over for that
  // cursor instead.
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuSections = $state<MenuSection[]>([]);

  function onListContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const rowEl = target.closest<HTMLElement>('[data-head-id]');
    const headId = rowEl?.dataset.headId ?? null;
    const head = headId ? (heads.find((h) => h.head_id === headId) ?? null) : null;
    if (head === null) return;
    const sections = buildMenu(head);
    if (sections.length === 0) return;
    e.preventDefault();
    // Stop propagation so the workspace detail page's root
    // `oncontextmenu` doesn't also open at the same cursor --
    // inner handlers always win, matching the convention in
    // CategoryList.
    e.stopPropagation();
    menuX = e.clientX;
    menuY = e.clientY;
    menuSections = sections;
    menuOpen = true;
  }

  function buildMenu(head: HeadRecord): MenuSection[] {
    const isThisDeployed = deployedHeadId === head.head_id;
    const isThisExporting = exportingHeadId === head.head_id;
    // Per-item disablement:
    // * Export: only blocked when ANOTHER mutation is in flight
    //   on this list (including this row's own deploy).  If this
    //   row is already exporting, surface the live state in the
    //   label rather than silently disabling.
    // * Delete: blocked when this head is the runtime-active
    //   one (the daemon would 409) or when any mutation is in
    //   flight.  The `hint` column on the menu item carries the
    //   short reason for visibility.
    const exportDisabled = interactionBlocked && !isThisExporting;
    const deleteDisabled = isThisDeployed || interactionBlocked;
    const deleteHint = isThisDeployed ? 'deployed' : undefined;
    return [
      {
        items: [
          {
            label: isThisExporting ? 'Exporting…' : 'Export as .alpkg',
            disabled: exportDisabled || isThisExporting,
            onclick: () => void exportHeadAction(head)
          },
          {
            label: 'Delete',
            variant: 'destructive',
            disabled: deleteDisabled,
            hint: deleteHint,
            onclick: () => {
              requestDelete(head);
            }
          }
        ]
      }
    ];
  }
</script>

<!-- Compact pane card matching the dataset module's InputPane /
     SlicePane chrome: `rounded-md` (not -xl), no `shadow-sm`,
     `px-3 pt-1.5 pb-3` outer padding.  `flex h-full min-h-0
     flex-col` so the section fills the parent's `h-80` budget
     (320 px) and the internal list scroller can absorb a long
     heads list without pushing the action chrome below the fold.
     `overflow-hidden` clips the scroller's rounded inner edge to
     the section's rounded outer edge.  The pane is its own
     <section> so DeployPane only has to set width / row height on
     the grid cell -- identical contract to how CategoryRow slots
     InputPane + SlicePane into its accordion body. -->
<section
  class="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-zinc-200 bg-white px-3 pt-1.5 pb-3"
>
  <!-- Header rhythm: `min-h-5.25` (21 px) + `mb-1` (4 px) -- a
       deliberate variance from the other panes' `min-h-4.75`
       (19 px) + `mb-1.5` (6 px) pattern.  The reason: the
       optional revert button uses `text-[10px] py-0.5 border`
       which, under Tailwind preflight's inherited unitless
       `line-height: 1.5`, has a natural height of 21 px
       (line-box 15 + py 4 + border 2).  At `min-h-4.75` the
       header was 19 px headless and 21 px with the button,
       reflowing the scroller by 2 px the moment the button
       mounted and tipping the cap=3 + default fallback list
       (~274 px) past the scroller's 275 px capacity.
       Pinning `min-h-5.25` locks the header at 21 px in both
       states so the button mount no longer reflows anything.
       `mb-1` exactly offsets the +2 px in min-h so the section's
       header+mb total stays at 25 px (was 19+6, now 21+4),
       which preserves the scroller's original 277 px capacity
       and the comfortable ~3 px headroom over the list.  The
       h4 baseline shifts down ~1 px relative to InputPane /
       SlicePane (cross-pane "welded baseline" comment in
       InputPane.svelte) but those panes are vertically stacked
       elsewhere on the page, not side-by-side with this one,
       so the divergence is imperceptible in practice. -->
  <header class="mb-1 flex min-h-5.25 items-center justify-between gap-1.5">
    <!-- `translate-y-px` on the heading cluster: optical-centre
         correction shared by all four pane-level headings (this
         pane + InferencePreview + InputPane + SlicePane).
         `items-center` geometrically centres the ~13.2 px line-box
         in the 19 px header, but the cap glyph of `text-[11px]
         uppercase` sits ~0.55 px above line-box centre (descender
         allocation is reserved in the line-box even for uppercase,
         so the bottom half of the line-box is ~1.1 px taller than
         the top half).  Uncorrected, the heading reads as
         "floating high" with more whitespace below than above;
         the neighbouring button reads as balanced because its
         border masks the same internal bias.  Round to integer-px
         for crispness across DPIs (matches +page.svelte's
         translate-y-0.5 at text-lg precedent); 1 px overshoots
         the ideal ~0.7 px by ~0.3 px, but the residual is below
         the perceptual threshold while the uncorrected bias is
         the visible defect.  Cross-pane: shifting only the deploy
         headings would break the "h4 baselines welded cross-pane"
         contract noted in InputPane.svelte; all four panes carry
         the same shift to preserve the weld. -->
    <div class="flex translate-y-px items-baseline gap-1.5">
      <h4 class="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Heads</h4>
      <!-- Count reading in the dashboard meta-text idiom: plain
           muted text, no chip chrome.  Borders + bg are reserved
           for actions and status indicators; data readouts like
           a head count read more clearly as a flat phrase next
           to the heading.  The label includes the noun ("5 heads"
           / "1 head") so the value carries its own unit even when
           detached from the heading by a baseline shift on a
           wrapping viewport.  `tabular-nums` keeps the digit
           column stable as the count ticks.  Trailing ", latest
           N retained" surfaces the daemon's sliding-window
           rotation cap inline so the operator sees the retention
           policy without diving into docs -- N is HEAD_HISTORY_CAP
           (script preamble) which mirrors the daemon's
           `MAX_HEADS_PER_WORKSPACE`. -->
      <span class="text-[10px] text-zinc-400 tabular-nums">
        {heads.length}
        {heads.length === 1 ? 'head' : 'heads'}, latest {HEAD_HISTORY_CAP} retained
      </span>
    </div>
    {#if showRevert && revertLabel}
      <!-- Revert affordance in the SlicePane toolbar-button idiom
           (px-1.5 py-0.5 text-[10px]).  `leading-tight`
           (line-height 1.25) tightens the line-box from 15 →
           12.5 px and the button height from natural 21 → 18.5 px.
           In the 21 px header, items-center yields ~1.25 px of
           whitespace on the button's top + bottom -- locally
           symmetric.  But the SECTION CARD'S vertical rhythm is
           asymmetric: `pt-1.5` (6 px) above the header and `mb-1`
           (4 px) below it (the +2 px on top is load-bearing for
           the scroller-capacity math noted on the section's
           header rhythm comment above and cannot move).  Stacked,
           the button sat with 7.25 px of empty card-chrome above
           (pt-1.5 + 1.25) but only 5.25 px below (1.25 + mb-1),
           a 2 px top-heavy bias that the eye reads as "button
           sits 1-2 px low in the card".  `-translate-y-px` lifts
           the visible button by exactly 1 px so the contextual
           whitespace lands at 6.25 / 6.25 -- visually symmetric
           in the card-level frame the reader actually scans.
           Transform (not margin) so the layout pass still
           positions the button at items-center: the scroller's
           277 px budget below the header is computed from the
           layout-flow position, not the visual one. -->
      <button
        type="button"
        onclick={revert}
        disabled={interactionBlocked}
        class="inline-flex shrink-0 -translate-y-px items-center rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] leading-tight font-medium text-zinc-700 transition duration-200 ease-out hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
        title="Re-deploy the previously running head"
      >
        {revertLabel}
      </button>
    {/if}
  </header>

  <!-- Internal scroller absorbs over-long heads lists so a 20-head
       workspace doesn't push the default fallback row off the
       bottom of the card.  `pr-1` keeps the scrollbar from
       landing on the right edge of the row borders; `-mr-1`
       reclaims the space so the visual right inset still matches
       `px-3`.  No empty-state notice: when `heads.length === 0`
       the default fallback row below is the only deploy target,
       and the row's own copy plus its Deploy button already
       answer "what can I do here".
       `oncontextmenu` hangs off this scroller (not the row
       elements themselves) so the parent owns a single delegated
       handler -- matches the convention in CategoryList /
       workspaces list, and lets the menu state live in one
       place.  Right-clicks outside a head row (e.g. on the
       dashed Default row) fall through to the workspace detail
       page's own context menu via the early-return in
       `onListContextMenu`. -->
  <div
    class="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1"
    oncontextmenu={onListContextMenu}
    role="presentation"
  >
    <ul class="flex flex-col gap-2">
      {#each ordered as head (head.head_id)}
        <HeadRow
          {head}
          isLatest={head.head_id === latestHeadId}
          isDeployed={deployedHeadId === head.head_id}
          busy={interactionBlocked &&
            busyHeadId !== head.head_id &&
            exportingHeadId !== head.head_id}
          isExporting={exportingHeadId === head.head_id}
          ondeploy={deployHead}
          onexport={exportHeadAction}
        />
      {/each}

      <!-- Daemon-default fallback row.  Always present so the
           operator has an unconditional escape hatch when every
           workspace head is missing, stale, or doesn't fit the
           current dataset.  Sits below the workspace heads
           (visually separated by a dashed border + faded
           backdrop) so it never competes with a freshly trained
           head for attention.  When the default is the runtime
           active record we tint this row the same blue as a
           deployed workspace head -- the visual vocabulary is
           consistent across both origins. -->
      <li
        class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2.5 transition-colors"
        class:border-blue-300={defaultDeployed}
        class:bg-blue-50={defaultDeployed}
        class:border-zinc-300={!defaultDeployed}
        class:bg-zinc-50={!defaultDeployed}
      >
        <div class="min-w-0 flex-1">
          <!-- "Default" alone is the headline -- the surrounding
               context (the Heads section, the fallback row's
               dashed border + zinc-50 backdrop) already says
               "this is a head"; the redundant "head" suffix was
               chrome.  Also aligns the headline with the
               DeployPane's header pill "Default" token so the
               surface speaks one vocabulary for the daemon-
               bundled state. -->
          <p class="text-sm font-semibold text-zinc-900">Default</p>
          <p class="mt-1 text-[11px] text-zinc-500">Daemon-bundled fallback, always available.</p>
        </div>
        <!-- Button-label morph mirrors HeadRow's "Deploy" ↔
             "Deployed" so the workspace-head rows above and the
             fallback row below read as one action vocabulary.
             No standalone "Deployed" pill on the row: the
             dashed-blue border + bg + the disabled "Deployed"
             button label are the active-state signals, identical
             in spirit to the workspace-head rows above. -->
        <span
          class="inline-flex shrink-0"
          title={defaultDeployed
            ? 'The default head is already deployed'
            : 'Revert to the daemon-bundled default head'}
        >
          <Button
            size="sm"
            variant="secondary"
            onclick={deployDefault}
            disabled={defaultDeployed || interactionBlocked}
            loading={deployingDefault}
          >
            {#if defaultDeployed}Deployed{:else}Deploy{/if}
          </Button>
        </span>
      </li>
    </ul>
  </div>

  <!-- Action-failure banner.  Pinned to the bottom of the card
       (below the scroller, above the section's bottom padding)
       so a slow-network failure doesn't shove still-correct
       heads down and stays visible regardless of scroll position.
       Title branches on `actionError.kind` so the operator sees
       which action failed (deploy / deploy-default / export) and
       which row was involved.
       Shared style with TrainPane's start-error and InputPane's
       recorder/generic error chips so the three dismissible
       alert surfaces read as one family:
         * Chrome: rose-200 border on rose-50 fill, px-3 py-2,
           rounded-md, text-xs.
         * Text colour: a single `text-rose-900` declared on the
           outer flex container; the title, the head-id chip, and
           the message row all inherit it.  Weight + size (the
           `font-medium` title vs the lighter message) carries the
           hierarchy on its own without a second rose shade.
         * Dismiss button: `-mr-2` corner offset + `text-rose-700`
           with `hover:bg-rose-100` (in-family hover wash, not the
           prior `bg-white/60` which broke the rose-on-rose
           palette).  Stroke X glyph (24x24 viewBox, stroke-width
           2) for a thinner, more modern silhouette than the prior
           filled-path glyph -- matches InputPane's icon, and at
           h-3.5 w-3.5 reads identically across the family.
       Two layout modes, driven by whether `actionError.message`
       carries any text:
         * MULTI-LINE (default for real failures -- the daemon
           returns a typed string explanation): `items-start` +
           `px-3 py-2` chrome + `-mt-1 -mr-2` on the dismiss
           pins the X to the top-right corner with 4 px to the
           top edge and 4 px to the right edge (px-3 − mr-2 = 4,
           py-2 − mt-1 = 4).  Below-button whitespace is
           *intentional* -- the corner pattern reads as "dismiss
           this whole error block", letting the eye flow
           vertically through title + wrapped message without
           the button competing for the visual centre.
         * SINGLE-LINE (defensive: message comes back blank or
           the typed error has no detail to surface): `items-
           center` + `py-1 pr-1 pl-2.5` (asymmetric padding: 4 px
           top/right/bottom, 10 px left) + no negative margins on
           the dismiss.  The asymmetric left compensates for two
           text-positioning offsets that don't apply on the
           horizontal axis: (a) `items-center` adds 3 px above /
           below the 16 px text line-box (centring it inside the
           22 px button-driven content area), and (b) the
           text-xs font's half-leading + ascender-cap delta puts
           the visible cap top ~3.2 px below the line-box top.
           At the visible-cap level the text otherwise reads as
           4 px left vs ~10 px top -- a 6 px asymmetry the eye
           reads as "title hugs the left wall".  Lifting padding-
           left to 10 px lands cap-left ≈ cap-top ≈ visible
           bottom (within ~1.2 px across descender variation), so
           the inner content sits with visually balanced left /
           top / bottom whitespace.  Right stays at 4 px because
           the button has its own internal `p-1` -- icon-to-
           chrome-edge already measures 8 px (4 chrome + 4
           button) without needing an extra chrome offset.
           Alert collapses from 40 px tall (ML) to 32 px (SL)
           for a more compact, glanceable chip when there's no
           message body to anchor. -->

  {#if actionError}
    <!-- Snapshot the reactive `actionError` into a non-reactive
         local so the inner kind-discriminated branches can narrow
         once and reuse the narrowed type without each
         `actionError.X` access re-reading the `$state` proxy and
         widening back to the union (which then loses
         `.headId` for the export branch).  Pattern shared with
         other reactive-discriminator surfaces in this codebase
         (the `active` snapshot in DeployPane's `pillCopy`
         derivation does the same trick). -->
    {@const err = actionError}
    {@const hasMessage = err.message.trim().length > 0}
    <div
      in:fade={{ duration: 200, easing: cubicOut }}
      out:fade={{ duration: 160, easing: cubicOut }}
      class="mt-1.5 flex justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 text-xs text-rose-900"
      class:items-start={hasMessage}
      class:items-center={!hasMessage}
      class:px-3={hasMessage}
      class:py-2={hasMessage}
      class:py-1={!hasMessage}
      class:pr-1={!hasMessage}
      class:pl-2.5={!hasMessage}
      role="alert"
    >
      <div class="min-w-0">
        <p class="font-medium">
          {#if err.kind === 'deploy-head'}
            Could not deploy head
            <span class="font-mono text-[10px]" title={err.headId}>
              {err.headId.slice(0, 8)}…
            </span>
          {:else if err.kind === 'export-head'}
            Could not export head
            <span class="font-mono text-[10px]" title={err.headId}>
              {err.headId.slice(0, 8)}…
            </span>
          {:else}
            Could not deploy default head
          {/if}
        </p>
        {#if hasMessage}
          <p class="mt-0.5 wrap-break-word">{err.message}</p>
        {/if}
      </div>
      <button
        type="button"
        onclick={dismissActionError}
        aria-label="Dismiss"
        class="shrink-0 rounded-md p-1 text-rose-700 transition hover:bg-rose-100"
        class:-mt-1={hasMessage}
        class:-mr-2={hasMessage}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          class="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M6 18L18 6" />
        </svg>
      </button>
    </div>
  {/if}
</section>

<DeleteHeadDialog
  open={deleteOpen}
  {workspaceId}
  head={deleteHead}
  onclose={onDeleteClose}
  ondeleted={onDeleted}
/>

<!-- Single per-list ContextMenu instance.  Renders at the body
     end so its `position: fixed` chrome paints above the section
     card and the workspace detail page's tab strip without an
     explicit `z-index` stack discipline (the menu's own `z-50`
     handles the rest).  Triggered from the scroller's
     `oncontextmenu` handler. -->
<ContextMenu
  open={menuOpen}
  x={menuX}
  y={menuY}
  sections={menuSections}
  onclose={() => (menuOpen = false)}
/>
