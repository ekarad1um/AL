<script lang="ts">
  import EnvelopeWaveform from '$lib/components/EnvelopeWaveform.svelte';
  import type { Recorder } from '$lib/audio/recorder.svelte';

  // Thin wrapper binding the shared `EnvelopeWaveform` renderer
  // to a per-pane `Recorder` instance.  Same engine as the
  // dashboard's WaveformCanvas (which binds to `streams`), so the
  // mic surface and the daemon-stream surface render with one
  // pipeline -- including the renderCursor jitter smoothing
  // documented in [pcm-source.ts](../../audio/pcm-source.ts).
  // Earlier this component had its own canvas + envelope loop
  // wired directly to the recorder's raw `liveTotalSamples`
  // index, which jumped in chunks (worklet posts ~94 Hz vs RAF
  // 60 Hz) and produced a visible step / blink pattern on every
  // chunk arrival; the shared renderer reads through the cursor
  // instead so motion is decoupled from chunk timing.
  interface Props {
    recorder: Recorder;
    seconds?: number;
    color?: string;
    background?: string;
  }
  let { recorder, seconds = 3, color = '#3b82f6', background = '#fafafa' }: Props = $props();
</script>

<EnvelopeWaveform source={recorder} {seconds} {color} {background} />
