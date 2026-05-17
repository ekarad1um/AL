import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

// Single per-origin IndexedDB database for the whole frontend.
// One DB per origin is the recommended pattern -- it lets us
// atomically `deleteDatabase('acoustics-lab')` for a hard reset
// and keeps the schema in one place.
//
// v6 is a clean re-cut over the v5 work that introduced the
// revision-based sync model.  The model still applies; the v6
// bump simplifies its plumbing by collapsing every surface's
// identity onto the slice's sha256.  Slices are content-
// addressed: the WAV bytes' sha256 is the slice id, the
// daemon-side filename basename (`<sha>.wav`), the spectrogram
// cache key, and the in-memory blob cache key.  Same content
// uploaded twice ends up at the same path with the same hash
// -- the upload is idempotent, and the diff is a pure set
// comparison of filenames.
//
// Stores landed in v6:
//   * `categories`       -- operator-added categories that
//                            haven't materialised on the daemon
//                            yet.  Composite key
//                            `[workspace_id, name]`.
//   * `drafts`           -- single in-progress clip per
//                            `(workspace_id, category_name)`.
//   * `slices`           -- 1 s @ 44.1 kHz slice rows.  Primary
//                            key is the composite triple
//                            `[workspace_id, category_name, id]`
//                            (id = sha256 hex of the WAV
//                            bytes); same content in two
//                            categories must coexist.
//                            Filename is derived (`${id}.wav`).
//   * `workspace_sync`   -- last reconciled
//                            `workspace_revision.id` per
//                            workspace.  Tier 1 skip-condition
//                            on workspace mount.
//   * `spectrograms`     -- cached spectrogram PNG bytes keyed
//                            by the slice's sha256 (= id).
//                            Shared across categories and
//                            workspaces; the cache is valid
//                            forever for a given content hash
//                            until explicit eviction.
//
// Upgrade path: drop every pre-existing store and recreate.  No
// migration -- the operator-side workspaces are being wiped in
// lock-step with this change.

export const DB_NAME = 'acoustics-lab';
export const DB_VERSION = 6;

export const STORE_CATEGORIES = 'categories' as const;
export const STORE_DRAFTS = 'drafts' as const;
export const STORE_SLICES = 'slices' as const;
export const STORE_WORKSPACE_SYNC = 'workspace_sync' as const;
export const STORE_SPECTROGRAMS = 'spectrograms' as const;

export interface CategoryRecord {
  workspace_id: string;
  name: string;
  created_at: string;
}

export type DraftSource = 'recorded' | 'imported';

export interface DraftRecord {
  workspace_id: string;
  category_name: string;
  blob: Blob;
  duration_ms: number;
  sample_rate: number;
  size_bytes: number;
  source: DraftSource;
  created_at: string;
  original_name?: string;
  trim_start_samples?: number;
  trim_end_samples?: number;
}

// Slice state machine.
//   local     -- produced by the Slice action, awaiting upload.
//   uploading -- XHR PUT in flight.
//   committed -- daemon ack received; the WAV bytes can be GC'd
//                from IDB (the canonical copy lives on disk).
//   failed    -- upload errored; retry from the slice card.
export type SliceState = 'local' | 'uploading' | 'committed' | 'failed';

// Daemon-side filename for a slice given its content-addressed
// id.  Centralised so call sites can grep to one place and a
// future format change (e.g. switching to opus or compressed
// WAV) flows through this helper.
export function sliceFilename(id: string): string {
  return `${id}.wav`;
}

// Lowercase-hex sha256 shape (exactly 64 chars).  Filenames
// that don't fit this shape are foreign-named (e.g. a daemon
// CLI uploader broke the content-addressing convention) and
// are silently skipped by the reconcile path -- the content-
// addressed integrity check in `slice-fetch.ts` would reject
// their bytes anyway (`sha256(bytes) !== "foo"`), so admitting
// them would just render a permanently-broken card.  The
// convention is asserted across every uploader; a violation is
// a setup bug, not user input.
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Extract a slice's content-addressed id from a daemon
// listing entry's filename.  Returns null for any filename
// that doesn't fit the strict `<64-hex>.wav` shape -- see the
// `SHA256_HEX` discussion above for the rationale.
export function sliceIdFromFilename(filename: string): string | null {
  if (!filename.endsWith('.wav')) return null;
  const id = filename.slice(0, -'.wav'.length);
  return SHA256_HEX.test(id) ? id : null;
}

