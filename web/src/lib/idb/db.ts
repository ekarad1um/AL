import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

// Single per-origin IndexedDB database for the whole frontend.
// One DB per origin is the recommended pattern -- it lets us atomically
// `deleteDatabase('acoustics-lab')` for a hard reset and keeps the
// schema in one place.  Different feature areas claim different
// object stores.
//
// Schema versions:
//   v1 -- (retired) `recordings` store from the deviated B.2 draft.
//   v2 -- B.2 `categories` store (operator-added category metadata
//          that hasn't materialised on the daemon yet).
//   v3 -- B.3 `drafts` store: single in-progress clip per
//          `(workspace_id, category_name)`.  PCM-16 mono WAV @
//          44.1 kHz in the canonical encoder format; "single-slot"
//          per the architecture spec means a new record/import
//          replaces the prior draft for the same key.
//   v4 -- B.4 `slices` store: 44,100-sample (1 s @ 44.1 kHz)
//          slices produced by the trim + Slice action.  Keyed by
//          uuid; indexed by `[workspace_id, category_name]` for
//          per-category queries.  Local-only in B.4; the upload
//          state machine (`state: 'local' | 'uploading' |
//          'committed' | 'failed'`) lands in B.6.
//
// We bump VERSION per shipped sub-slice rather than pre-allocating
// stores; an `idb` upgrade callback that no-ops on already-created
// stores is fine, but exposing typed stores via `DBSchema` forces
// every consumer to handle missing stores anyway, so incremental
// creation is the simpler discipline.

export const DB_NAME = 'acoustics-lab';
export const DB_VERSION = 4;

// Object-store names.  Centralised as `const` literals so the typed
// schema below references them via mapped-keys, and call sites grep
// to one place.
export const STORE_CATEGORIES = 'categories' as const;
export const STORE_DRAFTS = 'drafts' as const;
export const STORE_SLICES = 'slices' as const;

// Per-workspace operator-added category record.  The mandatory
// `_background_noise_` category is synthesised in code (see
// `$lib/components/category/labels.ts`) and never persisted here.
//
// Categories materialise on the daemon when the first slice uploads
// to them (the file mutation creates the parent directory).  Until
// then, an operator-added category lives only in this IDB store so
// that a page reload preserves the operator's intent -- the daemon's
// `GET /assets/datasets` doesn't list empty directories because
// there's no such directory to list.
//
// `created_at` is local clock time at first-add; it's purely for
// ordering bytes on disk and never crosses the daemon boundary.
export interface CategoryRecord {
  workspace_id: string;
  name: string;
  created_at: string;
}

// Single in-progress clip per `(workspace_id, category_name)`.  The
// architecture spec calls for the Input Module to retain *only the
// most recent audio clip* per category, so the operator never has
// to manage a list of partial work in the Input pane -- the slot is
// either empty, or holds exactly one clip.
//
// `blob` carries the canonical PCM-16 mono WAV bytes @ 44.1 kHz.
// `source: 'recorded'` clips come from `getUserMedia`; `'imported'`
// clips come from drag-drop WAV files.  `original_name` is only set
// on imported clips for provenance display.
//
// `sample_rate` is denormalised here for forward-compat: a future
// schema bump might allow alternate rates per-category, but B.3 -
// B.6 commit to 44.1 kHz everywhere.
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
  // Trim range over the canonical 44.1 kHz PCM samples.  Absent
  // means "no trim yet" -- readers default to (0, sample_count)
  // computed from the blob size.  Persisted on drag-commit so
  // the operator's selection survives reload; not used by the
  // slicer until the operator clicks Slice.
  //
  // Optional rather than required so legacy B.3 drafts (which
  // pre-date the trim feature) read back cleanly without a
  // schema-level migration -- the defaults apply transparently.
  trim_start_samples?: number;
  trim_end_samples?: number;
}

// Slice state machine.  B.4 produces every slice in 'local' state
// (no upload path yet); B.6 will add the upload transitions.
//   local     -- produced by the Slice action, awaiting upload.
//   uploading -- XHR PUT in flight.
//   committed -- daemon ack received; the WAV bytes can be GC'd
//                from IDB (the canonical copy lives on disk).
//   failed    -- upload errored; retry from the slice card.
export type SliceState = 'local' | 'uploading' | 'committed' | 'failed';

