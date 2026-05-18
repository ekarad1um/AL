<script lang="ts">
  import { fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { streams } from '$lib/stores/streams.svelte';
  import { config } from '$lib/stores/config.svelte';
  import SpectrogramCanvas from '$lib/components/dashboard/SpectrogramCanvas.svelte';
  import TopKMeter from '$lib/components/dashboard/TopKMeter.svelte';
  import { SOCKET_LABEL, socketPillClass } from '$lib/components/dashboard/socketPill';

  // Auto-managed live preview for the deploy module.  Mounting the
  // spectrogram + top-k surfaces runs a 60 Hz RAF + FFT loop that,
  // while light, is wasteful when the operator is here to swap
  // heads rather than monitor inference -- so the preview is OFF
  // by default and is started / stopped by three signals rather
  // than a persistent toggle:
  //
  //   1. Manual start: the big CTA in the off-state placeholder
  //      below.  Once started, no manual stop affordance is
  //      shown -- the operator's attention signals (2 + 3 below)
  //      handle teardown.
  //
  //   2. Auto-start on deploy: an `$effect` watches
  //      `config.active.activation_id`.  The daemon reassigns
  //      this UUID every time it activates a head, so a change
  //      after the page-load baseline is a strong "operator just
  //      deployed" signal -- whether the deploy came from this
  //      pane's Deploy button, the Revert button, the default-
  //      row's Deploy, another tab, or the daemon CLI.  In every
  //      case, the operator wants to see the result without an
  //      extra click.  Initial fetch establishes the baseline
  //      and doesn't auto-start.
  //
  //   3. Auto-stop on attention shift: an `IntersectionObserver`
  //      watches the pane's own <section>.  When the pane drops
  //      below 20% visible for more than 800 ms continuously the
  //      preview tears down.  The 800 ms debounce filters quick
  //      glance-aways (briefly scrolling up to check the dataset
  //      and back); only a sustained focus shift trips the stop.
  //      Component unmount (route navigation) cleans up the
  //      observer automatically -- no separate "stop on page
  //      leave" handler needed.
  //
  // ## Why no localStorage
  // Persisting "I want preview on" between page visits stops
  // making sense once the lifecycle is auto-managed: each
  // visit's preview is bound to operator attention within that
  // visit.  Removing localStorage simplifies the model and
  // avoids the "why is the preview running on a fresh load?"
  // confusion.
  //
  // Layout: a fixed-height spectrogram strip (96 px) on top, a
  // top-k scroller below taking the remaining body height.  Card
  // height is pinned by the parent grid cell to `h-80` (320 px),
  // matching the dataset accordion's `min-h-80` -- a single
  // compact rhythm across the workspace's three sections.  The
  // off-state placeholder occupies the same vertical budget so
  // toggling doesn't reflow the heads table next to it.

  let preview = $state(false);
  let sectionEl: HTMLElement | undefined = $state();

  // Ratio under which the pane is considered "out of focus".
  // 0.2 means more than 80% of the 320 px pane is off-screen
  // (i.e., < 64 px visible).  Anything less aggressive (e.g.,
  // 0.5) would stop while the operator is still mostly looking
  // at the pane; anything stricter (e.g., 0.05) would let a tiny
  // sliver count as "still focused", missing genuine attention
  // shifts.
  const STOP_INTERSECTION_RATIO = 0.2;

  // How long the pane must be below the stop threshold before
  // the stop actually fires.  Filters quick glances away (e.g.,
  // a brief scroll up to read a slice row, then back down).  Set
  // shorter than ~600 ms and accidental scrolls trip the stop;
  // longer than ~1.5 s and the auto-stop feels sluggish.
  const STOP_DEBOUNCE_MS = 800;

  // Baseline-init guard for the auto-start watcher.  Plain `let`
  // (not `$state`): the value is only read + written inside the
  // single effect below.  Making it reactive would cause the
  // effect's own write to re-trigger itself; the explicit
  // null-vs-non-null comparison handles the "did we see a first
  // value yet" semantics without dragging the reactive graph
  // into the loop.  Reset on every component mount, so a
  // navigate-away-and-back establishes a fresh baseline rather
  // than treating the post-remount fetch as a deploy.
  let lastSeenActivationId: string | null = null;

  $effect(() => {
    const cur = config.active?.activation_id ?? null;
    if (cur === null) {
      // Pre-load or daemon-disconnect.  Don't update the
      // baseline; when the active record comes back, we'll
      // compare against the pre-disconnect value rather than
      // false-positive a "deploy" on the reconnect itself.
      return;
    }
    if (lastSeenActivationId === null) {
      // First non-null observation: record the baseline and
      // bail.  The initial fetch on page mount is NOT a deploy.
      lastSeenActivationId = cur;
      return;
    }
    if (cur !== lastSeenActivationId) {
      // Activation changed since baseline -- the daemon just
      // swapped runtime heads.  Auto-start so the operator sees
      // the result of their click without an extra interaction.
      lastSeenActivationId = cur;
      preview = true;
    }
  });

  // IntersectionObserver auto-stop.  Only observes while the
  // preview is ON; toggling off (manual or auto) tears the
  // observer down via the effect's cleanup return.  Toggling
  // back on re-creates a fresh observer.  Single-flight timer
  // is captured per-effect-run so the cleanup can clear a
  // pending stop on disconnect.
  $effect(() => {
    if (!preview || !sectionEl) return;
    let offScreenTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        // The observer may batch multiple events when scrolling
        // crosses several thresholds in one frame; the last entry
        // reflects the current state, which is the only one that
        // determines whether we're focused or not.  Reading
        // `entries[entries.length - 1]` is safe: IntersectionObserver
        // never invokes the callback with an empty array.
        const entry = entries[entries.length - 1];
        if (entry.intersectionRatio < STOP_INTERSECTION_RATIO) {
          // Pane is off-focus.  Start the debounce timer if not
          // already running (`??=` is the nullish-only assign so a
          // pending timer isn't replaced by a later off-focus event
          // before it fires).  A subsequent "back in view" event
          // will clear the timer before it fires.
          offScreenTimer ??= setTimeout(() => {
            preview = false;
            offScreenTimer = null;
          }, STOP_DEBOUNCE_MS);
        } else if (offScreenTimer !== null) {
          // Came back into focus within the debounce window --
          // cancel the pending stop.
          clearTimeout(offScreenTimer);
          offScreenTimer = null;
        }
      },
      { threshold: [0, STOP_INTERSECTION_RATIO] }
    );
    observer.observe(sectionEl);
    return () => {
      observer.disconnect();
      if (offScreenTimer !== null) clearTimeout(offScreenTimer);
    };
  });

  // ── Top-K scroller fade edges ──
  // Reuses the dashboard InferencePanel's pattern: a 28 px mask
  // gradient is applied to whichever edge has hidden content past
  // it (top edge if scrolled down, bottom edge if there's more
  // below).  The CSS classes `fade-edge-top` / `fade-edge-bottom`
  // live in app.css and handle all three states (top only, bottom
  // only, both) via the combined `.fade-edge-top.fade-edge-bottom`
  // rule.  We just toggle the classes based on scroll geometry.
  //
  // The dashboard wires this via `onMount` because its scroller is
  // always mounted.  The deploy preview's scroller is conditional
  // (`{#if preview}`), so we wire via `$effect` reacting to
  // `scrollEl`'s bind -- when the element mounts (preview turns
  // on) the effect fires and registers listeners; when the element
  // unmounts (preview turns off) the effect's cleanup tears them
  // down.  Same lifecycle Svelte's onMount provides, but bound to
  // the inner element's mount rather than the component's.
  let scrollEl = $state<HTMLDivElement | undefined>();
  let canScrollUp = $state(false);
  let canScrollDown = $state(false);

  function updateFades(el: HTMLDivElement): void {
    canScrollUp = el.scrollTop > 0;
    // `- 1` absorbs sub-pixel rounding -- at exact bottom,
    // scrollTop + clientHeight can round to a value one px short
    // of scrollHeight on some platforms, which would otherwise
    // leave the bottom fade stuck on at rest.
    canScrollDown = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }

  // Re-measure on every Top-K update: a class list that shrinks
  // below the pane height should drop both fades; one that grows
  // past the height should surface the bottom fade.  `queueMicrotask`
  // defers the measurement to after Svelte has flushed the DOM
  // update for the new rows, so `scrollHeight` reflects the new
  // content.
  $effect(() => {
    void streams.latestTopK;
    const el = scrollEl;
    if (!el) return;
    queueMicrotask(() => updateFades(el));
  });

  // Mount/unmount wiring keyed on `scrollEl`.  Listens for scroll
  // events (the operator scrolling through a long top-k) and
  // ResizeObserver events (the pane resizing, e.g. when the
  // window is resized while the preview is on).  Both feed
  // `updateFades`; an initial call seeds the state for the
  // current scroll position.
  $effect(() => {
    const el = scrollEl;
    if (!el) return;
    const onScroll = (): void => updateFades(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => updateFades(el));
    ro.observe(el);
    updateFades(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  });
</script>

<!-- Compact pane card matching the dataset module's InputPane /
     SlicePane chrome: `rounded-md` (not -xl), no `shadow-sm`,
     `px-3 pt-1.5 pb-3` outer padding, `h-full` so the section
     fills the parent grid cell's `h-80` budget.
     `bind:this={sectionEl}` anchors the IntersectionObserver
     auto-stop watcher. -->
<section
  bind:this={sectionEl}
  class="flex h-full min-h-0 flex-col rounded-md border border-zinc-200 bg-white px-3 pt-1.5 pb-3"
>
  <!-- Header rhythm matches InputPane / SlicePane: `min-h-4.75`
       (19 px) locks the heading-row height even when the optional
       fps + status chrome is absent in the off-state, so the
       heads card and preview card share the same heading-bottom
       strip across the side-by-side row.  `mb-1.5` is the
       standard pane-header → body gap.

       The header carries only ambient indicators (fps + socket
       status, both fade in/out with the preview state); no
       manual toggle button.  Stop is auto-managed via the
       IntersectionObserver (see script).  Start is auto-managed
       via the `config.active.activation_id` watcher and exposed
       manually via the big CTA in the off-state below. -->
  <header class="mb-1.5 flex min-h-4.75 items-center justify-between gap-1.5">
    <div class="flex items-baseline gap-1.5">
      <h4 class="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Preview</h4>
      {#if preview}
        <!-- FPS reading in the dashboard meta-text idiom: plain
             muted mono text, no chip chrome.  Mirrors the
             dashboard InferencePanel's "{fps.toFixed(1)} Hz" so
             the same metric reads identically across both
             surfaces.  Mono + `tabular-nums` keeps the digit
             column stable under fluctuating rate; only visible
             when the preview is live so a stale "0.0 Hz" never
             dangles against a paused renderer. -->
        <span
          in:fade={{ duration: 160, easing: cubicOut }}
          out:fade={{ duration: 140, easing: cubicOut }}
          class="font-mono text-[10px] text-zinc-400 tabular-nums"
        >
          {streams.inferenceFps.toFixed(1)} Hz
        </span>
      {/if}
    </div>
    {#if preview}
      <!-- Socket status pill.  `rounded-full px-2 py-0.5 text-[11px]`
           is the canonical state-indicator pill shape -- same as the
           dashboard InferencePanel's pill so a "live" / "connecting"
           / "disconnected" state reads identically across the deploy
           preview and the dashboard.  Fully-rounded ends carry the
           "this is a status, not an action chip" semantic; the
           neighbouring fps chip stays `rounded-md` because it's a
           metric readout, not a state.  Fades in with the preview,
           fades out on auto-stop -- no abrupt pill-disappearance
           when the IntersectionObserver tears down the preview. -->
      <span
        in:fade={{ duration: 160, easing: cubicOut }}
        out:fade={{ duration: 140, easing: cubicOut }}
        class="rounded-full px-2 py-0.5 text-[11px] font-medium capitalize tracking-wide transition-colors duration-200 {socketPillClass(
          streams.inferStatus
        )}"
      >
        {SOCKET_LABEL[streams.inferStatus]}
      </span>
    {/if}
  </header>

  {#if preview}
    <!-- Spectrogram + top-k stack.  Spectrogram is a *fixed*-height
         strip (`h-24` = 96 px, `shrink-0`) -- a confirmation
         readout ("audio is flowing through the head") rather than
         the dashboard's full monitoring surface, so a thin strip
         carries the signal at much lower vertical cost.  Top-K
         takes the remaining body height via `flex-1`, which gives
         the actionable readout (which classes are firing) the
         larger share.  `min-h-0` on the top-k wrapper lets the
         scroller clip its content when the class list exceeds the
         pane height.  `-mr-1` reclaims the scrollbar inset so the
         visible right edge still aligns with the section's `px-3`.

         Fade edges (`fade-edge-top` / `fade-edge-bottom`) appear
         only on the side where content is hidden past the edge --
         the operator's scan target is "is there more above /
         below this fold".  Toggled by the script's scroll +
         resize observers; CSS lives in app.css and is shared with
         the dashboard's InferencePanel so the same affordance
         reads identically across both surfaces. -->
    <div class="flex min-h-0 flex-1 flex-col gap-2">
      <div class="h-24 shrink-0">
        <SpectrogramCanvas seconds={3} />
      </div>
      <div
        bind:this={scrollEl}
        class="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1"
        class:fade-edge-top={canScrollUp}
        class:fade-edge-bottom={canScrollDown}
      >
        <TopKMeter />
      </div>
    </div>
  {:else}
    <!-- Off state.  The placeholder occupies the same vertical
         budget so toggling doesn't reflow the side-by-side row.
         Dashed border + zinc-50 background mirrors EmptyState so
         the affordance reads as "intentionally empty, awaiting
         operator action". -->
    <div
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-zinc-300 bg-zinc-50/60 px-6 py-8 text-center"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        class="h-8 w-8 text-zinc-400"
        aria-hidden="true"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 19V6l11 7-11 6zM4 4v16" />
      </svg>
      <div class="min-w-0">
        <p class="text-sm font-medium text-zinc-700">Preview is off</p>
        <p class="mt-1 text-xs text-zinc-500">
          Start the preview to watch the deployed head's spectrogram and top-k stream.
        </p>
      </div>
      <!-- Manual start: the only operator-driven entry point.
           Auto-stop (IntersectionObserver) handles teardown; the
           operator never needs a paired manual stop affordance. -->
      <button
        type="button"
        onclick={() => (preview = true)}
        class="mt-1 inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-blue-500 bg-blue-500 px-3.5 py-1.5 text-sm font-medium text-white transition hover:border-blue-600 hover:bg-blue-600"
      >
        Start preview
      </button>
    </div>
  {/if}
</section>
