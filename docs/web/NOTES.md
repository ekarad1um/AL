# AcousticsLab Frontend — Design-System Notes

A running record of the non-obvious design and engineering decisions taken
while iterating on the Dashboard surface. Companion to
[`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`PLAN.md`](./PLAN.md).

## Type & casing hierarchy

The app uses a four-tier casing hierarchy. Mixing tiers inside one surface
is a smell.

| Tier                  | Style                                 | Examples                                         |
| --------------------- | ------------------------------------- | ------------------------------------------------ |
| Brand                 | PascalCase                            | `AcousticsLab`                                   |
| Top-level navigation  | Title Case                            | `Dashboard`, `Workspace`, `Converter`            |
| Panel titles (`h2`)   | Title Case                            | `Visualization`, `Inference`, `Configuration`    |
| Section labels (`h3`) | `UPPERCASE` + `tracking-wider` + 11px | `MICROPHONE`, `INFERENCE CADENCE`, `ACTIVE HEAD` |
| Form labels           | Sentence case                         | `Source`, `Channel`, `Overlap Ratio`, `Top-K`    |
| Body / status         | lowercase                             | `live`, `connecting`, `healthy`, `default`       |
| Pills                 | source lowercase + CSS `capitalize`   | renders as `Live`, `Healthy`, `Default`          |

**Pills are special**: the source data stays lowercase (`'live'`,
`'default'`) and `text-transform: capitalize` does the rendering. This
avoids duplicating string-formatting logic on every site that emits a
status.

## Label normalization

Backend labels follow the Speech-Commands convention of marking synthetic
classes with surrounding underscores: `_unknown_`, `_background_noise_`.
The wire format is treated as data; the display layer normalises it via
the shared `prettyCategoryName()` in
[`labels.ts`](../../web/src/lib/components/category/labels.ts), used by
both the dataset accordion and the dashboard's `TopKMeter`:

```ts
// Strip outer `_` / `-`, split on `_` / `-` / whitespace, uppercase.
// _unknown_          -> "UNKNOWN"
// _background_noise_ -> "BACKGROUND NOISE"
// stop               -> "STOP"
// my-class_42        -> "MY CLASS 42"
```

UPPERCASE rendering reads as a label (banner / chip), not a shell
identifier, and gives the dataset row header, the top-K meter row,
and the slice card label a consistent visual weight regardless of
on-disk casing. The raw label still lives in the `title` attribute
for engineers inspecting via devtools.

## Corner radius and padding scale

A coherent scale (every value is a multiple of 4px) keeps the optical
rhythm consistent across nested surfaces:

| Surface         | Radius              | Padding               | Ratio        | Notes                                   |
| --------------- | ------------------- | --------------------- | ------------ | --------------------------------------- |
| Top-level panel | `rounded-xl` (12px) | `p-5` (20px)          | 1.67×        | Visualization, Inference, Configuration |
| Nested card     | `rounded-lg` (8px)  | `p-3.5` (14px)        | 1.75×        | Active Head card                        |
| Form control    | `rounded-md` (6px)  | `px-2.5 py-1.5`       | 1.67H / 1.0V | Selects                                 |
| Action button   | `rounded-md` (6px)  | `px-3.5 py-1.5`       | 2.33H / 1.0V | Apply buttons                           |
| Pill            | `rounded-full`      | `px-2 py-0.5`         | —            | Status, origin                          |
| Outer rhythm    | —                   | `gap-5` / `space-y-5` | 20px gap     | Matches panel interior padding          |

**Why padding ≥ ~1.5× radius matters**: with `p-4` (16px) + `rounded-xl`
(12px), the corner curve consumes 12 of the 16px padding area, leaving
only 4px of straight padding before the curve starts. Content near the
corner reads as _tighter_ than content near the edges — uneven optical
density. Pushing the ratio to 1.5–2.0× gives the curve room to sit
_within_ the padding rather than dominating it, so all four sides of a
content corner feel evenly cushioned.

**Why the cross-card padding ratio is identical (1.67×)**: the three
top-level panels live side-by-side; matching their interior breathing
room makes the row read as one composition instead of three slightly
different boxes.

**Why nested cards use a slightly higher ratio (1.75×)**: a deeper
hierarchy level should feel _slightly_ more contained than its parent.
Pushing nested ratio higher than the parent reads as "this is a card
inside a card" without explicit borders shouting about it.

**Why outer whitespace == panel padding (`gap-5` == `p-5`)**: the eye
reads consistent whitespace as continuous; mismatched gaps make the
layout feel grid-defined rather than card-defined.

## Squircle corners, selectively

`*, *::before, *::after { corner-shape: squircle }` is applied
globally as a progressive enhancement (Chrome 139+, Firefox in progress
as of May 2026; older browsers silently fall back to circular curves).

Pills are exempted: `corner-shape: round` on `.rounded-full` and on the
slider track/thumb pseudo-elements. At max-radius, a squircle's
slightly-flatter cap subtly breaks the established "pill" identity.
The same exception applies to the Top-K bar's outer container.

The visible-but-not-shouting payoff is on top-level panels:
`border-radius: 12px` + `corner-shape: squircle` gives an iOS-style
soft corner instead of a circular arc.

## Sliders

A custom-rendered control replaces the native chrome to keep
Chromium/Firefox identical:

- **Height** `1.875rem` (30px) — matches the height of a
  `text-xs / py-1.5 / 1px-border` select so a slider and a select on
  adjacent rows share baselines.
- **Track** 6px tall, zinc-200, `rounded-full`.
- **Filled portion** blue-500, painted by a two-stop linear gradient on
  `::-webkit-slider-runnable-track` keyed off a CSS custom property
  `--slider-percent` that the Svelte component computes from `(value -
min) / (max - min)`. Firefox uses the dedicated
  `::-moz-range-progress` pseudo and ignores the variable.
- **Thumb** 16px diameter, blue-500, 2px white border, soft shadow.
  Centered on the track via `margin-top: -(thumb_h - track_h) / 2`,
  which by coincidence is `-5px` at both the 4/14 and 6/16 pairings —
  if the ratio changes the formula travels.
- **Hover** scales the thumb to 1.08; **focus** adds a 4px translucent
  blue ring.

The Svelte side just sets `style="--slider-percent: {pct}%"` inline.
No JS listeners on input — Svelte reactivity covers it.

## Scroll-aware fade edges

Top-K can carry up to 20 rows; the panel caps its visible region
with `max-h-44` and scrolls inside. A 28px linear-gradient mask is
toggled per direction:

```svelte
class:fade-edge-top={canScrollUp}
class:fade-edge-bottom={canScrollDown}
```

`canScrollUp = scrollTop > 0` and `canScrollDown = scrollTop +
clientHeight < scrollHeight - 1`. The owner re-measures on `scroll`,
on `ResizeObserver` of the container, and inside an `$effect` that
re-runs when `streams.latestTopK` changes shape (so a config-driven
Top-K change updates the fade state immediately).

The 28px gradient was chosen empirically — at 18px the fade reads as
a hairline rather than an affordance; 28px is large enough that the
"more available" cue lands without consuming a full row of content.

## Layout pitfalls (lessons learned)

### Equal-height panels with internal scroll

The natural reflex is `grid-template-rows: min-content` on the parent
grid to force the row height to track only Visualization's content.
**This doesn't work**: an item's `min-content` contribution includes
its full intrinsic content size when it contains explicit-height
descendants (like the Top-K's children). The row sizes to the larger
item regardless.

The reliable fix is to cap the _content_ directly: `max-h-44` on the
Top-K wrapper bounds the Inference panel's intrinsic height under
Visualization's natural height, so the grid auto-sizing chooses
Visualization. `overflow-y-auto` on the same wrapper handles overflow
inside the cap. `mt-auto` pins the Active Head card to the panel
bottom so the spacer absorbs any leftover height.

### CSS Grid arbitrary `min-content`

Tailwind v4's `grid-rows-[min-content]` doesn't generate the expected
CSS — `grid-template-rows` gets `repeat(min-content, minmax(0, 1fr))`,
which the browser silently discards. Use the arbitrary property syntax
`[grid-template-rows:min-content]` or a hand-rolled CSS class. We
ultimately didn't need either (see above), but this gotcha is worth
remembering.

### Conditional form rows resize their parent

Earlier versions of the Microphone column rendered the Device row only
when Source was "fixed device" and the Channel-index row only when
Channel was "fixed". Toggling either dropdown made the column jump in
height, throwing off the cross-column alignment. The fix was to
collapse each two-control pair into a single dropdown:

- `Source`: `auto · first available` or each candidate.
- `Channel`: `auto` or each integer.

The policy's two-field shape (`{ mic: { kind, id? }, channel: { kind,
channel? } }`) is reconstructed at submit time from the single string
value. Layout is now intrinsically stable; no rows appear or vanish.

### Cross-column row alignment

To make `Source ↔ Overlap Ratio` and `Channel ↔ Top-K` align row-by-row,
both rows must have the same total height _including_ the label. The
key insight: a `<select>`'s height is `text-xs (16) + 2×py-1.5 (12) +
2×1px (border) = 30px`. Match it on the slider side with
`height: 1.875rem` (30px). DOM measurements after the fix:
Channel-select bottom and Top-K-slider bottom land within 1px of each
other.

### Visualization bottom padding

A `<footer>` (sample rate + window length metadata) below the
spectrogram pushed the panel's effective bottom padding to ~48px
(`mt-3` + footer line + `p-5`), while the sides stayed at 20px. The
corner asymmetry was the perceived problem; the footer was the cause.

Resolution: fold the metadata into the panel header as a small
subtitle next to the `h2`, drop the footer. Now the spectrogram ends
exactly `p-5` (20px) above the card edge, matching the sides.

### Three-tier elevation system

The dashboard uses exactly three surface tones to create perceived depth.
Within each tier every surface is identical; the eye therefore learns
to read tone changes as "this is at a different elevation" rather than
"this is a different type of card".

| Tier            | Color   | Hex       | Examples                                                                               |
| --------------- | ------- | --------- | -------------------------------------------------------------------------------------- |
| Page (outer)    | zinc-50 | `#fafafa` | `<body>` background                                                                    |
| Card (elevated) | white   | `#ffffff` | Visualization / Inference / Configuration panels; Health-badge popover; select control |
| Nested data     | zinc-50 | `#fafafa` | Active Head card; WaveformCanvas viewport                                              |

The page-tier and nested-data-tier deliberately share `zinc-50`. Cards
sit between them at white, reading as "raised" surfaces that the
nested-data wells recede back from. Active Head and the waveform area
visually pair within the white panels — both are `zinc-50` — so the eye
groups them as "this is data living inside the card".

Tones outside this tier system are reserved for _state_ and for
_visualization-context_ roles, not for hierarchy:

| Purpose                           | Color                                            |
| --------------------------------- | ------------------------------------------------ |
| Status / origin pills             | `bg-emerald-100` / `bg-blue-100` / `bg-zinc-200` |
| Progress-bar tracks (Top-K)       | `bg-zinc-100`                                    |
| Slider unfilled track             | `#e4e4e7` (zinc-200)                             |
| Spectrogram canvas (dark heatmap) | `bg-zinc-950`                                    |
| Disabled controls                 | `bg-zinc-50` / `bg-zinc-100`                     |
| Orphaned-head warning             | `bg-amber-50`                                    |
| Form error rows                   | `bg-rose-50`                                     |

The user learns "tone change = something to notice or a different
elevation", not "tone change = sub-card I should mentally classify".

The waveform canvas's internal fill is wired through a prop
(`background`) defaulting to `#fafafa` so the elevation tier can be
overridden per-instance (e.g., on a future Tiny Dashboard floating
overlay where the parent surface differs).

### Native FFT via Web Audio AnalyserNode

The spectrogram pipeline does not own its own DFT. An earlier iteration
shipped a hand-rolled radix-2 Cooley–Tukey FFT in JS (`audio/fft.ts`)
with precomputed twiddle factors and a Hann window. It worked, but
real-time spectrogram visualisation is exactly the use case that
`AnalyserNode` was designed for — a native FFT plus a Blackman window
plus a built-in smoothing pole (`smoothingTimeConstant`), all in C++.

Architecture:

1. The Worker decodes Opus → `Float32Array` PCM chunks (~960 samples,
   ~50 chunks/s) and posts them to the main thread (transferred buffer).
2. `streams.svelte.ts` keeps the old ring buffer for the WaveformCanvas
   _and_ forwards every chunk to a singleton `AnalyserBundle` (see
   `lib/audio/analyser.ts`).
3. The bundle wraps each chunk in a single-channel `AudioBuffer`, plays
   it through an `AudioBufferSourceNode` → `AnalyserNode` → muted gain
   → `AudioContext.destination`. Successive buffers are scheduled
   head-to-tail using a `nextStartTime` cursor, so the analyser sees a
   continuous signal.
4. `SpectrogramCanvas` calls `analyser.getFloatFrequencyData(target)`
   on each RAF tick — the browser returns dB values ready for the
   palette mapper.

What this buys us:

- **Speed**: native FFT vs. JS bouncing around `Float32Array`. Not a
  hot bottleneck at our scale (50 calls/s at 512 points), but it
  frees the main thread for canvas rendering and worker decoding.
- **Quality**: the Blackman window has a narrower main lobe than Hann,
  so a pure-tone test signal renders as a tight band instead of
  bleeding across several bins. Combined with the smoothing pole, the
  scrolling history looks more stable.
- **Less code**: removed `audio/fft.ts`, removed manual hop tracking,
  removed manual log-magnitude conversion. SpectrogramCanvas's ingest
  step is now a single line.

Caveats:

- `AudioContext` starts in `suspended` state on most browsers until a
  user gesture. We install **persistent** `pointerdown` / `keydown` /
  `visibilitychange` listeners on `document` in `streams.start()` that
  call `ctx.resume()` on each event. `resume()` is idempotent when the
  context is already running, so repeat calls are free; the listeners
  stay attached for the lifetime of the store.
- The earlier iteration used `{ once: true }` listeners. That worked
  for the first-gesture case but failed silently in a real scenario:
  Chrome auto-suspends the context when the tab is backgrounded, and
  the once-listeners had already self-removed -- so on tab return the
  spectrogram stayed black with no path to recovery. Persistent
  listeners + visibilitychange close that hole.
- We deliberately **skip `pushPcm` while the context is suspended**.
  Each `AudioBufferSourceNode` is retained by the audio engine until
  its scheduled end-of-play; queueing through a multi-minute suspend
  would create tens of thousands of orphaned sources and then _play
  them all in real time_ once the context resumes, so the user would
  see the spectrogram showing 5-minute-old audio scrolling at normal
  speed. Dropping during suspend is correct -- we visualise _current_
  audio only.
- `pushPcm` also **caps the forward-queue depth at 500 ms**: if
  `nextStartTime - currentTime > 0.5` we snap back to `currentTime`.
  This absorbs worker bursts (decoder hands us a quick stack of frames)
  and recovers cleanly after suspend → resume.
- We feed silent audio (gain = 0) through `destination` because Chrome
  short-circuits the graph for sub-trees not connected to a sink. No
  audible output.
- Component mount order: SvelteKit's `onMount` fires bottom-up, so
  `SpectrogramCanvas.onMount` runs _before_ the layout's onMount could
  call `streams.start()`. Fix: layout calls `streams.start()` at
  script-level (top-down), so `streams.analyser` is non-null by the
  time any child mounts. `onDestroy` handles teardown.

### RAF-coalesced canvas resize

Both `WaveformCanvas` and `SpectrogramCanvas` previously reset
`canvas.width` / `canvas.height` directly inside the `ResizeObserver`
callback. That assignment wipes the pixel buffer to transparent black,
and the next `draw()` call only runs on the next animation frame —
producing a 0–16 ms flash of blank canvas (showing the surface beneath)
on every observed resize. During window-edge drag at ~60 Hz the flash
was a continuous stutter.

Pattern in use now:

1. `ResizeObserver` only records the target dimensions and sets a
   `needsResize` flag — no DOM mutation, no buffer allocation.
2. The RAF tick reads `needsResize`, applies the dimension change, and
   _immediately_ renders in the same frame.
3. The reallocated buffers (`hiBuf` / `loBuf` for waveform,
   `ImageData` for spectrogram) are only created when the new
   dimensions truly differ from the old (`if (hiBuf.length !== w)`,
   `if (img?.width !== w || img.height !== h)`), so a steady stream of
   identical resize callbacks is a no-op.

Worst case: one RAF frame of stretched-stale content (the canvas's old
pixel buffer drawn at the new CSS size, slightly DPR-mismatched). No
blank flash at any point. This is a measurable win during drag —
verified by rapid-resizing the chrome-devtools page (1100→1300→1500)
and immediately sampling the canvas: the 1 kHz peak band remained
painted throughout.

### Animation tier

Every animation is intentional and capped to **minimum perceptible**.
The system has three tiers:

| Trigger            | Animation                         | Duration                               | Where                                                                       |
| ------------------ | --------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| Hover              | border/background tint            | 150 ms (Tailwind default `transition`) | Apply / Revert buttons, selects, tab links, HealthBadge wrapper             |
| Press              | `scale(0.98)`                     | 150 ms                                 | Apply buttons (`active:scale-[0.98]`, suppressed when `disabled`)           |
| State flip         | `transition-colors`               | 200 ms                                 | Status pills (Live/Connecting/Disconnected/Error), Origin pill, Active head |
| State flip (slow)  | `transition-colors`               | 300 ms                                 | HealthBadge dot (semantically heaviest signal — slower feels deliberate)    |
| Ambient            | `animate-ping` on the badge dot   | 1 s loop                               | HealthBadge only when `level === 'ok'` (suppressed in degraded/down)        |
| Slider interaction | thumb `scale(1.08)` + focus ring  | 120 ms                                 | All range sliders (defined in app.css pseudo-elements)                      |
| Top-K bar          | `transition-[width] duration-150` | 150 ms                                 | Inference TopKMeter inner fills                                             |

Rules of the road:

- Don't animate where there's no state change. Pills are
  informational, so they only animate when _the data underneath flips_.
- Don't animate expensive properties. All hover/state effects target
  `color`, `background-color`, `border-color`, `transform`, or
  `opacity` — never `width`/`height`/`top`/`left` outside of
  composited fast paths.
- The `transition` (Tailwind default) utility covers `color,
background-color, border-color, text-decoration-color, fill,
stroke, opacity, box-shadow, transform, translate, scale, rotate,
filter, backdrop-filter` at 150 ms — that's the right umbrella for
  any element with `hover:` or `active:` modifiers. We reach for
  `transition-colors` explicitly when _only_ colors change (cheaper)
  and when we want a non-default duration (the 200/300 ms state-flip
  tier).
- `active:scale-[0.98]` is suppressed via `disabled:active:scale-100`
  so a disabled button doesn't fake a press response on click.

### Waveform single-channel guarantee

The waveform pipeline is end-to-end mono:

- WebCodecs decoder is configured `{ numberOfChannels: 1 }` (see
  `stream/worker.ts`).
- The worker reads plane 0 of the decoded `AudioData` into a single
  `Float32Array` and transfers it to the main thread.
- The streams store's ring buffer is a flat `Float32Array` (no channel
  interleaving).
