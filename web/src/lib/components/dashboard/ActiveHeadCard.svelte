<script lang="ts">
  import { config } from '$lib/stores/config.svelte';
  import { workspaces as wsApi } from '$lib/api/endpoints';
  import { formatRelativeShort } from '$lib/utils/time';
  import { formatLabelsList } from '$lib/components/category/labels';

  // Narrowed view of the active record's `head` variant.  Threading
  // the union through a derived (instead of repeatedly checking
  // `origin === 'head'` inline) lets the template read
  // `source_workspace_id` / `workspace_revision` without a non-null
  // assertion, and TypeScript stays exhaustive when new variants
  // are introduced upstream.
  let headActive = $derived(config.active?.origin === 'head' ? config.active : null);
  // Strictly `=== false`: the daemon's `POST /active` omits
  // `source_workspace_alive` entirely (see `$lib/api/types.ts`
  // contract on `ActiveResp`), so a truthy negation would briefly
  // render every freshly-activated workspace head as detached.
  // `undefined` (POST) and `true` (GET, alive) both mean "not
  // orphaned"; only an explicit `false` from a `GET` is the
  // detached signal.
  let orphaned = $derived(headActive !== null && headActive.source_workspace_alive === false);

  let origin = $derived(config.active?.origin ?? null);
  let nClasses = $derived(config.active?.n_classes ?? null);
  // Labels are inline on `ActiveBase` (runtime contract), so the
  // class-count tile can surface every label name on hover
  // without any per-head GET.  `null` when no head is active.
  let classLabels = $derived(config.active?.labels ?? null);
  let activatedAt = $derived(config.active?.activated_at ?? null);

  // Workspace-name resolution for the source workspace.  The daemon
  // ships the workspace `id` on `ActiveResp` but not the `name`
  // (which lives on `WorkspaceDetail`), so we lazy-fetch it via
  // `wsApi.get` whenever the active head transitions to a live
  // workspace-origin one.
  //
  // State transitions handled in the effect:
  //   - origin=default / null                  -> wsName reset, no fetch.
  //   - origin=head, alive=true or undefined   -> fetch (with same-id
  //                                                flicker suppression via
  //                                                prevId).  `undefined`
  //                                                is the `POST /active`
  //                                                shape (see
  //                                                `$lib/api/types.ts`
  //                                                contract); we treat it
  //                                                as alive because the
  //                                                activation just
  //                                                succeeded against the
  //                                                live workspace.
  //   - origin=head, alive=false               -> KEEP any previously-
  //                                                resolved name (so the
  //                                                workspace row can
  //                                                render "Test (deleted)"
  //                                                when the operator was
  //                                                working with the head
  //                                                this session).  A
  //                                                dashboard-first orphan
  //                                                load has nothing to
  //                                                preserve and the row
  //                                                falls back to the
  //                                                short-id form.
  //
  // We intentionally do NOT import `$lib/stores/workspaces.svelte` to
  // reuse its `all` list as a cache: its transitive imports
  // (slices / categories / drafts stores) pull ~50 kB onto the
  // dashboard chunk that nothing else on `/` ever needs.  The local
  // `prevId` guard takes the cache's place: an effect re-run with
  // the same id (e.g., layout auto-reconnect `config.refresh()` lands
  // a fresh `config.active` reference) keeps the previously-resolved
  // name visible while the verifier-fetch is in flight -- "loading…"
  // then only appears on the first paint and on a genuine head swap.
  //
  // Race handling: `wsApi.get` does not accept an `AbortSignal`
  // (matching the `workspace-poller.ts` shortcut), so the post-await
  // re-check (id unchanged AND still alive) is the only safety net.
  // The `source_workspace_alive` clause matters: a workspace deleted
  // between fetch start and resolution would otherwise let us write
  // a name back over the (now-preserved) cached one, drifting state
  // away from what the daemon last reported.
  let wsName = $state<string | null>(null);
  let wsNameStatus = $state<'idle' | 'loading' | 'error'>('idle');
  // Plain `let` -- per-component-instance scratch space, not reactive:
  // we only read it from inside the effect we also write it from, and
  // an extra signal would just feedback-loop the same effect.
  let prevId: string | null = null;

  $effect(() => {
    const cur = headActive;
    if (cur === null) {
      wsName = null;
      wsNameStatus = 'idle';
      prevId = null;
      return;
    }
    if (cur.source_workspace_alive === false) {
      wsNameStatus = 'idle';
      return;
    }
    const id = cur.source_workspace_id;
    // Clear the previous name only on a genuine head swap.  Same-id
    // re-fetches (config refresh on auto-reconnect) leave the prior
    // name visible until the new response lands, suppressing the
    // "Test -> loading… -> Test" flicker.
    if (id !== prevId) wsName = null;
    prevId = id;
    wsNameStatus = 'loading';
    // Per-run cancellation flag.  The `config.active` re-check after
    // the await already rejects stale fetches when the head swaps to
    // a different workspace, but it can't distinguish "head
    // unchanged, component live" from "head unchanged, component
    // unmounted".  Without this flag a late `.then` after unmount
    // would still invoke the `wsName` / `wsNameStatus` setters;
    // Svelte 5 still processes the mutation, but the component's
    // render graph has already been torn down, so the write reaches
    // no DOM -- harmless, just a code-smell that pretends to update
    // UI that no longer exists.  Flag is closure-captured and
    // flipped in the effect's cleanup, which Svelte invokes on both
    // re-run and unmount.
    let cancelled = false;
    void wsApi.get(id).then(
      (detail) => {
        if (cancelled) return;
        const a = config.active;
        if (
          a?.origin === 'head' &&
          a.source_workspace_id === id &&
          a.source_workspace_alive !== false
        ) {
          wsName = detail.name;
          wsNameStatus = 'idle';
        }
      },
      () => {
        if (cancelled) return;
        const a = config.active;
        if (
          a?.origin === 'head' &&
          a.source_workspace_id === id &&
          a.source_workspace_alive !== false
        ) {
          wsNameStatus = 'error';
        }
      }
    );
    return () => {
      cancelled = true;
    };
  });

  // Adaptive tick: schedules the next `now` update at the next bucket
  // boundary in `formatRelativeShort`'s output (60 s / 60 min / 24 h /
  // 30+ d), instead of polling every second.  Because the format
  // floors to integer units, the string only changes when elapsed
  // crosses a boundary -- so a 1 Hz interval would emit 59 no-op
  // re-derives per minute.  At 1 Hz the absolute cost is ~600 μs/min
  // (sub-perceptual), but the adaptive form makes the wake-up cadence
  // match the visible-change cadence, which reads cleaner and scales
  // naturally past the > 1 h mark (one wake-up per hour, then per
  // day, instead of 3600 / 86400 per cycle).
  //
  // Visibility handling: browsers throttle long-delay `setTimeout`s
  // in backgrounded tabs (Chrome drops to 1 Hz after ~5 min idle, or
  // pauses entirely past 5 minutes for cross-origin frames), so a
  // multi-hour timer scheduled while visible may fire arbitrarily
  // late on tab refocus.  The `visibilitychange` listener clears any
  // pending timer and forces an immediate `now` update + reschedule
  // when the tab becomes visible again, so the display catches up to
  // wall-clock state before the operator's eyes land on the card.
  //
  // 250 ms floor on `setTimeout` prevents pathologically tight loops
  // if a re-schedule lands microseconds before a boundary (e.g.,
  // after a small clock-skew correction).
  let now = $state(Date.now());
  $effect(() => {
    if (!activatedAt) return;
    const t = Date.parse(activatedAt);
    if (Number.isNaN(t)) return;

    // Initialized below by the synchronous `schedule()` call before
    // any event handler can run; declared `| undefined` so the type
    // reflects the brief pre-schedule window honestly (and so a
    // future maintainer adding a code path that reads `timer` before
    // `schedule()` gets a TS error instead of silently relying on
    // `clearTimeout(undefined)` being a no-op).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      const elapsedMs = Date.now() - t;
      let nextDeltaMs: number;
      if (elapsedMs < 60_000) {
        // Pre-minute: wake at the 60 s mark.
        nextDeltaMs = 60_000 - elapsedMs;
      } else if (elapsedMs < 3_600_000) {
        // In minutes: wake at the next minute boundary.
        nextDeltaMs = 60_000 - (elapsedMs % 60_000);
      } else if (elapsedMs < 86_400_000) {
        // In hours: wake at the next hour boundary.
        nextDeltaMs = 3_600_000 - (elapsedMs % 3_600_000);
      } else {
        // In days: wake at the next day boundary.
        nextDeltaMs = 86_400_000 - (elapsedMs % 86_400_000);
      }
      timer = setTimeout(
        () => {
          now = Date.now();
          schedule();
        },
        Math.max(250, nextDeltaMs)
      );
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        now = Date.now();
        schedule();
      }
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });

  let activeRelative = $derived(
    activatedAt ? formatRelativeShort(activatedAt, new Date(now)) : null
  );

  // Pill copy maps the wire `origin` token to the operator-facing
  // state vocabulary: `default` (daemon-bundled head), `workspace`
  // (live trained head), `detached` (the workspace that produced
  // the running weights has since been deleted -- git's term for a
  // HEAD pointing at nothing, applied here to a runtime head with
  // no live source).  The amber tint + inline "deleted" tag carry
  // the load-bearing visual signal; the pill word names the state.
  let pillLabel = $derived<'default' | 'workspace' | 'detached' | null>(
    origin === null ? null : orphaned ? 'detached' : origin === 'head' ? 'workspace' : 'default'
  );

  // Tooltip for the workspace cell: always the full UUID for copy-
  // paste, prefixed with the resolved name when we have one and
  // tagged `(workspace deleted)` when orphaned so the operator
  // hovering the row sees the same state the visible text already
  // conveys.
  let wsTitle = $derived<string | null>(
    headActive === null
      ? null
      : orphaned
        ? wsName !== null
          ? `${wsName} · ${headActive.source_workspace_id} (workspace deleted)`
          : `${headActive.source_workspace_id} (workspace deleted)`
        : wsName !== null
          ? `${wsName} · ${headActive.source_workspace_id}`
          : headActive.source_workspace_id
  );
