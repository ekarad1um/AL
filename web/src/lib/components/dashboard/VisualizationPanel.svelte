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

  <!-- h-32 + h-56 are the source of the `--vis-panel-h` budget in
       app.css (434 px total).  Don't bump these without updating the
       variable.  The split also keeps the spectrogram visually dominant
       so p-5 reads balanced. -->
  <div class="space-y-2">
    <div class="h-32">
      <WaveformCanvas seconds={3} />
    </div>
    <div class="h-56">
      <SpectrogramCanvas seconds={3} />
    </div>
  </div>
</section>