- `WaveformCanvas` reads samples directly and computes the min/max
  envelope per pixel column — appropriate primitive for ~110 samples
  per column at 3 s / 48 kHz / ~1300 px viewport.

If the daemon ever emits stereo Opus, the decoder configuration is the
single point of change; the rest of the pipeline is channel-agnostic
mono.

### Canvas-to-padding visual balance

Numerically-equal padding (`p-5` on all four sides) isn't enough — the
panel can still _look_ top-heavy if the header (text + status pill +
`mb-3`) takes ~54px while the bottom only has the bare `p-5` (20px).
The fix isn't more bottom padding (that breaks corner symmetry); it's
giving the _content_ enough vertical presence that the bottom
whitespace reads as proportional to the content above it.

Final canvas sizing for the Visualization panel:

- Waveform `h-32` (128px)
- Spectrogram `h-56` (224px)

At those sizes the dominant spec canvas anchors the visual weight, so
the 20px bottom strip stops feeling like a remnant. An earlier attempt
with `flex-1 min-h-44` on the spectrogram is **not** the answer — it
introduces a flex-grow chain that inflates the grid row size unpredictably
when paired with Inference's `mt-auto` spacer (both wrappers ended up at
570px instead of ~390px because `flex-1` interacted with `align-items:
stretch`). Fixed heights keep the section's intrinsic size predictable.

