<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { EpochMetrics } from '$lib/api/types';

  // Per-epoch train-loss + val-accuracy chart.  Hand-rolled
  // canvas (no chart lib) because:
  //  1. The data set is tiny (~max 1000 points each line; in
  //     practice <100 during typical runs).  A small
  //     `drawAxes / drawLine` block is shorter than Chart.js's
  //     import-and-bundle cost.
  //  2. The visual shape is fixed -- one X (epoch), two Y
  //     series at different scales (loss is positive unbounded,
  //     acc is [0, 1]).  We render the loss on the left axis
  //     and the accuracy on the right axis; a generic chart
  //     library would force per-instance theming for what is
  //     two straight lines.
  //  3. We control the redraw cadence -- the parent re-passes
  //     `epochs` once per poll tick (~1 Hz) and a RAF schedules
  //     the actual paint; a `<canvas>` repaint at that cadence
  //     is invisible to the layout engine, where a Svelte
  //     `<svg>` per-point would churn the DOM.
  //
  // ## Refinement: number-less axes + overlay legend pill
  //
  // The previous pass added tick labels on both Y axes and the X
  // axis -- useful, but every tick label cost margin: 36 px on
  // the left, 32 px on the right, 14 px below, and a dedicated
  // 18-px legend strip above.  68 px of horizontal padding alone
  // on a card body that's typically ~600 px wide, eating ~11% of
  // the plot's horizontal real estate for labels that the hover
  // tooltip already surfaces on demand.
  //
  // This pass strips the chart back to "shape over time" -- the
  // canonical job of a training mini-chart in a dashboard card:
  //   1. No tick labels on any axis.  The hover tooltip carries
  //      the exact value of every series at the nearest epoch;
  //      the per-tick readout strip below the chart (in
  //      JobProgress) carries the latest absolute numbers.
  //      Operators reach for one of those for "what is the
  //      number", not the chart.
  //   2. Faint acc gridlines at 0.5 and 1.0 stay -- a fixed
  //      [0,1] scale still benefits from the mid + ceiling
  //      anchors even without text, because the *position* of
  //      the val_acc line relative to "half" is what an operator
  //      reads at a glance.  Loss has no gridline since its
  //      ceiling is per-run.
  //   3. Best-val-acc marker (vertical dashed emerald rule +
  //      filled dot) stays -- it points at the epoch that
  //      actually shipped as a head when validation_split > 0.
  //   4. Pointer hover (crosshair + per-series dots + tooltip)
  //      stays -- this is the on-demand number surface that
  //      justifies removing the static labels.
  //   5. Legend moves from a dedicated top strip into a compact
  //      frosted pill anchored top-right INSIDE the plot
  //      region.  Reclaims the strip's vertical row AND frees
  //      the labels' horizontal margins, so plot area grows
  //      while the card itself shrinks.

  interface Props {
    epochs: readonly EpochMetrics[];
    // True if `validation_split === 0` -- the val-acc line is
    // not drawn (would be all-NaN), the legend pill drops the
    // `val` chip, and the best-val marker is skipped.  Cheaper
    // than threading every NaN through the line-renderer's edge
    // cases.
    valDisabled?: boolean;
    // CSS height; matches the parent's canvas-area sizing.
    // Defaults to 112 px -- with the new 6 px paddings on every
    // side, the plot region is 100 px tall (slightly larger than
    // the previous 96 px), and the card is 16 px shorter overall.
    height?: number;
  }
  let { epochs, valDisabled = false, height = 112 }: Props = $props();

  let canvasEl = $state<HTMLCanvasElement | undefined>();
  let wrapperEl = $state<HTMLDivElement | undefined>();
  let cssW = $state(0);
  // Canvas pixel buffers re-set inside RAF (not inside the
  // ResizeObserver) per NOTES.md §"RAF-coalesced canvas resize".
  let needsResize = false;
  let rafId: number | null = null;

  // Hover state.  `hoveredIdx` is the index into `epochs[]` of
  // the point currently nearest the pointer, or null when the
  // pointer is outside the canvas / no points yet.  Set by
  // pointermove + cleared by pointerleave; re-fires the render
  // through the same RAF coalescer so the crosshair / tooltip
  // update at display refresh rate, not pointer-event rate.
  let hoveredIdx = $state<number | null>(null);

  function scheduleRender(): void {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      render();
    });
  }

  // Plot region padding.  With axis tick labels removed, the
  // gutters collapse to a hairline that exists only to keep the
  // data + baseline from kissing the canvas edge:
  //   - 6 px on every side is the smallest gap that still reads
  //     as "the chart is inside a rounded box" rather than
  //     "the chart is the rounded box".  Going to 0 made the
  //     stroke caps on the data lines clip against the
  //     `bg-zinc-50` border-radius corners.
  //   - The legend pill sits INSIDE the plot region (top-right,
  //     4 px inset), so the top padding doesn't need to reserve
  //     a strip for it -- see `drawLegendPill` below.
  //   - The X-axis baseline is still drawn at `plotH + PAD_T`,
  //     so PAD_B is just bottom breathing room.
  const PAD_L = 6;
  const PAD_R = 6;
  const PAD_T = 6;
  const PAD_B = 6;

  // Best val epoch index (into `epochs[]`).  -1 when no val_acc
  // ever landed (validation_split === 0, or pre-train failure).
  // Hoisted out of render() so consumers / tests could inspect
  // without driving a paint.  Recomputed on every render() since
  // the inputs change rarely and the loop is cheap.
  function findBestValIdx(): number {
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < epochs.length; i++) {
      const v = epochs[i].val_acc;
      if (v === null || !Number.isFinite(v)) continue;
      if (v > bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  // Linear mapping helpers.  Hoisted so the hover-handler can
  // reuse `xToPx` to invert pointer position back to epoch.
  // The closure rebuilds these on every render() (cheap) and
  // stashes them on the component instance via let bindings so
  // the pointer handler can call them.
  let lastXToPx: ((x: number) => number) | null = null;
  let lastEpochs: readonly EpochMetrics[] = [];

  function render(): void {
    const cnv = canvasEl;
    if (!cnv) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = cssW || cnv.clientWidth;
    if (cssWidth <= 0) return;
    if (needsResize) {
      const targetW = Math.max(1, Math.round(cssWidth * dpr));
      const targetH = Math.max(1, Math.round(height * dpr));
      if (cnv.width !== targetW) cnv.width = targetW;
      if (cnv.height !== targetH) cnv.height = targetH;
      needsResize = false;
    }
    const ctx = cnv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cnv.width / dpr, cnv.height / dpr);

    const w = cssWidth;
    const h = height;
    const plotW = Math.max(1, w - PAD_L - PAD_R);
    const plotH = Math.max(1, h - PAD_T - PAD_B);

    // Always paint the X-axis baseline so the chart's shape is
    // visible even before the first epoch lands.
    ctx.strokeStyle = '#e4e4e7'; // zinc-200
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T + plotH + 0.5);
    ctx.lineTo(PAD_L + plotW, PAD_T + plotH + 0.5);
    ctx.stroke();

    if (epochs.length === 0) {
      // Legend pill drawn first so the placeholder text reads
      // against an otherwise-empty plot region.  Always painted
      // so the operator sees the colour mapping even on an empty
      // / waiting chart.
      drawLegendPill(ctx, PAD_L + plotW, PAD_T);
      ctx.fillStyle = '#a1a1aa'; // zinc-400
      ctx.font = '500 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      // Centre the placeholder over the plot region instead of
      // anchoring to the left edge -- the empty plot reads as a
      // single visual cell, so the message belongs at its
      // optical centre.  The legend pill (top-right, ~13 px tall)
      // sits well above the vertical centre line, so no overlap.
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for first epoch…', PAD_L + plotW / 2, PAD_T + plotH / 2);
      lastXToPx = null;
      lastEpochs = [];
      return;
    }

    // X domain: epoch indexes 1..maxEpoch.  We use `epochs[last].epochs`
    // as the total when available so the X axis represents the
    // operator's chosen run length, not just observed-so-far.
    const last = epochs[epochs.length - 1];
    const xMax = Math.max(1, last.epochs || epochs.length);
    const xMin = 1;
    // Loss domain is `[0, max(loss seen)]`.  Clamp at 0 because
    // losses are non-negative.  `maxLoss === 0` keeps a sane
    // axis on an all-zero edge case (rounding fold).
    let maxLoss = 0;
    for (const e of epochs) {
      if (Number.isFinite(e.train_loss) && e.train_loss > maxLoss) maxLoss = e.train_loss;
    }
    if (maxLoss === 0) maxLoss = 1; // empty / all-zero edge case
    // Pad the loss ceiling a little so a value sitting exactly
    // at the observed max doesn't kiss the top of the plot.
    const lossCeil = maxLoss * 1.05;

    const xToPx = (x: number): number => PAD_L + ((x - xMin) / (xMax - xMin || 1)) * plotW;
    const lossToPx = (l: number): number => PAD_T + plotH - (l / lossCeil) * plotH;
    const accToPx = (a: number): number => PAD_T + plotH - a * plotH;

    lastXToPx = xToPx;
    lastEpochs = epochs;

    // ── Accuracy gridlines.  Faint horizontal rules at acc=0.5
    //    and acc=1.0 -- the [0, 1] domain is fixed so the
    //    position of the val_acc line relative to "half" is
    //    legible at a glance even without tick labels.  No loss
    //    gridline because the loss ceiling is per-run; an
    //    unlabelled mid-loss tick would imply a value the
    //    operator can't read. ──
    ctx.strokeStyle = '#f4f4f5'; // zinc-100
    ctx.lineWidth = 1;
    for (const a of [0.5, 1.0]) {
      const y = accToPx(a);
      ctx.beginPath();
      ctx.moveTo(PAD_L, y + 0.5);
      ctx.lineTo(PAD_L + plotW, y + 0.5);
      ctx.stroke();
    }

    // ── Best-val marker.  Vertical dashed rule + filled dot at
    //    the peak val_acc epoch.  Drawn BEFORE the data lines so
    //    the lines paint over the marker where they intersect
    //    (rather than the marker veining the line strokes).
    //    Skipped when valDisabled, when val_acc never landed, or
    //    when there's only one val point (no "peak" to call out
    //    on a single-point series). ──
    const bestIdx = valDisabled ? -1 : findBestValIdx();
    const bestEntry = bestIdx >= 0 ? epochs[bestIdx] : null;
    const bestVal = bestEntry?.val_acc ?? null;
    if (bestEntry !== null && bestVal !== null && countValPoints() > 1) {
      const x = xToPx(bestEntry.epoch);
      const y = accToPx(Math.max(0, Math.min(1, bestVal)));
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)'; // emerald-500 @ 40%
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, PAD_T);
      ctx.lineTo(x + 0.5, PAD_T + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#10b981'; // emerald-500
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Loss line (rose-500).  Drawn before the acc lines so
    //    the acc lines land on top when they overlap visually
    //    (rare but reads cleaner when it happens). ──
    ctx.strokeStyle = '#f43f5e'; // rose-500
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < epochs.length; i++) {
      const e = epochs[i];
      const x = xToPx(e.epoch);
      const y = lossToPx(Math.max(0, e.train_loss));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // ── Val-acc line (emerald-500).  Skip if disabled. ──
    if (!valDisabled) {
      ctx.strokeStyle = '#10b981'; // emerald-500
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const e of epochs) {
        if (e.val_acc === null || !Number.isFinite(e.val_acc)) continue;
        const x = xToPx(e.epoch);
        const y = accToPx(Math.max(0, Math.min(1, e.val_acc)));
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // ── Train-acc line (blue-500, dashed).  Provides a "without
    //    holdout" reference next to val_acc; useful when
    //    val_split is small + the lines diverge late. ──
    ctx.strokeStyle = '#3b82f6'; // blue-500
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    let tStarted = false;
    for (const e of epochs) {
      if (!Number.isFinite(e.train_acc)) continue;
      const x = xToPx(e.epoch);
      const y = accToPx(Math.max(0, Math.min(1, e.train_acc)));
      if (!tStarted) {
        ctx.moveTo(x, y);
        tStarted = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Single-point fallback.  A `stroke()` with one `moveTo`
    //    and no `lineTo` produces no visible mark, so on the
    //    first epoch_completed the chart would otherwise show
    //    only the baseline + gridlines for ~one tick.  Paint
    //    one filled dot per visible series at the lone point
    //    so the first epoch lands visibly.  Skipped for >=2
    //    epochs where the line strokes carry the visual on
    //    their own. ──
    if (epochs.length === 1) {
      const e = epochs[0];
      const x = xToPx(e.epoch);
      if (Number.isFinite(e.train_loss)) {
        ctx.fillStyle = '#f43f5e'; // rose-500
        ctx.beginPath();
        ctx.arc(x, lossToPx(Math.max(0, e.train_loss)), 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (Number.isFinite(e.train_acc)) {
        ctx.fillStyle = '#3b82f6'; // blue-500
        ctx.beginPath();
        ctx.arc(x, accToPx(Math.max(0, Math.min(1, e.train_acc))), 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!valDisabled && e.val_acc !== null && Number.isFinite(e.val_acc)) {
        ctx.fillStyle = '#10b981'; // emerald-500
        ctx.beginPath();
        ctx.arc(x, accToPx(Math.max(0, Math.min(1, e.val_acc))), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Legend pill.  Drawn AFTER the data so the frosted
    //    backplate occludes any series line crossing the pill
    //    region (e.g. val_acc kissing the plot top at 100%).
    //    Drawn BEFORE the hover overlay so the opaque tooltip
    //    -- when it slides toward the right edge -- sits on top
    //    of the pill rather than under it. ──
    drawLegendPill(ctx, PAD_L + plotW, PAD_T);

    // ── Hover overlay.  Crosshair + tooltip box.  Drawn last so
    //    it sits above every other layer.  The overlay is
    //    skipped when no point is hovered OR when the hovered
    //    point is out of range (epochs[] was truncated since
    //    the pointermove fired).  Tooltip is rendered with a
    //    flip if the right-anchored position would clip the
    //    plot region. ──
    if (hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < epochs.length) {
      const e = epochs[hoveredIdx];
      const x = xToPx(e.epoch);
      // Crosshair line.
      ctx.strokeStyle = 'rgba(82, 82, 91, 0.35)'; // zinc-600 @ 35%
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 2]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, PAD_T);
      ctx.lineTo(x + 0.5, PAD_T + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Filled dots on each series at this epoch (loss + train +
      // val).  Skips val on disabled / null val_acc.
      ctx.fillStyle = '#f43f5e'; // rose-500
      ctx.beginPath();
      ctx.arc(x, lossToPx(Math.max(0, e.train_loss)), 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (Number.isFinite(e.train_acc)) {
        ctx.fillStyle = '#3b82f6'; // blue-500
        ctx.beginPath();
        ctx.arc(x, accToPx(Math.max(0, Math.min(1, e.train_acc))), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!valDisabled && e.val_acc !== null && Number.isFinite(e.val_acc)) {
        ctx.fillStyle = '#10b981'; // emerald-500
        ctx.beginPath();
        ctx.arc(x, accToPx(Math.max(0, Math.min(1, e.val_acc))), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // Tooltip box.  Tight three-line layout: epoch, loss,
      // acc-pair.  Width is fixed at 132 px for predictable
      // flip; height is computed from the line count so a
      // valDisabled run gets a tidier two-line box.
      const lines: { label: string; value: string }[] = [
        { label: 'epoch', value: `${e.epoch}` },
        { label: 'loss', value: fmtLoss(e.train_loss) }
      ];
      if (Number.isFinite(e.train_acc)) {
        lines.push({
          label: 'train',
          value: fmtAcc(e.train_acc)
        });
      }
      if (!valDisabled) {
        lines.push({
          label: 'val',
          value: fmtAcc(e.val_acc)
        });
      }
      const ttW = 124;
      const lineH = 12;
      const ttH = 6 + lines.length * lineH;
      // Anchor: 8 px to the right of the crosshair when there's
      // room, else flipped to the left.  Vertical anchor at the
      // top of the plot.
      let ttX = x + 8;
      if (ttX + ttW > PAD_L + plotW) ttX = x - 8 - ttW;
      const ttY = PAD_T + 2;
      // Background + border.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
      ctx.strokeStyle = '#e4e4e7'; // zinc-200
      ctx.lineWidth = 1;
      roundRect(ctx, ttX, ttY, ttW, ttH, 4);
      ctx.fill();
      ctx.stroke();
      // Lines.  Label on left zinc-500, value on right zinc-900
      // mono.  The label/value columns line up across rows so
      // the operator's eye moves down the value column without
      // re-scanning labels.
      ctx.textBaseline = 'top';
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const y = ttY + 4 + i * lineH;
        ctx.fillStyle = '#71717a'; // zinc-500
        ctx.textAlign = 'left';
        ctx.font = '500 9px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(ln.label, ttX + 6, y);
        ctx.fillStyle = '#18181b'; // zinc-900
        ctx.textAlign = 'right';
        ctx.font =
          '500 10px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
        ctx.fillText(ln.value, ttX + ttW - 6, y);
      }
    }
  }

  function countValPoints(): number {
    let n = 0;
    for (const e of epochs) {
      if (e.val_acc !== null && Number.isFinite(e.val_acc)) n++;
    }
    return n;
  }

  // Compact in-plot legend pill -- a frosted-white rounded box
  // anchored to the top-right corner of the plot region.
  // Replaces the previous dedicated `PAD_T` legend strip; the
  // pill sits over the data instead of above it, so the strip's
  // vertical row collapses into the plot and the card shrinks
  // accordingly.  Top-right was picked over the corners with
  // dense data (loss starts at top-left; both acc lines END at
  // top-right) because:
  //   - The frosted backplate (alpha 0.92) makes any underlying
  //     line read as a faint ghost rather than competing chrome.
  //   - The hover tooltip flips to the LEFT of the crosshair
  //     when it would cross the right edge of the plot, so the
  //     tooltip never tries to occupy the pill's column.
  //   - When the tooltip slides under the pill from the centre,
  //     it draws AFTER the pill (full opacity, 0.96 alpha) so
  //     the active read surface always wins the z-order.
  // Renders three items in fixed order (`loss · train · val`);
  // `val` drops when `valDisabled` so the pill never advertises
  // a series the chart isn't drawing.
  function drawLegendPill(ctx: CanvasRenderingContext2D, plotRight: number, plotTop: number): void {
    interface Item {
      // Pre-resolved hex.  Mirrors the data-line stroke hex so
      // a swatch's hue can never drift from the series it
      // documents.
      color: string;
      dashed: boolean;
      label: string;
    }
    const items: Item[] = [
      { color: '#f43f5e', dashed: false, label: 'loss' }, // rose-500
      { color: '#3b82f6', dashed: true, label: 'train' } // blue-500
    ];
    if (!valDisabled) {
      items.push({ color: '#10b981', dashed: false, label: 'val' }); // emerald-500
    }

    const SWATCH_W = 6;
    const SWATCH_GAP = 3;
    const ITEM_GAP = 7;
    const INNER_PAD_X = 5;
    const PILL_H = 13;
    // 4-px inset from the top/right plot edges -- the same
    // visual gap the gridlines use against the plot baseline.
    const EDGE_INSET = 4;

    ctx.font = '500 9px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';

    // Measure inner content width once so we can size the pill
    // and left-anchor items inside it.
    let contentW = 0;
    for (let i = 0; i < items.length; i++) {
      if (i > 0) contentW += ITEM_GAP;
      contentW += SWATCH_W + SWATCH_GAP + ctx.measureText(items[i].label).width;
    }
    const pillW = contentW + INNER_PAD_X * 2;
    const pillX = plotRight - pillW - EDGE_INSET;
    const pillY = plotTop + EDGE_INSET;

    // Frosted backplate.  alpha 0.92 keeps the pill clearly a
    // foreground element while still letting the operator see
    // there's chart underneath (so it doesn't read as an opaque
    // overlay that's "in the way").
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.strokeStyle = '#e4e4e7'; // zinc-200
    ctx.lineWidth = 1;
    roundRect(ctx, pillX, pillY, pillW, PILL_H, 3);
    ctx.fill();
    ctx.stroke();

    const yMid = pillY + PILL_H / 2;
    let x = pillX + INNER_PAD_X;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (i > 0) x += ITEM_GAP;
      // Swatch.  Solid filled rect for solid lines, dashed
      // horizontal rule for the train-acc dashed series so the
      // chip carries the same dash idiom the data line does.
      if (item.dashed) {
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(x, yMid);
        ctx.lineTo(x + SWATCH_W, yMid);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = item.color;
        ctx.fillRect(x, yMid - 1.5, SWATCH_W, 3);
      }
      x += SWATCH_W + SWATCH_GAP;
      // Label -- zinc-600 (one step darker than the previous
      // zinc-500) for better contrast against the frosted
      // backplate, which dilutes label saturation.
      ctx.fillStyle = '#52525b'; // zinc-600
      ctx.textAlign = 'left';
      ctx.fillText(item.label, x, yMid);
      x += ctx.measureText(item.label).width;
    }
  }

  // Loss formatting -- adaptive precision so the hover tooltip's
  // right-aligned value column stays bounded at ≤ 6 chars
  // regardless of loss magnitude (`0.0123`, `1.0e-4`, `12.34`,
  // `234`).  A fixed `toFixed(3)` produced strings up to 8 chars
  // (`999.999`) for an early-epoch blowout run that briefly hit
  // loss ~50, which made the tooltip's value column ragged.
  function fmtLoss(v: number): string {
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return '0';
    const abs = Math.abs(v);
    if (abs < 0.001) return v.toExponential(1); // 1.0e-4
    if (abs < 0.01) return v.toFixed(4); // 0.0012
    if (abs < 1) return v.toFixed(3); // 0.123
    if (abs < 10) return v.toFixed(2); // 1.23
    if (abs < 100) return v.toFixed(1); // 12.3
    return Math.round(v).toString(); // 234
  }

  function fmtAcc(v: number | null): string {
    if (v === null || !Number.isFinite(v)) return '—';
    return `${(v * 100).toFixed(1)}%`;
  }

  // Rounded rectangle helper.  Inlined here so the chart's
  // canvas drawing doesn't pull in a utility helper just for
  // the tooltip box.  Matches the project's 4-px radius for
  // small ephemeral surfaces.
  function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  // Pointer handlers.  Attached to the wrapper (not the canvas)
  // so the hit region matches the bounding box the operator
  // sees; the small 6-px padding gutters around the plot are
  // excluded inside `onPointerMove` so the crosshair never
  // snaps to an epoch when the pointer is sitting in the
  // breathing room rather than on the data.
  function onPointerMove(e: PointerEvent): void {
    if (lastXToPx === null || lastEpochs.length === 0) {
      if (hoveredIdx !== null) {
        hoveredIdx = null;
        scheduleRender();
      }
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    // Outside the plot region (in the 6-px breathing gutters) → no hover.
    const plotW = Math.max(1, (cssW || rect.width) - PAD_L - PAD_R);
    if (px < PAD_L || px > PAD_L + plotW) {
      if (hoveredIdx !== null) {
        hoveredIdx = null;
        scheduleRender();
      }
      return;
    }
    // Find nearest epoch by absolute X distance.  Linear scan;
    // O(n) over a tiny n.
    let bestIdx = 0;
    let bestDx = Infinity;
    for (let i = 0; i < lastEpochs.length; i++) {
      const ex = lastXToPx(lastEpochs[i].epoch);
      const dx = Math.abs(ex - px);
      if (dx < bestDx) {
        bestDx = dx;
        bestIdx = i;
      }
    }
    if (bestIdx !== hoveredIdx) {
      hoveredIdx = bestIdx;
      scheduleRender();
    }
  }

  function onPointerLeave(): void {
    if (hoveredIdx !== null) {
      hoveredIdx = null;
      scheduleRender();
    }
  }

  // Re-render when `epochs` reference changes (Svelte runes
  // create new arrays on every push) or when `valDisabled` flips.
  $effect(() => {
    void epochs;
    void valDisabled;
    scheduleRender();
  });

  let resizeObs: ResizeObserver | null = null;

  onMount(() => {
    if (!wrapperEl) return;
    cssW = wrapperEl.clientWidth;
    needsResize = true;
    scheduleRender();
    resizeObs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = Math.floor(entry.contentRect.width);
        if (next !== cssW) {
          cssW = next;
          needsResize = true;
          scheduleRender();
        }
      }
    });
    resizeObs.observe(wrapperEl);
  });

  onDestroy(() => {
    resizeObs?.disconnect();
    resizeObs = null;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  });
</script>

<!-- Single canvas wrapper.  Every visual layer -- baseline,
     gridlines, data, legend, hover overlay -- is painted into
     the canvas, so the chart reads as one cohesive surface and
     no sibling DOM row eats vertical space.  The legend is now
     an in-plot frosted pill (see `drawLegendPill`); axis labels
     are gone (the hover tooltip + the readout strip below the
     chart in JobProgress carry the numbers). -->
<div
  bind:this={wrapperEl}
  class="relative w-full"
  style="height: {height}px;"
  onpointermove={onPointerMove}
  onpointerleave={onPointerLeave}
  role="img"
  aria-label="Training metrics chart"
>
  <canvas bind:this={canvasEl} class="block h-full w-full rounded-md bg-zinc-50"></canvas>
</div>
