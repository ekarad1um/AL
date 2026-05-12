<script lang="ts">
  import type { Snippet } from 'svelte';

  // Centred zero-content placard.  Used wherever a list, grid, or
  // table has nothing to show -- always pairs with a CTA snippet so
  // the operator never lands in a true dead end (Forgiveness &
  // User Control, ARCHITECTURE.md §C.3.5).
  interface Props {
    title: string;
    description?: string;
    // Action affordance(s) (e.g. "Create workspace" button).  Snippet
    // form keeps the empty state a presentational shell; owners
    // wire their own button + handler.
    action?: Snippet;
    // Inline SVG / icon to lead the placard.  Optional -- without
    // it the placard reads as text-only and stays compact.
    icon?: Snippet;
  }
  let { title, description, action, icon }: Props = $props();
</script>

<div
  class="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-6 py-12 text-center"
>
  {#if icon}
    <div class="text-zinc-400">
      {@render icon()}
    </div>
  {/if}
  <h3 class="text-sm font-semibold text-zinc-900">{title}</h3>
  {#if description}
    <p class="max-w-sm text-xs text-zinc-500">{description}</p>
  {/if}
  {#if action}
    <div class="mt-1">
      {@render action()}
    </div>
  {/if}
</div>
