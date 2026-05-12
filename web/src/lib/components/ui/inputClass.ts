// Shared visual language for free-typing text inputs.  Matches the
// dashboard `<select>` control on every dimension except text size
// (text-sm here vs text-xs on the select, since the operator types
// into these and needs the extra legibility), and uses a halo-style
// focus ring (`box-shadow`, set globally on `input:focus-visible`
// in [app.css](../../app.css)) so the focus state hugs the input's
// own border instead of floating beside it.
//
// `hasError` swaps the border palette to rose and adds a rose-
// tinted focus halo of the same geometry so the error state stays
// readable even while focused.  Disabled+hover preserves the
// static colour so the border never flickers mid-submit.
export function inputClass(hasError = false): string {
  const palette = hasError
    ? 'border-rose-300 hover:border-rose-400 disabled:hover:border-rose-300 focus-visible:border-rose-500 focus-visible:shadow-[0_0_0_3px_rgb(244_63_94_/_0.18)]'
    : 'border-zinc-200 hover:border-zinc-300 disabled:hover:border-zinc-200';
  return `block w-full rounded-md border ${palette} bg-white px-2.5 py-1.5 text-sm transition-colors disabled:cursor-wait disabled:bg-zinc-50 disabled:text-zinc-400`;
}