## Active Head card

The card carries five fields, of which the `id` is by far the longest
(a 36-char UUID). Constraints:

1. The `id` must fit on a single line at the typical viewport width.
   Wrapping a UUID looks broken.
2. All five values (`id`, `version`, `classes`, `workspace`,
   `revision`) should share one type size — mixed sizes inside a card
   read as "design accident", not hierarchy.
3. The label column has to be wide enough for the longest label
   (`version`, ~49px at text-xs).

Final form:

- Label column `3.5rem` (56px), value column `1fr`.
- Both `dt` and `dd` cells `text-xs` for the labels and
  `font-mono text-[10px]` for the values.
- `truncate` on every `dd` — even though at typical widths nothing
  truncates, it's the safety net for narrow viewports. Anything that
  ever overflows shows `…` rather than wrapping.
- `title={fullValue}` on the `id` and `workspace` cells so devtools
  hover surfaces the un-truncated string.

`text-[10px]` is the conventional size for technical hashes/UUIDs in
modern dashboards (Stripe, Vercel) and it earns enough column width
back that the parent panel can keep its 1.67× padding ratio without
forcing a UUID wrap.

## Health badge state colors

| State        | Dot         | Meaning                                                        |
| ------------ | ----------- | -------------------------------------------------------------- |
| `connecting` | zinc-400    | Daemon reachable but no snapshot yet                           |
| `ok`         | emerald-500 | All subsystems healthy + fresh                                 |
| `degraded`   | amber-500   | Any subsystem stale or `degraded_reason` set, or metrics stale |
| `down`       | rose-500    | Daemon unreachable, or any subsystem reports `healthy: false`  |

