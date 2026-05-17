<script lang="ts">
  import { fade } from 'svelte/transition';
  import { config } from '$lib/stores/config.svelte';
  import type { MicPolicy } from '$lib/api/types';
  import Spinner from '$lib/components/Spinner.svelte';

  // The daemon's hop_samples contract is `SR*(1 - MAX_OVERLAP)..=SR` =
  // `11_025..=44_100` at 44.1 kHz; exposing the slider as
  // `overlap = hop / SR` gives the operator a dimension-free 0.25..1.0
  // knob that maps directly to cadence = 1 / overlap (4..1 Hz).
  const CAPTURE_SAMPLE_RATE = 44_100;
  const OVERLAP_MIN = 0.25;
  const OVERLAP_MAX = 1.0;
  const TOPK_MIN = 1;
  const TOPK_MAX = 20;

  function overlapToHop(o: number): number {
    return Math.round(o * CAPTURE_SAMPLE_RATE);
  }
  // cadence Hz = SR / hop = 1 / overlap (4..1 Hz across the slider range).
  function approxHz(o: number): string {
    const hz = 1 / Math.max(0.001, o);
    if (hz >= 10) return `${hz.toFixed(0)} Hz`;
    if (hz >= 1) return `${hz.toFixed(1)} Hz`;
    return `${hz.toFixed(2)} Hz`;
  }

  function formatRate(rate: unknown): string | null {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
    if (rate >= 1000) {
      const khz = rate / 1000;
      return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
    }
    return `${rate} Hz`;
  }

  function formatSourceKind(kind: string): string {
    if (kind === 'alsa') return 'ALSA';
    if (!kind) return 'unknown';
    return kind[0].toUpperCase() + kind.slice(1).replaceAll('_', ' ');
  }

  function sourceLabel(cand: (typeof candidates)[number]): string {
    const kind = formatSourceKind(cand.source.kind);
    const detail =
      cand.source.kind === 'alsa' ? cand.source.hw_spec : formatRate(cand.source.sample_rate);
    return [cand.id, kind, detail].filter(Boolean).join(' · ');
  }

  // Source select holds 'auto' (= first_available) or a candidate id (=
  // fixed device); channel select holds 'auto' or a stringified channel.
  // Collapsing the policy's two-field shape into a single dropdown keeps
  // the form intrinsically stable -- no rows appearing on toggle.
  let sourceSel = $state<string>('auto');
  let channelSel = $state<string>('auto');

  // Slider knob; round-tripped via `hop_samples = round(overlap * SR)`.
  let overlap = $state(0.5);
  let topK = $state(3);

  // While true the section's controls are disabled (blocks a rapid
  // re-fire racing the in-flight request) and a spinner appears next
  // to the heading.  Cleared after MIN_APPLY_MS at the earliest.
  let micApplying = $state(false);
  let inferApplying = $state(false);

  // Sync local form state from canonical config: fires on initial
  // load, auto-reconnect refresh, and successful auto-apply.  On apply
  // failure config.mic is unchanged so this effect is a no-op and the
  // catch in autoApplyMic snaps the form back via revertMic().
  $effect(() => {
    const m = config.mic;
    if (!m) return;
    sourceSel = m.policy.mic.kind === 'fixed' ? m.policy.mic.id : 'auto';
    channelSel = m.policy.channel.kind === 'fixed' ? String(m.policy.channel.channel) : 'auto';
  });

  $effect(() => {
    const c = config.inference;
    if (!c) return;
    overlap = c.hop_samples / CAPTURE_SAMPLE_RATE;
    topK = c.top_k;
  });

  let candidates = $derived(config.mic?.catalogue.candidates ?? []);

  let channelOptions = $derived.by(() => {
    const m = config.mic;
    if (!m) return [] as number[];
    const targetId = sourceSel === 'auto' ? (m.catalogue.candidates[0]?.id ?? '') : sourceSel;
    const cand = m.catalogue.candidates.find((c) => c.id === targetId);
    return cand?.channels ?? [];
  });

  // Slider progress -> CSS variable for the track gradient (see app.css).
  let overlapPct = $derived(((overlap - OVERLAP_MIN) / (OVERLAP_MAX - OVERLAP_MIN)) * 100);
  let topKPct = $derived(((topK - TOPK_MIN) / (TOPK_MAX - TOPK_MIN)) * 100);

  // First load failed and config is empty: surface a "daemon unavailable"
  // state instead of an indefinite "loading..." placeholder.  Recovery
  // is driven by the auto-reconnect $effect in +layout.svelte.
  let unavailable = $derived<boolean>(
    (config.mic === null || config.inference === null) && config.error !== null
  );

  // Snap the form back to canonical on apply failure -- otherwise the
  // visible value would linger on the user's failed pick, confusing
  // cause/effect on retry.
  function revertMic(): void {
    const m = config.mic;
    if (!m) return;
    sourceSel = m.policy.mic.kind === 'fixed' ? m.policy.mic.id : 'auto';
    channelSel = m.policy.channel.kind === 'fixed' ? String(m.policy.channel.channel) : 'auto';
  }
  function revertInference(): void {
    const c = config.inference;
    if (!c) return;
    overlap = c.hop_samples / CAPTURE_SAMPLE_RATE;
    topK = c.top_k;
  }

  // ~420 ms floor on the visible "applying" state.  Localhost round-trips
  // are 30-100 ms, well below what any transition needs to play out -- so
  // without a floor the user sees a sub-perceptual flicker (transition
  // reverses before reaching its target) and the spinner stutters.  420 ms
  // is long enough that every motion lands cleanly, short enough that the
  // operator still feels the system is responsive.
  const MIN_APPLY_MS = 420;

  // Awaits `fn`, then pads the total elapsed time to at least MIN_APPLY_MS.
  // Errors propagate through the finally so the caller's revert still runs,
  // but only AFTER the floor -- otherwise the snap-back races the in-flight
  // transition.
  async function applyWithFloor(fn: () => Promise<void>): Promise<void> {
    const start = performance.now();
    try {
      await fn();
    } finally {
      const elapsed = performance.now() - start;
      if (elapsed < MIN_APPLY_MS) {
        await new Promise((r) => setTimeout(r, MIN_APPLY_MS - elapsed));
      }
    }
  }

  async function autoApplyMic(): Promise<void> {
    if (micApplying) return;
    micApplying = true;
    try {
      await applyWithFloor(async () => {
        const policy: MicPolicy = {
          mic:
            sourceSel === 'auto' ? { kind: 'first_available' } : { kind: 'fixed', id: sourceSel },
          channel:
            channelSel === 'auto'
              ? { kind: 'auto' }
              : { kind: 'fixed', channel: Number(channelSel) }
        };
        await config.setMicPolicy(policy);
      });
    } catch {
      revertMic();
    } finally {
      micApplying = false;
    }
  }

  async function autoApplyInference(): Promise<void> {
    if (inferApplying) return;
    inferApplying = true;
    try {
      await applyWithFloor(async () => {
        await config.setInferenceCfg({ hop_samples: overlapToHop(overlap), top_k: topK });
      });
    } catch {
      revertInference();
    } finally {
      inferApplying = false;
    }
  }

  // One static class; the "applying" cue is delivered by the parent
  // wrapper's opacity transition (identical to the slider column), so
  // selects and sliders share one visual vocabulary for in-flight.
  const selectCls =
    'select-chevron block w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs transition-colors hover:border-zinc-300 disabled:cursor-wait disabled:bg-zinc-50 disabled:text-zinc-400 disabled:hover:border-zinc-200';
