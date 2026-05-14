<script lang="ts">
  import { streams } from '$lib/stores/streams.svelte';
  import EnvelopeWaveform from '$lib/components/EnvelopeWaveform.svelte';

  // Thin wrapper that binds the shared `EnvelopeWaveform`
  // renderer to the dashboard's `streams` `PcmSource`.  The
  // recorder waveform is the same component bound to a `Recorder`
  // instance instead -- one code path for both surfaces.
  interface Props {
    seconds?: number;
    color?: string;
    background?: string;
  }
  let { seconds = 3, color = '#3b82f6', background = '#fafafa' }: Props = $props();
</script>

<EnvelopeWaveform source={streams} {seconds} {color} {background} />