The dot animates with `animate-ping` only in `ok` — degradation and
errors are static so they don't compete with the "everything is fine"
pulse.

## Pitfalls outside the design layer

### `corner-shape: squircle` is universal-selector-safe

Applying via `*, *::before, *::after { corner-shape: squircle }` has
no perceptible perf impact and the property is silently ignored on
elements without a `border-radius`. Don't try to be clever with
narrow selectors.

### `appearance: none` disables `accent-color`

We strip the native select chrome via `.select-chevron`'s
`appearance: none` and paint our own SVG chevron. This also disables
`accent-color`, which is why slider track fill is done via custom
gradient + CSS variable instead.

### Tailwind v4 + svelte-prettier + tailwind-prettier-plugin

`prettier-plugin-tailwindcss@0.6.14` crashes `prettier-plugin-svelte`
on `.svelte` files without a `<script>` block (`TypeError:
getVisitorKeys is not a function`). Mitigation: don't load the
Tailwind class-sorter plugin in `.prettierrc.json` — Svelte's plugin
preserves class order well enough, and ESLint catches non-canonical
class spellings.

## Operator-facing knobs

### Overlap Ratio (vs. raw hop samples)

The inference engine accepts a raw `hop_samples` integer (44.1 kHz capture
rate, range `11_025..=44_100`). Exposing that as the slider's label
forces the operator to mentally convert "this many sample frames" into
"how often does inference fire" — a friction tax that pays no dividend
for someone who just wants to tune cadence.

The slider now reads as `Overlap Ratio` with range `0.25..=1.0` and
`step=0.01`. The mapping is `hop_samples = round(ratio * 44_100)` on
submit and the inverse on load, so the daemon contract is unchanged and
the slider's range is a clean dimension-free interval. The companion
`≈ N Hz` caption (computed `1 / ratio`) preserves the cadence intuition
without locking the slider's units to it.

We deliberately label the knob `Overlap Ratio` rather than `Hop ratio`
because the operator's mental model is "how much of the previous window
am I re-using" — even though strictly `hop / sample_rate` is the _step_
fraction. Empirically the framing reads more naturally: ratio 0.25
means "fire often, big window overlap"; ratio 1.0 means "no overlap,
slowest cadence".

### Why no `policy v*` chip on Microphone

The mic configuration footer used to show `policy v<N>` next to the
Apply button as the round-trip token for read-your-writes ordering.
It's load-bearing inside `setMicPolicy` (we re-GET with
`?min_version=<new>`), but as visible UI it earns no real estate:
operators don't drive their own policy versions and the number jitters
on every Apply with no actionable meaning. The token still flows
through the store; the footer is just cleaner now.

### Active head — the inline metadata line

`Active head` used to surface `id`, `version`, `classes`, and (for
workspace-origin heads) `workspace`/`revision` as a 2-column dl. The
runtime head id is a UUID; for the operator it adds noise more than
signal, and the same value is reachable via the API for engineers.

The card now leads with a single inline metadata line:

```
v0  ·  20 classes
```

…and falls back to the dl for `workspace`/`revision` only when
`origin === 'head'`, where the labels are doing real disambiguation
work. The card is shorter, reads as one unit instead of a list, and
the dropped UUID row was the only thing that used to overflow the
column on narrow desktops.

## Layout integrity

### Inference panel must not inflate with Top-K

The Inference panel sits in the lg grid's right column next to
Visualization. Grid auto-rows-stretch makes the row's height = max of
its items' intrinsic content heights. Earlier, the Top-K wrapper used
`max-h-56 overflow-y-auto`: its intrinsic content height varied with K
(more rows = taller intrinsic), so raising K from 1 → 20 pushed
Inference's intrinsic past Visualization's and _the grid row grew_ —
visibly resizing the spectrogram on every K change.

Fix: switch the Top-K wrapper to `min-h-0 flex-1 overflow-y-auto`.
Inside a `flex-col` parent with `h-full`, this combination:

- `flex-1` → wrapper grows to fill any slack left by header + active
  head card
- `min-h-0` → wrapper can shrink below its content's intrinsic height
- `overflow-y-auto` → content overflow scrolls inside the wrapper

With `min-h-0`, the flex item's contribution to its parent's max-content
becomes zero (the layout engine knows the wrapper can shrink to nothing
visually because the content scrolls). The Inference panel's intrinsic
height collapses to `header + active head + padding` — which is
_always_ less than Visualization's fixed `h-32 + h-56 + paddings`.
Grid row height becomes locked to Visualization's intrinsic. No more
jitter on K change.

The earlier `mt-auto pt-4` on the active head wrapper became
unnecessary: with the Top-K wrapper absorbing slack, the active head
sits naturally at the bottom.

## Popover dismissal model (HealthBadge)

The popover (badge → subsystem readout) needs to dismiss correctly for
three independent input modes:

1. **Mouse hover**: enter the badge, leave anywhere outside. _Including
   the 8 px `mt-2` gap between trigger and popover_ — that's the
   geometric reality of `position: absolute` siblings.
2. **Tap (touch / pen / click)**: toggle on the trigger, dismiss on a
   tap anywhere outside the wrapper.
3. **Keyboard**: `Enter`/`Space` toggles via the native button click;
   `focusout` (focus left wrapper) closes; `Escape` always closes.

The earlier implementation listened for `mouseleave` _on the popover
alone_ — so a quick hover-then-drift over the trigger left the popover
open forever (the popover's `mouseleave` never fired because the cursor
never reached it).

Two structural changes:

- **Single hover scope**: button + popover share one wrapper `<div>`.
  The wrapper's `mouseenter` opens and `mouseleave` schedules close
  (120 ms timer that the popover can cancel by re-entry). `mouseleave`
  fires on the wrapper only when the cursor leaves the union of its
  descendants — which now includes the popover.
- **8 px bridge**: an `aria-hidden` zero-content div sits in the gap
  between trigger bottom and popover top (`absolute right-0 top-full
h-2 w-80`). Without it the cursor falls into dead space mid-traverse
  and the close timer fires when there was no real dismissal intent.

Tap-outside dismissal uses a document-level `pointerdown` listener
installed only while open — one listener covers mouse, touch, and pen
because `PointerEvent` unifies them. We deliberately omit a
`focusin → open` path: a tap focuses _then_ clicks the button, so
opening on focus would race the click toggle and flash the popover.

### Mobile header

At `<sm` (640 px Tailwind breakpoint):

- The `AcousticsLab` wordmark hides; the indicator dot remains.
- Tabs shrink to `text-xs` with `px-2 py-1`, `gap-0.5` between them.
- The Health Badge label hides; the dot (plus its `aria-label`)
  remains.
- The popover's `w-80` is capped by `max-w-[calc(100vw-2rem)]` so it
  never escapes the viewport.

This keeps the header on one row down to ~360 px (typical modern phone
width), without the brittleness of a hamburger menu for three tabs.

## File map

Surfaces touched during this iteration:

