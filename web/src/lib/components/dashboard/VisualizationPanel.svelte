<script lang="ts">
  import { streams } from '$lib/stores/streams.svelte';
  import WaveformCanvas from './WaveformCanvas.svelte';
  import SpectrogramCanvas from './SpectrogramCanvas.svelte';
  import { SOCKET_LABEL, socketPillClass } from './socketPill';
</script>

<section
  class="flex h-full flex-col rounded-xl border border-zinc-200 bg-white p-5 shadow-sm lg:h-(--vis-panel-h)"
>
  <!-- Metadata folds into the header so the bottom edge sits at exactly
       p-5 -- a separate footer pushed it to ~48 px and broke corner
       symmetry. -->
  <header class="mb-3 flex items-center justify-between gap-3">
    <div class="flex items-baseline gap-2">
      <h2 class="text-sm font-semibold text-zinc-900">Visualization</h2>
      <span class="text-[11px] text-zinc-400">48 kHz · mono · opus · 3 s window</span>
    </div>
    <span
      class="rounded-full px-2 py-0.5 text-[11px] font-medium capitalize tracking-wide transition-colors duration-200 {socketPillClass(
        streams.audioStatus
      )}"
    >
      {SOCKET_LABEL[streams.audioStatus]}
    </span>
  </header>

  <!-- Waveform + spectrogram split the remaining height evenly via
       `flex-1 min-h-0`.  The panel's outer height is pinned to
       `--vis-panel-h` (see app.css), so the two children always sum to
       the same budget -- only the internal distribution changed (from a
       fixed 128/224 px split to 50/50).  `min-h-0` lets the canvases
       shrink below their intrinsic size so flex actually distributes,
       and `gap-2` replaces `space-y-2` to keep the gap outside the
       flex sizing math. -->
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <div class="min-h-0 flex-1">
      <WaveformCanvas seconds={3} />
    </div>
    <div class="min-h-0 flex-1">
      <SpectrogramCanvas seconds={3} />
    </div>
  </div>
</section>