</script>

<section class="rounded-xl border border-zinc-200 bg-white px-5 pt-3.5 pb-5 shadow-sm">
  <header class="mb-4 flex items-baseline justify-between">
    <h2 class="text-sm font-semibold text-zinc-900">Configuration</h2>
    {#if config.error && !unavailable}
      <span class="truncate text-xs text-rose-700">{config.error}</span>
    {/if}
  </header>

  {#if unavailable}
    <!-- +layout.svelte retries config.refresh on health-level recovery;
         this panel just shows a clear "waiting" message until then. -->
    <div class="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
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
      <div class="min-w-0 text-xs">
        <p class="font-medium text-amber-900">Daemon unavailable</p>
        <p class="mt-0.5 truncate text-amber-800">
          {config.error ?? 'configuration will resume automatically when the daemon is reachable'}
        </p>
      </div>
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-2">
      <!-- Microphone ============================================ -->
      <div class="flex flex-col">
        <h3
          class="mb-3 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase"
        >
          <span>Microphone</span>
          {#if micApplying}
            <span class="inline-flex" in:fade={{ duration: 160 }} out:fade={{ duration: 120 }}>
              <Spinner />
            </span>
          {/if}
        </h3>

        {#if !config.mic}
          <p class="text-xs text-zinc-400">loading…</p>
        {:else}
          <!-- Same opacity-dim treatment as the Inference column.
               Duration / easing tracks the spinner's fade-in (160 ms)
               so the three motions land on the same beat. -->
          <div
            class="space-y-3 transition-opacity duration-150 ease-out"
            class:opacity-60={micApplying}
          >
            <label for="mic-source" class="block text-xs">
              <span class="mb-1 block text-zinc-600">Source</span>
              <select
                id="mic-source"
                name="mic-source"
                bind:value={sourceSel}
                onchange={autoApplyMic}
                disabled={micApplying}
                class={selectCls}
              >
                <option value="auto">auto · first available</option>
                {#each candidates as cand (cand.id)}
                  <option value={cand.id}>{sourceLabel(cand)}</option>
                {/each}
              </select>
            </label>

            <label for="mic-channel" class="block text-xs">
              <span class="mb-1 block text-zinc-600">Channel</span>
              <select
                id="mic-channel"
                name="mic-channel"
                bind:value={channelSel}
                onchange={autoApplyMic}
                disabled={micApplying}
                class={selectCls}
              >
                <option value="auto">auto</option>
                {#each channelOptions as ch (ch)}
                  <option value={String(ch)}>{ch}</option>
                {/each}
              </select>
            </label>
          </div>
        {/if}
      </div>

      <!-- Inference cadence ====================================== -->
      <div class="flex flex-col">
        <h3
          class="mb-3 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase"
        >
          <span>Inference cadence</span>
          {#if inferApplying}
            <span class="inline-flex" in:fade={{ duration: 160 }} out:fade={{ duration: 120 }}>
              <Spinner />
            </span>
          {/if}
        </h3>

        {#if !config.inference}
          <p class="text-xs text-zinc-400">loading…</p>
        {:else}
          <!-- space-y-3 matches the Microphone column so row baselines
               align side-by-side.  Same opacity-dim treatment as the
               Microphone wrapper -- single visual vocabulary for the
               applying state across both columns. -->
          <div
            class="space-y-3 transition-opacity duration-150 ease-out"
            class:opacity-60={inferApplying}
          >
            <!-- Slider row geometry mirrors the Microphone column's
                 `<label>span + select</label>` (16 + mb-1 + 30 = 50 px) so the
                 two columns are intrinsically the same height -- without
                 that, the right column was 3 px taller per row (×2 rows =
                 6 px), the grid stretched both cells to the taller, and the
                 left column's Channel select picked up 6 px of unwanted
                 slack between its bottom and the section's pb-5 edge.
                 `flex flex-col gap-1` replaces the old block + `mt-1`:
                 promoting the input out of inline-replaced-element layout
                 removes the line-box-baseline overhead that block-stacked
                 it 2 px below where its border-box ended.  `items-center`
                 on the header + `leading-4` on the value span force the
                 header flex to a flat 16 px (rather than baseline-aligning
                 ascent boxes of mixed 11 / 12 px text, which pushed the
                 flex to 17 px from the larger ascent of the value span);
                 the small visual shift of the value baseline relative to
                 the label is well below perception (≤0.5 px between SF
                 Pro 11 and 12 px metrics). -->
            <div class="flex flex-col gap-1">
              <div class="flex items-center justify-between">
                <label for="overlap-ratio" class="text-xs text-zinc-600">Overlap Ratio</label>
                <span class="text-[11px] leading-4 text-zinc-500">
                  <span class="font-mono text-zinc-700">{overlap.toFixed(2)}</span>
                  <span class="text-zinc-400">· ≈ {approxHz(overlap)}</span>
                </span>
              </div>
              <input
                id="overlap-ratio"
                type="range"
                min={OVERLAP_MIN}
                max={OVERLAP_MAX}
                step="0.01"
                bind:value={overlap}
                onchange={autoApplyInference}
                disabled={inferApplying}
                style="--slider-percent: {overlapPct}%"
              />
            </div>

            <!-- `-mb-1.75 md:mb-0` compensates for the range input's
                 internal whitespace below the thumb when this slider is
                 the section's last element (stacked layout below `md`).
                 The input is 30 px tall to match the select height, but
                 its visible content (6 px track + 16 px thumb, centered)
                 only spans rows 7–23 within the input box -- the bottom
                 7 px is transparent inside the input's border-box, so the
                 card's `pb-5` measures from a phantom edge and the
                 visible thumb sits 28 px from the card bottom while the
                 track sides sit at 21 px from the card sides.  Pulling
                 the container up by exactly 7 px restores ink-to-edge
                 symmetry on mobile.  At `md+` the grid stretches the
                 right column to row height (which is ≥ this column's
                 intrinsic), so the negative margin gets absorbed into
                 stretch slack -- but `md:mb-0` neutralizes it explicitly
                 so the column intrinsic does not drift below the LEFT
                 column's, which would resurrect the original 6 px slack
                 the previous fix eliminated. -->
            <div class="-mb-1.75 flex flex-col gap-1 md:mb-0">
              <div class="flex items-center justify-between">
                <label for="top-k" class="text-xs text-zinc-600">Top-K</label>
                <span class="font-mono text-[11px] leading-4 text-zinc-700">{topK}</span>
              </div>
              <input
                id="top-k"
                type="range"
                min={TOPK_MIN}
                max={TOPK_MAX}
                step="1"
                bind:value={topK}
                onchange={autoApplyInference}
                disabled={inferApplying}
                style="--slider-percent: {topKPct}%"
              />
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</section>
