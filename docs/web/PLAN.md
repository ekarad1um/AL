# Web Frontend Implementation Plan

> Implementation lives at [`web/`](../../web/). Spec at [`docs/web/ARCHITECTURE.md`](./ARCHITECTURE.md).

## Context

The acoustics_lab daemon (`acousticsd`) is mature: REST at `/api/v1/*`, two binary-protobuf WebSocket streams (`/stream/audio`, `/stream/infer`), SSE for job events, async job model, revision-tracked workspaces, 2-slot head storage with atomic hot-swap. Backend serves no static files. `web/` is a clean slate.

The frontend spec defines eight modules across three tabs (Dashboard, Workspace, Converter) plus a persistent Health Badge and floating Tiny Dashboard. The job is to build a slim SPA that lets a single operator record/edit audio clips, fine-tune classification heads, hot-swap weights, and observe live inference — all locally, with zero-latency dataset playback and no backend changes.

Pacing is deliberate: ample time, step-by-step. We will not pursue testing/benchmarking/CI infrastructure ([ARCHITECTURE.md §E.5](./ARCHITECTURE.md)).

## Locked decisions

- **Stack**: SvelteKit (latest) + TypeScript + Vite + Tailwind CSS v4. `@sveltejs/adapter-static`. Vite dev proxy → 127.0.0.1:8787.
- **Rendering**: pure-client SPA. Root layout sets `prerender = true; ssr = false` so build emits a static shell that hydrates browser-only.
- **No SSR/Node runtime**: build artifact is a static `web/build/` deployable to any static host or reverse-proxied.
- **Components**: hand-rolled Tailwind primitives. **Extracted only after a pattern is copy-pasted twice in real features.** No headless lib, no kit.
- **History**: memory ring via `GET /api/v1/jobs` for live state + JSONL backfill via `GET /api/v1/workspace/{id}/assets/training_logs/<job>.jsonl?after_seq=&limit=` for durability.
- **Converter workspaces**: marker tag `__converter__`, auto-name `converter-<uuid8>`. Client-side filter uses **name-prefix `converter-`** (not tag membership, since the daemon's list response omits `tags` — see corrections below). Tag is still set on creation as forward-compat metadata.
- **No tests, no benchmarks, no CI**.

## Implementation status (rolling)

Updated as slices ship. Anchor for future sessions to avoid re-doing.

### Shipped

- **Slice A — Dashboard MVP** (complete; see [docs/web/NOTES.md](./NOTES.md) for design-system decisions).
- **Slice C — Training + Heads management** (2026-05-14, refactored to SSE 2026-05-15, persistent per-workspace history landed 2026-05-15) — **Slice C training surface complete; the cross-cutting workspace-agnostic Jobs history view (Slice E §2) is still deferred until Slice D contributes converter rows so the merged history isn't a one-type list. Per-workspace training history is now persistent across refresh as of 2026-05-15: a workspace mount lists `training_logs/` and replays the JSONL backstop for past terminal runs, paged in batches of 5.**
  - **2026-05-15 update — bridged into the cross-cutting JobRegistry.** The earlier dual-registry asymmetry was closed: the training POST route now calls `jobs.try_acquire(JobType::Train, ...)` ([modules/api/routes/training.rs:119](../../modules/api/routes/training.rs#L119)), the resulting `JobHandle` threads into `training.spawn(...)`, and `emit_train_event` broadcasts every typed `TrainEvent` via `handle.append_log(serde_json::to_string(&event))` ([modules/training.rs:1208](../../modules/training.rs#L1208)). Consequence: `GET /jobs` now lists training jobs (`job_type: "train"`, `last_seq: N`, terminal `result`) and `GET /jobs/{id}/events` streams every typed event in real time (live curl-tested; ~70 events / 50-epoch run, 14× headroom against the 1024-slot ring). The web side replaces the polling architecture below with a [`TrainingSubscriber`](../../web/src/lib/api/training-subscriber.ts): a single long-lived `EventSource` opens at `after_seq=0&logs=true` and stays bound for the whole run, three callbacks fan into the store (`onEvent` for typed payloads / `onProgress` for rate-limited progress ticks / `onStateTransition` for terminal flips), and `applyEventToView` + `applyProgressToView` + `applyStateToView` reconstruct `TrainingJobView` from the event stream alone. The `TrainingJobPoller` is deleted; [`TrainingLogTail`](../../web/src/lib/api/training-log-tail.ts) survives as the dormant gap-recovery substrate for a future Phase 4 (`event_gap` 409 → JSONL backfill → resubscribe), not yet wired because the ring's 14× headroom hasn't been observed to overflow in practice.
  - **Types + endpoints** ([api/types.ts](../../web/src/lib/api/types.ts), [api/endpoints.ts](../../web/src/lib/api/endpoints.ts)): full restatement of `TrainingCfg`, `TrainStartResp`, `TrainingPhase`, `EpochMetrics`, `TrainingProgress`, `TrainingResult`, `TrainingJobState`, `TrainingJobView`, `TrainingListResp`, `CancelResp`, `DeleteHeadResp`, `LogEvent`, `LogPageResp`. Endpoints: `training.{start, list, get, cancel, logPath, readLogPage}`, `heads.{list, manifest, delete}`. `error-copy` adds fixed copy for `another_convert_running` + a `bad_dataset` pass-through.
  - **Bounds + validation** ([components/training/labels.ts](../../web/src/lib/components/training/labels.ts), [cfg-validate.ts](../../web/src/lib/components/training/cfg-validate.ts)): client-side mirrors `validate_training_cfg` ([modules/file_mgr/request_payload.rs:331](../../modules/file_mgr/request_payload.rs#L331)) so the form fails on the same inputs the daemon would 400 on: `epochs ∈ [1, 1000]`, `batch_size ∈ [1, 4096]`, `learning_rate ∈ (0, 1.0]`, `validation_split ∈ [0, 1)`. Defaults: 30 / 32 / 1e-3 / 0.2. Required fields surface as disabled-submit; per-field errors as `aria-invalid` + inline rose paragraphs.
  - **`TrainingSubscriber`** ([api/training-subscriber.ts](../../web/src/lib/api/training-subscriber.ts)): single long-lived `EventSource` over `/api/v1/jobs/{id}/events?after_seq=0&logs=true`. Three callback shapes drive the store's slots disjointly. EventSource auto-reconnects re-use the original URL (replays from `seq=0`); store-side dedup-on-seq in `ingestLogEvent` makes replays idempotent. Terminal-state observation flips `terminalObserved` so the daemon's clean post-terminal stream close is distinguished from a transport failure. Predecessors (`TrainingJobPoller` + `TrainingLogTail` paired at 1 Hz) are gone -- the poller class file is deleted; the tail survives only as the Phase 4 backfill substrate.
  - **Reactive training store** ([stores/training.svelte.ts](../../web/src/lib/stores/training.svelte.ts)): singleton `active` slot (mirrors the daemon's `max_train_jobs = 1`) + per-workspace history list for "previous runs" cards. `start(workspaceId, cfg)` + `cancel()` + `dismissTerminal(workspaceId)` + `dismissHistoryEntry` + `forget(workspaceId)` + `recover(workspaceId)` (page-reload mid-train uses `/workspace/{id}/training` listing to find the running job, then binds the subscriber from `seq=0`). The subscriber's `onEvent` calls `ingestLogEvent` which appends to `logLines`, merges epoch metrics via `mergeEpochFromEvent`, and applies per-kind view-field updates via `applyEventToView` (phase, started_at, result, error, terminal state); `onProgress` calls `applyProgressToView` (current/total); `onStateTransition` calls `applyStateToView` (state, finished_at) and routes terminal into `handleTerminal`. The full `TrainingJobView` is reconstructed client-side from the event stream alone -- the polled `/training/{job}` endpoint is no longer on the routine path. `terminalSeq` counter increments on every terminal landing so the workspace detail's `$effect` re-fetches and `heads[]` picks up the newly-published head.
    - **Persistent history hydration** (2026-05-15): the workspace page mount also calls `trainingStore.hydrateHistory(workspaceId)` alongside `recover()`. The store lists `GET /api/v1/workspace/{id}/assets/training_logs?limit=100`, sorts by `mtime` (newest-first), and eagerly fetches the top 2 JSONLs via `training.readLogPage`, replaying each through `replayJsonl` -- a pure fold over the same `applyEventToView` / `mergeEpochFromEvent` / `renderEvent` helpers the live SSE path uses -- to synthesise terminal `TrackedTrainingJob` entries that get pushed into `historyByWs` via the mtime-sorted `pushHistoryBatch`. Beyond the eager tier, an "▾ Show N older runs" disclosure backed by `loadMoreHistory(workspaceId)` paginates older entries in batches of `PAGE_SIZE = 5` parallel JSONL fetches; the per-card expand path is free because the JSONL is already cached. `MAX_HISTORY_PER_WS` raised from 10 to 50 to accommodate the paged-load model. Operator-soft-hidden runs persist via `localStorage` under `acoustics-lab:training-hidden:<workspace_id>` so dismissals survive refresh; a "Show K hidden" reveal link at the bottom unhides everything at once. Skips the active jobId (recover owns it via SSE) and JSONLs without a terminal event (abandoned runs) at fetch time.
  - **TrainForm** ([components/training/TrainForm.svelte](../../web/src/lib/components/training/TrainForm.svelte)): two-column grid (sm+), `<input type="number">` bound to `number | null` so a cleared field re-enters the "required" affordance instead of being treated as 0. Validation is per-field `$derived`; `canSubmit` gates on `allRequiredPresent && !hasFieldErrors && !starting && !disabled`. Backend error surfaces inline (the form lives inside a section, no toast surface yet). `seed === null` is omitted from the request body so the daemon's `Option<u64>` parses as `None` (per-job entropy) rather than `null` literal.
  - **JobProgress** ([components/training/JobProgress.svelte](../../web/src/lib/components/training/JobProgress.svelte)): five-chip phase strip (past = emerald, current = blue, pending = zinc) keyed off `PHASE_ORDER.indexOf(phase)`. Progress bar is determinate when `total > 0` and falls back to a 30 %-wide CSS-keyframe sweep otherwise (the Loading phase often emits `total: 0` before the dataset scan completes). Metrics readout strip (train loss / train acc / val acc) + per-second cancel affordance. The `valDisabled` derived (NaN val_acc → no holdout) hides the val-acc readout + the chart's val-line cleanly.
  - **MetricsChart** ([components/training/MetricsChart.svelte](../../web/src/lib/components/training/MetricsChart.svelte)): hand-rolled canvas line chart (~150 LOC, no chart lib) over per-epoch `{train_loss, train_acc, val_acc}`. Loss on the implicit left axis (auto-scaled to observed max), accuracies on the implicit right axis (fixed `[0, 1]`). Three series differentiated by colour + dash: rose for loss, dashed blue for train acc, emerald for val acc. RAF-coalesced resize per [NOTES.md](./NOTES.md#raf-coalesced-canvas-resize). 96 px fixed height matches the Visualization panel's waveform rhythm.
  - **TrainPane** ([components/training/TrainPane.svelte](../../web/src/lib/components/training/TrainPane.svelte)): three orthogonal display states branched on store reads — `active` → JobProgress, `terminal + no active` → dismissable terminal banner above the form, otherwise → smart-suggestion banner (when a `current` head exists + isn't already active) + form. The "another workspace is training" amber note disables the form via TrainForm's `disabled` prop when the daemon's single train slot is held by a sibling workspace. `onMount` fires `training.recover(workspaceId)` so a page reload mid-train picks up the running job seamlessly.
  - **HeadCard / HeadsList / DeleteHeadDialog** ([components/training/HeadCard.svelte](../../web/src/lib/components/training/HeadCard.svelte), [HeadsList.svelte](../../web/src/lib/components/training/HeadsList.svelte), [DeleteHeadDialog.svelte](../../web/src/lib/components/training/DeleteHeadDialog.svelte)): per-head card with newest-first sort, locally-recomputed `current | stale` pill against the workspace detail's `liveRevision` (so an upload-receipt-driven advance flips stale on the head trained at the previous rev without waiting for the page poller), an "Active" pill driven off `config.active.source_head_id`, and Activate + Delete actions. The active head can't be deleted (button + tooltip telegraph the constraint; the daemon would 409 anyway). The HeadsList serialises mutations via a `busyHeadId` so double-clicks across rows don't race.
  - **Workspace detail integration** ([routes/workspace/[id]/+page.svelte](../../web/src/routes/workspace/[id]/+page.svelte)): replaces the read-only Heads `<ul>` with `<TrainPane>` + `<HeadsList>`. `refreshDetail()` helper re-pulls `wsApi.get(id)` without restarting the WorkspacePoller; binds to `trainingStore.terminalSeq` so a successful terminal re-fetches the detail to pick up the published head. `activateHead` is a single handler reused by both the smart-suggestion banner and the per-head Activate button.
  - **Workspace delete cleanup** ([stores/workspaces.svelte.ts](../../web/src/lib/stores/workspaces.svelte.ts)): the workspace-delete chain now calls `trainingStore.forget(id)` in lock-step with the drafts + slices store forgets, so the global active slot frees if the workspace owned a running train at the time of delete. No daemon-side mutation needed -- `WorkspaceDelete` already releases the training producer's workspace reference, which the producer observes at the next cancel-flag check.
- **Slice B polish — Slice selection + bulk-delete UX** (2026-05-13):
  - **No-confirmation slice batch delete** ([category/SlicePane.svelte](../../web/src/lib/components/category/SlicePane.svelte)): every batch entry point (toolbar `Delete N` pill, Del / Backspace on the focused grid, right-click "Delete N slices") fires `slices.deleteMany` directly on click — single-target deletes (hover trash, single-slice context-menu Delete) stay immediate, and the batch path now matches them. The earlier `BulkDeleteSlicesDialog` confirmation modal was deleted because the selecting-mode opt-in (Ctrl/Cmd-click / Cmd-Ctrl+A / right-click "Select") + the explicit per-row tick + the destructive rose toolbar pill already represent intent expressed three times; stacking a fourth "are you sure?" modal duplicated the friction without adding signal, and diverged from the single-card path that ships immediate. Targets are captured synchronously at click time (the `.filter` runs before any await) so a background upload appending mid-`deleteMany` doesn't poison the batch; `clearSelection()` fires before the pipeline starts so a follow-up toolbar click or held Backspace lands on an empty selection and bails through the existing `selectedIds.size === 0` early-return. Failed targets re-enter the selection on terminal so the operator can retry without rebuilding it. Workspaces' bulk delete keeps its modal — its blast radius (whole dataset + heads + logs) is a different magnitude from a 1 s clip.
  - **`slices.deleteMany(targets)`** ([stores/slices.svelte.ts](../../web/src/lib/stores/slices.svelte.ts)): fans out to per-record `delete()` via `Promise.all`. Daemon-bound deletes serialise through the global `enqueueDelete` chain (the daemon's `max_delete_jobs = 1` requires it); local-only / failed / uploading targets parallelise their IDB writes since disjoint primary keys don't conflict. Returns `BulkSliceDeleteOutcome { succeeded, failed }` for future "retry failures" surfaces.
  - **In-flight delete protection** ([stores/slices.svelte.ts](../../web/src/lib/stores/slices.svelte.ts) + [category/SliceCard.svelte](../../web/src/lib/components/category/SliceCard.svelte) + [category/SlicePane.svelte](../../web/src/lib/components/category/SlicePane.svelte)): the slices store exposes a reactive `deletingIds: SvelteSet<string>` populated/cleared by `delete()`'s `try/finally` (with an idempotency early-return so a re-entrant call on an already-mid-flight id is a no-op). Per-row chrome on `SliceCard` is _static_ — `opacity-50` + `pointer-events-none` + `aria-busy` on the wrapper, plus `disabled={deleting}` on every interactive descendant (card body, trash, checkbox, retry) so a keyboard Enter on a focused card can't bypass the mouse-only pointer-events block. The ONLY animated affordance lives in the toolbar's Delete button: when `deletingIds.size > 0` it label-swaps to "Deleting N…" with an `animate-spin` glyph and disables. Centralising the animation is the performance call — a 30-slice batch previously meant 30 simultaneous spinners (30 transform recalcs + 30 compositor layers / frame on top of the live-audio RAF loop); now it's one spinner regardless of batch size. `SlicePane`'s `selectAll` / `toggleSelection` / `selectRange` / `play` / `retryUpload` / `bulkDelete` / `onGridContextMenu` all filter or bail on deleting ids; `Del`/`Backspace` and the header click both gate on `isAnyDeleting` so a held-down Backspace or a re-clicked toolbar button can't fire a fresh `slices.deleteMany` over the drain; `allSelected` is computed against the non-deleting eligible subset so the toolbar's `Select all` / `Deselect all` toggle flips correctly even when one row is mid-flight. Mirrors the workspaces store's `deleting: SvelteSet<Uuid>` + WorkspaceCard's `isDeleting` pattern for cross-module consistency.
  - **Daemon-as-master reconciliation on `slices.refresh`** ([stores/slices.svelte.ts](../../web/src/lib/stores/slices.svelte.ts)): refresh now splits local IDB rows into `kept` + `orphans` against the daemon's category listing. An orphan is a local `committed` row whose filename is absent from the daemon — i.e., the daemon-side delete completed but the local cleanup didn't (most commonly: page closed mid-batch-delete between the SSE-terminal landing and `idbDeleteSlice` firing). Orphans get GC'd from IDB + their spectrogram / blob caches revoked, so on next mount the operator sees the daemon-truthful state with no phantom committed cards that would 404 on play. `local` / `uploading` / `failed` rows are preserved unconditionally — those have no daemon presence by definition, and `resumePending` re-queues them through the upload pool from the same mount cycle. This makes the page-close-mid-delete failure mode self-healing: the daemon job runs independently to terminal, refresh reconciles, no persistent "this delete is in flight" marker has to survive the tab dying.
  - **InputPane height parity across modes** ([category/InputPane.svelte](../../web/src/lib/components/category/InputPane.svelte), [category/CategoryRow.svelte](../../web/src/lib/components/category/CategoryRow.svelte)): waveform row's `flex-1 min-h-32` → `flex-1 min-h-0` so the pane's outer height stays welded to the grid's `min-h-80` (320 px) floor across every state — previously, `min-h-32` plus the action row + selection-status line + a recorder error banner + an "Imported from" footnote drove cumulative intrinsic content past 320 px, the grid row grew to absorb it, and SlicePane stretched to match. The "InputPane jumps a notch taller when an error fires" feel is gone; the waveform absorbs whatever fixed chrome is present (down to ~70-90 px in worst-case error-heavy states), but every other piece is layout-stable. Outer pane also picks up `min-h-0 overflow-hidden` as a defensive cap.
  - **Operator-facing caps** ([category/InputPane.svelte](../../web/src/lib/components/category/InputPane.svelte), [category/labels.ts](../../web/src/lib/components/category/labels.ts)): two new limits mirror existing patterns elsewhere in the app. (a) `MAX_IMPORT_BYTES = 64 MiB`: drag-and-drop / file-picker imports check `file.size` BEFORE the decode pipeline fires, so an oversized WAV never reaches the Float32Array decode that would inflate it 4× and OOM the tab. Rejection copy includes both sizes and a "trim shorter and re-export" hint. Dropzone tooltip surfaces the cap so the operator sees it before they drop. (b) `MAX_SLICES_PER_CATEGORY = 200` (in `labels.ts` next to the training thresholds): per-category cumulative slice cap. The Slice button degrades to a disabled "At cap · N/MAX" label-swap identical to the Workspace list's "At cap" New-workspace pattern; if a batch would push past the cap (count + projectedSliceCount > MAX) the button stays in standard shape but disables, with the Selection status line spelling out the remaining headroom so the operator can trim the selection to fit. The 60-slices-per-click hard cap (matching the 60-second recording cap) is unchanged and orthogonal.
  - **Mode FSM converged with the workspaces list** ([category/SlicePane.svelte](../../web/src/lib/components/category/SlicePane.svelte)): pane-local `mode: 'normal' | 'selecting'` matches the workspaces store's selection FSM so the chrome reads as one primitive across the app. Normal mode = playback-curate shape (bare clicks play, header is just "Slices" + quota chip). Selecting mode = three left-aligned **pill buttons** in the header (`Select all` / `Deselect all`, `Done`, `Delete N`), always-visible top-right checkbox on every card replacing the hover trash, and bare clicks toggle selection instead of playing. All three pills share the same shape (`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium`); the destructive accent rides on rose-50/rose-200 colour alone, not on a different container shape, so the row reads as one toolbar instead of "two text-links + a button". Title Case labels match the workspaces toolbar so the two bulk-action surfaces feel like the same primitive. Selection mutators (`toggleSelection`, `selectRange`, `selectAll`) call `enterSelecting()` unconditionally — it's idempotent — so the FSM transition flows from any selection-shaped action (Ctrl/Cmd-click, Shift-click range, right-click "Select", Cmd/Ctrl+A) without callsite plumbing. Auto-exits when the grid empties post-delete so the toolbar never hangs over an empty-state body.
  - **Slice-specific tweaks over the workspaces' baseline FSM**: no "Select" entry button in the idle header (slice pane is dense + lives inside a category accordion; the right-click menu + `Ctrl/Cmd-click` + `Cmd/Ctrl+A` cover the entry path). No "N selected" counter — the toolbar starts flush at the header's left edge and the count is already baked into the rightmost `Delete N` button. "Select all" is hidden until in selecting mode, then surfaces as a label-swap toggle (`select all` ⇄ `deselect all`). Right-click on an unselected card while in selecting mode keeps a single-card immediate `Delete` entry so an operator can drop one stray card without exiting + re-selecting through the toolbar (Finder-style precedent; blast radius is one 1 s clip). `Retry failed in selection` rides as a conditional tail item in the right-click menu — no workspace equivalent because workspaces have no per-record failure state.
  - **Shared `capFirst(s, fallback)` util** ([utils/error-copy.ts](../../web/src/lib/utils/error-copy.ts)): the message-normalisation helper that was module-private in `workspaces.svelte.ts` is now exported. Slices use it from `deleteMany`'s failure path so SSE-terminal error messages (which arrive pre-cleaned by the daemon, without the `fs:` / `convert:` layer prefix `errorCopy` strips) get the same sentence-case + trailing-period treatment as the workspaces equivalent.
- **Slice B.6 — Backend sync** (2026-05-13) — **Slice B complete.**
  - **SliceRecord.blob nullable** ([idb/db.ts](../../web/src/lib/idb/db.ts)). Three blob-less flavours converge cleanly:
    - `state === 'committed'` after upload: the bytes live on the daemon; the IDB row drops the blob to free origin quota.
    - Synthesised server-only rows from category sync (operator uploaded from another tab / browser).
    - Re-mount after the page is reloaded, where the upload pipeline had previously committed.
  - **Lazy slice-fetch cache** ([audio/slice-fetch.ts](../../web/src/lib/audio/slice-fetch.ts)): `getSliceBlob(slice)` returns the local blob when present, else `fetch`es `GET /assets/datasets/<class>/<filename>` and caches per-id with an `inflight` dedup. `revokeSliceBlobs(ids)` drops the cache on per-row delete / per-category clear / per-workspace forget.
  - **XHR upload helper** ([api/upload.ts](../../web/src/lib/api/upload.ts)): `xhrPut<T>` with `upload.onprogress` (the only reliable upload-progress signal in a browser) + caller-supplied `AbortSignal`. Maps non-2xx to a real `ApiError` so the existing `errorCopy` machinery handles operator copy. `UploadPool` class caps concurrent tasks at a constructor-supplied limit (default 3 in the slices store) and drains FIFO.
  - **Endpoint additions** ([api/endpoints.ts](../../web/src/lib/api/endpoints.ts)): `assets.deleteSlice(workspaceId, category, filename)` issues `DELETE /assets/datasets/<class>/<filename>` (async job ack, drains through the global delete chain). `assets.slicePutPath` / `assets.sliceAssetPath` build the daemon URLs for upload / fetch consumers (called from slice-fetch + the slices store).
  - **Slices store overhaul** ([stores/slices.svelte.ts](../../web/src/lib/stores/slices.svelte.ts)):
    - `enqueueUpload(sliceId)` → upload pool → `runUpload` walks `local | failed → uploading → committed | failed` with IDB + in-memory writes at every state transition. Progress updates are memory-only (`patchInMemory` swaps the entries array) so the XHR's many tiny `onprogress` events don't thrash IDB.
    - Per-slice `AbortController` registry: `delete` / `clearForCategory` / `forget` abort in-flight uploads before tearing the slice down so the runUpload's `signal.aborted` branch skips the state-machine update we'd otherwise race against.
    - `delete` now branches: server-side `committed` slices go through `enqueueDelete` → `DELETE /assets/datasets/<class>/<filename>` → SSE-terminal; local / uploading / failed bypass the daemon. Both paths revoke spectrogram + blob caches.
    - `refresh` merges local IDB + `GET /assets/datasets/<class>` (with 404 → empty as the fresh-category case). Server-only files become synthesised `srv:<ws>:<cat>:<filename>` committed rows (deterministic id so re-sync is idempotent); persisted to IDB so future sessions read from cache.
    - `resumePending(workspaceId)` re-queues every slice in `local | uploading | failed`. Called by the PendingUploadsBanner's resume button.
    - `latestRevisionFor(workspaceId)` exposes the highest `workspace_revision_id` seen on an upload receipt this session; the workspace detail's revision chip max'es this against its loaded value.
  - **InputPane** ([category/InputPane.svelte](../../web/src/lib/components/category/InputPane.svelte)) — `performSlice` now collects newly-appended slice ids and fires `slices.enqueueUpload(id)` for each. Fire-and-forget; the pool throttles concurrency. Operator clicks Slice and uploads start immediately.
  - **SliceCard state chrome** ([category/SliceCard.svelte](../../web/src/lib/components/category/SliceCard.svelte)): `uploading` cards show a bottom progress bar tracking `slice.upload_progress`; `failed` cards get a rose ring + an inline `retry` badge in the bottom-left that fires `onRetry`. Tooltips telegraph the state on the play-button title.
  - **SlicePane** ([category/SlicePane.svelte](../../web/src/lib/components/category/SlicePane.svelte)) — `getSliceBlob` powers playback for both local + committed slices. Context menu adds a "Retry upload" item for `state === 'failed'` rows.
  - **PendingUploadsBanner** ([category/PendingUploadsBanner.svelte](../../web/src/lib/components/category/PendingUploadsBanner.svelte)): mounts at the workspace detail level, auto-hides when nothing is pending, shows aggregate progress while uploads are in flight, and surfaces a Resume / Retry button when the pool is idle but uploads remain.
  - **Live revision chip** ([routes/workspace/[id]/+page.svelte](../../web/src/routes/workspace/[id]/+page.svelte)) — the detail's revision chip now max's the loaded `workspace_revision.id` against `slices.latestRevisionFor(detail.id)` and tags a small `live` badge when the upload-driven value has advanced past the snapshot, avoiding a per-upload `GET /workspace/{id}` round-trip.
- **Slice B.5 — Slice Management + Spectrogram cards** (2026-05-13):
  - **Plasma colormap** ([audio/palette.ts](../../web/src/lib/audio/palette.ts)): eight RGB stops digitised from matplotlib's `plasma`, linear interpolation between adjacent stops. Chosen because plasma's high-energy end is yellow (not white) — keeps peak energies readable against the white card surround.
  - **Spectrogram engine** ([audio/spectrogram.ts](../../web/src/lib/audio/spectrogram.ts)): per-slice 512-point Hann-windowed STFT (hop 256), log-magnitude in a fixed [-80, 0] dB range (avoids the auto-range pitfall of amplifying noise on silent slices), plasma-colormapped image into an `OffscreenCanvas`, `convertToBlob` → blob URL. Module-scope cache keyed by slice id; `inflight` map dedups concurrent generation. `revokeSliceSpectrograms(ids)` exposes the GC path called by the slices store on delete / clearForCategory / forget.
  - **Slices store extensions** ([stores/slices.svelte.ts](../../web/src/lib/stores/slices.svelte.ts)): `refreshForWorkspace(workspaceId, categoryNames)` does one IDB query and partitions every slice in the workspace into the per-category map — including empty categories (so collapsed rows transition to `loaded: true` and per-category refreshes short-circuit). Guarded by a `workspacesLoaded` `SvelteSet` so re-mount of CategoryList doesn't re-do the IDB walk. `countFor(workspaceId, categoryName)` exposes the badge value. All delete paths (`delete`, `clearForCategory`, `forget`) now revoke the affected slices' spectrogram URLs in lock-step so the browser GCs the image blobs immediately.
  - **SliceCard component** ([category/SliceCard.svelte](../../web/src/lib/components/category/SliceCard.svelte)): per-slice 96 × 64 px card with the spectrogram PNG as its `<img>` source. `data-slice-id` on the wrapper for the parent's right-click walk. Hover-revealed trash icon (focus-within keeps it visible during keyboard navigation; `pointer-events-none` at rest so the no-hover state doesn't block the card-body click). Spectrogram fetch is lazy + cancellable; failures fall back to a neutral wave-icon placeholder so the card stays clickable.
  - **SlicePane rebuild** ([category/SlicePane.svelte](../../web/src/lib/components/category/SlicePane.svelte)): `grid-cols-[repeat(auto-fit,96px)] content-start justify-evenly gap-2` — fixed-width 96 px tracks with `space-evenly` distributing leftover width into equal edge + inter-card slots (`gap-2` is the 8 px floor so cards never touch); flows 8-12 cards per row at desktop. `content-start` pins the row tracks at their 64 px content height so the y-gap stays a literal 8 px regardless of row count — without it, the spec's `align-content: normal` would stretch the auto-sized row tracks to fill the `flex-1` height and inflate the visible between-row distance for 2/3-row partials. `scrollbar-gutter-stable` reserves the scrollbar gutter up front so flipping into overflow on a fresh batch doesn't yank horizontal real estate out from under the existing cards. Single shared `AudioContext` lazily constructed on first play; `AudioBufferSourceNode` per click with `onended` resetting `playingId`. Right-click handled at the grid wrapper, walks `[data-slice-id]` to identify the slice and shows a Play / Delete `ContextMenu`. Quantity chip in the pane header (`<count>/<threshold>`, emerald with checkmark when satisfied, amber otherwise). Empty state telegraphs the path back to the Input pane's Slice button.
  - **CategoryRow header badge** ([category/CategoryRow.svelte](../../web/src/lib/components/category/CategoryRow.svelte)): the same `<count>/<threshold>` chip on collapsed rows so an operator can scan the dataset list at a glance ("which categories still need more slices"). Threshold lookup via `labels.thresholdFor` (20 for `_background_noise_`, 10 elsewhere).
  - **Workspace bulk-load wiring** ([category/CategoryList.svelte](../../web/src/lib/components/category/CategoryList.svelte)): once the categories list resolves, fires `slices.refreshForWorkspace` so the badges on every row light up without forcing the operator to expand each category. `untrack`-wrapped to avoid the reactive-loop trap.
  - **Incidental fix in [dashboard/SpectrogramCanvas.svelte](../../web/src/lib/components/dashboard/SpectrogramCanvas.svelte)**: an `OffscreenCanvas | HTMLCanvasElement` union confused TS's overload resolution for `.getContext('2d')` (resolving to the generic `RenderingContext | null` fallback). Narrowed via `instanceof OffscreenCanvas` so each branch picks the right 2D-context overload.
- **Slice B.4 — Trim + Slice action** (2026-05-13):
  - IDB schema v4 adds the `slices` object store ([idb/db.ts](../../web/src/lib/idb/db.ts), [idb/slices.ts](../../web/src/lib/idb/slices.ts)). Keyed by uuid; indexes `by-workspace` (workspace-delete cleanup) and `by-workspace-category` (per-category listing). Optional `trim_start_samples` / `trim_end_samples` added to `DraftRecord` -- absent on legacy B.3 rows; readers default to (0, sample_count). No schema migration required.
  - Slicer ([audio/slicer.ts](../../web/src/lib/audio/slicer.ts)): `chunkPcmToSlices` chunks the trimmed range into fixed-length 44 100-sample windows; a sub-window trailing remainder is **dropped** (floor-divide) so every emitted slice carries 1 s of _real_ audio rather than a half-silence padded tail (which degraded background-noise training quality and surprised operators by inflating slice counts past the audio that justified them). The daemon's [`to_waveform`](../../modules/preproc/wav_io.rs) already pads or truncates each input to its 44 032-sample preproc frame, so the prior web-side padding was never load-bearing downstream. `sliceCountFor` telegraphs the projected count on the Slice button label; the selection-status hint surfaces the unused remainder so the operator can extend the trim to reclaim it.
  - Reactive slices store ([stores/slices.svelte.ts](../../web/src/lib/stores/slices.svelte.ts)): per-`(workspace_id, category_name)` list in a `SvelteMap`. `refresh / append / delete / clearForCategory / forget`. Same in-flight short-circuit + `untrack` discipline as the categories + drafts stores.
  - Drafts store gains `patchTrim` ([stores/drafts.svelte.ts](../../web/src/lib/stores/drafts.svelte.ts)): in-memory update happens synchronously (so the trim handle's drag-commit flows through the parent's `$effect` without resetting), IDB write trails asynchronously.
  - **TrimWaveform component** ([category/TrimWaveform.svelte](../../web/src/lib/components/category/TrimWaveform.svelte)): wraps `StaticWaveform` with two pointer-draggable handles, a translucent mask over the unselected regions, and a blue contour bracket around the selection. Controlled component: parent owns the trim state and receives both `onChange` (every pointermove for smooth visual) + `onCommit` (on pointerup for IDB persistence). Min-1 s gap enforced at the constraint layer so handles can't cross or shrink below the slicer minimum. Pointer capture on the wrapper (not the 3 px handle) so a fast drag doesn't escape the hit area.
  - **Basic SlicePane** ([category/SlicePane.svelte](../../web/src/lib/components/category/SlicePane.svelte)): per-category count + filename list + per-row delete. Utilitarian B.4 surface; B.5 replaces it with spectrogram-background cards + quantity badge + click-to-play. The store / IDB layer is already shaped for B.5's needs so the rebuild is purely presentational.
  - **InputPane integration** ([category/InputPane.svelte](../../web/src/lib/components/category/InputPane.svelte)):
    - `StaticWaveform` replaced by `TrimWaveform` in the draft state.
    - Selection status line surfaces `<duration> · <N> slices of 1 s each` plus `· <Y>s unused` when the trim has a >= 10 ms sub-slice remainder the floor-divide will drop (or an amber "Drag to ≥ 1 s" prompt when below the minimum) so the Slice button's `disabled` state and the slice count both stay legible.
    - **Play selection**: a single shared `AudioContext` + cached `AudioBuffer` per draft; `AudioBufferSourceNode.start(0, offset, duration)` plays exactly the trimmed range. Button collapses to a Stop affordance while a source is alive; `onended` resets the button. Teardown on pane unmount + on draft removal.
    - **Slice button**: primary CTA when a draft exists. Label tracks `projectedSliceCount` (`Slice · 6`) so the operator sees what the click will produce. Disabled below 1 s with a tooltip; loading-spinned during the encode loop. Sequential per-slice append so a partial IDB-quota failure leaves the earlier slices visible.
  - **CategoryRow integration**: dashed Slices placeholder replaced by the live `SlicePane`.
  - **Cleanup wiring** ([stores/categories.svelte.ts](../../web/src/lib/stores/categories.svelte.ts), [stores/workspaces.svelte.ts](../../web/src/lib/stores/workspaces.svelte.ts)): category delete now also drops the per-category slice list (both IDB-only and server-side paths); workspace delete GCs every slice IDB row + forgets the in-memory cache via the same chain that already covers categories + drafts.
- **Slice B.3 — Input Module per category** (2026-05-13):
  - IDB schema v3 adds the `drafts` object store keyed by `[workspace_id, category_name]` ([idb/db.ts](../../web/src/lib/idb/db.ts), [idb/drafts.ts](../../web/src/lib/idb/drafts.ts)). The composite key enforces single-slot semantics structurally -- a second `put` to the same key overwrites in place, which is what we want when an operator re-records or replaces via import.
  - Recorder runtime extended ([audio/recorder.svelte.ts](../../web/src/lib/audio/recorder.svelte.ts)) with a rolling-window PCM ring (3 s capacity at the native capture rate) plus `liveSampleRate` / `liveTotalSamples` / `liveWindowSamples` / `liveEnvelopeAt(...)` public API mirroring the dashboard `streams` store's shape. The live ring is allocated per-Recorder on first start; the worklet message handler now writes both the chunk accumulator (used at finalize) and the live ring (used by the live-waveform canvas at RAF).
  - WAV decode helpers ([audio/wav-decode.ts](../../web/src/lib/audio/wav-decode.ts)): `verifyWavMagic` / `readWavMagic` reject non-WAV imports early with a clear operator-facing message ("not a WAV"), avoiding the vague `decodeAudioData` "EncodingError"; `decodeCanonicalWav` / `decodeCanonicalWavSync` bypass `AudioContext.decodeAudioData` for stored drafts (the bytes are always in our canonical encoder format, so a direct PCM-16 read is faster and preserves the 44 100-sample alignment B.4 needs).
  - Reactive drafts store ([stores/drafts.svelte.ts](../../web/src/lib/stores/drafts.svelte.ts)): per-`(workspace_id, category_name)` slice in a `SvelteMap`. `refresh`, `save`, `clear`, `forget`. Optimistic loading slice preserves the prior draft so the waveform canvas doesn't flicker through empty state mid-refresh.
  - Two waveform components:
    - [category/LiveRecorderWaveform.svelte](../../web/src/lib/components/category/LiveRecorderWaveform.svelte) -- recorder-driven scrolling waveform during capture. Reads from `recorder.liveEnvelopeAt`, RAF-coalesced resize, same render style as the dashboard's `WaveformCanvas`.
    - [category/StaticWaveform.svelte](../../web/src/lib/components/category/StaticWaveform.svelte) -- one-shot envelope render of a Float32Array. Re-renders on resize + when the `pcm` prop reference flips. Designed as the base for B.4's trim-handle overlay (additive extension, not a rewrite).
  - Input Module orchestrator ([category/InputPane.svelte](../../web/src/lib/components/category/InputPane.svelte)) -- per-category state machine across `idle` / `recording` / `finalizing` / `importing` / `draft` / `error`. Fixed-height waveform area (128 px) toggles between live and static renders without layout shift. Action row collapses through Record / Re-record / Stop / Discard / Export / Delete / Import depending on state. Inline rose banner per failure. Drop-anywhere drag handling on the pane wrapper.
  - WAV-only import: 12-byte magic verified before `decodeAudioData`; non-WAV input rejected with "Not a WAV file (missing RIFF magic)." File picker `accept` restricted to `.wav,audio/wav,audio/wave,audio/x-wav,audio/vnd.wave`. Multi-file drops rejected -- the slot only holds one clip.
  - Export: `URL.createObjectURL(blob)` + anchor `download` attribute. Filename pattern `<workspace>-<category>-<rfc3339>.wav` (colons stripped because Windows). URL revoked on the next tick after click.
  - CategoryRow integration: the prior dashed "Input" placeholder is replaced by a live `InputPane` mount; the Slices pane stays a placeholder until B.5. The `workspaceName` prop threads through `CategoryList -> CategoryRow -> InputPane` for the export filename.
  - Draft cleanup: deleting a category (IDB-only or server-side) now clears its draft slot ([stores/categories.svelte.ts](../../web/src/lib/stores/categories.svelte.ts)); deleting a workspace GCs every per-workspace category + draft row in IDB ([stores/workspaces.svelte.ts](../../web/src/lib/stores/workspaces.svelte.ts), [idb/drafts.ts](../../web/src/lib/idb/drafts.ts)). Both flows swallow IDB errors -- daemon-side delete is load-bearing; local GC is housekeeping.
- **Slice B.2 — Foundation alignment + Category lifecycle** (2026-05-13):
  - WAV pipeline retargeted to 44.1 kHz ([audio/wav.ts](../../web/src/lib/audio/wav.ts)). New `SLICE_SAMPLES = WAV_SAMPLE_RATE` constant locks the 1-second slice grid to a single source of truth for B.4 and B.5.
  - IDB schema v2: `categories` store keyed by `[workspace_id, name]` with a `by-workspace` index ([idb/db.ts](../../web/src/lib/idb/db.ts), [idb/categories.ts](../../web/src/lib/idb/categories.ts)). The deviated v1 `recordings` store is dropped at upgrade time on any browser that carries it over.
  - Shared global delete queue ([api/delete-queue.ts](../../web/src/lib/api/delete-queue.ts)): one chain spans every feature area because the daemon's `max_delete_jobs = 1` slot covers Workspace + Dataset + Converter + \*\_Logs. The B.1 workspaces store was refactored to consume the shared queue so workspace and category deletes serialise correctly across features.
  - Reactive categories store ([stores/categories.svelte.ts](../../web/src/lib/stores/categories.svelte.ts)) merges three sources by exact-byte name: mandatory synthetic (`_background_noise_`, code-only), operator-added local (IDB-persisted), and server-listed (`GET /assets/datasets`). Server > IDB > mandatory on conflict. Single-expand UX (`expandedName: string | null`). Async DELETE flows through the shared queue with SSE-terminal awaiting.
  - Per-category accordion UI ([category/CategoryList.svelte](../../web/src/lib/components/category/CategoryList.svelte), [category/CategoryRow.svelte](../../web/src/lib/components/category/CategoryRow.svelte)). Right-click context menu carries Delete (disabled for mandatory); empty-area right-click and the header CTA both open Add Category. Expanded body renders two dashed placeholder panes ("Input" / "Slices") so the future B.3/B.5 wiring is purely a placeholder swap.
  - Add Category dialog ([category/AddCategoryDialog.svelte](../../web/src/lib/components/category/AddCategoryDialog.svelte)) with live AssetPath validation ([category/name-validate.ts](../../web/src/lib/components/category/name-validate.ts)) mirroring [`AssetPath`](../../modules/common/asset_path.rs) (`[A-Za-z0-9._-]`, no leading `.`, ≤ 255 bytes). Case-insensitive uniqueness check beyond byte-equal: blocks `Cat` when `cat` exists because most filesystems collapse the difference.
  - Delete Category dialog ([category/DeleteCategoryDialog.svelte](../../web/src/lib/components/category/DeleteCategoryDialog.svelte)) handles both flavours: IDB-only deletes complete inline (no daemon round-trip); server-side deletes are fire-and-forget through the global queue with a "deleting" pill on the row until terminal.
  - Label utilities ([category/labels.ts](../../web/src/lib/components/category/labels.ts)): mandatory name + threshold constants, `prettyCategoryName()` mirroring the dashboard's `prettyLabel` for Speech-Commands synthetics.
  - Asset endpoints ([api/endpoints.ts](../../web/src/lib/api/endpoints.ts)): `assets.listRoot`, `assets.listDatasets`, `assets.listCategory`, `assets.deleteCategory`. `DatasetListing` + `AssetEntry` types in [api/types.ts](../../web/src/lib/api/types.ts).
  - Workspace detail page ([routes/workspace/[id]/+page.svelte](../../web/src/routes/workspace/[id]/+page.svelte)) wires the live `CategoryList`. The dashed placeholder from the course-correction turn is gone; the operator now sees the real accordion.
- **Slice B.1 — Workspace CRUD foundation**:
  - List / detail routes, async-job-tracked delete, create dialog, inline rename, delete + bulk-delete dialogs.
  - Right-click context menu is the canonical surface for Rename / Delete / Select (on cards) and New / Select all / Done (on the empty list area). No always-visible per-card action icons.
  - Selection mode is opt-in via the header's "Select" button (or the context menu). Checkboxes slide in only while `mode === 'selecting'`; the header swaps to Select-all / Done / Delete-N. No sticky bottom toolbar.
  - Bulk and per-item delete both flow through the store's `deleteChain` in [stores/workspaces.svelte.ts](../../web/src/lib/stores/workspaces.svelte.ts) because the daemon's delete-family slot is global (1 at a time — see corrections below).
  - Every backend-mutating dialog renders an inline error banner (rose-50). Native `<dialog>` lives in the browser top-layer, so any later toast surface would be hidden behind the backdrop; inline is the only operator-visible error path while a modal is open.
  - Primitives extracted to [components/ui/](../../web/src/lib/components/ui/): `Button`, `Modal`, `EmptyState`, `ContextMenu`, `InlineName`, `PlusIcon`, `TrashIcon`, `inputClass()`.
  - Live name validation via `$derived` + red-bordered input mirrors [`validate_workspace_name`](../../modules/file_mgr/registry.rs).
  - Error-copy layer strips daemon thiserror prefixes (`fs:`, `convert:`, `training:`, …) so operator copy reads as "Workspace name conflict: test." rather than "Fs: workspace name conflict: test."
  - `color-scheme: light` pinned globally so native form controls (checkboxes, scrollbars) don't render dark on systems with `prefers-color-scheme: dark`. Slice E's dark-mode work flips this to `light dark` and gates reactively.
  - Toast / Drawer / Tooltip primitives still deferred to Slice E.

### Partial / superseded

- **Slice B.2 (prior draft, deviated)** — IDB `recordings` + flat-list recorder + import. Shipped 2026-05-12 but did not match the Dataset Management Module described in [ARCHITECTURE.md §A.4 "Extra Notes"](./ARCHITECTURE.md): wrong sample rate (16 kHz vs the spec's 44.1 kHz), wrong organisation (flat per-workspace list vs the spec's per-category accordion), wrong input-slot semantics (64-recording list vs single most-recent clip per category), no mandatory `_background_noise_`, no trim or Slice action, no spectrogram cards, no backend sync. Audio infrastructure ([wav.ts](../../web/src/lib/audio/wav.ts), [resample.ts](../../web/src/lib/audio/resample.ts), [recorder.svelte.ts](../../web/src/lib/audio/recorder.svelte.ts), [fft.ts](../../web/src/lib/audio/fft.ts), [format.ts](../../web/src/lib/utils/format.ts)) is salvageable and remains in the tree; the IDB / store / UI seam is being rebuilt under the revised B.2–B.6 below. The deviated Dataset section has been removed from the workspace detail page so the misalignment is not user-visible while the rebuild proceeds. See [NOTES.md §"Slice B course correction"](./NOTES.md) for the deviation map + salvage discipline.

### In flight / not started

Slice B (Workspace + Dataset Management) is complete; Slice C training surface is complete (history view deferred). Remaining slices:

- **Slice C — History view** (deferred): merge live/recent training jobs (`GET /workspace/{id}/training`) with converter jobs (Slice D). Held back so the first ship of "History" doesn't read as a one-type list. Foundation in place: `training.list`, `training.readLogPage`, and parallel converter endpoints in Slice D will plug in cleanly.
- **Slice D** — Converter tab + Tiny Dashboard.
- **Slice E** — Polish + remaining primitive extractions (Toast, Drawer, Tooltip, Tabs, …).
- ~~**Backend follow-up**: bridge the training producer into `file_mgr::JobRegistry` so `GET /jobs/{id}/events` covers train jobs and the per-epoch metrics flow over SSE rather than via the polled `/workspace/{id}/training/{job}`.~~ **Done (2026-05).** The web side moved to SSE as planned; the polled view stays only as the recovery snapshot. See the 2026-05-15 update in the [Slice C entry](#shipped).

### Corrections to the spec (verified against the running daemon)

The original Slice B prose assumed wire shapes that don't match the actual API. Discovered by direct probing in [docs/API.md](../API.md) cross-referenced with [modules/api/routes/workspace.rs](../../modules/api/routes/workspace.rs); future sessions should treat these as authoritative:

1. **`GET /api/v1/workspace` (list)** returns only `{id, name, created_at}` per entry — **no `tags`, no `workspace_revision`, no `head_count`**. The `__converter__` filter therefore can't read tags from the list and uses the workspace-name prefix `converter-` instead.
2. **`GET /api/v1/workspace/{id}` (detail)** returns `{id, name, created_at, workspace_revision, heads[]}` — **no `tags` either**. Only `POST` / `PATCH` responses carry tags.
3. **Workspace delete concurrency**: the daemon's `JobRegistry` admits one `WorkspaceDelete` at a time globally. Firing N parallel `DELETE`s rejects N-1 with `409 conflict` (`fs: job conflict: conflicts with running job ... (WorkspaceDelete)`). Both the per-item and bulk delete flow through a single client-side `deleteChain` that serializes ACK + SSE-terminal before kicking off the next.
4. **Heads bundle**: heads come on the workspace detail. There IS a separate `GET /workspace/{id}/heads` endpoint that returns `{ heads: HeadManifest[] }` (with `labels` filled in, omitted from the inline `HeadRecord`); the original PLAN claim that this endpoint didn't exist was wrong — it does, and Slice C wires it via `heads.list` for the refresh-after-train flow.
5. **Training jobs are in the unified `/jobs` surface** (bridge landed 2026-05). The training producer's `try_acquire(JobType::Train, ...)` admission route + `JobHandle::append_log` event broadcast wire it into the cross-cutting `file_mgr::JobRegistry`. Frontend implication: live training progress streams over SSE at `GET /api/v1/jobs/{id}/events` (each `JobEvent.message` carries a JSON-stringified typed `TrainEvent`); the polled `GET /workspace/{id}/training/{job}` endpoint stays as the snapshot surface used by `recover()`'s discovery hop only. Earlier Slice C notes that described the asymmetry as in-place are now historical (see the 2026-05-15 update in the [Slice C entry](#shipped) above).

### Sub-slice strategy for Slice B

The PLAN.md prose for Slice B describes the full end state; in practice we ship it in six gates so each gate verifies independently against the daemon. The original three-gate split (B.1/B.2/B.3) under-specified the Dataset Management Module's per-category structure (see [ARCHITECTURE.md §A.4 "Extra Notes"](./ARCHITECTURE.md)); the revised plan below decomposes the "audio + slice + commit" path into four narrower slices so each ends in a 5–10-minute manual verification gate.

- **B.1 — CRUD foundation** (done): workspace lifecycle + selection + bulk delete; primitives + error-copy infrastructure.
- **B.2 — Foundation alignment + Category lifecycle** (done): WAV pipeline at 44.1 kHz; IDB schema v2 (`categories`); category accordion; Add / Delete category; mandatory `_background_noise_`; sync read of `GET /assets/datasets`; shared global delete queue across feature areas.
- **B.3 — Input Module per category** (done): IDB schema v3 (`drafts`); recorder ring + envelope API; live + static waveform components; per-category Input pane with state machine; WAV-only import with magic-byte validation; single-slot drafts; export/download; draft cleanup on category + workspace delete.
- **B.4 — Trim + Slice action** (done): IDB schema v4 (`slices` + optional trim fields on drafts); slicer floor-divides the trimmed range into 1 s windows (sub-window remainder dropped) so every emitted slice is real audio; reactive slices store; `patchTrim` for in-memory-first persistence; TrimWaveform component with pointer-captured draggable handles and the ≥ 1 s constraint; selection playback via `AudioBufferSourceNode`; Slice button producing per-category appended slice rows; basic SlicePane (count + list + delete) bridging to B.5; slice cleanup on category + workspace delete.
- **B.5 — Slice Management + Spectrogram cards** (done): plasma colormap; FFT-driven spectrogram engine with module-scope cache + revoke API; bulk `refreshForWorkspace` populates collapsed-row badges via a single IDB query; SliceCard with hover-trash + right-click menu; SlicePane grid with shared AudioContext + click-to-play; quantity chip on both the SlicePane header and the collapsed CategoryRow header.
- **B.6 — Backend sync** (done): nullable `SliceRecord.blob`; lazy slice-fetch cache; XHR upload with `onprogress` + UploadPool (default 3); per-slice state machine (`local → uploading → committed | failed`) wired through the slices store; server merge on `refresh` (404 → empty as the fresh-category case, synthetic `srv:...` records for server-only files); remote DELETE through the global delete chain; `resumePending` + PendingUploadsBanner for cross-reload upload recovery; SliceCard surfaces progress + retry; live revision chip on the workspace detail.
- **B.4 — Trim + Slice action**: range-select handles over the draft waveform; min 1 s gap; Slice produces 44,100-sample chunks appended to the per-category slice list (local-only).
- **B.5 — Slice Management + Spectrogram cards**: pre-rendered spectrogram backgrounds; click-to-play; delete; quantity badges (≥ 20 / ≥ 10).
- **B.6 — Backend sync**: lazy GET on expand; XHR PUT with progress on Slice; DELETE on slice removal; reload resumability for in-flight uploads.

Each sub-slice ends in its own manual verification gate (no automated tests per project policy). Gate details live inline with each sub-slice's deliverables above.

## Strategy: vertical slices

We **do not** build full horizontal layers (audio infra → IDB → stores → components → modules). Each layer's correctness only becomes visible when an actual feature wires it end-to-end; building all three before the first feature compounds undetected integration risk.

Instead: five vertical slices, each delivering working user value. Shared foundations are extracted only when a second slice needs them.

### Slice A — Dashboard MVP (live audio + inference + health)

**User outcome**: open the app, see waveform/spectrogram of mic input, see live top-K classifications, see daemon health badge.

Deliverables:

1. SvelteKit scaffolding: `package.json`, `vite.config.ts`, `svelte.config.js`, `tsconfig.json`, `tailwind.config.js`, `postcss.config.js`, `app.html`, `app.css`, path aliases (`$lib`, `$proto`).
2. `src/routes/+layout.ts` → `prerender = true; ssr = false`. `+layout.svelte` → tab shell + badge slot.
3. Vite dev proxy for `/api`, `/stream/audio` (with `ws: true`), `/stream/infer` (with `ws: true`) to `127.0.0.1:8787`.
4. Proto decoder: a hand-written ~150 LOC decoder at [src/lib/stream/proto.ts](../../web/src/lib/stream/proto.ts). The schemas are tiny (4 messages, 14 fields total) and stable per [PROTO.md](../PROTO.md) (no third-party peers; wire-breaking changes ship as full replacements). Source-of-truth remains [modules/proto/\*.proto](../../modules/proto); the TS decoder is kept in 1:1 correspondence by inspection — desync surfaces as a runtime decode warning, not a build break, but the cost of a codegen step + Long.js runtime + 200 KB of protobufjs/ts-proto outweighs the safety gain at this scope.
5. Fetch wrapper `src/lib/api/http.ts`: typed JSON helper with error envelope parsing (`{ error, code }`), default 5 s timeout, surfaces `code` on rejection for store-level handling.
6. WS client `src/lib/stream/socket.ts`: opens with `Sec-WebSocket-Protocol: acoustics`, auto-reconnect with capped exponential backoff (200 ms → 5 s), exposes a `MessagePort`-style consumer API. **Operates in a Web Worker** to keep envelope decode + Opus decode off the main thread. Main thread receives postMessage transferables.
7. Opus decoder: WebCodecs `AudioDecoder` with `{ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 }`. Feature-detect `'AudioDecoder' in self`; if missing, show a clear "browser not supported" placeholder. **No WASM Opus fallback in v1** (defer until a real user has Safari ≤16).
8. Pair audio + inference by `t_us_capture_monotonic`: tiny ring buffer (last ~50 inference frames, ~12 s at 4 Hz) indexed by capture time; renderer queries nearest at RAF.
9. Renderers: `WaveformCanvas.svelte` (running PCM buffer, scrolling), `SpectrogramCanvas.svelte` (FFT via `AudioContext.AnalyserNode` for v1 — cheap and good enough; replace with Worker FFT only if quality demands), `TopKMeter.svelte` (bars for class probabilities).
10. Health badge: poll `GET /api/v1/status` at 2 Hz when visible, hover → popover with subsystem heartbeats. Single shared store.
11. Configuration drawer: mic policy (`GET/POST /api/v1/mic` with `?min_version=N` read-your-writes gate), inference cadence (`GET/POST /api/v1/inference`), active head selection (`GET/POST /api/v1/active` with `{ default: true }` option).

Critical files to create:

- [web/package.json](../../web/package.json), [web/vite.config.ts](../../web/vite.config.ts), [web/svelte.config.js](../../web/svelte.config.js), [web/tsconfig.json](../../web/tsconfig.json), [web/tailwind.config.js](../../web/tailwind.config.js)
- [web/src/app.html](../../web/src/app.html), [web/src/app.css](../../web/src/app.css)
- [web/src/routes/+layout.ts](../../web/src/routes/+layout.ts), [web/src/routes/+layout.svelte](../../web/src/routes/+layout.svelte)
- [web/src/routes/+page.svelte](../../web/src/routes/+page.svelte) (Dashboard)
- [web/src/lib/api/http.ts](../../web/src/lib/api/http.ts), [web/src/lib/api/types.ts](../../web/src/lib/api/types.ts), [web/src/lib/api/endpoints.ts](../../web/src/lib/api/endpoints.ts)
- [web/src/lib/stream/worker.ts](../../web/src/lib/stream/worker.ts), [web/src/lib/stream/client.ts](../../web/src/lib/stream/client.ts), [web/src/lib/stream/proto.ts](../../web/src/lib/stream/proto.ts)
- [web/src/lib/components/dashboard/](../../web/src/lib/components/dashboard/) — `WaveformCanvas.svelte`, `SpectrogramCanvas.svelte`, `TopKMeter.svelte`
- [web/src/lib/components/HealthBadge.svelte](../../web/src/lib/components/HealthBadge.svelte)
- [web/src/lib/stores/config.ts](../../web/src/lib/stores/config.ts), [web/src/lib/stores/streams.ts](../../web/src/lib/stores/streams.ts), [web/src/lib/stores/health.ts](../../web/src/lib/stores/health.ts)

Slice A done means: `pnpm dev` shows live waveform + spectrogram + top-K + health badge.

### Slice B — Workspace + Dataset Management

**User outcome**: create a workspace, record/upload audio, slice into labeled samples, commit to backend, see workspace revision update.

Deliverables:

1. Workspace list + detail routes: `/workspace`, `/workspace/[id]` (dynamic, client-rendered, no prerender).
2. CRUD via `POST/GET/PATCH/DELETE /api/v1/workspace[/{id}]`. Async delete: returns `{ job_id }` → subscribe to job events until terminal state. Workspace store tracks deletion-in-flight UI.
3. **Client-side filter**: workspaces tagged `__converter__` excluded from this tab's list.
4. IDB layer via `idb` (the minimal one, ~3 KB). Schema (one DB per origin):
   - `workspaces` — operator metadata cache (id, name, last seen revision).
   - `drafts` — recordings and segments. Fields: `id`, `workspace_id`, `class_label`, `blob` (WAV PCM-16 16 kHz mono), `duration_ms`, `created_at`, `state ∈ {draft, uploading, committed, failed}`, `upload_url`, `target_filename`, `last_error?`.
5. Recorder: `getUserMedia` → `AudioContext` (16 kHz target via `OfflineAudioContext` resample on stop) → PCM-16 WAV blob → IDB. Display recording timer + level meter via AnalyserNode.
6. Audio file import: drag-drop or file picker → decode via `AudioContext.decodeAudioData` → resample to 16 kHz mono → store in IDB.
7. Slicer UI: waveform editor with draggable boundaries, click-to-play segment, label per segment. Drafts persist across reloads from IDB. Spectrogram + waveform views per segment, basic quality flags (clipping, low SNR heuristics — defer if time pressed).
8. Commit flow (the load-bearing path):
   - Read `workspace.workspace_revision.id` as `base_rev`.
   - For each segment with `state = draft`: PUT to `/api/v1/workspace/{id}/assets/datasets/<class_label>/<uuid8>-<filename>.wav` via **XHR** (only place we use XHR — `upload.onprogress` is the only reliable upload progress).
   - On success: update IDB segment `state = committed`, record returned `workspace_revision_id`.
   - On failure: `state = failed`, store error code; show retry button per-segment.
   - **Filename safety**: prefix with uuid8 to avoid collisions; reject non-ASCII labels client-side per AssetPath rules.
   - **Resumability**: on page reload, scan for `state ∈ {uploading, failed}`, prompt "resume pending uploads?".
9. Revision UX: workspace card shows `rev N` chip. Heads list (when populated by Slice C) shows per-head `current` (green) or `stale (rev X → Y)` (amber) pill.

Critical files:

- [web/src/routes/workspace/+page.svelte](../../web/src/routes/workspace/+page.svelte), [web/src/routes/workspace/[id]/+page.svelte](../../web/src/routes/workspace/[id]/+page.svelte)
- [web/src/lib/idb/db.ts](../../web/src/lib/idb/db.ts), [web/src/lib/idb/drafts.ts](../../web/src/lib/idb/drafts.ts)
- [web/src/lib/audio/recorder.ts](../../web/src/lib/audio/recorder.ts), [web/src/lib/audio/wav.ts](../../web/src/lib/audio/wav.ts), [web/src/lib/audio/resample.ts](../../web/src/lib/audio/resample.ts)
- [web/src/lib/components/dataset/](../../web/src/lib/components/dataset/) — `Recorder.svelte`, `ImportZone.svelte`, `SegmentEditor.svelte`, `CommitDialog.svelte`
- [web/src/lib/api/upload.ts](../../web/src/lib/api/upload.ts) — XHR PUT with progress
- [web/src/lib/stores/workspace.ts](../../web/src/lib/stores/workspace.ts), [web/src/lib/stores/drafts.ts](../../web/src/lib/stores/drafts.ts)

### Slice C — Training + Job Events + History

**User outcome**: configure hyperparameters, launch a train job, watch real-time progress, browse past runs.

Deliverables:

1. Train form: epochs (1–1000), batch_size (1–4096), learning_rate (>0, ≤1.0), seed (optional), validation_split (0–1). Submit → `POST /api/v1/workspace/{id}/train` → receive `{ head_id, job_id }`.
2. **`subscribeJob(jobId)` helper** with the full state machine:
   - Open `GET /api/v1/jobs/{job_id}/events?after_seq=<cursor>` (SSE via `EventSource`).
   - On 409 `event_gap` response: parse body `{ oldest_seq, latest_seq }`, page through `GET /api/v1/workspace/{id}/assets/training_logs/<job_id>.jsonl?after_seq=<cursor>&limit=1000` until cursor ≥ `latest_seq`, then reopen SSE with `after_seq=<latest_seq>`.
   - On terminal state (`succeeded`/`failed`/`cancelled`): close stream, refresh heads list.
3. Progress UI: phase indicator (Loading → FeatureExtract → Train → Saving → Done), per-epoch loss/acc/val_acc line chart (canvas, no chart lib — small custom), virtualized log viewer.
4. Heads list (per workspace): `GET /api/v1/workspace/{id}/heads`. Per-head card: id (8 char), labels, n_classes, size, created_at, revision, status pill, "Activate" button → `POST /api/v1/active`, "Delete" button → `DELETE`.
5. Smart suggestion: if dataset revision matches an existing `current` head, show banner "head matches current dataset — skip training?" with "Activate instead" CTA. Implements ARCHITECTURE.md §B.3.
6. Cancel: `DELETE /api/v1/workspace/{id}/training/{job_id}`.
7. History view: `GET /api/v1/jobs` for memory ring; per workspace, also list `training_logs/` and `converter_logs/` via `GET /api/v1/workspace/{id}/assets/training_logs?after_seq=&limit=` directory listing, page through JSONL files for older entries. Merge + dedupe by `job_id`, sort by `created_at`. Filter by type (train / convert / dataset_delete / converter_delete / workspace_delete) and status.

Critical files:

- [web/src/lib/api/jobs.ts](../../web/src/lib/api/jobs.ts) — `subscribeJob`, JSONL pager, gap-recovery state machine
- [web/src/lib/components/training/](../../web/src/lib/components/training/) — `TrainForm.svelte`, `JobProgress.svelte`, `MetricsChart.svelte`, `LogViewer.svelte`, `HeadCard.svelte`
- [web/src/lib/components/history/HistoryList.svelte](../../web/src/lib/components/history/HistoryList.svelte)
- [web/src/lib/stores/jobs.ts](../../web/src/lib/stores/jobs.ts), [web/src/lib/stores/heads.ts](../../web/src/lib/stores/heads.ts)

### Slice D — Converter Tab + Tiny Dashboard

**User outcome**: drop TFJS bundle, convert to MPK, hot-swap converted head. Tiny Dashboard floats anywhere.

Deliverables:

1. Converter tab route `/converter`. Shows only workspaces tagged `__converter__`.
2. New conversion wizard: drop TFJS files (`model.json` + shards + labels) → auto-create workspace with name `converter-<uuid8>` and tags `['__converter__']` → PUT each file to `/api/v1/workspace/{id}/assets/converters/<filename>` → POST `/api/v1/workspace/{id}/convert` with `{ converter_type: 'tfjs', model_json_path, shards: [...], labels_path, labels_format }` → reuse `subscribeJob` from Slice C.
3. Post-conversion: download converted MPK button, "activate as inference head" button, "free up workspace" button (async DELETE with job tracking).
4. **Tiny Dashboard** as a floating, draggable card available on Workspace and Converter tabs. Reuses Slice A's streams + components (`WaveformCanvas`, `TopKMeter`). The shared Worker is always running; Tiny Dashboard just subscribes to its ring buffer. Toggle pinned/hidden via header icon. Persists open/closed state in `localStorage`.

Critical files:

- [web/src/routes/converter/+page.svelte](../../web/src/routes/converter/+page.svelte), [web/src/routes/converter/new/+page.svelte](../../web/src/routes/converter/new/+page.svelte)
- [web/src/lib/components/converter/](../../web/src/lib/components/converter/) — `ConvertWizard.svelte`, `ConverterCard.svelte`
- [web/src/lib/components/TinyDashboard.svelte](../../web/src/lib/components/TinyDashboard.svelte)

### Slice E — Polish + Primitive Extraction

**User outcome**: app feels finished. Polished feedback, keyboard navigation, responsive layout.

Deliverables:

1. Extract primitives **now** (after 4 slices of inline use): `Button`, `IconButton`, `Modal`, `Drawer`, `Toast`, `Tooltip`, `Tabs`, `Select`, `Slider`, `Toggle`, `Input`, `ProgressBar`, `Spinner`, `EmptyState`. Each tuned to the variants we actually used.
2. Global toast system: errors from API surface as toasts with `code`-aware copy ("Conflict: another training job is already running" for `another_train_running`, etc.).
3. Accessibility pass: semantic HTML, ARIA on interactive widgets, visible focus rings, full Tab/Enter/Space keyboard nav, contrast ≥ WCAG AA.
4. Responsive: target ≥1280 px desktop primary; ≥768 px tablet (collapsed nav, stacked cards); mobile not in scope per "single operator at the device" assumption.
5. Performance: virtualize logs and history (`@tanstack/svelte-virtual` or hand-rolled), debounce search inputs, RAF-throttle canvas renders, pool canvas contexts, lazy-import heavy routes.
6. Error boundary at the layout level — surfaces unrecovered errors instead of blank screen.
7. Empty states for every list (no workspaces, no heads, no jobs, no segments).
8. Optional: light/dark mode + i18n scaffolding deferred per [ARCHITECTURE.md §E.5.7](./ARCHITECTURE.md). Note locations where deferred work plugs in.

Critical files:

- [web/src/lib/components/ui/](../../web/src/lib/components/ui/) — extracted primitives
- [web/src/lib/components/Toast.svelte](../../web/src/lib/components/Toast.svelte), [web/src/lib/stores/toasts.ts](../../web/src/lib/stores/toasts.ts)
- [web/src/lib/utils/error-copy.ts](../../web/src/lib/utils/error-copy.ts) — code → message map

## Cross-cutting conventions

### Proto decoder

- Source-of-truth: [modules/proto/\*.proto](../../modules/proto). Never copied into `web/`.
- Implementation: hand-written decoder at [src/lib/stream/proto.ts](../../web/src/lib/stream/proto.ts) covering `Envelope`, `AudioFrame`, `InferenceFrame`, `TopK`. ~150 LOC, zero deps.
- Wire-format dispatch on field tag: receiver silently drops unknown tags per proto3 unknown-field semantics ([PROTO.md](../PROTO.md)).
- When `.proto` files change, the TS decoder must be updated in lockstep. The total field count is tiny enough that visual inspection suffices; consider adding back codegen only if the schema grows.

### Error envelope handling

- All API responses parsed for `{ error, code }`. Fetch wrapper rejects with a typed `ApiError { status, code, message }`.
- Stores translate `ApiError.code` → user-facing copy via [src/lib/utils/error-copy.ts](../../web/src/lib/utils/error-copy.ts).
- The one special case: SSE `event_gap` (409) is **not** an error — it triggers JSONL backfill in `subscribeJob`.

### Read-your-writes — mic policy

- `POST /api/v1/mic` returns new `version`. Immediately re-GET with `?min_version=<new>`, retry on 425 `too_early` with backoff (≤3 attempts), then surface success. Without this, the UI flickers back to the pre-write state.

### WS lifecycle

- Single shared Worker owns both `/stream/audio` and `/stream/infer`. Drains continuously regardless of UI visibility (backpressure threshold 64 frames = 1.28 s at 50 Hz — never let the renderer be the consumer).
- Renderer subscribes to Worker's ring via `postMessage` transferables. Audio frames decoded in Worker; main thread receives `Float32Array` PCM windows.
- On WS close (1011 lagged): full reconnect, accept frame loss (no replay). Show momentary "stream interrupted" indicator.

### Active head provenance

- Header strip displays `head_id[:8]@v{head_version}` from latest inference frame. Hover → popover with `source_workspace_id`, `workspace_revision`, `labels`.
- If `GET /api/v1/active` returns `source_workspace_alive: false`, header strip turns amber: "active head's source workspace deleted".

### TypeScript types match Rust

- All domain types in [src/lib/api/types.ts](../../web/src/lib/api/types.ts). Use discriminated unions where Rust uses tagged enums (e.g., `ActiveResp` with `origin: 'head' | 'default'` discriminates on whether `source_*` fields exist).
- Keep `as const` enums for codes/states. No string literals scattered in feature code.

### Vite proxy

```ts
server: {
  proxy: {
    '/api':           { target: 'http://127.0.0.1:8787' },
    '/stream/audio':  { target: 'ws://127.0.0.1:8787', ws: true },
    '/stream/infer':  { target: 'ws://127.0.0.1:8787', ws: true },
  }
}
```

Forgetting `ws: true` is silent — upgrade fails and debugging takes an hour. Lock this in Slice A.

### `__converter__` tag convention

- Set on workspace creation in the converter wizard. Filtered out of Workspace Tab's list (`tags.includes('__converter__')` excludes). Shown in Converter Tab.
- Backend doesn't know about the marker; it's purely a frontend convention.

## Verification

End-to-end manual verification per slice. No automated tests.

**Slice A**:

1. Run daemon (`cargo run --release`) and `pnpm dev` (in `web/`).
2. Open `http://localhost:5173`. Confirm waveform draws live mic audio.
3. Confirm Top-K bars update at ~4 Hz with the bundled default head's classifications.
4. Hover Health Badge: confirm subsystem heartbeat list. Trip a degraded state (e.g., disconnect mic in mock mode) and confirm the badge color reflects.
5. Open dev tools: confirm exactly one `/stream/audio` and one `/stream/infer` WS open. Disconnect Wi-Fi, reconnect, confirm auto-reconnect.

**Slice B**:

1. Create workspace "test-1" via UI. Confirm appears in list with `rev 0`.
2. Open detail. Record 3 clips, slice into 2 segments each (6 total), label as `dog`/`cat` (3 each). Confirm drafts persist after page reload.
3. Commit. Watch per-segment progress. Confirm `GET /api/v1/workspace/{id}` shows `workspace_revision.id` advanced to 6, `head_count: 0`.
4. Kill the page mid-commit; reload; confirm "resume pending uploads" prompt, complete commit successfully.
5. Delete the workspace; confirm async job completes and workspace disappears from list.

**Slice C** (updated 2026-05-14 to reflect the polled-not-SSE backend reality; see PLAN.md §"Corrections to the spec" #5):

1. With a committed dataset from Slice B, open the Train pane on a workspace detail page. Submit the defaults (30 epochs / batch 32 / lr 1e-3 / val_split 0.2 / blank seed).
2. Confirm the phase strip advances Loading → Feature extract → Training → Saving → Done as the 1 Hz poll ticks. Confirm the canvas chart fills in per-epoch loss (rose), train acc (dashed blue), val acc (emerald). Confirm the latest-metrics readout matches the most recent epoch.
3. After completion, confirm the terminal banner reads "Last run completed · just now" with the published head id, AND the Heads list below shows the new head with a `current` pill + an Activate button.
4. Click Activate. Confirm the head's pill changes to `Active` + the Activate button collapses to a disabled "Active" affordance. Confirm `/stream/infer` frames in the Dashboard tab carry the new `head_id` (the Active Head card on Dashboard updates).
5. Add 1 more slice to the dataset, wait for upload to commit. Confirm the previously-current head's pill flips to `stale` (driven by the upload-receipt-promoted `liveRevision`, no page poller wait needed).
6. From the same workspace, click Train head again. Confirm the form submits and the phase strip resumes. Click Cancel mid-run; confirm the button label flips to "Cancelling…", the next 1-2 polls observe `state: cancelled`, and the terminal banner reads "Last run cancelled".
7. While a train is in flight, navigate to a sibling workspace's detail. Confirm its Train form is disabled with the amber "Another workspace is training a head" note. Confirm the active workspace's progress survives the route swap (the singleton store keeps tracking; the visited workspace's TrainPane re-binds on return).
8. Reload the page mid-train. Confirm the Train pane snaps back to active progress within ~1 second (`training.recover` lists the workspace's `/training` and re-binds the poller).
9. Delete a stale head from the Heads list. Confirm the dialog accepts the deletion (rose Delete button, no double-confirm beyond the modal itself) and the card disappears from the list immediately. Confirm the active head can't be deleted (button disabled, tooltip explains).
10. Smart-suggestion: with a `current` head that isn't the active one, dismiss the suggestion banner; confirm the form re-appears. Add a slice (advances `liveRevision`); confirm the banner returns once the new revision arrives but the previously-current head is now stale (so no suggestion).

**Slice D**:

1. In Converter Tab, run the wizard with a Teachable Machine TFJS export. Confirm `converter-<uuid8>` workspace appears here, **not** in Workspace Tab.
2. Confirm conversion job streams progress, completes; confirm download MPK works; confirm "Activate" updates inference head globally.
3. Open Tiny Dashboard on the Workspace Tab; confirm it shows the same live waveform + Top-K as the main Dashboard.
4. Free up the converter workspace; confirm async deletion.

**Slice E**:

1. Tab through every interactive control on every tab; confirm focus rings visible, Enter/Space activate correctly.
2. Force every error code path (e.g., POST `/train` while one is running → `another_train_running` 409) and confirm a toast surfaces with helpful copy.
3. Resize browser to 1280 px, 1024 px, 768 px; confirm layouts hold.
4. Open 50 segments + 5000 log lines; confirm scroll perf stays smooth (no jank).
5. Run Lighthouse: confirm no critical accessibility violations, perf score acceptable for a local SPA.

## Things explicitly NOT in scope

- Light/dark mode (deferred per [ARCHITECTURE.md §E.5.7](./ARCHITECTURE.md))
- Internationalization (deferred)
- Mobile-first responsive (≥768 px tablet only)
- Automated tests, benchmarks, CI
- Backend modifications (no static-file serving from daemon, no new endpoints)
- WebTransport / QUIC streams (WebSocket only)
- Multi-user / auth UI (operator-local trust model per [docs/API.md](../API.md))
- Telemetry / analytics

## Open questions worth revisiting after Slice A

- Spectrogram: stay with cheap `AnalyserNode` or migrate to Worker FFT? Decide based on visible quality after Slice A.
- WASM Opus fallback: skip in v1; revisit if a real user reports Safari ≤16 needs.
- COOP/COEP for `crossOriginIsolated` + SharedArrayBuffer: only needed if Worker→main transfer becomes a bottleneck. Skip in v1.