export interface SliceRecord {
  id: string;
  workspace_id: string;
  category_name: string;
  // Daemon-facing filename: `<uuid8>.wav` (AssetPath-valid:
  // `[A-Za-z0-9._-]`).  Constructed at slice-time and persisted
  // so re-tries of a failed upload reuse the same filename
  // (idempotent PUT semantics on the daemon's `/assets/{*path}`).
  filename: string;
  // Nullable in B.6.  `null` covers two flavours:
  //   - `state === 'committed'` after upload: the bytes live on
  //     the daemon, the local IDB row drops the blob to free
  //     origin quota.  Callers go through `getSliceBlob(slice)`
  //     ([audio/slice-fetch.ts]) to lazy-fetch + cache.
  //   - Server-only synthetic slices from category sync: the
  //     daemon listed a file we never had locally (operator
  //     uploaded from another tab / browser).  Same lazy-fetch
  //     path applies on first play / spectrogram.
  // Locally-produced slices keep a real Blob until the upload
  // commits.  Failed uploads keep the blob so a retry can re-PUT.
  blob: Blob | null;
  state: SliceState;
  // Populated as the upload state machine progresses (B.6).
  // `upload_progress` is 0..1 during `state === 'uploading'`;
  // `workspace_revision_id` is the daemon's receipt on success;
  // `last_error` is the catch'd message on failure.
  upload_progress?: number;
  workspace_revision_id?: number;
  last_error?: string;
  created_at: string;
}

// `DBSchema` ties the object-store names to their value + key shapes
// so the `idb` wrapper can type transactions for us.  Composite
// `[workspace_id, name]` keys keep the categories scoped per-
// workspace without an extra index for the common "list within one
// workspace" query path; the `by-workspace` index still exists for
// bulk-delete-on-workspace-removal scenarios.
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
    key: string;
    value: SliceRecord;
    indexes: {
      'by-workspace': string;
      'by-workspace-category': [string, string];
    };
  };
}

export type AppDB = IDBPDatabase<AcousticsLabDB>;

let dbPromise: Promise<AppDB> | null = null;

export function getDB(): Promise<AppDB> {
  dbPromise ??= openDB<AcousticsLabDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Monotonic upgrade chain: each `oldVersion < N` branch runs
      // at most once per DB lifetime.  Branches must be additive
      // because IDB forbids re-entering an upgrade transaction.
      // The deviated v1 (`recordings` store) is not migrated --
      // its data was never user-facing, and dropping it is the
      // intentional course correction.
      if (oldVersion < 2) {
        // Clean up the v1 `recordings` store if a developer
        // machine carries it over from the deviated draft.  Both
        // `objectStoreNames` and `deleteObjectStore` are typed
        // against the current schema (`categories` only), so the
        // legacy store name needs an `as` escape on both sides --
        // runtime is unaffected, the names are still byte-checked
        // against the IDB.
        const storeNames = Array.from(db.objectStoreNames) as string[];
        if (storeNames.includes('recordings')) {
          (db as unknown as { deleteObjectStore(name: string): void }).deleteObjectStore(
            'recordings'
          );
        }
        const store = db.createObjectStore(STORE_CATEGORIES, {
          keyPath: ['workspace_id', 'name']
        });
        store.createIndex('by-workspace', 'workspace_id', { unique: false });
      }
      if (oldVersion < 3) {
        // B.3 drafts: one row per `(workspace_id, category_name)`.
        // The composite key enforces the single-slot semantic
        // structurally -- a second `put()` to the same key
        // overwrites in place (which is what we want when the
        // operator re-records or replaces via import).
        const drafts = db.createObjectStore(STORE_DRAFTS, {
          keyPath: ['workspace_id', 'category_name']
        });
        drafts.createIndex('by-workspace', 'workspace_id', { unique: false });
      }
      if (oldVersion < 4) {
        // B.4 slices: many per `(workspace_id, category_name)`.
        // Keyed by `id` (uuid) because the Slice action appends
        // (never replaces).  Two indexes: `by-workspace` for the
        // workspace-delete cleanup path; `by-workspace-category`
        // for the per-category listing the SlicePane reads.
        const slices = db.createObjectStore(STORE_SLICES, { keyPath: 'id' });
        slices.createIndex('by-workspace', 'workspace_id', { unique: false });
        slices.createIndex('by-workspace-category', ['workspace_id', 'category_name'], {
          unique: false
        });
      }
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

// Test/dev convenience: wipe the DB completely.  Not exposed in the
// UI -- used only when manually resetting state during development.
// `idb`'s `deleteDB` wraps the native `IDBOpenDBRequest` in a real
// Promise so we can `await` it correctly.
export async function resetDB(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await deleteDB(DB_NAME);
}
