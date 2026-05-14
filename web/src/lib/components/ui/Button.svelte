<script lang="ts">
  import type { Snippet } from 'svelte';
  import Spinner from '$lib/components/Spinner.svelte';

  // Three semantic variants cover everything Slice B.1 needs:
  //   primary     -- confirmatory / create / save
  //   secondary   -- cancel / dismiss / non-destructive alt
  //   destructive -- delete / remove
  // Sizes match the existing tab + select rhythm at `text-sm /
  // py-1.5` (sm uses `text-xs / py-1`).  `px-3.5` (vs `px-3`) is the
  // NOTES.md "action button" footprint -- gives the label a touch
  // more breathing room than tabs / menu items.
  export type ButtonVariant = 'primary' | 'secondary' | 'destructive';
  export type ButtonSize = 'sm' | 'md';

  interface Props {
    children?: Snippet;
    variant?: ButtonVariant;
    size?: ButtonSize;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    // When true, renders a small spinner before the label, blocks
    // clicks, and switches the cursor to `wait` -- matches the
    // dashboard's `disabled:cursor-wait` idiom for in-flight controls.
    loading?: boolean;
    // Owner-supplied accessibility hint when the visible label alone
    // isn't enough (e.g. icon-led buttons).
    ariaLabel?: string;
    title?: string;
    onclick?: (e: MouseEvent) => void;
    // Escape hatch for one-off layout tweaks (e.g. `w-full` inside a
    // dialog footer).  Concatenated after the base classes.
    class?: string;
  }
  let {
    children,
    variant = 'primary',
    size = 'md',
    type = 'button',
    disabled = false,
    loading = false,
    ariaLabel,
    title,
    onclick,
    class: extraClass = ''
  }: Props = $props();

  const VARIANT_CLASSES: Readonly<Record<ButtonVariant, string>> = {
    primary:
      'bg-blue-500 text-white border-blue-500 hover:bg-blue-600 hover:border-blue-600 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:border-zinc-200',
    secondary:
      'bg-white text-zinc-900 border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 disabled:bg-zinc-50 disabled:text-zinc-400 disabled:border-zinc-200',
    destructive:
      'bg-rose-600 text-white border-rose-600 hover:bg-rose-700 hover:border-rose-700 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:border-zinc-200'
  };

  const SIZE_CLASSES: Readonly<Record<ButtonSize, string>> = {
    sm: 'text-xs px-2.5 py-1',
    md: 'text-sm px-3.5 py-1.5'
  };

  let isDisabled = $derived(disabled || loading);
</script>

<button
  {type}
  disabled={isDisabled}
  aria-label={ariaLabel}
  {title}
  {onclick}
  class="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium transition duration-200 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100 {SIZE_CLASSES[
    size
  ]} {VARIANT_CLASSES[variant]} {loading ? 'cursor-wait' : ''} {extraClass}"
>
  {#if loading}
    <!-- Strip the spinner's default `text-blue-500` so its stroke
         (`currentColor`) inherits from the button -- white on
         primary/destructive, zinc on secondary. -->
    <Spinner class="h-3 w-3" />
  {/if}
  {@render children?.()}
</button>