</script>

<!-- Asymmetric inner padding (`pt-2.5` / `pb-3` / `px-3.5`) makes the
     visible text insets read as equal on all four sides despite
     CSS's box-edge being the "padding" reference.  Each side
     compensates a different typographic stack:
       - Top (`pt-2.5` = 10 px): the header is a `flex items-center`
         where the (taller) pill controls container height; the h4
         text centers within it, adding ~2 px of centering offset
         plus ~1.5 px half-leading above the cap line.  Total
         compensation: 4 px.
       - Bottom (`pb-3` = 12 px): the last text element (caption or
         meta `dd`) has only its own half-leading-below to
         compensate.  Total compensation: 2 px.
       - Sides (`px-3.5` = 14 px): text starts directly at the
         padding edge, no half-leading offset; no compensation.
     Measured visible insets after the fix: top 14.5 px, left 15 px,
     right 15 px, bottom 15 px -- all within sub-pixel tolerance, so
     the card reads as optically square.  The pill (decorative flex
     item) sits 11 px from the top and 15 px from the right; that
     4 px tucked-into-corner offset is intentional, since the pill's
     visible *text glyph* aligns with the h4 cap line at 14.5 px,
     and the pill's decorative-rounded background is a qualifier,
     not an alignment anchor. -->
<aside
  class="rounded-lg border px-3.5 pt-2.5 pb-3 transition-colors duration-200"
  class:border-amber-200={orphaned}
  class:bg-amber-50={orphaned}
  class:border-zinc-200={!orphaned}
  class:bg-zinc-50={!orphaned}
