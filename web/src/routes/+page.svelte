<script lang="ts">
  import { streams } from '$lib/stores/streams.svelte';
  import VisualizationPanel from '$lib/components/dashboard/VisualizationPanel.svelte';
  import InferencePanel from '$lib/components/dashboard/InferencePanel.svelte';
  import ConfigurationPanel from '$lib/components/dashboard/ConfigurationPanel.svelte';

  // The dashboard is the canonical streams consumer: every panel
  // below reads either the PCM ring (Waveform/Spectrogram) or the
  // reactive top-k / fps fields (Inference panel).  Acquiring at
  // the page level (rather than from each panel) keeps the worker
  // alive across the panels' independent mount cycles and tears it
  // down on route exit.  Returning the dispose closure directly
  // from the effect lets Svelte 5 run it as cleanup on destroy.
  //
  // `$effect.pre` (not plain `$effect`): the panel pills below
  // (VisualizationPanel's `audioStatus`, InferencePanel's
  // `inferStatus`) read the status fields synchronously during
  // their first render.  With post-DOM `$effect`, the children
  // would paint one frame of "disconnected" red before this
  // effect fires `acquire()` → `connectClient()` and the
  // optimistic `'connecting'` write reaches them on the next
  // flush.  `$effect.pre` runs BEFORE the children mount, so
  // status is already `'connecting'` by the time the pills paint.
  $effect.pre(() => streams.acquire());
</script>

{#if streams.unsupportedReason}
  <div class="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
    <p class="font-medium">Limited browser support</p>
    <p class="mt-1 text-xs">{streams.unsupportedReason}</p>
  </div>
{/if}

<div class="space-y-5">
  <div class="grid grid-cols-1 gap-5 lg:grid-cols-3">
    <div class="lg:col-span-2">
      <VisualizationPanel />
    </div>
    <div class="lg:col-span-1">
      <InferencePanel />
    </div>
  </div>

  <ConfigurationPanel />
</div>