- [`web/src/app.css`](../../web/src/app.css) — global tokens, slider, chevron, fade utilities
- [`web/src/routes/+layout.svelte`](../../web/src/routes/+layout.svelte) — tab nav, brand, header
- [`web/src/routes/+page.svelte`](../../web/src/routes/+page.svelte) — Dashboard composition
- [`web/src/lib/components/HealthBadge.svelte`](../../web/src/lib/components/HealthBadge.svelte)
- [`web/src/lib/components/dashboard/VisualizationPanel.svelte`](../../web/src/lib/components/dashboard/VisualizationPanel.svelte)
- [`web/src/lib/components/dashboard/InferencePanel.svelte`](../../web/src/lib/components/dashboard/InferencePanel.svelte)
- [`web/src/lib/components/dashboard/ConfigurationPanel.svelte`](../../web/src/lib/components/dashboard/ConfigurationPanel.svelte)
- [`web/src/lib/components/dashboard/ActiveHeadCard.svelte`](../../web/src/lib/components/dashboard/ActiveHeadCard.svelte)
- [`web/src/lib/components/dashboard/TopKMeter.svelte`](../../web/src/lib/components/dashboard/TopKMeter.svelte)
- [`web/src/lib/components/dashboard/WaveformCanvas.svelte`](../../web/src/lib/components/dashboard/WaveformCanvas.svelte)
- [`web/src/lib/components/dashboard/SpectrogramCanvas.svelte`](../../web/src/lib/components/dashboard/SpectrogramCanvas.svelte)

## Slice B.1 additions

The Workspace tab introduces a few new patterns worth recording so future
work doesn't relitigate them.

### `color-scheme: light` pinning

Tailwind v4's Preflight leaves `color-scheme` at `normal`, which means
native form controls (checkboxes, scrollbars, date picker) follow the
operator's OS preference. Every author-styled surface in this app is
explicitly light (white panels on zinc-50), so a dark-mode operator
saw black-filled checkboxes against light cards — broken-looking.

[`web/src/app.css`](../../web/src/app.css) pins
`html, body { color-scheme: light }`. Slice E's dark-mode work
flips this to `light dark` and gates the palette via a `data-theme`
attribute on `<html>`; until then the app is intentionally light-only.

### Native `<dialog>` top-layer + inline error banners

Native `<dialog>` opened via `showModal()` sits in the browser
_top layer_, strictly above any `z-index` value. A fixed-position
toast container at `z-50` would be hidden behind the backdrop while
a modal is open.

B.1's resolution: every modal that fires a backend mutation renders
its own inline error banner beneath the form
(`rounded-md border border-rose-200 bg-rose-50 text-rose-900`).
No global toast surface ships in B.1 — when Slice E adds one, it
will need to render through a portal-into-dialog or a
top-layer-eligible primitive (e.g. the `popover` API) to avoid
re-introducing the same occlusion.

### Delete serialization (`deleteChain`)

The daemon's `JobRegistry` admits at most one job from the entire
delete family (Dataset / Converter / TrainingLogs / ConverterLogs /
Workspace) at a time globally (`max_delete_jobs = 1`). Firing N
parallel `DELETE /workspace/{id}` requests returns N-1 of them with
`409 conflict` (`fs: job conflict: … (WorkspaceDelete)`). Both
single-item and bulk delete flow through `WorkspacesStore.enqueueDelete`,
which chains every call onto a private `deleteChain: Promise<unknown>`
so each new request waits for the previous job's SSE terminal event
before its own DELETE fires. `.catch(() => undefined)` on the chain
swallows individual failures so one bad delete doesn't stall the queue.

The downstream UX: both the per-item and the bulk dialog are
**fire-and-forget**. The dialog closes immediately on confirm;
the queue runs in the background and the operator watches each card
transition through the list's `deleting` state. Failed deletes
re-enter the selection set so the operator can retry from the
toolbar without re-checking.

### Live name validation (`inputClass(hasError)`)

[`web/src/lib/components/ui/inputClass.ts`](../../web/src/lib/components/ui/inputClass.ts)
returns the shared text-input class string for a given error state.
Both Create- and Rename-workspace dialogs use `$derived` validation
that mirrors the daemon's
[`validate_workspace_name`](../../modules/file_mgr/registry.rs) — empty
input shows no error (the disabled submit button is signal enough),
but the moment the operator types a structurally-invalid character
the input border swaps to `rose-300/400`, an `aria-describedby`
linked inline message appears below, and the submit button stays
disabled until the validation passes.

Rename additionally treats `trimmedName === currentName` as a
no-op: not an error, but the submit button is disabled — so a
non-mutating "Save" can't accidentally fire.

### Layer-prefix stripping in error copy

Daemon errors arrive as `"<layer>: <message>"` because the Rust side
uses `thiserror` with leading-tag formats (`fs: …`, `convert: …`,
`training: …`, `not found: …` and so on). [`web/src/lib/utils/
error-copy.ts`](../../web/src/lib/utils/error-copy.ts) strips one
known leading prefix before sentence-casing + appending a period.
Nested instances (e.g. an inner `"conflict: test"` inside the
stripped layer) survive — only the outermost wrapper goes.

The prefix set is fixed (`fs`, `file`, `config`, `mic`, `head load`,
`head swap`, `convert`, `training`, `activation`, `invalid
identifier`, `invalid request`, `internal`). Adding a new layer to
the daemon means adding it here; the regression mode is just slightly
uglier copy, not broken UX.

### Context menu + opt-in selection mode

The Workspace list deliberately ships no always-visible per-card
action icons — Rename / Delete / Select all live behind the
right-click context menu (`ContextMenu.svelte`). The page handles
the `contextmenu` event on a single wrapping `<div>` and walks
`closest('[data-workspace-id]')` to decide whether the menu opened
on a card or on empty list area; each context produces its own
section set in `buildMenu()`.

Selection is opt-in: the header "Select" button (or the context
menu) transitions `WorkspacesStore.mode` to `'selecting'`, at which
point each card slides a checkbox in via `transition:fly` and the
card body's click toggles selection instead of navigating. The
header swaps to a Select-all / Done / Delete-N group; no sticky
bottom toolbar. Selection state is `SvelteSet<Uuid>` on the store
so the `selectedEntries` derived view re-prunes if the underlying
list changes.

Selected cards swap their border palette to
`border-blue-300 hover:border-blue-400` for an at-a-glance batch
preview. Cards with a delete job in flight stay in the list with
an `opacity-60` dim + a rose `deleting` pill until terminal.

## Slice B course correction (2026-05-12)

The Dataset Management surface in [ARCHITECTURE.md §A.4 "Extra Notes"](./ARCHITECTURE.md)
is the design contract; the prior B.2 draft missed it on several
load-bearing axes. Recording the deviation here so the rebuild does
not repeat the mistakes -- and so the salvaged pieces don't get
re-thrown-out the next time someone reads the directory.

### The architecture spec, restated

A workspace's dataset is a **vertical list of categories** (one row
per category). Each row is independently expand/collapse; expanding
splits into two panes: **Input Module** (left) and **Slice
Management** (right). The Input module retains _one_ in-progress
audio clip at a time; the Slice button chunks the trimmed range into
**1-second slices @ 44,100 samples** and appends them to the right
pane. Slice cards render with their spectrogram as the card's
background fill. `_background_noise_` is mandatory and undeletable;
threshold for training-ready is 20 slices on `_background_noise_`,
10 on everything else.

