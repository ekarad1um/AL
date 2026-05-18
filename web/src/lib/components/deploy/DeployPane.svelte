<script lang="ts">
  import { fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { config as configStore } from '$lib/stores/config.svelte';
  import HeadsTable from './HeadsTable.svelte';
  import InferencePreview from './InferencePreview.svelte';
  import ConfigurationControls from '$lib/components/dashboard/ConfigurationControls.svelte';
  import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
  import type { HeadRecord, Uuid } from '$lib/api/types';

  // Workspace-scoped deploy module.  Owns the operator-facing
  // surface for swapping a trained head into the inference
  // pipeline, watching the live stream (opt-in), and tuning the
  // pipeline's input device + cadence.  Layout:
  //
  //   ┌─ Deploy ──────────────────────────────────────────────┐
  //   │ Deploy                                       <pill>    │
  //   │ <one-line description>                                 │
  //   │                                                        │
  //   │ ┌─ Heads ─────────┐ ┌─ Preview ───────────────────┐    │
  //   │ │ [head rows]     │ │ [off-state placeholder]     │    │
  //   │ │ default row     │ │ or [spectrogram + topK]     │    │
  //   │ └─────────────────┘ └─────────────────────────────┘    │
  //   │                                                        │
  //   │ ▸ Input & Inference config  [freq 2 Hz] [top-k 3]      │
  //   └────────────────────────────────────────────────────────┘
  //
  // Side-by-side panels lock to `h-80` (320 px) so the row height
  // is intrinsically stable: starting / stopping the preview
  // doesn't reflow the heads table next to it, and adding rows to
  // a long heads list scrolls internally instead of pushing the
  // configuration disclosure further down.

  interface Props {
    workspaceId: Uuid;
    heads: readonly HeadRecord[];
    liveRevision: number;
    onchanged: () => Promise<void> | void;
  }
  let { workspaceId, heads, liveRevision, onchanged }: Props = $props();

  const active = $derived(configStore.active);

  // Header-pill state vocabulary.  Every state maps to a one-word
  // label so the badge reads as a stable identity primitive --
  // wider strings ("Deployed elsewhere", "Deployed here") forced
  // the eye to re-parse on every transition; one word lets the
  // colour + the slot-machine motion carry the change.
  //
  // States (all four resolve to a single token visible in the pill):
  //   - 'workspace-deployed' → 'Deployed' (blue):  this workspace's
  //     trained head is the runtime head.  Operator's normal state
  //     when working in the workspace they just trained against.
  //   - 'default'            → 'Default'  (zinc):  the daemon-bundled
  //     default head is running.
  //   - 'elsewhere'          → 'Standby'  (amber): a head from a
  //     DIFFERENT workspace is the runtime.  "Standby" reads as
  //     "this workspace is ready to be deployed but isn't right now"
  //     -- captures the operator's relationship to the runtime
  //     rather than just naming the runtime's source ("Elsewhere"
  //     said where, "Standby" says what role).
  //   - 'detached'           → 'Detached' (amber, deeper): the
  //     active head's source workspace has been deleted (orphaned
  //     runtime).  Mirrors the dashboard ActiveHeadCard so the same
  //     state reads the same word across both surfaces.
  //   - 'unknown':            `config.active` hasn't landed yet
  //     (first-load / daemon-unreachable race).  Pill suppressed.
  type DeployState = 'workspace-deployed' | 'default' | 'elsewhere' | 'detached' | 'unknown';

  const deployState = $derived.by<DeployState>(() => {
    const a = active;
    if (a === null) return 'unknown';
    if (a.origin === 'default') return 'default';
    if (a.source_workspace_alive === false) return 'detached';
    return a.source_workspace_id === workspaceId ? 'workspace-deployed' : 'elsewhere';
  });

  const pillCopy = $derived<{ label: string; title: string; tone: string } | null>(
    deployState === 'workspace-deployed'
      ? {
          label: 'Deployed',
          title: 'A head trained in this workspace is the runtime head.',
          tone: 'bg-blue-100 text-blue-800'
        }
      : deployState === 'default'
        ? {
            label: 'Default',
            title: 'The daemon-bundled default head is running.',
            tone: 'bg-zinc-200 text-zinc-700'
          }
        : deployState === 'elsewhere'
          ? {
              label: 'Standby',
              title:
                'A head from a different workspace is the runtime head. This workspace is on standby; deploying one here will replace it.',
              tone: 'bg-amber-100 text-amber-900'
            }
          : deployState === 'detached'
            ? {
                label: 'Detached',
                title:
                  'The workspace that produced the runtime head was deleted; the head is still running.',
                tone: 'bg-amber-200 text-amber-900'
              }
            : null
  );

  // Configuration disclosure.  Closed by default per the spec --
  // the operator's mainline action here is "deploy a head", not
  // "tune cadence".  The disclosure mirrors TrainPane's
  // hyperparameters pattern (grid-rows 0fr ↔ 1fr animation, chevron
  // rotation, `inert` on the collapsed body) so the deploy module
  // shares one disclosure vocabulary with training.  Labelled
  // "Input & Inference config" -- explicitly names both halves of
  // the body (mic input on top, inference cadence below) so the
  // collapsed-state label tells the operator what the controls are
  // for even without expanding.  The chip row carries the live
  // values of the two operator-relevant inference parameters.
  let configOpen = $state(false);

  // Daemon's capture rate; matches `CAPTURE_SAMPLE_RATE` in
  // `ConfigurationControls.svelte` so chip-displayed cadence reads
  // identically to the slider readout when the operator expands
  // the panel.  Kept as a const here (not imported) to avoid a
  // cross-component dependency for a single number; if the daemon
  // ever ships configurable sample rates, this lifts to a single
  // source of truth.
  const CAPTURE_SAMPLE_RATE = 44_100;

  // Summary chips shown to the right of the disclosure label when
  // collapsed.  Two chips only -- inference cadence + top-k --
  // because the operator's at-a-glance interest at the deploy
  // surface is "how fast / how many" not "which mic" (the mic
  // controls live behind the disclosure for the rare occasion the
  // operator needs to change them; their values aren't worth a
  // chip's worth of visual budget here).  Cadence is shown as Hz
  // (operator-facing: "how often does the head fire") rather than
  // the technical hop-samples knob.  Format prefixes ("freq …",
  // "top-k …") match the slider labels inside the body so the
  // mental mapping chip↔control is one-to-one.
  const configChips = $derived.by<string[]>(() => {
    const inf = configStore.inference;
    if (!inf) return [];
    const hz = CAPTURE_SAMPLE_RATE / Math.max(1, inf.hop_samples);
    const hzStr = hz >= 10 ? hz.toFixed(0) : hz >= 1 ? hz.toFixed(1) : hz.toFixed(2);
    return [`freq ${hzStr} Hz`, `top-k ${inf.top_k}`];
  });
</script>

<section class="rounded-xl border border-zinc-200 bg-white px-5 pt-3.5 pb-5 shadow-sm">
  <header class="mb-4 flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-sm font-semibold text-zinc-900">Deploy</h2>
      <p class="mt-0.5 text-xs text-zinc-500">Hot-swap a trained head into live inference.</p>
    </div>
    {#if pillCopy}
      <!-- StatusBadge orchestrates the slot-machine word flip +
           colour morph internally; the parent only feeds it new
           props on state change.  The wrapper carries `shrink-0`
           so the badge never gets squeezed against the header
           description when the viewport narrows. -->
      <span class="shrink-0">
        <StatusBadge label={pillCopy.label} tone={pillCopy.tone} title={pillCopy.title} />
      </span>
    {/if}
  </header>

  <!-- Side-by-side row.  Stacks below `lg` to a single column so
       narrow viewports keep both surfaces fully usable (the preview
       is opt-in regardless, but its placeholder is still legible
       below the heads table on mobile).  Both cells pin to `h-80`
       (320 px / 20 rem) -- matches the dataset accordion's
       `min-h-80` floor so the three workspace sections (dataset,
       train, deploy) share a single height rhythm.  Deliberately
       shorter than the dashboard's `--vis-panel-h` (434 px): the
       deploy pane is an action surface (deploy a head, glance at
       the result), not a monitoring surface, so the compact
       budget reflects the lower visual-density need.  HeadsTable
       + InferencePreview each own a `<section>` inside that uses
       `h-full` to fill the cell.  Same contract the dataset
       accordion uses for InputPane + SlicePane: the parent sets
       row width / height, the panes own their own chrome. -->
  <div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
    <!-- 3/5 width for the heads list at lg+: the headroom matters
         because each row has two trailing buttons (Deploy / Delete)
         that wrap on narrow widths.  Preview is 2/5 -- enough for
         a thin spectrogram strip + the top-k readout without
         crowding. -->
    <div class="h-80 lg:col-span-3">
      <!-- `{#key workspaceId}` forces a fresh HeadsTable instance on
           workspace swap (same-route navigation between
           /workspace/<a> and /workspace/<b> reuses this page
           component, so without keying, HeadsTable's internal
           $state -- previousActive, busyHeadId, deployingDefault,
           deployError, deleteOpen -- would leak from one workspace
           into the next.  Keying tears down the prior instance
           cleanly; the global config store updates from any
           in-flight deploy still land on configStore.active. -->
      {#key workspaceId}
        <HeadsTable {workspaceId} {heads} {liveRevision} {onchanged} />
      {/key}
    </div>
    <div class="h-80 lg:col-span-2">
      <InferencePreview />
    </div>
  </div>

  <!-- Configuration disclosure.  Same grid-rows trick as
       TrainPane's hyperparameter disclosure so the body mounts
       once and animates open/close without losing form state. -->
  <div class="rounded-md border border-zinc-200 bg-zinc-50/60">
    <button
      type="button"
      onclick={() => (configOpen = !configOpen)}
      aria-expanded={configOpen}
      aria-controls="deploy-config-panel"
      class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-zinc-50"
    >
      <span class="flex min-w-0 items-center gap-2">
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          class="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-200"
          class:translate-y-px={!configOpen}
          class:rotate-90={configOpen}
        >
          <path
            fill-rule="evenodd"
            d="M7.21 5.23a.75.75 0 011.06.02L12 9l-3.73 3.71a.75.75 0 11-1.06-1.06L9.94 9 7.19 6.29a.75.75 0 01.02-1.06z"
            clip-rule="evenodd"
          />
        </svg>
        <span class="text-xs font-medium text-zinc-700">Input &amp; Inference config</span>
      </span>
      {#if !configOpen}
        <!-- Summary chips: glance-scannable snapshot of the
             two operator-relevant inference parameters (cadence
             + top-k).  Same visual idiom as TrainPane's
             hyperparameter chips (rounded-full bg-white + ring,
             mono text-[10px]) so the two disclosures speak the
             same chip vocabulary across the deploy + train
             surfaces.  Hidden below `sm` so narrow viewports show
             just the label and the chevron. -->
        <span
          in:fade={{ duration: 180, easing: cubicOut }}
          class="hidden shrink-0 flex-wrap items-center justify-end gap-1 sm:flex"
          aria-hidden="true"
        >
          {#each configChips as chip (chip)}
            <span
              class="inline-flex items-center rounded-full bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 ring-1 ring-zinc-200"
            >
              {chip}
            </span>
          {/each}
        </span>
      {/if}
    </button>
    <div
      id="deploy-config-panel"
      class="grid transition-[grid-template-rows] duration-200 ease-out"
      class:grid-rows-[1fr]={configOpen}
      class:grid-rows-[0fr]={!configOpen}
    >
      <div class="min-h-0 overflow-hidden" inert={!configOpen} aria-hidden={!configOpen}>
        <div class="border-t border-zinc-200 bg-white px-4 py-4">
          <ConfigurationControls />
        </div>
      </div>
    </div>
  </div>
</section>
