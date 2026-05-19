// Trained-head export orchestrator.  Drives the pipeline that
// turns a `HeadRecord` row from the Deploy module's `HeadsTable`
// into an operator-facing `.alpkg` file in the browser's
// downloads folder.
//
// Pipeline (each phase is a single yield point so the caller can
// abort + the UI can morph copy):
//
//   1. fetching-weights    GET /assets/heads/<id>.mpk
//   2. fetching-manifest   GET /assets/heads/<id>.json
//   3. validating          structural manifest checks +
//                          cross-check vs HeadRecord +
//                          weight size + sha256 vs manifest
//   4. packing             ZIP-encode three entries
//                          (package.json + head/<id>.{mpk,json})
//                          via $lib/utils/alpkg
//   5. downloading         Blob -> object URL -> <a download>
//
// Validation order mirrors the spec's "metadata first, then size
// + hash for the weight data": we never claim the weights are
// good before the manifest agrees on their identity, and we
// fail closed at the first mismatch with a typed `ExportError`
// carrying the phase so the UI can pick the right copy.

import type { ApiErrorBody, HeadManifest, HeadRecord, Uuid } from './types';
import { ApiError } from './http';
import { heads } from './endpoints';
import { sha256Hex } from '$lib/audio/sha256';
import {
  buildAlpkgManifest,
  packAlpkg,
  safeFilenameSlug,
  type AlpkgEntry,
  type AlpkgManifest
} from '$lib/utils/alpkg';

// MARK: Public types

export type ExportPhase =
  | 'fetching-weights'
  | 'fetching-manifest'
  | 'validating'
  | 'packing'
  | 'downloading';

export interface ExportProgress {
  phase: ExportPhase;
}

/// Typed pipeline failure.  `phase` names the step that threw so
/// the UI can pick operator copy ("Couldn't download head
/// weights" vs "Head metadata is malformed") without parsing the
/// message string.  Underlying daemon `ApiError` (when present)
/// is preserved on `cause` so the existing `errorCopy` machinery
/// can extract its code + body verbatim for the inline banner.
export class ExportError extends Error {
  readonly phase: ExportPhase;
  constructor(phase: ExportPhase, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExportError';
    this.phase = phase;
  }
}

export interface ExportHeadInput {
  workspaceId: Uuid;
  workspaceName: string;
  /// The list-row the operator clicked.  The pipeline cross-
  /// validates this against the daemon's per-head manifest -- a
  /// race where the row went stale between list + click surfaces
  /// as a typed `ExportError` rather than a successfully packed
  /// but inconsistent artefact.
  head: HeadRecord;
}

export interface ExportHeadOptions {
  /// Caller-supplied abort -- propagates into the fetch chain
  /// so a workspace-swap mid-export tears down the pipeline.
  signal?: AbortSignal;
  /// Phase-transition callback.  Fires at the start of each
  /// pipeline phase; callers typically use it to swap an
  /// inline status pill.
  onprogress?: (p: ExportProgress) => void;
}

export interface ExportResult {
  /// Filename suggested via `<a download>`.  Operating-system
  /// SaveAs dialogs may still rewrite this for collision
  /// avoidance, but the suggested name guarantees the `.alpkg`
  /// extension survives.
  filename: string;
  /// Packed archive size in bytes.  Exposed primarily for
  /// post-export telemetry / status copy.
  size_bytes: number;
}

// MARK: Public entry point

