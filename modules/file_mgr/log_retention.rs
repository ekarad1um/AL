//! Producer-side keep-last-N retention for per-workspace JSONL
//! job logs.
//!
//! # Scope
//!
//! The shared [`super::JsonlEventLog`] writer is invoked from
//! training (`JsonlEventLog<TrainEvent>` against
//! `<workspace>/training_logs/<job_id>.jsonl`) and the converter
//! (`JsonlEventLog<ConvertEvent>` against
//! `<workspace>/converter_logs/<job_id>.jsonl`); both call
//! [`enforce_keep_last_n`] right after opening the new log
//! file.  The newly-opened file's mtime is set by `create(true)`
//! and is therefore the freshest non-future entry in the
//! directory, so it survives every sweep as long as
//! `keep >= 1` and no forward-stamped peer pushes it out of the
//! top slot.  Older runs that exceed the cap are unlinked in
//! mtime-descending order (newest survives, oldest dies first).
//!
//! # Why producer-side, not periodic
//!
//! The previous design swept logs in
//! `crate::file_mgr::storage_reaper` on a 1 h timer against a
//! 30-day age threshold.  Two problems:
//!
//! 1. **Latency**: a workspace that ran 100 short training
//!    iterations in an hour would not see retention applied
//!    until the next sweep tick.
//! 2. **Coupling**: the reaper had two unrelated jobs (`.tmp/`
//!    orphan cleanup + log pruning) under one config struct,
//!    each with its own threshold.  Operators tuning one
//!    inevitably touched the other.
//!
//! Moving retention to the producer means it runs exactly when
//! new logs arrive -- the only moment the cap can be exceeded.
//! Idle workspaces incur zero retention cost; their log dirs
//! stay bounded at whatever count they reached on the last run.
//!
//! # Safety against concurrent operations
//!
//! * **Operator-initiated single-file delete**
//!   (`DELETE /assets/training_logs/<id>.jsonl`): the tombstone
//!   delete path renames the target into `.tmp/` before
//!   unlinking; our `remove_file` on the same path observes
//!   `NotFound` and treats it as benign.
//! * **Operator-initiated whole-tree wipe**
//!   (`DELETE /assets/training_logs`): the dispatcher gates on
//!   `has_active_train_for(ws)` and refuses with `JobConflict`
//!   while a producer is running, so it cannot race the producer
//!   that just invoked this helper.
//! * **Cross-workspace concurrency**: per-workspace dirs do not
//!   overlap, so producers in different workspaces never touch
//!   each other's listings.
//! * **Cross-tree concurrency**: a Train and a Convert job in
//!   the same workspace touch disjoint dirs
//!   (`training_logs/` vs `converter_logs/`).
//!
//! # File selection
//!
//! Only regular files whose filename ends in `.jsonl` are
//! candidates for unlinking.  Subdirectories, symlinks, and
//! files with other extensions are skipped so an
//! operator-pasted artifact (a `notes.txt`, a stashed
//! `archive/` subdir) survives the sweep.  This is stricter
//! than the previous reaper's "any regular file" rule and
//! matches the producer's actual on-disk shape.
//!
//! # Clock-skew safety
//!
//! Files whose mtime is *in the future* relative to wall-clock
//! `now` are excluded from the candidate set (mirrors the
//! `Err(_)` branch of `SystemTime::duration_since` exploited by
//! [`super::storage_reaper`]).  This protects the just-opened
//! log from being demoted out of the top-`keep` slots by an
//! operator-touched (or NFS-skewed) sibling whose mtime
//! outranks ours.  Trade-off: forward-stamped files do NOT
//! count toward the cap, so the per-tree file count can exceed
//! `keep` by the number of such files.  Operator-pasted
//! forward stamps are a deliberate act; preserving the
//! producer's data integrity wins over a strict cap.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Number of `.jsonl` log files kept per workspace per tree.
/// Applied independently to `<workspace>/training_logs/` and
/// `<workspace>/converter_logs/` whenever a producer opens a
/// new log file.  Operator-tunable in spirit; promote to the
/// launch TOML if a deployment asks for a tighter / looser cap.
pub const LOG_RETENTION_KEEP_COUNT: usize = 10;

/// Outcome of one [`enforce_keep_last_n`] sweep.  Producers
/// pass `pruned`/`failures` into the metrics hook so operators
/// see "log files reaped" without grepping the daemon log.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RetentionReport {
    /// `.jsonl` files unlinked because they fell outside the
    /// `keep` newest.  Excludes raced `NotFound` (the file was
    /// removed by an operator between our listing and the
    /// unlink; counts as success-with-no-op).
    pub pruned: u64,
    /// Per-entry failures (metadata probe, mtime probe, unlink
    /// other than `NotFound`).  Logged at `warn!` by the
    /// caller; counted here so the metrics surface reflects the
    /// hygiene path's health.
    pub failures: u64,
}

