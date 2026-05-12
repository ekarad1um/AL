// Dynamic workspace detail.  The id can't be enumerated at build
// time, so this route opts out of the prerender (the layout already
// disables SSR; we restate it here so the contract is local).
export const prerender = false;
export const ssr = false;