export async function exportHead(
  input: ExportHeadInput,
  opts: ExportHeadOptions = {}
): Promise<ExportResult> {
  const { signal, onprogress } = opts;
  const { workspaceId, workspaceName, head } = input;

  // Phase 1 -- fetch the weight bytes.  Goes through the asset
  // GET surface (`heads/<id>.mpk`); the daemon streams the
  // on-disk file verbatim with `application/octet-stream`, so
  // `resp.arrayBuffer()` yields a buffer byte-identical to
  // what the daemon hashes for `HeadManifest.sha256`.
  emit(onprogress, 'fetching-weights');
  const weightsBytes = await fetchBinary(
    heads.weightsAssetPath(workspaceId, head.head_id),
    signal,
    'fetching-weights'
  );

  // Phase 2 -- fetch the per-head manifest JSON.  Goes through
  // the same asset surface (not the dedicated `/heads/{id}`
  // route) so the operator-facing path is symmetric with the
  // weight fetch; the orphan-index filter the dedicated route
  // adds is redundant here because the export entry point is
  // a row in the cached `HeadsTable`.
  emit(onprogress, 'fetching-manifest');
  const manifestRaw = await fetchBinary(
    heads.manifestAssetPath(workspaceId, head.head_id),
    signal,
    'fetching-manifest'
  );
  const manifest = parseManifestJson(manifestRaw);

  // Phase 3 -- validate.  The user's stated order is
  // metadata-first (cheap structural + cross-checks), then the
  // expensive sha256 of the weights against the manifest's
  // recorded value.  We bail at the first mismatch -- there is
  // no "best-effort" export semantic.
  emit(onprogress, 'validating');
  validateManifest(manifest, head, workspaceId);
  const weightsSha = await sha256Hex(weightsBytes);
  validateWeightsAgainstManifest(weightsBytes, weightsSha, manifest);

  // Phase 4 -- pack.  The embedded `.json` reuses the raw
  // manifest bytes the daemon served, verbatim.  Two reasons
  // we don't re-serialise the parsed object:
  //   1. Forward-compat.  An enumerative re-serialiser names
  //      every field explicitly; a future daemon-side
  //      `HeadManifest` field would land in the parsed object
  //      (TypeScript's structural typing accepts unknown keys
  //      at the cast) but be silently dropped on the way back
  //      out.  Verbatim bytes preserve every field on the
  //      wire so an importer built against a newer schema can
  //      still read everything the daemon emitted.
  //   2. Byte-stability across re-exports.  `serde_json` emits
  //      the manifest with deterministic whitespace + key
  //      ordering for a given input, which is the same
  //      property a re-serialiser would offer for the in-type
  //      fields -- but without the field-drop hazard above.
  // The bytes are already validated as well-formed UTF-8 +
  // JSON by `parseManifestJson`, and the cross-checked
  // `manifest.sha256` is identical to what the daemon
  // computed against the on-disk file -- so the alpkg can
  // never embed unreadable garbage.
  emit(onprogress, 'packing');
  const headJsonBytes = manifestRaw;
  const weightsPath = `head/${manifest.head_id}.mpk`;
  const manifestPath = `head/${manifest.head_id}.json`;

  // The envelope is intentionally tiny: format + version +
  // exported_at.  Every other field (head identity, hashes,
  // sizes, labels) is canonical in the embedded
  // `head/<id>.json` -- the importer reads it there and
  // verifies the embedded `.mpk` by hashing against
  // `manifest.sha256`, so duplicating those values in the
  // envelope would only invite drift.  The file tree
  // (`head/<id>.{mpk,json}`) tells the importer what kind of
  // bundle this is without an explicit `kind` discriminator.
  const pkg: AlpkgManifest = buildAlpkgManifest();
  const pkgBytes = new TextEncoder().encode(stringifyAlpkgManifest(pkg));

  const entries: AlpkgEntry[] = [
    { path: 'package.json', bytes: pkgBytes },
    { path: weightsPath, bytes: weightsBytes },
    { path: manifestPath, bytes: headJsonBytes }
  ];

  throwIfAborted(signal, 'packing');
  const alpkgBlob = await packAlpkg(entries);

  // Phase 5 -- trigger the browser SaveAs dialog.  We do this
  // on the same task tick the operator initiated so popup
  // blockers honour the click gesture chain; `URL.revokeObject
  // URL` is deferred a tick so the download starts before the
  // blob is GC'd.
  emit(onprogress, 'downloading');
  throwIfAborted(signal, 'downloading');
  const filename = buildExportFilename(workspaceName, head.head_id);
  triggerDownload(alpkgBlob, filename);

  return { filename, size_bytes: alpkgBlob.size };
}

// MARK: Internals -- fetch