/// Enforce "keep at most `keep` `.jsonl` files in `dir`",
/// unlinking the rest in mtime-descending order (the newest
/// `keep` survive).
///
/// # Behaviour
///
/// * Missing `dir` is a no-op (the producer creates the dir
///   immediately before calling this helper, so this branch is
///   exercised only when the producer's `create_dir_all`
///   raced with a concurrent operator-driven whole-tree wipe).
/// * `dir` entries that are not regular files, or whose
///   filename does not end in `.jsonl`, are skipped (preserved).
/// * Files whose mtime is *in the future* relative to the
///   per-call `SystemTime::now()` snapshot are excluded from
///   the candidate set; see the module-level
///   `# Clock-skew safety` section.
/// * Files whose `metadata()` or `modified()` probe fails are
///   excluded from the retention set AND counted in
///   `failures`; they survive this sweep (the next producer
///   tick re-probes them).
/// * `keep == 0` is accepted (the caller has explicitly asked
///   to clear every `.jsonl` file).  No warning, no clamp:
///   tests use this as a "delete everything" shorthand.  A
///   `keep == 0` from a producer hot path would also unlink
///   the just-opened file, so production callers must use a
///   non-zero `keep` (the daemon's
///   [`LOG_RETENTION_KEEP_COUNT`] is hard-coded to 10).
///
/// # Failure isolation
///
/// Top-level `read_dir` failure other than `NotFound` returns
/// a report with `failures = 1` and no removals -- consistent
/// with the per-entry failure path so the caller has one shape
/// to feed metrics.  No `io::Error` is propagated: this is a
/// best-effort hygiene action and a failing producer hot path
/// must not fail the job.
///
/// # Metrics
///
/// On return, both counts in the returned [`RetentionReport`]
/// are forwarded through `super::metrics_hooks::emit_logs_pruned`
/// (crate-private).
/// The returned report is for caller (test) introspection only;
/// production callers can discard it.  Mirrors the
/// emit-at-completion pattern of other `file_mgr` write helpers
/// (`schema::write_workspace_core`, `dataset::upload_workspace_file`,
/// ...) so adding a new producer that invokes this helper does
/// not require a separate metric-emission step.
pub fn enforce_keep_last_n(dir: &Path, keep: usize) -> RetentionReport {
    // Snapshot `now` once up front so every per-entry
    // comparison shares the same wall-clock reference, even if
    // the clock moves during a sweep.  Mirrors
    // `storage_reaper::sweep_once`.
    let now = SystemTime::now();
    let mut report = RetentionReport::default();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return report,
        Err(e) => {
            tracing::warn!(
                target: "file_mgr",
                err = %e,
                path = %dir.display(),
                "log retention: read_dir failed",
            );
            report.failures += 1;
            return report;
        }
    };
    let mut candidates: Vec<(PathBuf, SystemTime)> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(
                    target: "file_mgr",
                    err = %e,
                    parent = %dir.display(),
                    "log retention: dir-iter entry failed",
                );
                report.failures += 1;
                continue;
            }
        };
        let path = entry.path();
        if !path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|s| s.ends_with(".jsonl"))
        {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                tracing::warn!(
                    target: "file_mgr",
                    err = %e,
                    path = %path.display(),
                    "log retention: metadata probe failed",
                );
                report.failures += 1;
                continue;
            }
        };
        // `DirEntry::metadata` does NOT follow symlinks, so a
        // symlink whose target is a regular file is reported
        // as `is_symlink` here and skipped by the
        // `!is_file()` gate.  Defensive against an
        // operator-pasted symlink in the log dir: we only
        // touch files the producer would actually create.
        if !metadata.file_type().is_file() {
            continue;
        }
        let mtime = match metadata.modified() {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    target: "file_mgr",
                    err = %e,
                    path = %path.display(),
                    "log retention: mtime probe failed (platform does not expose mtime?)",
                );
                report.failures += 1;
                continue;
            }
        };
        // Future-mtime safety: an operator-touched (or
        // NFS-skewed) `.jsonl` whose mtime > now would sort
        // ABOVE our just-opened log file (mtime ≈ now) and
        // could push it into the delete tail.  Skip these
        // entries entirely; they survive the sweep but do
        // not count toward `keep`.  See module-level
        // `# Clock-skew safety`.
        if mtime > now {
            continue;
        }
        candidates.push((path, mtime));
    }
    if candidates.len() <= keep {
        return report;
    }
    // Stable sort by mtime DESCENDING (newest first).  Ties
    // (same mtime to filesystem resolution) survive in
    // dir-iter order, which on most filesystems matches the
    // order of creation closely enough that a tie-break is a
    // hygiene concern, not a correctness one.
    candidates.sort_by(|(_, a), (_, b)| b.cmp(a));
    for (path, _) in candidates.into_iter().skip(keep) {
        match std::fs::remove_file(&path) {
            Ok(()) => report.pruned += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Operator-driven single-file delete raced our
                // listing.  Already gone; nothing to count.
            }
            Err(e) => {
                tracing::warn!(
                    target: "file_mgr",
                    err = %e,
                    path = %path.display(),
                    "log retention: remove failed",
                );
                report.failures += 1;
            }
        }
    }
    // Publish the per-sweep counts through the daemon's
    // installed hook.  Mirrors the other `file_mgr` write
    // helpers (`schema::write_workspace_core`,
    // `dataset::upload_workspace_file`, ...) which emit their
    // own metric events at the natural completion point; keeps
    // producer call sites to a single helper invocation.  The
    // hook short-circuits at `(0, 0)` so no-op sweeps incur
    // zero metrics traffic.
    super::metrics_hooks::emit_logs_pruned(report.pruned, report.failures);
    report
}

