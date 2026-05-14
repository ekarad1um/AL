import { ApiError } from './http';
import type { ApiErrorBody } from './types';

// Classify retry-worthy errors.  Transient: network blips (plain
// `Error` from `xhrPut`'s onerror/ontimeout) and daemon-side 5xx /
// 429 rate limits -- worth retrying.  Permanent: 4xx other than
// 429.  Aborts are out of scope: callers check `signal.aborted`
// separately and short-circuit before consulting this predicate.
export function isTransientUploadError(e: unknown): boolean {
  if (e instanceof ApiError) {
    return e.status >= 500 || e.status === 429;
  }
  return e instanceof Error && !(e instanceof DOMException);
}

// Abortable sleep for retry backoff.  Resolves after `ms`; rejects
// with `DOMException('AbortError')` on abort -- same shape
// `xhrPut` rejects with, so retry call-sites can check
// `signal.aborted` regardless of which phase was interrupted.
export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// XHR-based upload helper.  `fetch` lacks an `upload.onprogress`
// event, so byte-level progress requires XHR -- the one place in
// the codebase we reach for it.  Maps non-2xx to `ApiError` so
// `errorCopy` handles operator copy the same way as fetch failures.

export interface XhrUploadOptions {
  url: string;
  body: Blob;
  // Defaults to `application/octet-stream`; the daemon doesn't
  // inspect content-type but our HTTP middleware (if any) might.
  contentType?: string;
  // Per-byte progress.  Fires only when `event.lengthComputable`
  // is true (which is always the case for Blob bodies; the guard
  // is just defence against chunked-encoded streams a future
  // caller might pass through).
  onProgress?: (loaded: number, total: number) => void;
  // Caller-supplied cancellation.  Calling `abort()` aborts the
  // XHR and rejects the returned promise with `signal.reason`.
  signal?: AbortSignal;
}

// Generic typed PUT.  Returns `{status, body}` parsed as JSON;
// throws `ApiError` for non-2xx with the parsed error envelope so
// `errorCopy` can map it to operator-facing text the same way it
// does for fetch failures.
export function xhrPut<T>(opts: XhrUploadOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', opts.url, true);
    // The daemon writes JSON responses for both success and
    // error paths; setting `responseType` makes XHR parse on
    // demand and surfaces `xhr.response` as the typed value.
    xhr.responseType = 'json';
    xhr.setRequestHeader('content-type', opts.contentType ?? 'application/octet-stream');

    if (opts.onProgress) {
      xhr.upload.onprogress = (e: ProgressEvent): void => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
      };
    }

    xhr.onload = (): void => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as T);
        return;
      }
      // Build an ApiError shaped like the fetch wrapper produces
      // so call sites can `instanceof ApiError` uniformly.  The
      // daemon's error envelope is `{error, code}`; if XHR's
      // response parsing didn't surface that (e.g. malformed
      // JSON), fall back to the status text.
      const body: ApiErrorBody = (xhr.response as ApiErrorBody | null) ?? {
        error: xhr.statusText || `HTTP ${xhr.status}`,
        code: 'unknown'
      };
      reject(new ApiError(xhr.status, body));
    };
    xhr.onerror = (): void => {
      // Network-level failure (DNS, refused connection, CORS).
      // Surface as a non-API Error so the catch in the upload
      // queue can distinguish transport failures from server
      // rejections; `errorCopy` handles the bare Error path too.
      reject(new Error('Network error during upload.'));
    };
    xhr.ontimeout = (): void => {
      reject(new Error('Upload timed out.'));
    };

    if (opts.signal) {
      // `signal.reason` is typed `any` -- coerce to an Error so
      // call sites can rely on `catch (e: unknown)` narrowing.
      // Non-Error reasons (e.g. caller passed a string) wrap
      // into a `DOMException('aborted', 'AbortError')`, which is
      // the same shape the platform produces for native aborts.
      const abortError = (reason: unknown): Error =>
        reason instanceof Error ? reason : new DOMException('aborted', 'AbortError');
      if (opts.signal.aborted) {
        // Synchronously abort -- caller already cancelled.
        xhr.abort();
        reject(abortError(opts.signal.reason));
        return;
      }
      opts.signal.addEventListener(
        'abort',
        () => {
          xhr.abort();
          reject(abortError(opts.signal?.reason));
        },
        { once: true }
      );
    }

    xhr.send(opts.body);
  });
}

// Bounded-concurrency task pool.  Caps simultaneous uploads at
// `max` (default 3) so a 60-slice batch doesn't open 60 XHRs at
// once.  FIFO drain so the operator sees progress in submit
// order, not arbitrary completion order.
export class UploadPool {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  // Run `task` once a slot frees.  Returns the task's own promise
  // so the caller can `await pool.submit(...)` and surface
  // failures upstream; the pool itself never swallows them.
  async submit<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  // Optional: introspect the pool.  Useful for the pending-uploads
  // banner to surface "uploading 2 of 7" copy without poking at
  // private state.
  get pending(): number {
    return this.waiting.length;
  }
  get inflight(): number {
    return this.active;
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }
}