async function fetchBinary(
  url: string,
  signal: AbortSignal | undefined,
  phase: ExportPhase
): Promise<Uint8Array> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal });
  } catch (e) {
    if (signal?.aborted) throw e; // honour caller abort
    throw new ExportError(phase, `Network error fetching ${url}`, { cause: e });
  }
  if (!resp.ok) {
    // Parse the daemon's `{error, code}` envelope so the UI's
    // `errorCopy` helper can pick fixed copy ("Conflict: ...")
    // when the code is recognised, falling back to the message
    // otherwise.  Mirrors `$lib/api/http.ts:parseError`.
    let body: ApiErrorBody;
    try {
      body = (await resp.json()) as ApiErrorBody;
    } catch {
      body = { error: resp.statusText || `HTTP ${resp.status}`, code: 'unknown' };
    }
    throw new ExportError(phase, body.error || `HTTP ${String(resp.status)}`, {
      cause: new ApiError(resp.status, body)
    });
  }
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

// MARK: Internals -- manifest decode + validation

function parseManifestJson(bytes: Uint8Array): HeadManifest {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  try {
    return JSON.parse(text) as HeadManifest;
  } catch (e) {
    throw new ExportError('validating', 'Head metadata is not valid JSON', { cause: e });
  }
}

function validateManifest(manifest: HeadManifest, expected: HeadRecord, workspaceId: Uuid): void {
  // Structural shape -- `JSON.parse` returns `any` and the cast
  // to `HeadManifest` is unsound until each load-bearing field is
  // typed at runtime.  A tampered alpkg or a daemon misbehaviour
  // surfaces here rather than as an undefined-method throw deep
  // in the packer.
  if (typeof manifest.head_id !== 'string' || manifest.head_id.length === 0) {
    throw new ExportError('validating', 'Head metadata is missing the head id');
  }
  if (manifest.head_id !== expected.head_id) {
    throw new ExportError(
      'validating',
      `Head metadata reports a different head id (${manifest.head_id} vs ${expected.head_id})`
    );
  }
  // The manifest's `workspace_id` is the daemon's record of which
  // workspace produced the head; a hand-tampered manifest that
  // pointed at a different workspace would surface here rather
  // than slipping into the importer.
  if (typeof manifest.workspace_id !== 'string' || manifest.workspace_id !== workspaceId) {
    // `workspace_id` is statically typed as `Uuid` (string) but the
    // typeof guard above runs because the manifest landed from
    // `JSON.parse` -- a tampered manifest could carry a non-string
    // value the template literal renders as "undefined" / "[object
    // Object]"; the operator still sees that the value didn't
    // match, which is the load-bearing fact.
    throw new ExportError(
      'validating',
      `Head metadata's workspace id (${manifest.workspace_id}) does not match the requested workspace (${workspaceId})`
    );
  }
  if (
    typeof manifest.n_classes !== 'number' ||
    !Number.isInteger(manifest.n_classes) ||
    manifest.n_classes < 1
  ) {
    throw new ExportError('validating', 'Head metadata has a non-positive class count');
  }
  if (typeof manifest.size_bytes !== 'number' || manifest.size_bytes < 0) {
    throw new ExportError('validating', 'Head metadata has an invalid size');
  }
  if (typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new ExportError('validating', 'Head metadata has an invalid sha256');
  }
  if (!Array.isArray(manifest.labels)) {
    throw new ExportError('validating', 'Head metadata is missing the labels array');
  }
  if (manifest.labels.length !== manifest.n_classes) {
    throw new ExportError(
      'validating',
      `Head metadata's label count (${String(manifest.labels.length)}) does not match n_classes (${String(manifest.n_classes)})`
    );
  }
  for (let i = 0; i < manifest.labels.length; i++) {
    const lbl = manifest.labels[i];
    if (typeof lbl !== 'string' || lbl.length === 0) {
      throw new ExportError(
        'validating',
        `Head metadata's label at index ${String(i)} is empty or not a string`
      );
    }
  }
  // Cross-check with the `HeadRecord` the operator clicked.  The
  // daemon's `list_heads` route builds rows from the cached
  // `heads.json` index so a divergence here points at a
  // concurrent train / delete that swapped the row out from
  // under the click; surface it as a clear mismatch rather
  // than packing a stale artefact.
  if (manifest.sha256 !== expected.sha256) {
    throw new ExportError(
      'validating',
      `Head metadata sha256 does not match the workspace's index (${manifest.sha256} vs ${expected.sha256})`
    );
  }
  if (manifest.n_classes !== expected.n_classes) {
    throw new ExportError(
      'validating',
      `Head metadata class count (${String(manifest.n_classes)}) does not match the workspace's index (${String(expected.n_classes)})`
    );
  }
  if (manifest.size_bytes !== expected.size_bytes) {
    throw new ExportError(
      'validating',
      `Head metadata size (${String(manifest.size_bytes)}) does not match the workspace's index (${String(expected.size_bytes)})`
    );
  }
  // The workspace revision the head was trained against should
  // match what the row reports.  An off-by-one here points at a
  // race where another producer published between list + click.
  // `workspace_revision` itself is type-checked first because a
  // tampered manifest could omit the entire nested object -- a
  // bare `.id` dereference below would then throw a raw
  // TypeError that bypasses the typed `ExportError` contract
  // the inline banner consumes (every other field check above
  // guards with `typeof X` against the *primitive* slot, so
  // missing top-level fields already surface as ExportError;
  // the nested case needs its own guard).  Cast to `unknown`
  // first so the strict null + typeof checks compile cleanly
  // under `@typescript-eslint/no-unnecessary-condition`: the
  // static type says `WorkspaceRevision` (non-null object) but
  // JSON.parse returns whatever was on the wire.
  const rev = manifest.workspace_revision as unknown;
  if (rev === null || typeof rev !== 'object' || typeof (rev as { id?: unknown }).id !== 'number') {
    throw new ExportError('validating', 'Head metadata workspace_revision is missing or malformed');
  }
  const manifestRevId = (rev as { id: number }).id;
  if (manifestRevId !== expected.workspace_revision.id) {
    throw new ExportError(
      'validating',
      `Head metadata workspace revision (${String(manifestRevId)}) does not match the workspace's index (${String(expected.workspace_revision.id)})`
    );
  }
}

