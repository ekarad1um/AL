//! Global-allocator release hint via mimalloc's `mi_collect`.
//!
//! Lives outside [`crate::common`] (which carries
//! `#![forbid(unsafe_code)]`) for the same reason as
//! [`crate::sched`]: the FFI call needs `unsafe`.
//!
//! Call from training-job tails after the feature buffer + head
//! snapshot drop.  Do NOT call from steady-state hot paths
//! (inference, opus encode, API handlers).
//!
//! This build links **mimalloc v3** (the `v2` feature is not
//! enabled on the `mimalloc` / `libmimalloc-sys` deps).

#![warn(missing_debug_implementations)]

/// Hint the global allocator to release freed pages back to the
/// OS.  With `mimalloc`: calls `mi_collect(true)` (mimalloc's
/// `malloc_trim` equivalent; on Linux issues
/// `madvise(MADV_DONTNEED)` so VmRSS drops immediately).
/// Without: no-op.
///
/// Typical cost: <10 ms on a daemon-sized heap.  Async callers
/// should `spawn_blocking` to insulate the runtime from worst-
/// case fragmentation.
pub fn release_to_os() {
    #[cfg(feature = "mimalloc")]
    {
        // SAFETY: thread-safe FFI entry, no pointer arguments;
        // safe even when mimalloc is not the active global
        // allocator (operates on an empty arena pool).
        unsafe { libmimalloc_sys::mi_collect(true) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_to_os_does_not_panic() {
        release_to_os();
        release_to_os();
    }
}
