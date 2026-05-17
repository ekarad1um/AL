import { sliceAssetPath } from '$lib/api/endpoints';
import { ApiError } from '$lib/api/http';
import { UploadPool } from '$lib/api/upload';
import { sliceFilename } from '$lib/idb/db';
import { sha256Hex } from './sha256';
import type { ApiErrorBody } from '$lib/api/types';
import type { SliceRecord } from '$lib/idb/db';

// Per-slice WAV-blob fetch + cache.
//
// Three slice flavours converge through one path:
//   1. Local (produced, awaiting / mid-upload): `slice.blob`
//      is populated -- return it directly.
//   2. Committed-local (uploaded, blob dropped from IDB to
//      free origin quota): `slice.blob` is null but the slice
//      exists on the daemon.  Lazy-fetch via the daemon URL.
//   3. Server-only (synthesised by reconcile from a daemon
//      listing): same as case 2 -- lazy-fetch, cache.
//
// Content-addressed cache:
//   Keyed by sha256 (= `slice.id`).  Two slices in different
//   categories with byte-identical content share one cached
//   blob; the daemon HTTP path differs by category but the
//   bytes that flow back are byte-equal by construction.  No
//   per-row eviction -- the cache grows linearly with unique
//   content hashes; `resetDB` is the single reset point.

const MAX_CONCURRENT_DOWNLOADS = 6;
const downloadPool = new UploadPool(MAX_CONCURRENT_DOWNLOADS);

const blobCache = new Map<string, Blob>();
const inflight = new Map<string, Promise<Blob>>();

// Build the daemon URL for one slice.  Single source of truth
// for the asset URI lives in [api/endpoints.ts]; this adapter
// reshapes a `SliceRecord` (deriving the filename from the
// content-addressed id) for callers.
export function sliceAssetUrl(
  slice: Pick<SliceRecord, 'workspace_id' | 'category_name' | 'id'>
): string {
  return sliceAssetPath(slice.workspace_id, slice.category_name, sliceFilename(slice.id));
}

// Return the slice's WAV bytes.  Direct return for local
// slices; lazy fetch + cache for committed / server-only.
// Concurrent calls for the same content hash dedup via
// `inflight` so two SliceCards mounting in the same RAF tick
// share one network round-trip.
export async function getSliceBlob(slice: SliceRecord): Promise<Blob> {
  if (slice.blob && slice.blob.size > 0) return slice.blob;
  const cached = blobCache.get(slice.id);
  if (cached) return cached;
  const pending = inflight.get(slice.id);
  if (pending) return pending;
  const work = (async (): Promise<Blob> => {
    try {
      const blob = await downloadPool.submit(() => fetchSliceBlob(slice));
      blobCache.set(slice.id, blob);
      return blob;
    } finally {
      inflight.delete(slice.id);
    }
  })();
  inflight.set(slice.id, work);
  return work;
}

async function fetchSliceBlob(slice: SliceRecord): Promise<Blob> {
  const resp = await fetch(sliceAssetUrl(slice));
  if (!resp.ok) {
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
  const blob = await resp.blob();
  // Content-addressed integrity check.  The slice id is the
  // sha256 of its WAV bytes by construction (every client
  // uploads under the convention `<sha>.wav`).  Verifying the
  // downloaded bytes here catches three failure classes
  // cheaply:
  //   * Daemon-side on-disk corruption (file rotted between
  //     upload and read).
  //   * Network-layer tampering (MITM, mis-cached proxy).
  //   * Client-side mis-targeting (we asked for the wrong
  //     filename due to a sync bug -- defence in depth).
  // Cost: one sha256 over ~88 KB (~0.1 ms with native crypto).
  // Failures bubble through the same path as a 5xx -- the
  // SliceCard's catch renders without an image; the next
  // visit re-attempts (cache wasn't populated).
  const buf = await blob.arrayBuffer();
  const observed = await sha256Hex(buf);
  if (observed !== slice.id) {
    throw new Error(
      `Slice ${slice.id} content mismatch: daemon returned bytes hashing to ${observed}`
    );
  }
  return blob;
}
