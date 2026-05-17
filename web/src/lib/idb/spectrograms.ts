import { getDB, STORE_SPECTROGRAMS, type SpectrogramRecord } from './db';

// Typed CRUD over the `spectrograms` object store.
//
// Keyed by the slice's sha256 (= `SliceRecord.id`).  Content-
// addressed: the PNG is a deterministic function of the WAV
// bytes' content, so a cache row is valid forever for a given
// hash.  Two slices in different categories with byte-identical
// content share one row.
//
// Persisting the rendered PNG (vs holding only a `blob:` URL
// in module-scope memory) means a tab refresh, route swap, or
// device sleep doesn't burn the WAV decode + FFT + colour-map
// pass for every visible slice card.  ~3-4 KB per slice * a few
// hundred slices per session = trivial origin-quota footprint.
//
// No per-row eviction API: spectrograms are content-addressed,
// so a delete from any single (workspace, category) doesn't
// imply the hash is no-longer-referenced -- another slice may
// still rely on it.  The cache grows linearly with unique
// content hashes seen in the tab session; `resetDB` is the
// single reset point.

export async function getSpectrogramRecord(
  sha256: string
): Promise<SpectrogramRecord | undefined> {
  const db = await getDB();
  return db.get(STORE_SPECTROGRAMS, sha256);
}

export async function putSpectrogramRecord(record: SpectrogramRecord): Promise<void> {
  const db = await getDB();
  await db.put(STORE_SPECTROGRAMS, record);
}
