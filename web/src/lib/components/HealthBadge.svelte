<script lang="ts">
  import { health } from '$lib/stores/health.svelte';

  let open = $state(false);
  let wrapper = $state<HTMLDivElement | undefined>();
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  // Dismissal covers three input modes:
  //   - hover: mouseenter/mouseleave on the wrapper; the 8 px gap
  //     between trigger and popover is bridged by a transparent span
  //     so the hover scope stays contiguous.
  //   - tap: click toggles; document pointerdown outside dismisses
  //     (single PointerEvent listener unifies touch/pen/mouse).
  //   - keyboard: Enter/Space hits the button's native click; focusout
  //     (focus left the wrapper) closes; Escape closes while open.
  //
  // No focus-to-open path: a tap focuses *then* clicks, so opening on
  // focusin would race the click toggle.

  function cancelClose(): void {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }
  function scheduleClose(): void {
    cancelClose();
    closeTimer = setTimeout(() => {
      open = false;
      closeTimer = null;
    }, 120);
  }
  function openNow(): void {
    cancelClose();
    open = true;
  }
  function closeNow(): void {
    cancelClose();
    open = false;
  }
  function toggle(): void {
    if (open) closeNow();
    else openNow();
  }

  // Outside-tap dismissal.  Only attached while open so the closed
  // state has zero event cost.
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const root = wrapper;
      if (!root) return;
      if (!root.contains(e.target as Node | null)) closeNow();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
    };
  });

  // Escape key -- only attached while open.
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeNow();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  });

  // Clear any pending close timer on unmount.
  $effect(() => {
    return () => {
      cancelClose();
    };
  });

  const COLORS = {
    unknown: { dot: 'bg-zinc-400', label: 'connecting' },
    ok: { dot: 'bg-emerald-500', label: 'healthy' },
    degraded: { dot: 'bg-amber-500', label: 'degraded' },
    down: { dot: 'bg-rose-500', label: 'unreachable' }
  } as const;

  let palette = $derived(COLORS[health.level]);

  function formatUptime(s: number): string {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  // Close only when focus leaves the wrapper entirely.  relatedTarget
  // is null when focus moves to a non-focusable element or out of the
  // document -- treat both as "left the scope".
  function onFocusOut(e: FocusEvent): void {
    const next = e.relatedTarget as Node | null;
    if (!next || !wrapper?.contains(next)) closeNow();
  }
</script>

<div
  bind:this={wrapper}
  class="relative inline-block"
  role="group"
  aria-label="System health"
  onmouseenter={openNow}
  onmouseleave={scheduleClose}
  onfocusout={onFocusOut}
>
  <!-- `py-3 sm:py-1.5`: at <sm the label is hidden, so equal vertical
       and horizontal padding turns the button into a 34x34 circle under
       `rounded-full`.  At sm+ it reverts to the 34x22 pill with label. -->
  <button
    type="button"
    class="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-3 text-xs font-medium text-zinc-700 capitalize shadow-sm transition hover:border-zinc-300 sm:py-1.5"
    aria-expanded={open}
    aria-haspopup="dialog"
    onclick={toggle}
  >
    <span class="relative flex h-2.5 w-2.5">
      {#if health.level === 'ok'}
        <span
          class="absolute inline-flex h-full w-full animate-pulse-ring rounded-full {palette.dot}"
        ></span>
      {/if}
      <span
        class="relative inline-flex h-2.5 w-2.5 rounded-full transition-colors duration-300 {palette.dot}"
      ></span>
    </span>
    <span class="hidden sm:inline">{palette.label}</span>
  </button>

  {#if open}
    <!-- Bridges the 8 px gap so the hover scope is contiguous between
         trigger and popover (otherwise the cursor falls into dead space
         and starts the close timer). -->
    <div
      aria-hidden="true"
      class="absolute right-0 top-full z-30 h-2 w-80 max-w-[calc(100vw-2rem)]"
    ></div>
    <div
      role="dialog"
      aria-label="System health"
      tabindex="-1"
      class="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-200 bg-white p-4 text-sm shadow-lg"
    >
      {#if health.lastError}
        <p class="font-medium text-rose-700">Daemon unreachable</p>
        <p class="mt-1 text-xs text-zinc-500">{health.lastError}</p>
      {:else if !health.snapshot}
        <p class="text-zinc-500">waiting for first status snapshot…</p>
      {:else}
        {@const snap = health.snapshot}
        <div class="mb-3 flex items-center justify-between">
          <p class="text-xs font-semibold uppercase tracking-wide text-zinc-500">Subsystems</p>
          {#if health.lastUpdated}
            <p class="text-[10px] font-mono text-zinc-400">
              {Math.round((Date.now() - health.lastUpdated) / 100) / 10}s ago
            </p>
          {/if}
        </div>
        <ul class="space-y-1.5">
          {#each Object.entries(snap.subsystems) as [name, sub] (name)}
            <li class="flex items-center justify-between gap-2">
              <span class="font-mono text-xs text-zinc-700">{name}</span>
              <span class="flex items-center gap-2">
                {#if sub.degraded_reason}
                  <span class="truncate text-xs text-amber-700" title={sub.degraded_reason}
                    >{sub.degraded_reason}</span
                  >
                {/if}
                <span
                  class="inline-block h-2 w-2 rounded-full"
                  class:bg-emerald-500={sub.healthy && !sub.stale}
                  class:bg-amber-500={sub.healthy && sub.stale}
                  class:bg-rose-500={!sub.healthy}
                ></span>
              </span>
            </li>
          {/each}
        </ul>

        <div class="mt-3 grid grid-cols-3 gap-3 border-t border-zinc-100 pt-3 text-xs">
          <div>
            <div class="font-mono text-zinc-800">{snap.cpu_pct.toFixed(1)}%</div>
            <div class="text-zinc-400">cpu</div>
          </div>
          <div>
            <div class="font-mono text-zinc-800">{(snap.mem_rss_kb / 1024).toFixed(0)} MiB</div>
            <div class="text-zinc-400">rss</div>
          </div>
          <div>
            <div class="font-mono text-zinc-800">
              {(snap.disk_free_kb / 1024 / 1024).toFixed(1)} GiB
            </div>
            <div class="text-zinc-400">disk free</div>
          </div>
        </div>

        <div
          class="mt-3 flex items-center justify-between border-t border-zinc-100 pt-3 text-[11px] text-zinc-500"
        >
          <span
            >uptime <span class="font-mono text-zinc-700">{formatUptime(snap.uptime_s)}</span></span
          >
          {#if snap.broadcast_audio_messages_dropped + snap.broadcast_inference_messages_dropped > 0}
            <span class="text-amber-700"
              >dropped: {snap.broadcast_audio_messages_dropped +
                snap.broadcast_inference_messages_dropped}</span
            >
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