### Deviations the prior B.2 draft shipped

| Axis                    | Spec                               | Prior B.2                      | Recovery                           |
| ----------------------- | ---------------------------------- | ------------------------------ | ---------------------------------- |
| Pipeline sample rate    | 44.1 kHz                           | 16 kHz                         | Flip `WAV_SAMPLE_RATE` to 44 100.  |
| Per-workspace structure | Per-category accordion             | Flat recording list            | Replace UI in revised B.2.         |
| Mandatory category      | `_background_noise_` undeletable   | —                              | New in revised B.2.                |
| Input slot              | Single most-recent clip / category | 64-recording list / workspace  | Replace data model.                |
| Workflow                | record → trim → Slice → cards      | (record / import) only         | Add trim + Slice (B.4).            |
| Import format           | WAV only                           | audio/\*                       | Restrict + magic-byte check (B.3). |
| Slice rendering         | Spectrogram-bg cards               | Native `<audio controls>` rows | Replace (B.5).                     |
| Quantity gate           | ≥ 20 / ≥ 10                        | —                              | New (B.5).                         |
| Backend sync            | GET / PUT / DELETE per slice       | Local-only IDB                 | New (B.6).                         |
| Recording visual        | Real-time waveform                 | RMS level meter only           | Upgrade (B.3).                     |
| Export                  | Download clip as WAV               | —                              | New (B.3).                         |

### Why 44.1 kHz, not 16 kHz