export interface SliceRecord {
  // sha256 (lowercase hex) of the WAV bytes.  Used as the
  // primary-key suffix, the filename basename
  // (`sliceFilename(id) === '${id}.wav'`), the spectrogram
  // cache key, and the in-memory blob cache key.
  id: string;
  workspace_id: string;
  category_name: string;
  // Bytes for in-flight local rows; null after commit (canonical
  // copy lives on the daemon, retrieved on demand by
  // `getSliceBlob`).
  blob: Blob | null;
  state: SliceState;
  upload_progress?: number;
  workspace_revision_id?: number;
  last_error?: string;
  created_at: string;
}

// Per-workspace persisted sync state.  Tier 1 short-circuit
// reads this on workspace mount; equality with the freshly-
// fetched `workspace_revision.id` skips every per-category
// dataset GET.  `last_synced_at` is the client wall-clock at
// successful reconcile completion; it's surfaced for
// debugging, not consulted by any sync gate.
export interface WorkspaceSyncRecord {
  workspace_id: string;
  last_synced_revision_id: number;
  last_synced_at: string;
}

// Cached spectrogram PNG bytes keyed by the slice's sha256
// (= id).  Shared across categories + workspaces because the
// PNG is a deterministic function of content; same hash means
// same image.  No invalidation needed -- a content overwrite
// would produce a different filename (different hash) and a
// fresh cache row.  No per-row eviction either -- a single
// (workspace, category)-scoped delete doesn't imply the hash
// is no-longer-referenced; another slice may still rely on
// it.  `resetDB` is the single reset point.
export interface SpectrogramRecord {
  // sha256 hex of the slice's WAV bytes; matches the slice
  // record's `id`.
  sha256: string;
  png: Blob;
  created_at: string;
}

// Slice primary-key tuple.  Composite over workspace + category
// + content hash because the same content can land in two
// categories simultaneously (the daemon allows it, the trainer
// reads class labels off the directory name) and the IDB row's
// `category_name` would silently flip on the second put if the
// key were a single field.
export type SliceKey = [workspace_id: string, category_name: string, id: string];

interface AcousticsLabDB extends DBSchema {
  [STORE_CATEGORIES]: {
    key: [string, string];
    value: CategoryRecord;
    indexes: {
      'by-workspace': string;
    };
  };
  [STORE_DRAFTS]: {
    key: [string, string];
    value: DraftRecord;
    indexes: {
      'by-workspace': string;
    };
  };
  [STORE_SLICES]: {
    key: SliceKey;
    value: SliceRecord;
    indexes: {
      'by-workspace': string;
      'by-workspace-category': [string, string];
    };
  };
  [STORE_WORKSPACE_SYNC]: {
    key: string;
    value: WorkspaceSyncRecord;
  };
  [STORE_SPECTROGRAMS]: {
    key: string;
    value: SpectrogramRecord;
  };
}

export type AppDB = IDBPDatabase<AcousticsLabDB>;

let dbPromise: Promise<AppDB> | null = null;

export function getDB(): Promise<AppDB> {
  dbPromise ??= openDB<AcousticsLabDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Clean re-cut.  Pre-existing data is wiped because the
      // operator-side workspaces are being wiped in lock-step
      // with this schema rev (the daemon's slice filenames
      // change too, so any IDB content carried over would be
      // mis-keyed).
      for (const name of Array.from(db.objectStoreNames)) {
        (db as unknown as { deleteObjectStore(n: string): void }).deleteObjectStore(name);
      }
      const categories = db.createObjectStore(STORE_CATEGORIES, {
        keyPath: ['workspace_id', 'name']
      });
      categories.createIndex('by-workspace', 'workspace_id', { unique: false });

      const drafts = db.createObjectStore(STORE_DRAFTS, {
        keyPath: ['workspace_id', 'category_name']
      });
      drafts.createIndex('by-workspace', 'workspace_id', { unique: false });

      const slices = db.createObjectStore(STORE_SLICES, {
        keyPath: ['workspace_id', 'category_name', 'id']
      });
      slices.createIndex('by-workspace', 'workspace_id', { unique: false });
      slices.createIndex('by-workspace-category', ['workspace_id', 'category_name'], {
        unique: false
      });

      db.createObjectStore(STORE_WORKSPACE_SYNC, { keyPath: 'workspace_id' });
      db.createObjectStore(STORE_SPECTROGRAMS, { keyPath: 'sha256' });
    },
    blocked() {
      console.warn('[idb] upgrade blocked by another tab');
    },
    blocking() {
      console.warn('[idb] another tab requested upgrade -- this tab should reload');
    },
    terminated() {
      dbPromise = null;
    }
  });
  return dbPromise;
}

export async function resetDB(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await deleteDB(DB_NAME);
}
