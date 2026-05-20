// Unified workspace `.alpkg` export orchestrator.  Combines the
// dataset + heads entry-builders into one archive:
//
//   package.json                                  (shared envelope)
//   datasets/<category>/<sha256>.wav              (per selected category)
//   datasets/<category>/<sha256>.wav
//   ...
//   head/<head_id>.mpk                            (per selected head)
//   head/<head_id>.json
//   ...
//
// Pipeline phases (a callback fires at every transition):
//
//   1. preparing-datasets   buildDatasetEntries: list → fetch slices
//   2. preparing-heads      buildHeadEntries: fetch + validate each head
//   3. packing              ZIP everything via $lib/utils/alpkg
//   4. downloading          Blob → object URL → <a download>
//
// At least one of `categories` / `heads` must be non-empty (the
// "export nothing" case is rejected at the pipeline boundary so
// the dialog can keep its Export button enabled when at least
// one item is selected across both sections).  Either section
// may be empty -- a heads-only export skips the datasets phase
// entirely, and vice versa.

import type { HeadRecord, Uuid } from './types';
import {
  buildDatasetEntries,
  DatasetEntriesError,
  type DatasetEntriesProgress
} from './datasets-export';
import { buildHeadEntries, ExportError } from './heads-export';
import {
  buildAlpkgManifest,
  packAlpkg,
  safeFilenameSlug,
  type AlpkgEntry,
  type AlpkgManifest
} from '$lib/utils/alpkg';

// MARK: Public types

export type WorkspaceExportPhase =
  | 'preparing-datasets'
  | 'preparing-heads'
  | 'packing'
  | 'downloading';

export interface WorkspaceExportProgress {
  phase: WorkspaceExportPhase;
  /// During `preparing-datasets` -- "listing" before the slice
  /// count is known, "fetching" after, with itemsTotal/itemsDone
  /// populated.  During `preparing-heads` -- itemsTotal/itemsDone
  /// track heads validated.  Other phases leave these undefined.
  itemsTotal?: number;
  itemsDone?: number;
  /// `preparing-datasets` exposes whether we're still listing or
  /// already fetching, so the dialog can render distinct copy
  /// for each.  Unused for the other phases.
  subphase?: 'listing' | 'fetching';
}

/// Typed pipeline failure.  Wraps the underlying
/// `DatasetEntriesError` / heads `ExportError` to give the
/// dialog one error shape to switch on for banner copy.
export class WorkspaceExportError extends Error {
  readonly phase: WorkspaceExportPhase;
  /// Category that triggered a dataset-side failure; null for
  /// head-side or workspace-wide failures.
  readonly category: string | null;
  /// Head id that triggered a head-side failure; null otherwise.
  readonly headId: Uuid | null;
  constructor(
    phase: WorkspaceExportPhase,
    message: string,
    options?: { cause?: unknown; category?: string; headId?: Uuid }
  ) {
    super(message, options);
    this.name = 'WorkspaceExportError';
    this.phase = phase;
    this.category = options?.category ?? null;
    this.headId = options?.headId ?? null;
  }
}

export interface WorkspaceExportInput {
  workspaceId: Uuid;
  workspaceName: string;
  /// Selected category names; empty when the operator deselected
  /// every dataset row.  At least one of `categories` /  `heads`
  /// must be non-empty.
  categories: readonly string[];
  /// Selected head records; empty when the operator deselected
  /// every head row.  At least one of `categories` / `heads`
  /// must be non-empty.
  heads: readonly HeadRecord[];
}

export interface WorkspaceExportOptions {
  signal?: AbortSignal;
  onprogress?: (p: WorkspaceExportProgress) => void;
}

export interface WorkspaceExportResult {
  filename: string;
  size_bytes: number;
  /// How many categories landed in the archive (may be lower
  /// than `input.categories.length` if a selection turned out
  /// empty on disk -- e.g. operator-added but never uploaded).
  categories_count: number;
  slices_count: number;
  heads_count: number;
}

// MARK: Public entry point

