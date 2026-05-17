<script lang="ts">
  import { onMount } from 'svelte';
  import { streams } from '$lib/stores/streams.svelte';
  import TopKMeter from './TopKMeter.svelte';
  import ActiveHeadCard from './ActiveHeadCard.svelte';
  import { SOCKET_LABEL, socketPillClass } from './socketPill';

  // Scroll-aware fade edges: the mask only applies on the side where
  // additional rows are hidden, so a tight list shows no fade at all and
  // an overflowing one cues the operator that more is available.
  let scrollEl = $state<HTMLDivElement | undefined>();
  let canScrollUp = $state(false);
  let canScrollDown = $state(false);

  function updateFades(el: HTMLDivElement): void {
    canScrollUp = el.scrollTop > 0;
    canScrollDown = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }

  $effect(() => {
    // Re-measure whenever the Top-K list changes shape.
    void streams.latestTopK;
    const el = scrollEl;
    if (!el) return;
    queueMicrotask(() => {
      updateFades(el);
    });
  });

  onMount(() => {
    const el = scrollEl;
    if (!el) return;
    const onScroll = (): void => {
      updateFades(el);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      updateFades(el);
    });
    ro.observe(el);
    updateFades(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  });
</script>

<!-- Same `--vis-panel-h` lock as Visualization at every breakpoint.
     At `lg+` we still share the grid row; at `<lg` we stack but want
     the same vertical budget so the Top-K scroller / Active Head card
     layout doesn't reflow with viewport width. -->
<section
  class="flex h-(--vis-panel-h) flex-col rounded-xl border border-zinc-200 bg-white px-5 pt-3.5 pb-5 shadow-sm"
>
  <!-- Mirrors Visualization's header: title + meta caption left, status
       pill right.  font-mono on Hz prevents digit-width jitter as the
       rate fluctuates. -->
  <header class="mb-3 flex items-center justify-between gap-3">
    <div class="flex items-baseline gap-2">
      <h2 class="text-sm font-semibold text-zinc-900">Inference</h2>
      <span class="font-mono text-[11px] text-zinc-400">{streams.inferenceFps.toFixed(1)} Hz</span>
    </div>
    <span
      class="rounded-full px-2 py-0.5 text-[11px] font-medium capitalize tracking-wide transition-colors duration-200 {socketPillClass(
        streams.inferStatus
      )}"
    >
      {SOCKET_LABEL[streams.inferStatus]}
    </span>
  </header>

  <!-- The section is fixed to `--vis-panel-h` at lg+ (matches Vis).
       Inside that height, the Top-K wrapper takes `flex-1 min-h-0
       overflow-y-auto`: flex-1 absorbs the slack after header + active
       head, min-h-0 lets the scroller clip its content so Top-K count
       or head-origin changes never resize the panel. -->
  <div
    bind:this={scrollEl}
    class="min-h-0 flex-1 overflow-y-auto pr-1"
    class:fade-edge-top={canScrollUp}
    class:fade-edge-bottom={canScrollDown}
  >
    <TopKMeter />
  </div>

  <div class="pt-4">
    <ActiveHeadCard />
  </div>
</section>