function validateWeightsAgainstManifest(
  bytes: Uint8Array,
  observedSha: string,
  manifest: HeadManifest
): void {
  if (bytes.byteLength !== manifest.size_bytes) {
    throw new ExportError(
      'validating',
      `Head weight size (${String(bytes.byteLength)}) does not match the metadata's size (${String(manifest.size_bytes)})`
    );
  }
  if (observedSha !== manifest.sha256) {
    throw new ExportError(
      'validating',
      'Head weight hash does not match the metadata; the download is corrupted or the head changed mid-export.'
    );
  }
}

// MARK: Internals -- serialisation helpers

// The embedded head manifest reuses the daemon's raw bytes
// (see the "Phase 4 -- pack" comment in `exportHead`); the only
// serialisation we still own is the small `package.json`
// envelope below.

function stringifyAlpkgManifest(pkg: AlpkgManifest): string {
  return JSON.stringify(pkg, null, 2) + '\n';
}

// MARK: Internals -- filename + download trigger

function buildExportFilename(workspaceName: string, headId: Uuid): string {
  const wsSlug = safeFilenameSlug(workspaceName, 'workspace');
  const headSlug = headId.replace(/-/g, '').slice(0, 8);
  return `${wsSlug}-head-${headSlug}.alpkg`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // `target=_self` is the default, but spelling it out documents
  // that the download navigation stays in the current tab.
  a.target = '_self';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer the revoke so the browser has time to start the
  // download.  A 30 s budget is plenty for the click handler to
  // hand off to the network stack; the URL is workspace-scoped
  // to this page anyway so an over-long lifetime carries no
  // observable risk beyond a tiny memory delay.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 30_000);
}

// MARK: Internals -- abort + progress

function throwIfAborted(signal: AbortSignal | undefined, phase: ExportPhase): void {
  if (signal?.aborted === true) {
    const reason: unknown = signal.reason;
    const reasonMsg =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'export aborted';
    throw new ExportError(phase, reasonMsg, { cause: reason });
  }
}

function emit(onprogress: ((p: ExportProgress) => void) | undefined, phase: ExportPhase): void {
  if (onprogress) onprogress({ phase });
}