export async function exportWorkspace(
  input: WorkspaceExportInput,
  opts: WorkspaceExportOptions = {}
): Promise<WorkspaceExportResult> {
  const { signal, onprogress } = opts;
  const { workspaceId, workspaceName, categories, heads: headList } = input;

  if (categories.length === 0 && headList.length === 0) {
    // Pre-flight; the dialog's Export button already guards
    // against this, but the typed throw makes the boundary
    // explicit if a non-UI caller ever appears.
    throw new WorkspaceExportError('preparing-datasets', 'Pick at least one item to export.');
  }

  // Phase 1 -- dataset entries.  Skip entirely when no categories
  // are selected (heads-only export); the helper returns an empty
  // array in that case anyway, but skipping saves the phase
  // transition + an unnecessary progress emission.
  let datasetEntries: AlpkgEntry[] = [];
  let resolvedCategoriesCount = 0;
  if (categories.length > 0) {
    try {
      datasetEntries = await buildDatasetEntries(
        workspaceId,
        categories,
        signal,
        (p: DatasetEntriesProgress) => {
          emit(onprogress, {
            phase: 'preparing-datasets',
            subphase: p.phase,
            itemsTotal: p.itemsTotal,
            itemsDone: p.itemsDone
          });
        }
      );
    } catch (e) {
      if (e instanceof DatasetEntriesError) {
        throw new WorkspaceExportError('preparing-datasets', e.message, {
          cause: e,
          category: e.category ?? undefined
        });
      }
      throw e;
    }
    // Count distinct categories present in the entry list.  The
    // helper drops empty/404 categories silently; recovering the
    // surviving count for the result requires inspecting the
    // emitted entries.  Every dataset entry's path is shaped
    // `datasets/<cat>/<filename>` by `buildDatasetEntries`, so
    // `split('/')[1]` is the category name by construction.
    const seen = new Set<string>();
    for (const entry of datasetEntries) {
      seen.add(entry.path.split('/')[1]);
    }
    resolvedCategoriesCount = seen.size;
  }

  // Phase 2 -- head entries.  Skip when no heads selected.  The
  // helper fans out sequentially; we just adapt its per-head
  // callback to our workspace-level progress shape.
  let headEntries: AlpkgEntry[] = [];
  if (headList.length > 0) {
    emit(onprogress, {
      phase: 'preparing-heads',
      itemsTotal: headList.length,
      itemsDone: 0
    });
    try {
      headEntries = await buildHeadEntries(workspaceId, headList, signal, (done, total) => {
        emit(onprogress, {
          phase: 'preparing-heads',
          itemsTotal: total,
          itemsDone: done
        });
      });
    } catch (e) {
      if (e instanceof ExportError) {
        throw new WorkspaceExportError('preparing-heads', e.message, {
          cause: e,
          headId: e.headId ?? undefined
        });
      }
      throw e;
    }
  }

  // Pre-pack guard: every helper drops "empty" inputs silently,
  // so an export of "1 category that's empty on disk + 0 heads"
  // could land here with both entry arrays empty.  Refuse rather
  // than ship a `package.json`-only archive.
  if (datasetEntries.length === 0 && headEntries.length === 0) {
    throw new WorkspaceExportError(
      'preparing-datasets',
      categories.length > 0 && headList.length === 0
        ? 'The selected categories have no slices to export.'
        : 'Nothing to export.'
    );
  }

  // Phase 3 -- pack.  package.json first so a streaming reader
  // can detect the archive kind without seeking the central
  // directory.  Order after that: datasets (sorted by helper) →
  // heads (sorted by input order).  Two re-exports of an
  // unchanged workspace state yield identical bytes through the
  // packer modulo `exported_at`.
  emit(onprogress, { phase: 'packing' });
  throwIfAborted(signal, 'packing');
  const pkg: AlpkgManifest = buildAlpkgManifest();
  const pkgBytes = new TextEncoder().encode(stringifyAlpkgManifest(pkg));
  const entries: AlpkgEntry[] = [
    { path: 'package.json', bytes: pkgBytes },
    ...datasetEntries,
    ...headEntries
  ];

  let alpkgBlob: Blob;
  try {
    alpkgBlob = await packAlpkg(entries);
  } catch (e) {
    throw new WorkspaceExportError('packing', "Couldn't pack the workspace archive.", {
      cause: e
    });
  }

  // Phase 4 -- download.  Same trigger as the per-row head
  // export (blob → object URL → `<a download>`).  Runs on the
  // operator's gesture chain so popup blockers cooperate.
  emit(onprogress, { phase: 'downloading' });
  throwIfAborted(signal, 'downloading');
  const filename = buildExportFilename(workspaceName);
  triggerDownload(alpkgBlob, filename);

  return {
    filename,
    size_bytes: alpkgBlob.size,
    categories_count: resolvedCategoriesCount,
    slices_count: datasetEntries.length,
    heads_count: headEntries.length / 2 // two entries per head (mpk + json)
  };
}

// MARK: Internals -- serialisation, filename, download

function stringifyAlpkgManifest(pkg: AlpkgManifest): string {
  // Same two-space pretty form the per-row head export emits, so
  // operators who unzip and peek see one consistent `package.json`
  // across both flows.
  return JSON.stringify(pkg, null, 2) + '\n';
}

function buildExportFilename(workspaceName: string): string {
  // Single-word suffix (`-export`) so the filename's role is
  // unambiguous next to the per-row head export
  // (`<ws>-head-<short>.alpkg`) -- the operator's downloads
  // folder doesn't confuse the bundle with a one-off head.
  const wsSlug = safeFilenameSlug(workspaceName, 'workspace');
  return `${wsSlug}-export.alpkg`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.target = '_self';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the download starts before the blob is GC'd.
  // 30 s mirrors the per-row head export budget.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 30_000);
}

// MARK: Internals -- abort + progress

function throwIfAborted(signal: AbortSignal | undefined, phase: WorkspaceExportPhase): void {
  if (signal?.aborted === true) {
    const reason: unknown = signal.reason;
    const reasonMsg =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'export aborted';
    throw new WorkspaceExportError(phase, reasonMsg, { cause: reason });
  }
}

function emit(
  onprogress: ((p: WorkspaceExportProgress) => void) | undefined,
  p: WorkspaceExportProgress
): void {
  if (onprogress) onprogress(p);
}
