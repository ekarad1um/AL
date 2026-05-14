import { sliceAssetPath } from '$lib/api/endpoints';
import { ApiError } from '$lib/api/http';
import { UploadPool } from '$lib/api/upload';
import type { ApiErrorBody } from '$lib/api/types';
import type { SliceRecord } from '$lib/idb/db';

// Per-slice WAV-blob fetch + cache.
//
// Three slice flavours converge through one path:
//   1. Local (just produced, awaiting / mid-upload):
//        `slice.blob` is populated -- return it directly.
//   2. Committed-local (was local, upload succeeded, blob
//      dropped from IDB to free origin quota):
//        `slice.blob` is null but the slice exists on the daemon.
//        We fetch the bytes via `GET /assets/datasets/<class>/
//        <filename>` once per session and cache.
//   3. Server-only (synthesised by category sync from a daemon
//      listing the operator never had locally):
//        same as case 2 -- fetch on demand, cache.
//
// The cache is module-scope so it survives component unmount /
// remount within one tab session (e.g. operator collapses a
// category then re-expands it).  Revocation is explicit: the
// slices store calls `revokeSliceBlobs` on per-row delete +
// per-category clear + per-workspace forget so the browser can
// GC the underlying ArrayBuffer.

// Bounded-concurrency cap on simultaneous slice-bytes GETs.  A
// category expanding with N server-only slices would otherwise
// open N concurrent XHRs (one per SliceCard mounting in the same
// frame); 6 is the same shape the upload side already follows
// (`UploadPool` -- the class is generic, the name is historical),
// just tuned higher because GETs cheap-on-the-daemon-side don't
// share the upload's tempfile + fsync per request cost.  Inflight
// dedup still happens at the `inflight` map below so two cards
// racing for the same id share one slot, not one each.
const MAX_CONCURRENT_DOWNLOADS = 6;
const downloadPool = new UploadPool(MAX_CONCURRENT_DOWNLOADS);

const blobCache = new Map<string, Blob>();
const inflight = new Map<string, Promise<Blob>>();
// Per-id owner token used by the identity check in `getSliceBlob`
// (see the block comment there for the full rationale).  We can't
// use the IIFE's `work` Promise as the identity tag directly --
// TypeScript's "used-before-assigned" flow analysis flags the
// closure capture, since `work` is read inside an async closure
// while the `const work = ...` initializer is still evaluating.
// An auxiliary symbol map gives the same race-safe semantics
// without the TDZ-shaped TypeScript error: the symbol is created
// synchronously *before* the IIFE, captured by the closure cleanly,
// and `revokeSliceBlobs` clears it in lock-step with the inflight
// + cache entries.  Symbol vs counter / wrapper-object: symbols
// are nominally unique by construction (no collision concerns
// across re-entrant calls) and intent-revealing as identity tokens.
const inflightTokens = new Map<string, symbol>();

// Build the daemon URL for one slice.  Single source of truth for
// the asset URI lives in [api/endpoints.ts]; this adapter just
// reshapes a `SliceRecord` into the three positional fields the
// builder expects so callers can pass a slice directly.
export function sliceAssetUrl(
  slice: Pick<SliceRecord, 'workspace_id' | 'category_name' | 'filename'>
): string {
  return sliceAssetPath(slice.workspace_id, slice.category_name, slice.filename);
}

