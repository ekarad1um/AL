// Dataset entry-builder for the unified workspace exporter.
// Lists + fetches the selected categories' slices from the daemon
// and emits a `datasets/<category>/<sha256>.wav` `AlpkgEntry[]`.
// No `package.json`, no packing, no SaveAs trigger -- those live
// in the workspace exporter that prepends the envelope and
// combines this with head entries before one final zip pass.
//
// Why daemon-listed rather than IDB-store-derived: the IDB slice
// store can carry local rows that the daemon hasn't received yet
// (uncommitted uploads).  We export the daemon's view so the
// archive matches a snapshot the importer could have produced on
// its own — no half-uploaded clips silently shipped, no
// "phantom" entries from IDB-only state.

import type { Uuid } from './types';
import { ApiError } from './http';
import { assets } from './endpoints';
import { sliceIdFromFilename } from '$lib/idb/db';
import { getSliceBlob } from '$lib/audio/slice-fetch';
import type { AlpkgEntry } from '$lib/utils/alpkg';

// MARK: Public types

export type DatasetEntriesPhase = 'listing' | 'fetching';

export interface DatasetEntriesProgress {
  phase: DatasetEntriesPhase;
  /// `fetching` only — total slice count across all selected
  /// categories, finalised at the listing → fetching transition.
  itemsTotal?: number;
  /// `fetching` only — count of slices whose bytes have landed
  /// locally.  Monotonic upward across the fetch fan-out.
  itemsDone?: number;
}

/// Typed failure surface for the dataset side of the unified
/// pipeline.  `phase` + optional `category` give the workspace
/// exporter enough context to re-wrap with workspace-level error
/// shape (phase mapping, source attribution) without parsing the
/// message string.
export class DatasetEntriesError extends Error {
  readonly phase: DatasetEntriesPhase;
  /// Category that triggered the failure when phase is `listing`
  /// or `fetching`; null when the pre-flight rejected an empty
  /// selection.
  readonly category: string | null;
  constructor(
    phase: DatasetEntriesPhase,
    category: string | null,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'DatasetEntriesError';
    this.phase = phase;
    this.category = category;
  }
}

// MARK: Internal constants

const MAX_CONCURRENT_FETCHES = 6;
// Cap the per-category listing.  The daemon ships with a per-
// workspace slice cap well below this; the explicit limit guards
// against an accidentally large dataset (or a future limit lift)
// from materialising thousands of WAV byte arrays in memory.
const LISTING_LIMIT = 1000;

interface WorkItem {
  category: string;
  filename: string;
  id: string;
}

// MARK: Public entry point

