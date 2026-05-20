// Shared visual language for free-typing text inputs.  Matches the
// dashboard `<select>` control on every dimension except text size
// (text-sm here vs text-xs on the select, since the operator types
// into these and needs the extra legibility), and uses a halo-style
// focus ring (`box-shadow`, set globally on `input:focus-visible`
// in [app.css](../../app.css)) so the focus state hugs the input's
// own border instead of floating beside it.
//
// `hasError` swaps the unfocused-state border palette to rose.
// The focused-state rose border + rose halo are handled
// centrally by the `input[aria-invalid='true']:focus-visible`
// rule in `app.css`; callers must pair `inputClass(true)` with
// `aria-invalid={true}` on the element for the focus halo to
// switch to rose.  Doing the focus override in app.css (vs as
// `focus-visible:` utilities here) is load-bearing: Tailwind
// utilities live in `@layer utilities` and would lose to the
// unlayered blue-focus rule above via cascade-layer precedence,
// regardless of selector specificity.
//
// Disabled+hover preserves the static colour so the border never
// flickers mid-submit.
export function inputClass(hasError = false): string {
  const palette = hasError
    ? 'border-rose-300 hover:border-rose-400 disabled:hover:border-rose-300'
    : 'border-zinc-200 hover:border-zinc-300 disabled:hover:border-zinc-200';
  return `block w-full rounded-md border ${palette} bg-white px-2.5 py-1.5 text-sm transition-colors disabled:cursor-wait disabled:bg-zinc-50 disabled:text-zinc-400`;
}