// Return the slice's WAV bytes.  Direct return for local slices;
// lazy fetch + cache otherwise.  Concurrent calls for the same
// id dedup via `inflight` so two SliceCards mounting at the same
// RAF tick share one network round-trip.
//
// Race-safety against `revokeSliceBlobs` mid-fetch is encoded by
// **per-call owner tokens** in `inflightTokens`: the post-await
// cache write only happens when the id's token STILL matches
// the one this IIFE allocated.  If `revokeSliceBlobs` cleared
// the token while the fetch was in flight (slice deleted,
// category wiped, workspace forgotten), the comparison fails
// and we skip the `blobCache.set` so the cache cannot carry
// orphan bytes past the revoke.  We deliberately let the
// resolved blob flow back to whoever is awaiting `work`: a Play
// / Spectrogram task the operator started just before revoke
// is a single-shot effect, and the caller's component is
// usually being torn down anyway -- the blob is GC'd as soon
// as the awaiter returns.  Aborting the underlying fetch would
// save ~88 KB of bandwidth per race but at the cost of
// rejecting those single-shot tasks with `AbortError`, which
// is a poor trade for the operator (their click had effect;
// the audio plays once; the card then disappears).
//
// `finally` clears `inflight` + `inflightTokens` on BOTH success
// and failure -- an earlier `.then`-only chain leaked the
// rejected promise so a transient network blip on the first
// fetch poisoned every subsequent retry for the same id with
// the cached rejection (callers `await inflight.get(id)` and
// re-throw the stored error without re-firing the fetch).  The
// identity check in the finally is symmetric with the one in
// the success path: a revoke (or a later getSliceBlob that
// already replaced the token with its own) means we MUST NOT
// touch the inflight slot -- it isn't ours.
export async function getSliceBlob(slice: SliceRecord): Promise<Blob> {
  if (slice.blob && slice.blob.size > 0) return slice.blob;
  const cached = blobCache.get(slice.id);
  if (cached) return cached;
  const pending = inflight.get(slice.id);
  if (pending) return pending;
  // Allocate the owner token BEFORE the IIFE so the closure
  // captures a fully-initialised binding -- this is the entire
  // point of the auxiliary token map (see `inflightTokens`).
  const token = Symbol();
  inflightTokens.set(slice.id, token);
  const work = (async (): Promise<Blob> => {
    try {
      const blob = await downloadPool.submit(() => fetchSliceBlob(slice));
      // Identity check before caching: only write if we're still
      // the owning in-flight task.  Revoke clears the token
      // entirely; a later `getSliceBlob` after revoke replaces it
      // with its own token.  In either case `inflightTokens.get`
      // no longer returns this IIFE's token and the cache write
      // is skipped -- the resolved blob still flows back to the
      // awaiter, but the cache cannot carry orphan bytes past
      // the revoke.
      if (inflightTokens.get(slice.id) === token) {
        blobCache.set(slice.id, blob);
      }
      return blob;
    } finally {
      // Symmetric identity check: a revoke or a successor
      // `getSliceBlob` means the slot isn't ours to clean up.
      // Without this guard, our finally would clobber a fresh
      // successor's `inflight` / `inflightTokens` entries mid-
      // fetch and break their dedup.
      if (inflightTokens.get(slice.id) === token) {
        inflight.delete(slice.id);
        inflightTokens.delete(slice.id);
      }
    }
  })();
  inflight.set(slice.id, work);
  return work;
}

// Revoke + drop cache entries for the given slice ids.  Called by
// the slices store on per-row delete + per-category clear +
// per-workspace forget + orphan-GC paths.  Iterable rather than
// array so callers can pass a `Set` / `Map.keys()` directly.
//
// Clearing the inflight token is load-bearing for the identity
// check in `getSliceBlob`: with the token cleared, an in-flight
// IIFE's post-await check fails and the resolved blob is dropped
// on the floor instead of repopulating the cache.  Without it,
// a fetch that started just before the revoke would silently
// rebuild the cache for a deleted slice and the bytes would leak
// until the tab closed.  The `inflight` map entry is cleared in
// the same step so a follow-up `getSliceBlob` for the same id
// (rare but valid: the same UUID could in principle resurface if
// the daemon re-listed an identically-named file) goes through
// a fresh fetch path instead of awaiting the stale promise.
export function revokeSliceBlobs(sliceIds: Iterable<string>): void {
  for (const id of sliceIds) {
    blobCache.delete(id);
    inflight.delete(id);
    inflightTokens.delete(id);
  }
}

async function fetchSliceBlob(slice: SliceRecord): Promise<Blob> {
  const resp = await fetch(sliceAssetUrl(slice));
  if (!resp.ok) {
    // Parse the daemon's error envelope so the call site can map
    // 404 / 409 / 500 to operator copy via the existing
    // `errorCopy` helper.  `await resp.json()` returns `any`; we
    // assert to `ApiErrorBody` after a structural check so the
    // ApiError constructor receives the typed shape.
    let body: ApiErrorBody;
    try {
      const parsed: unknown = await resp.json();
      body =
        parsed && typeof parsed === 'object' && 'error' in parsed && 'code' in parsed
          ? (parsed as ApiErrorBody)
          : { error: resp.statusText || `HTTP ${resp.status}`, code: 'unknown' };
    } catch {
      body = { error: resp.statusText || `HTTP ${resp.status}`, code: 'unknown' };
    }
    throw new ApiError(resp.status, body);
  }
  return resp.blob();
}