#[cfg(test)]
mod tests {
    // Tests stage `.jsonl` fixtures with `std::fs::*` and
    // backdate mtimes with `filetime`; production guards
    // (writes through `file_mgr` atomic helpers) do not apply
    // to test setup.
    #![allow(clippy::disallowed_methods)]
    use super::*;
    use std::fs;
    use std::time::{Duration, UNIX_EPOCH};

    fn write_log(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, b"{}\n").expect("write fixture");
        p
    }

    fn set_mtime(path: &Path, offset_from_now: i64) {
        let target = if offset_from_now >= 0 {
            SystemTime::now()
                .checked_add(Duration::from_secs(offset_from_now as u64))
                .expect("forward mtime")
        } else {
            SystemTime::now()
                .checked_sub(Duration::from_secs((-offset_from_now) as u64))
                .expect("back mtime")
        };
        let secs = target
            .duration_since(UNIX_EPOCH)
            .expect("post-epoch")
            .as_secs();
        let ft = filetime::FileTime::from_unix_time(secs as i64, 0);
        filetime::set_file_mtime(path, ft).expect("set mtime");
    }

    /// Missing dir returns the zero report (no failure counted).
    /// Producers may invoke retention against a dir that was
    /// briefly wiped by an operator between `create_dir_all`
    /// and this call.
    #[test]
    fn missing_dir_is_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let report = enforce_keep_last_n(&tmp.path().join("absent"), 5);
        assert_eq!(report, RetentionReport::default());
    }

    /// Empty dir returns the zero report.
    #[test]
    fn empty_dir_is_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let report = enforce_keep_last_n(tmp.path(), 5);
        assert_eq!(report, RetentionReport::default());
    }

    /// `count <= keep` returns no-op even with files present.
    #[test]
    fn under_cap_is_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..3 {
            write_log(tmp.path(), &format!("job-{i}.jsonl"));
        }
        let report = enforce_keep_last_n(tmp.path(), 5);
        assert_eq!(report.pruned, 0);
        assert_eq!(report.failures, 0);
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 3);
    }

    /// `count > keep` unlinks (count - keep) oldest files;
    /// newest `keep` survive.  Sort is by mtime DESCENDING
    /// (newest first); we backdate older files so the test's
    /// expectations are independent of file-creation timing.
    #[test]
    fn over_cap_unlinks_oldest_first() {
        let tmp = tempfile::tempdir().unwrap();
        // 5 files; we'll keep the 2 newest.
        let a = write_log(tmp.path(), "a.jsonl");
        let b = write_log(tmp.path(), "b.jsonl");
        let c = write_log(tmp.path(), "c.jsonl");
        let d = write_log(tmp.path(), "d.jsonl");
        let e = write_log(tmp.path(), "e.jsonl");
        // Force ordering: a oldest, e newest.
        set_mtime(&a, -500);
        set_mtime(&b, -400);
        set_mtime(&c, -300);
        set_mtime(&d, -200);
        set_mtime(&e, -100);
        let report = enforce_keep_last_n(tmp.path(), 2);
        assert_eq!(report.pruned, 3);
        assert_eq!(report.failures, 0);
        assert!(!a.exists());
        assert!(!b.exists());
        assert!(!c.exists());
        assert!(d.exists(), "second-newest survives");
        assert!(e.exists(), "newest survives");
    }

    /// `keep == 0` removes every `.jsonl`.  Accepted shape
    /// (caller has explicit "clear all" intent); no clamp.
    #[test]
    fn keep_zero_removes_every_jsonl() {
        let tmp = tempfile::tempdir().unwrap();
        write_log(tmp.path(), "a.jsonl");
        write_log(tmp.path(), "b.jsonl");
        let report = enforce_keep_last_n(tmp.path(), 0);
        assert_eq!(report.pruned, 2);
        assert!(!tmp.path().join("a.jsonl").exists());
        assert!(!tmp.path().join("b.jsonl").exists());
    }

    /// Non-`.jsonl` regular files survive every sweep
    /// regardless of `keep`.  An operator-pasted `notes.txt`,
    /// a stashed `archive.tar.gz`, etc.: the producer owns the
    /// `.jsonl` extension, nothing else.
    #[test]
    fn non_jsonl_files_survive() {
        let tmp = tempfile::tempdir().unwrap();
        let notes = tmp.path().join("notes.txt");
        let archive = tmp.path().join("archive.tar.gz");
        let weird = tmp.path().join("job.jsonl.bak");
        fs::write(&notes, b"hello").unwrap();
        fs::write(&archive, b"junk").unwrap();
        fs::write(&weird, b"junk").unwrap();
        write_log(tmp.path(), "a.jsonl");
        let report = enforce_keep_last_n(tmp.path(), 0);
        assert_eq!(report.pruned, 1, "only `.jsonl` files count");
        assert!(notes.exists());
        assert!(archive.exists());
        assert!(weird.exists());
    }

    /// Subdirectories survive.  Defensive: production log dirs
    /// never hold subdirs, but an operator-pasted `stash/`
    /// must not disappear silently.
    #[test]
    fn subdirs_survive() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("operator-stash");
        fs::create_dir(&sub).unwrap();
        // Even a subdir literally named `*.jsonl` survives,
        // because we check the file-type AFTER the extension
        // gate.  Be paranoid: stage one.
        let weird_dir = tmp.path().join("looks-like-a-log.jsonl");
        fs::create_dir(&weird_dir).unwrap();
        write_log(tmp.path(), "a.jsonl");
        let report = enforce_keep_last_n(tmp.path(), 0);
        assert_eq!(report.pruned, 1, "only the regular .jsonl file is reaped");
        assert!(sub.is_dir());
        assert!(weird_dir.is_dir(), "subdir named *.jsonl survives");
    }

    /// Files with mtime *in the future* relative to wall-clock
    /// `now` are excluded from the candidate set.  Mirrors
    /// `storage_reaper`'s clock-skew safety branch; protects
    /// the just-opened producer log from being demoted out of
    /// the top-`keep` slots by an operator-touched (or
    /// NFS-skewed) sibling whose mtime outranks ours.  The
    /// trade-off (forward-stamped files do not count toward
    /// the cap) is the operator's responsibility.
    #[test]
    fn future_mtime_files_are_preserved_and_do_not_count_toward_cap() {
        let tmp = tempfile::tempdir().unwrap();
        // Two forward-stamped `.jsonl` files: an operator
        // touched these into the future (or a FUSE/NFS mount
        // skewed them).  They must survive every sweep.
        let future_a = write_log(tmp.path(), "future-a.jsonl");
        let future_b = write_log(tmp.path(), "future-b.jsonl");
        set_mtime(&future_a, 3600);
        set_mtime(&future_b, 3600);
        // Two past-stamped legitimate logs: a "recent" one
        // (1 min ago) and an "old" one (1 h ago).
        let recent = write_log(tmp.path(), "recent.jsonl");
        let old = write_log(tmp.path(), "old.jsonl");
        set_mtime(&recent, -60);
        set_mtime(&old, -3600);
        // keep=1: were future files included, they would sort
        // above the past files and only `future_a` (or `_b`)
        // would survive in the top slot; `recent` and `old`
        // would BOTH be unlinked, which is the hazard.  With
        // the future-skip in place, the candidate set is
        // {recent, old}; we keep `recent` and unlink `old`.
        let report = enforce_keep_last_n(tmp.path(), 1);
        assert_eq!(report.pruned, 1, "exactly one past file unlinked");
        assert_eq!(report.failures, 0);
        assert!(future_a.exists(), "future-stamped file survives");
        assert!(future_b.exists(), "second future-stamped file survives");
        assert!(recent.exists(), "newest past file survives the cap");
        assert!(!old.exists(), "oldest past file unlinked by the cap");
    }

    /// `RetentionReport::default()` is the all-zero "did
    /// nothing" shape returned by the missing-dir branch.
    /// Pinning this lets future-me distinguish "ran and found
    /// nothing" from "skipped because the dir wasn't there"
    /// at the call site without a separate Option<_> wrapping.
    #[test]
    fn default_report_is_all_zero() {
        let r = RetentionReport::default();
        assert_eq!(r.pruned, 0);
        assert_eq!(r.failures, 0);
    }
}