/// Build the `datasets/<category>/<sha256>.wav` AlpkgEntry list
/// for the supplied categories.  Returns an empty array (not an
/// error) when the categories collectively have no on-disk
/// slices -- the unified exporter handles the "everything was
/// empty" case at its pre-flight.
///
/// Entries are sorted deterministically (category asc, then
/// filename asc) so two exports of an unchanged dataset state
/// produce byte-stable bytes through the packer.
export async function buildDatasetEntries(
  workspaceId: Uuid,
  categories: readonly string[],
  signal: AbortSignal | undefined,
  onprogress?: (p: DatasetEntriesProgress) => void
): Promise<AlpkgEntry[]> {
  if (categories.length === 0) return [];

  // Phase 1 -- listing.  Serial across categories: each daemon
  // listing is tens of ms and the daemon serialises its readdir
  // anyway; fanning out would only add bookkeeping noise.  A 404
  // is the "category exists in IDB only" case (operator-added but
  // never uploaded a slice yet) and is treated as an empty
  // listing.
  emit(onprogress, { phase: 'listing' });
  const items: WorkItem[] = [];
  for (const cat of categories) {
    throwIfAborted(signal, 'listing', cat);
    let listing;
    try {
      listing = await assets.listCategory(workspaceId, cat, { limit: LISTING_LIMIT });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        continue;
      }
      throw new DatasetEntriesError('listing', cat, `Couldn't list slices in "${cat}".`, {
        cause: e
      });
    }
    for (const entry of listing.entries) {
      if (entry.kind !== 'file') continue;
      const id = sliceIdFromFilename(entry.name);
      // Skip foreign-named files (same filter the slices store
      // applies).  Their bytes wouldn't pass the importer's
      // content-addressed integrity check anyway.
      if (id === null) continue;
      items.push({ category: cat, filename: entry.name, id });
    }
  }

  if (items.length === 0) return [];

  // Phase 2 -- fetching.  `getSliceBlob` content-verifies bytes
  // against the slice id (sha256), so a partial /assets path that
  // served the wrong file would surface here rather than silently
  // shipping garbage.  The download pool inside `getSliceBlob`
  // (6-way) caps actual concurrency; the local worker fan-out
  // below just keeps the queue saturated and bookkeeps `done`
  // for the progress callback.
  emit(onprogress, { phase: 'fetching', itemsTotal: items.length, itemsDone: 0 });
  const bytesById = new Map<string, Uint8Array>();
  let done = 0;
  let cursor = 0;
  // First-failure-wins bag.  Workers stop pulling new items as
  // soon as anything lands here; the outer `await Promise.all`
  // re-throws the bag's head so the caller gets one typed error
  // instead of a flurry of unhandled rejections.
  const errors: DatasetEntriesError[] = [];
  const fanout = Math.min(MAX_CONCURRENT_FETCHES, items.length);
  const workers = Array.from({ length: fanout }, async () => {
    while (errors.length === 0) {
      const idx = cursor++;
      if (idx >= items.length) return;
      throwIfAborted(signal, 'fetching', null);
      const item = items[idx];
      // Dedup by content hash: two categories holding the same
      // sha256 share one network fetch + one byte buffer.
      if (bytesById.has(item.id)) {
        done++;
        emit(onprogress, { phase: 'fetching', itemsTotal: items.length, itemsDone: done });
        continue;
      }
      try {
        const blob = await getSliceBlob({
          id: item.id,
          workspace_id: workspaceId,
          category_name: item.category,
          // `getSliceBlob` checks `slice.blob` first; null forces
          // the cache + network path.  The remaining `state`
          // and `created_at` fields aren't read on the lazy-
          // fetch path; default values keep the `SliceRecord`
          // shape happy.
          blob: null,
          state: 'committed',
          created_at: ''
        });
        const buf = await blob.arrayBuffer();
        bytesById.set(item.id, new Uint8Array(buf));
      } catch (e) {
        errors.push(
          new DatasetEntriesError(
            'fetching',
            item.category,
            `Couldn't fetch slice ${item.id.slice(0, 8)}… in "${item.category}".`,
            { cause: e }
          )
        );
        return;
      }
      done++;
      emit(onprogress, { phase: 'fetching', itemsTotal: items.length, itemsDone: done });
    }
  });
  await Promise.all(workers);
  if (errors.length > 0) throw errors[0];

  // Deterministic emission order: by category, then by filename.
  // Two re-exports of an unchanged dataset state yield identical
  // bytes through the packer (the only changing slot is the
  // wall-clock `exported_at` field the workspace exporter writes
  // into `package.json`).
  const sorted = items.slice().sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return a.filename < b.filename ? -1 : 1;
  });
  const entries: AlpkgEntry[] = [];
  for (const item of sorted) {
    const bytes = bytesById.get(item.id);
    if (bytes === undefined) continue; // unreachable: every item populated above
    // Category and filename both sit inside the asset-path
    // allowlist (`[A-Za-z0-9._-]`); the slice id is hex.  No
    // sanitisation needed before joining with `/`.
    entries.push({
      path: `datasets/${item.category}/${item.filename}`,
      bytes
    });
  }
  return entries;
}

// MARK: Internals -- abort + progress

function throwIfAborted(
  signal: AbortSignal | undefined,
  phase: DatasetEntriesPhase,
  category: string | null
): void {
  if (signal?.aborted === true) {
    const reason: unknown = signal.reason;
    const reasonMsg =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'export aborted';
    throw new DatasetEntriesError(phase, category, reasonMsg, { cause: reason });
  }
}

function emit(
  onprogress: ((p: DatasetEntriesProgress) => void) | undefined,
  p: DatasetEntriesProgress
): void {
  if (onprogress) onprogress(p);
}