>
  <header class="mb-3 flex items-center justify-between gap-2">
    <h4 class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Active head</h4>
    {#if pillLabel}
      <span
        class="rounded-full px-2 py-0.5 text-[11px] font-medium capitalize tracking-wide transition-colors duration-200"
        class:bg-zinc-200={pillLabel === 'default'}
        class:text-zinc-700={pillLabel === 'default'}
        class:bg-blue-100={pillLabel === 'workspace'}
        class:text-blue-800={pillLabel === 'workspace'}
        class:bg-amber-200={pillLabel === 'detached'}
        class:text-amber-900={pillLabel === 'detached'}
        title={pillLabel === 'detached'
          ? 'Source workspace was deleted after this head was activated.'
          : pillLabel === 'default'
            ? 'The daemon-bundled default head is running.'
            : 'A trained workspace head is running.'}
      >
        {pillLabel}
      </span>
    {/if}
  </header>

  {#if config.active === null}
    <p class="text-xs text-zinc-400">waiting for first inference frame…</p>
  {:else}
    <!-- Stat-tile pair.  Both values share one font + size + weight
         (sans, text-xl, semibold, tabular-nums) so the row reads as
         a single typographic system; only the content distinguishes
         them.  `tabular-nums` keeps digit columns stable across
         ticks ("5 min" -> "6 min", "9" -> "10") without forcing the
         time tile into a monospaced look that would clash with its
         word units.  Time tile carries `min-w-0 truncate` so an
         unusually long locale form is clipped before it overflows
         the column; the numeric tile doesn't need it because
         realistic class counts fit in <30 px. -->
    <div
      class="grid grid-cols-2 divide-x"
      class:divide-amber-200={orphaned}
      class:divide-zinc-200={!orphaned}
    >
      <div class="min-w-0 pr-3 text-center" title={activatedAt ?? undefined}>
        <div class="truncate text-xl font-semibold tabular-nums text-zinc-900">
          {#if activeRelative}{activeRelative}{:else}<span class="text-zinc-400">—</span>{/if}
        </div>
        <div class="mt-1 text-[10px] text-zinc-400">activated</div>
      </div>
      <div
        class="pl-3 text-center"
        title={classLabels && classLabels.length > 0 ? formatLabelsList(classLabels) : undefined}
      >
        <div class="text-xl font-semibold tabular-nums text-zinc-900">
          {#if nClasses !== null}{nClasses}{:else}<span class="text-zinc-400">—</span>{/if}
        </div>
        <div class="mt-1 text-[10px] text-zinc-400">{nClasses === 1 ? 'class' : 'classes'}</div>
      </div>
    </div>

    {#if headActive}
      <!-- Two-row meta block for workspace-origin heads.  Compactness
           over completeness: the head id is intentionally absent (the
           pill + name already say "this is the trained head from
           workspace Test"); the orphaned state is folded inline into
           the workspace cell as "Test (deleted)" (cached name) or
           "(deleted)" (dashboard-first orphan), so no separate notice
           paragraph is needed below.  The workspace UUID is never
           rendered in the body -- it lives only in `wsTitle` for
           power users who need a copy-paste anchor on hover. -->
      <dl
        class="mt-3 grid grid-cols-[5rem_1fr] items-baseline gap-x-3 gap-y-1.5 border-t pt-3 text-xs"
        class:border-amber-200={orphaned}
        class:border-zinc-200={!orphaned}
      >
        <dt class="text-zinc-500">workspace</dt>
        <dd class="min-w-0 truncate text-zinc-800" title={wsTitle ?? undefined}>
          {#if orphaned}
            <!-- Orphaned: the visible row hides the workspace UUID
                 to keep the detached state from carrying forensic
                 noise.  When the name was resolved earlier this
                 session it leads ("Test (deleted)"); otherwise the
                 row reads "(deleted)" alone -- the detached pill +
                 amber tint already say "this is wrong", the tag
                 just names the failure mode. -->
            {#if wsName !== null}
              <span class="font-medium text-amber-800">{wsName}</span>
              <span class="ml-1 text-amber-800 italic">(deleted)</span>
            {:else}
              <span class="text-amber-800 italic">(deleted)</span>
            {/if}
          {:else if wsName !== null}
            <span class="font-medium">{wsName}</span>
          {:else if wsNameStatus === 'loading'}
            <span class="text-zinc-400">loading…</span>
          {:else}
            <!-- Live workspace whose name fetch failed (404 race or
                 transient network).  The short-id anchors the row;
                 the tooltip carries the full UUID. -->
            <span class="font-mono text-[10px]"
              >{headActive.source_workspace_id.slice(0, 8)}<span class="text-zinc-400">…</span
              ></span
            >
          {/if}
        </dd>

        <dt class="text-zinc-500">revision</dt>
        <dd class="truncate text-zinc-800">rev {headActive.workspace_revision.id}</dd>
      </dl>
    {/if}
  {/if}
</aside>
