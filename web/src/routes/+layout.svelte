<script lang="ts">
  import '../app.css';
  import { onDestroy, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { health } from '$lib/stores/health.svelte';
  import { config } from '$lib/stores/config.svelte';
  import HealthBadge from '$lib/components/HealthBadge.svelte';

  interface Props {
    children?: Snippet;
  }
  let { children }: Props = $props();

  const TABS = [
    { href: resolve('/'), label: 'Dashboard' },
    { href: resolve('/workspace'), label: 'Workspace' },
    { href: resolve('/converter'), label: 'Converter' }
  ];

  function isActive(href: string): boolean {
    const root = resolve('/');
    if (href === root) return page.url.pathname === root;
    return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
  }

  let currentTabLabel = $derived(TABS.find((t) => isActive(t.href))?.label ?? 'Menu');

  // At <sm the 3-tab row is replaced by a "current tab + chevron"
  // drop-down.  Dismissal mirrors HealthBadge (tap outside, Escape,
  // focusout) plus route change.
  let mobileMenuOpen = $state(false);
  let mobileMenuWrapper = $state<HTMLDivElement | undefined>();

  function closeMobileMenu(): void {
    mobileMenuOpen = false;
  }
  function toggleMobileMenu(): void {
    mobileMenuOpen = !mobileMenuOpen;
  }
  function onMobileMenuFocusOut(e: FocusEvent): void {
    const next = e.relatedTarget as Node | null;
    if (!next || !mobileMenuWrapper?.contains(next)) closeMobileMenu();
  }

  // Auto-close on actual route changes (covers keyboard navigation too).
  // `lastPath` is intentionally a plain `let`, not $state: we don't want
  // reading/writing it inside the effect to retrigger the effect -- only
  // page.url.pathname is the real dependency.
  let lastPath: string | null = null;
  $effect(() => {
    const p = page.url.pathname;
    if (lastPath !== null && lastPath !== p) mobileMenuOpen = false;
    lastPath = p;
  });

  $effect(() => {
    if (!mobileMenuOpen) return;
    const onDown = (e: PointerEvent): void => {
      const root = mobileMenuWrapper;
      if (!root) return;
      if (!root.contains(e.target as Node | null)) closeMobileMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMobileMenu();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  });

  // Throttle ref for the auto-reconnect $effect below.  Plain `let`
  // (not `$state`) so writes don't re-fire the effect -- if this
  // were reactive, scheduling the timer would itself re-enter the
  // effect and defeat the whole purpose.  Cleared on recovery,
  // on health-unreachable transitions, and on component destroy.
  let pendingRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const RETRY_THROTTLE_MS = 2_000;

  // Bootstrap at script level (not onMount): children's onMount fires
  // bottom-up so a parent onMount wouldn't have these stores ready
  // when the canvases / poller / etc mount.  ssr=false in +layout.ts
  // keeps this browser-only.
  //
  // Streams are NOT started here.  The opus + inference WebSockets
  // are gated on `streams.acquire()` refcount; pages that need them
  // (dashboard, deploy-preview, InputPane stream capture) acquire on
  // mount and dispose on unmount.  Routes that never read the live
  // stream (workspace list, converter, workspace-detail with preview
  // off + no stream-input) no longer burn the worker's ~50 Hz Opus
  // decode loop + 16 KB/s daemon bandwidth.
  health.start();
  void config.refresh();
  onDestroy(() => {
    health.stop();
    if (pendingRefreshTimer !== null) {
      clearTimeout(pendingRefreshTimer);
      pendingRefreshTimer = null;
    }
  });

  // Auto-reconnect REST config when the daemon comes back up.  Health
  // already polls /api/v1/status every 2 s; we piggyback on its
  // transitions rather than run a separate retry timer.  The
  // `config.error !== null` guard keeps the effect inert on the steady-
  // state path -- only a failed config + reachable backend triggers a
  // refresh.  `unhealthy` is a reachable state (subsystem fault, not
  // transport) so it must also retry config.  WS streams reconnect via
  // the worker's own backoff.
  //
  // Throttled to one attempt per RETRY_THROTTLE_MS.  Previously every
  // failed `config.refresh` mutated `config.error`, which re-triggered
  // this effect synchronously, which called `refresh` again -- and
  // when the daemon was failing fast (4xx returns at ~50-200 ms RTT)
  // the loop spun at network speed, pinning the browser thread with
  // config-store mutations + Svelte re-renders.  The same loop fires
  // after any user action that goes through `config.guard` (deploy a
  // head, set mic policy, set inference cadence) because the guard
  // also sets `config.error`.  setTimeout-based throttle queues
  // retries with a 2 s floor and cancels the pending timer when the
  // error clears (manual recovery) or the daemon becomes unreachable
  // (no point retrying).  The schedule is idempotent: a re-fire while
  // a timer is pending no-ops rather than double-scheduling, so a
  // rapidly-changing error message (e.g. "msg1" → "msg2") still
  // respects the original wait window.
  $effect(() => {
    const level = health.level;
    const reachable = level === 'ok' || level === 'degraded' || level === 'unhealthy';

    if (!reachable || config.error === null) {
      // Recovered or unreachable: cancel any pending retry.  A late
      // timer firing after recovery would run a redundant refresh;
      // after unreachable, refresh would fail and re-enter the loop.
      if (pendingRefreshTimer !== null) {
        clearTimeout(pendingRefreshTimer);
        pendingRefreshTimer = null;
      }
      return;
    }

    // Already throttled — don't double-schedule.  Holds the original
    // wait window across mid-flight error-message updates.
    if (pendingRefreshTimer !== null) return;

    pendingRefreshTimer = setTimeout(() => {
      pendingRefreshTimer = null;
      void config.refresh();
    }, RETRY_THROTTLE_MS);
  });
</script>

<div class="flex min-h-screen flex-col">
  <!-- sm+: wordmark + inline tabs + labelled badge.
       <sm: dot-only logo + "current tab ▾" dropdown + dot-only badge.
       Contextual dropdown beats a generic hamburger for 3 tabs because
       the operator always sees where they are. -->
  <header class="border-b border-zinc-200 bg-white">
    <div class="mx-auto flex h-14 max-w-7xl items-center justify-between gap-2 px-4 sm:gap-4">
      <div class="flex min-w-0 items-center gap-3 sm:gap-6">
        <a
          href={resolve('/')}
          class="flex shrink-0 items-center gap-2 text-zinc-900"
          aria-label="AcousticsLab home"
        >
          <span class="inline-block h-2.5 w-2.5 rounded-full bg-blue-500"></span>
          <span class="hidden text-base font-semibold tracking-tight sm:inline">AcousticsLab</span>
        </a>

        <!-- Mobile drop-down nav (≤ sm) -->
        <div
          bind:this={mobileMenuWrapper}
          class="relative sm:hidden"
          role="group"
          aria-label="Primary navigation"
          onfocusout={onMobileMenuFocusOut}
        >
          <!-- Trigger + menu unified at text-sm (matches desktop nav).
               px-3 py-1.5 matches the HealthBadge button's geometry. -->
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 transition hover:border-zinc-300"
            aria-expanded={mobileMenuOpen}
            aria-haspopup="menu"
            onclick={toggleMobileMenu}
          >
            <span>{currentTabLabel}</span>
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              class="h-3.5 w-3.5 text-zinc-500 transition-transform duration-150"
              class:rotate-180={mobileMenuOpen}
              aria-hidden="true"
            >
              <path
                fill-rule="evenodd"
                d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.4a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
                clip-rule="evenodd"
              />
            </svg>
          </button>

          {#if mobileMenuOpen}
            <div
              role="menu"
              aria-label="Primary navigation"
              class="absolute top-full left-0 z-30 mt-2 min-w-44 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg"
            >
              {#each TABS as tab (tab.href)}
                <a
                  href={tab.href}
                  role="menuitem"
                  onclick={closeMobileMenu}
                  class="block rounded-md px-4 py-2 text-sm font-medium transition"
                  class:bg-zinc-100={isActive(tab.href)}
                  class:text-zinc-900={isActive(tab.href)}
                  class:text-zinc-600={!isActive(tab.href)}
                  class:hover:bg-zinc-50={!isActive(tab.href)}
                  class:hover:text-zinc-900={!isActive(tab.href)}>{tab.label}</a
                >
              {/each}
            </div>
          {/if}
        </div>

        <!-- Desktop inline nav (sm+) -->
        <nav class="hidden items-center gap-1 sm:flex">
          {#each TABS as tab (tab.href)}
            <a
              href={tab.href}
              class="rounded-md px-3 py-1.5 text-sm font-medium transition"
              class:bg-zinc-100={isActive(tab.href)}
              class:text-zinc-900={isActive(tab.href)}
              class:text-zinc-500={!isActive(tab.href)}
              class:hover:text-zinc-900={!isActive(tab.href)}>{tab.label}</a
            >
          {/each}
        </nav>
      </div>

      <div class="flex shrink-0 items-center gap-3">
        <HealthBadge />
      </div>
    </div>
  </header>

  <main class="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
    {@render children?.()}
  </main>
</div>
