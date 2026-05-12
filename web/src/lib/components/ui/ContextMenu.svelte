<script lang="ts" module>
  export interface MenuItem {
    label: string;
    onclick: () => void;
    variant?: 'default' | 'destructive';
    disabled?: boolean;
    // Optional keyboard hint (e.g. "Enter").  Pure presentation --
    // we don't bind the shortcut globally; the owner is responsible
    // for installing any real listeners.
    hint?: string;
  }

  export interface MenuSection {
    items: MenuItem[];
  }
</script>

<script lang="ts">
  import { fade } from 'svelte/transition';

  // Custom right-click context menu.  Owners capture the
  // `contextmenu` event on their surface, preventDefault, and pass
  // (x, y, sections) here; the menu paints at the cursor, auto-
  // shifts to stay in-viewport, and self-dismisses on Escape,
  // outside click, scroll, or window resize.
  interface Props {
    open: boolean;
    x: number;
    y: number;
    sections: MenuSection[];
    onclose: () => void;
  }
  let { open, x, y, sections, onclose }: Props = $props();

  let menuEl = $state<HTMLDivElement | undefined>();
  // Measured after first paint so we can flip the menu's anchor if
  // the cursor was too close to a viewport edge.  Until we have a
  // measurement we render at the raw cursor coords; the very first
  // frame may be slightly mispositioned but the fade-in masks it.
  let measured = $state({ w: 0, h: 0 });

  $effect(() => {
    if (!open) {
      measured = { w: 0, h: 0 };
      return;
    }
    if (!menuEl) return;
    const el = menuEl;
    requestAnimationFrame(() => {
      measured = { w: el.offsetWidth, h: el.offsetHeight };
    });
  });

  // Hard-coded gutter so we never sit flush against a viewport
  // edge; matches `gap-2` rhythm elsewhere.
  const EDGE_GUTTER = 8;
  const computedX = $derived.by(() => {
    if (!measured.w) return x;
    return Math.max(EDGE_GUTTER, Math.min(x, window.innerWidth - measured.w - EDGE_GUTTER));
  });
  const computedY = $derived.by(() => {
    if (!measured.h) return y;
    return Math.max(EDGE_GUTTER, Math.min(y, window.innerHeight - measured.h - EDGE_GUTTER));
  });

  // Dismissal: pointerdown outside the menu, Escape anywhere,
  // scroll (anywhere -- the menu is fixed to the viewport, so a
  // scroll would leave it stranded), and window resize (same).
  $effect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent): void => {
      const root = menuEl;
      if (!root) return;
      if (!root.contains(e.target as Node | null)) onclose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onclose();
      }
    };
    const onScroll = (): void => onclose();
    const onResize = (): void => onclose();
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  });

  function activate(item: MenuItem): void {
    if (item.disabled) return;
    item.onclick();
    onclose();
  }
</script>

{#if open}
  <div
    bind:this={menuEl}
    role="menu"
    aria-orientation="vertical"
    style="position: fixed; left: {computedX}px; top: {computedY}px;"
    class="z-50 min-w-48 rounded-md border border-zinc-200 bg-white py-1 shadow-lg"
    transition:fade={{ duration: 100 }}
  >
    {#each sections as section, i (i)}
      {#if i > 0}
        <div class="my-1 h-px bg-zinc-100" role="separator"></div>
      {/if}
      {#each section.items as item, j (j)}
        <button
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onclick={() => activate(item)}
          class="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-xs transition disabled:cursor-not-allowed disabled:text-zinc-400 {item.variant ===
          'destructive'
            ? 'text-rose-700 hover:bg-rose-50 disabled:hover:bg-transparent'
            : 'text-zinc-800 hover:bg-zinc-100 disabled:hover:bg-transparent'}"
        >
          <span>{item.label}</span>
          {#if item.hint}
            <span class="font-mono text-[10px] text-zinc-400">{item.hint}</span>
          {/if}
        </button>
      {/each}
    {/each}
  </div>
{/if}