The daemon's training preprocessor targets exactly
`TARGET_SR = 44_100` ([modules/preproc/wav_io.rs:21](../../modules/preproc/wav_io.rs#L21))
and consumes 44,032 samples per inference frame
([modules/preproc.rs:6](../../modules/preproc.rs#L6)). The
architecture spec's "1 s, 44,100 samples" maps 1:1 to this.
Shipping 16 kHz on the client would have forced the daemon to
upsample on every batch -- needless cost, lower spectral fidelity,
and a divergence between the wire format and the architecture spec.

The mic capture rate is whatever the device gives (`AudioContext.
sampleRate`, typically 48 kHz on macOS / 44.1 kHz on Linux ALSA);
the existing [recorder.svelte.ts](../../web/src/lib/audio/recorder.svelte.ts)
resampler already pipes through `WAV_SAMPLE_RATE`, so flipping the
constant retargets the entire pipeline.

### Salvage map (what survives the rebuild)

These files are reusable foundation; B.2's rebuild does NOT touch
them except for the sample-rate constant flip:

- [audio/wav.ts](../../web/src/lib/audio/wav.ts) -- PCM-16 mono WAV
  encoder.
- [audio/resample.ts](../../web/src/lib/audio/resample.ts) --
  parametric on target rate; downmix + `OfflineAudioContext`
  resample + `decodeAudioFile` helper.
- [audio/recorder.svelte.ts](../../web/src/lib/audio/recorder.svelte.ts)
  -- `getUserMedia` + inline `AudioWorklet` (blob URL) + state
  machine. B.3 will extend this to expose a `snapshot(samples,
out)` API so the live-waveform canvas can read mic PCM without
  the global `streams` ring being involved.
- [audio/fft.ts](../../web/src/lib/audio/fft.ts) -- radix-2
  Cooley-Tukey FFT (legacy Slice A artifact). Re-promoted as the
  B.5 spectrogram engine. Offline render in a Worker; no
  AnalyserNode dependency.
- [utils/format.ts](../../web/src/lib/utils/format.ts) -- byte /
  duration formatters.

These files are deleted as part of the B.2 rebuild because their
design assumed the flat-recordings model:

- `idb/recordings.ts`
- `stores/recordings.svelte.ts`
- `components/dataset/RecordingList.svelte`
- `components/dataset/RecordingCard.svelte`
- `components/dataset/DeleteRecordingDialog.svelte` (folded into
  a generic `ConfirmDeleteDialog.svelte` primitive)
- `components/dataset/Recorder.svelte` / `ImportZone.svelte` --
  rebuilt under the per-category layout, not raw-replaced.

[idb/db.ts](../../web/src/lib/idb/db.ts) keeps the open / upgrade /
WeakMap-cache skeleton; the `recordings` store definition gets
replaced by `drafts` + `slices` under schema v2 (no migration --
the deviated v1 was never user-facing).

### Inline AudioWorklet via blob: URL

(Preserved from the prior B.2 notes -- still correct.)

`MediaRecorder` would have given us audio bytes without an
AudioWorklet, but only after a lossy opus/webm/ogg round-trip --
unacceptable for our master copy. `AudioWorklet` hands us raw
Float32 frames directly off the audio graph; no codec, no precision
loss. Bonus: Safari 14.5+ supports it where MediaRecorder audio
is patchy.

We register the worklet from an _inline_ string sealed inside a
`Blob` + object URL, not from a separate `.ts` module:

```ts
const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
const url = URL.createObjectURL(blob);
await ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
```

Why not a separate module file? The worklet processor is ~20 lines.
Shipping it via Vite's worklet bundling adds build-graph machinery
(an extra chunk, an extra URL to register, fingerprinted assets)
for zero functional gain. The blob URL is revoked the moment
`addModule` resolves so it doesn't leak.

### Five-state recorder, explicit dispose

(Preserved from the prior B.2 notes -- still correct.)

The Recorder runtime lives in `audio/recorder.svelte.ts` so `$state`
class fields work. Lifecycle is _explicit_: the component creating
the Recorder owns `onDestroy(() => recorder.dispose())`. Five-state
machine:

```
idle → requesting → recording ─stop()─▶ finalizing → idle
        │              │                    │
        └─ error ◀─────┴──── error ◀────────┘
```

`stop()` is idempotent; `cancel()` is the manual-discard path;
`dispose()` funnels into it. `start()` is gated on `state ∈ {idle,
error}` so double-clicks are no-ops.

### `decodeAudioData` discards the file's native sample rate

(Preserved -- the rebuild's WAV-only path will read the rate from
the WAV header directly, sidestepping this lossy detour.)

`AudioContext.decodeAudioData` resamples the input to the _context's_
rate before exposing the AudioBuffer to JS, so `decoded.sampleRate`
is the context's rate, not the file's native rate. Recovering the
true rate requires a per-format header parser; B.3 only needs WAV,
which is a 44-byte header read.

### `Float32Array<ArrayBuffer>` at Web Audio boundaries

(Preserved -- TS 5.7's narrower typed-array discriminator still
applies wherever we cross into Web Audio.)

TS 5.7 tightened the typed-array generic to `Float32Array<ArrayBuffer-
Like>`. Web Audio's `copyToChannel` and `getFloatTimeDomainData`
require `Float32Array<ArrayBuffer>`. We add explicit
`as Float32Array<ArrayBuffer>` casts at boundary call sites.

### Sequential file imports

(Preserved -- B.3 keeps the single-file import semantics; the input
slot is single-clip per category so there is nothing to parallelise
within one row.)

### SvelteMap mutations need fresh values

Cross-cutting, learned during the prior B.2 -- still applies to the
revised B.2's `categories` / `drafts` / `slices` stores.

SvelteMap is reactive on `.set` / `.delete` / `.clear`, but values
stored inside it are _not_ deeply reactive -- mutating
`slice.loading = true` on a reference returned from `.get()` triggers
no `$effect` / `$derived` rerun. Every store mutation in these
files therefore re-`.set`s a _fresh_ object reference. An early draft
mutated the existing reference then called `.set` with the same
reference; reactivity skipped the change because the reference did
not change. Always-fresh-object is the cheap discipline.

### `$effect` + `refresh()` reactive-loop trap

Discovered during the B.3 verification gate: entering a workspace
detail page felt sluggish and queued dozens of redundant
`GET /assets/datasets` requests. Root cause was a self-perpetuating
microtask loop between the `$effect` that bootstraps a per-workspace
fetch and the store method it calls.

The shape of the bug:

```ts
// store
async refresh(workspaceId: Uuid): Promise<void> {
  const existing = this.slices.get(workspaceId); // tracked read
  if (existing?.loaded && !existing.error) return;
  this.slices.set(workspaceId, { loading: true, loaded: false }); // write
  await Promise.all([...]);                                       // first await
  this.slices.set(workspaceId, { loading: false, loaded: true }); // final write
}

// caller
$effect(() => {
  void store.refresh(workspaceId);
});
```

Svelte 5's `$effect` tracks reads that happen during its synchronous
execution -- and that tracking propagates across method calls. So
the inner `this.slices.get(...)` registers the slice as a dependency
of the outer effect, and the write that follows it _invalidates_
that dependency. In the next microtask the effect re-fires, calls
`refresh` again, reads the (now `loading: true, loaded: false`)
slice, falls through the short-circuit (because `loaded` is still
false), writes again, re-queues, ... until Svelte's
`effect_update_depth_exceeded` guard fires. Every iteration kicks
off a fresh `Promise.all([fetch, ...])`.

Two reasons it stayed silent through B.2:

1. With a fast daemon the inner `Promise.all` resolves in tens of
   milliseconds, so the loop terminates after a few iterations and
   the user doesn't notice the queued fetches.
2. The `datasets/` directory under a workspace is **not** laid down
   at workspace-create time (only `training_logs/` /
   `converter_logs/` are). A first `GET
/workspace/{id}/assets/datasets` therefore returns 404
   ([docs/API.md](../API.md) §"Workspace assets"). The catch
   handler then writes `error: <404>` onto the slice -- which
   `existing.error` flips the loaded-cache short-circuit OFF on
   subsequent iterations, so even the steady-state cache hit no
   longer saves us. B.3's testing scenario (fresh workspaces with
   no slices yet) hits this case head-on.

Three coordinated fixes:

1. **`if (existing?.loading && !force) return;` short-circuit** in
   every reactive `refresh()` ([categories](../../web/src/lib/stores/categories.svelte.ts),
   [drafts](../../web/src/lib/stores/drafts.svelte.ts)) before the
   slice-write. Once one refresh is in flight, the second iteration
   bails on this gate. Load-bearing for correctness, not just perf.
2. **`untrack(() => store.refresh(id))` at call sites** in
   `$effect` ([CategoryList](../../web/src/lib/components/category/CategoryList.svelte),
   [InputPane](../../web/src/lib/components/category/InputPane.svelte)).
   The effect tracks only the props it reads outside the wrapper
   (`workspaceId`, `categoryName`); reads inside the wrapper don't
   accrue dependencies. Belt-and-suspenders -- the in-flight guard
   alone fixes the loop, but `untrack` documents intent at the call
   site so a future refactor of the store doesn't silently re-open
   the door.
3. **`isNotFound` catch on `assets.listDatasets`**: a fresh
   workspace's missing `datasets/` directory is the empty case, not
   an error. Return an empty `DatasetListing` and let the merge
   logic produce mandatory + IDB-only rows. Other errors
   propagate.

Together they reduce workspace-detail entry from N redundant GETs
(growing until Svelte's guard fires) to exactly one IDB read + one
GET, with a clean empty list on fresh workspaces.

`workspaces.refresh()` is NOT affected because its synchronous
portion writes (`this.loading = true`) but doesn't read any state
the outer effect tracks -- the effect's body just contains
`void workspaces.refresh()`, no slice access at all. The same
in-flight guard is still cheap defence; left absent for now to keep
the diff minimal.

## Slice C additions

### Training event flow: SSE-driven, `TrainingJobView` reconstructed client-side

Training events flow through the cross-cutting
`GET /api/v1/jobs/{job_id}/events` SSE endpoint
([modules/api/routes/jobs.rs](../../modules/api/routes/jobs.rs)),
the same surface delete-family jobs use. The dual-registry
asymmetry that earlier revisions of this note described — the
training producer running its own `training::JobRegistry`,
unbridged to `file_mgr::JobRegistry` — was closed in 2026-05.
The training POST route now calls
`jobs.try_acquire(JobType::Train, ...)` directly
([modules/api/routes/training.rs:119](../../modules/api/routes/training.rs#L119)),
the resulting `JobHandle` threads into `training.spawn(...)`, and
`emit_train_event` broadcasts every typed `TrainEvent` via
`handle.append_log(serde_json::to_string(&event))` so each one
fans out over the cross-cutting SSE bus.

The web client consumes that stream through
[`TrainingSubscriber`](../../web/src/lib/api/training-subscriber.ts),
a single long-lived `EventSource` that opens with `after_seq=0&logs=true`
and stays bound for the whole run. Three `JobEvent` shapes arrive
interleaved:

- `{message: <stringified TrainEvent>}` — typed payload. The
  subscriber `JSON.parse`s the inner body and lifts the envelope
  (`seq` + `at`) onto it to produce a `TrainLogLine`. The store
  appends a rendered log line, merges per-epoch metrics, and
  applies per-kind view-field effects (phase, started_at, result,
  error, terminal state) via `applyEventToView`.
- `{progress: {done, total}}` — rate-limited (~4 Hz) tick from
  `JobHandle::update_progress`. Drives `view.progress.current /
total` between epoch_completed events.
- `{state: succeeded | failed | cancelled}` — the daemon's
  terminal transition from `JobHandle::terminate`. Drives
  `view.state` and routes the job into history via
  `handleTerminal`.

The full `TrainingJobView` (`started_at`, `progress.*`, `result`,
`error`, `finished_at`, `state`) is therefore **reconstructed
client-side** from the event stream alone; the polled
`GET /workspace/{id}/training/{job}` endpoint is no longer on the
routine path. It survives for two narrow uses:

1. `training.list(workspace)` (the listing form) is the recovery
   discovery hop — finds the running `job_id` for a workspace
   the operator just navigated to.
2. The polled `JobView` shape is still the canonical type for the
   reconstructed view; we don't define a separate "client view"
   type because the on-the-wire shape is already correct.

### Why the polled-view + JSONL-tail predecessors are gone

Earlier revisions paired a 1 Hz `TrainingJobPoller` with a 1 Hz
`TrainingLogTail` (JSONL paging). Both were workarounds for the
unbridged producer:

- The poller sampled `tokio::sync::watch<finetune::Progress>` at
  1 Hz. The watch channel retains only the _latest_ value, so on
  fast runs (a 50-epoch run finishing in <1 s) ~95% of
  `progress.message` deltas were overwritten before the next
  poll. The polled log surface was effectively unusable.
- The tail paged the JSONL backstop at 1 Hz, recovering all
  events but requiring a 3-second post-terminal drain to race
  the daemon's flush + state-flip ordering. Correct, but
  cycle-hungry and full of timing bookkeeping.

Both predecessors landed cleanly in the SSE world.
`TrainingJobPoller` is deleted; its routing logic moved into the
subscriber's three callbacks + `applyEventToView`.
`TrainingLogTail` survives as a dormant gap-recovery substrate
(see ["Gap recovery"](#gap-recovery-event_gap-409--jsonl-backfill)
below), but no code path binds it during routine operation.

### Gap recovery (`event_gap` 409 + JSONL backfill)

The daemon's per-job SSE ring is 1024 events deep. A typical
50-epoch run emits ~70 events (14× headroom), so a routine
subscription replays cleanly from `seq=0` without overflow. Two
scenarios can in principle exceed the ring:

- A 1000-epoch run (the daemon's hard cap) emits ~1010 events;
  by the time a recovering subscriber asks for `seq=0`, the
  ring has evicted the first few.
- A worker that broadcasts at extreme rates (currently not
  possible because the producer rate-limits) could overflow.

In the first case, the SSE endpoint returns HTTP 409 +
`{code: event_gap, oldest_seq, latest_seq}`. The web client's
response is to backfill via `TrainingLogTail` (the durable JSONL
substrate), then resubscribe SSE at `after_seq = latest_seq`.
The store's [`recoverFromGap`] wires this end-to-end and bounds
to `MAX_GAP_RETRIES = 3` consecutive recoveries so a pathological
loop (the daemon's ring evicting faster than we backfill) can't
recurse forever.

### Persistent training-history hydration

Past terminal runs survive a daemon restart and a tab reload
because the daemon writes every typed `TrainEvent` to a durable
`<ws>/training_logs/<job_id>.jsonl` file at admission time and
through to terminal. An earlier revision lost that history to
the operator's tab on refresh — the in-memory `training::JobRegistry`
holds the snapshot and a workspace-mount only called `recover()`,
which surfaced running jobs but ignored terminal ones. Since
2026-05-15 the workspace page also calls
[`trainingStore.hydrateHistory(workspaceId)`] alongside `recover()`,
which:

1. Lists `GET /api/v1/workspace/{id}/assets/training_logs?limit=100`
   (the directory-listing arm of the unified assets API), sorts the
   resulting JSONL filenames newest-first by `mtime`, and stores
   the result in `discoveredByWs` as the per-workspace
   "what JSONLs exist on disk" canonical list.
2. Eager-fetches the top `INITIAL_VISIBLE = 2` JSONL files
   in parallel and replays each through `replayJsonl` (a pure
   fold over the same `applyEventToView` /
   `mergeEpochFromEvent` / `renderEvent` helpers the live SSE
   path uses), producing a `TrackedTrainingJob` per file that
   gets pushed into `historyByWs` via `pushHistoryBatch`.
3. Surfaces the rest behind a "▾ Show N older runs"
   disclosure backed by `loadMoreHistory(workspaceId)`, which
   paginates in batches of `PAGE_SIZE = 5` JSONL fetches per
   click.

The two-tier model is what keeps the cost honest. Most operators
ask "what did I just run" and never click into history beyond the
last run; the eager tier answers that in 3 HTTP requests (~30 KB)
on every workspace mount. An operator who wants to compare 10
runs back pays for the second page only when they explicitly
ask for it. Per-card expansion is free because the JSONL is
already in memory by the time the card renders.

Idempotence: `hydrateHistory` short-circuits when
`discoveredByWs.has(workspaceId)` so a route-effect re-fire for
the same workspace is a no-op. A listing failure (network
hiccup) leaves the slot unset so the next mount retries. The
`forget(workspaceId)` path clears `discoveredByWs` +
`hiddenJobsByWs` + `loadingMoreByWs` + `olderExpandedByWs` along
with the active slot, so a workspace delete fully releases the
local cache.

Operator-soft-hidden runs persist via `localStorage` under
`acoustics-lab:training-hidden:<workspace_id>` (a JSON array of
jobIds). Dismissals survive refresh; a "Show K hidden runs"
reveal link at the bottom of the list unhides everything at once
and re-fetches their JSONLs into history. The underlying JSONL
files stay on disk regardless; permanent deletion is not
exposed in v1.

Active-slot guard: `fetchAndReplay` checks `this.active?.jobId ===
jobId` both before and after the JSONL round-trip and returns
null when they match. This prevents a still-running job (which
`recover()` owns via SSE) from being double-tracked as a
hydrated entry. A run that _terminates_ during the hydration
round-trip lands twice (once via SSE, once via JSONL) but
`pushHistoryBatch`'s de-dup-by-jobId collapses them.

In-flight runs whose JSONL has _no_ terminal event in it (the
worker crashed without emitting one) return null from
`replayJsonl` — we skip them in v1 rather than render an
"interrupted" placeholder. Future work could surface them
under a dedicated state pill.

### Why the training store is a singleton, not per-workspace

The daemon's `max_train_jobs = 1` admission gate is _daemon-wide_,
not per-workspace. A second `POST /train` returns 409
`another_train_running` regardless of which workspace it targets.
The web store mirrors this invariant:

- `active: TrackedTrainingJob | null` — the single in-flight slot
  across every workspace this tab knows about.
- `terminalByWs: SvelteMap<Uuid, TrackedTrainingJob>` — per-
  workspace "last run" pin, so a navigation back to a workspace
  shows the verdict of the most-recent run without an extra fetch.

This shape lets a sibling-workspace's `TrainPane` render the
"Another workspace is training a head" amber strip + disabled
form purely from store reads (`trainingStore.active !== null &&
trainingStore.active.workspaceId !== workspaceId`). Without the
singleton, that information would have to flow through a
sibling-channel — a global "is anything training" boolean — and
the UI would still have to look up the foreign workspace for the
copy. One global slot is simpler.

The flip side: a true multi-workspace future (where the daemon
gains `max_train_jobs > 1`) would need a per-workspace `active`
map. That refactor is local to the store; consumers read via
`activeFor(workspaceId)` already, so the call sites don't change.

### Hand-rolled canvas chart vs. a chart library

[MetricsChart.svelte](../../web/src/lib/components/training/MetricsChart.svelte)
renders three series (train loss, train acc, val acc) at most a
thousand points each as a single canvas. The whole component is
~250 LOC including the legend chip column.

Chart.js / uPlot / chartist would each pull > 30 KiB gzipped and
add a tree of DOM nodes (uPlot, the leanest, is the only canvas-
based one). Against that:

- Canvas redraw fires once per poll tick (~1 Hz) — RAF-coalesced
  via the [NOTES.md §"RAF-coalesced canvas resize"](#raf-coalesced-canvas-resize)
  pattern. No DOM churn between ticks.
- The chart shape is fixed: one X axis (epoch index), two Y axes
  at different ranges (loss is `[0, max-observed]`, accuracies
  are `[0, 1]`). A generic chart library would force per-instance
  theming and event handling for what is genuinely two `lineTo`
  loops.
- Dual-axis chart libraries in particular are over-engineered for
  this case — they assume the operator wants to toggle series,
  pan, zoom, brush, etc. None of that fits a "watch this train
  finish" surface; the operator's interaction is "wait, then maybe
  cancel".

The component's `epochs[]` prop is the source of truth; reactivity
flows through Svelte's `$effect` on the prop reference, and the
RAF schedules at most one paint per effect-fire. On a typical
30-epoch run that's 30 paints over ~5 minutes — invisible to the
compositor.
