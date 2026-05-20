//! Producer-side per-job JSONL writer.
//!
//! Shared backing for `<workspace>/training_logs/<job_id>.jsonl`
//! and `<workspace>/converter_logs/<job_id>.jsonl`: every line is
//! the envelope `{seq, at, ...flattened(event)}`, monotonic
//! per-file `seq`, RFC3339 `at`, and a producer-owned typed
//! event flattened in via `#[serde(flatten)]`.  Reading is the
//! producer-agnostic [`super::log_page::LogEvent`]; this module
//! is the symmetric writer.
//!
//! ## Behaviour
//!
//! * **Open**: creates `<workspace>/<subtree>/` if absent, opens
//!   `<job_id>.jsonl` in append mode, then applies
//!   [`super::LOG_RETENTION_KEEP_COUNT`] so the just-created log
//!   is the freshest entry by mtime and survives the sweep.
//! * **Emit**: serialises the envelope and appends one line +
//!   `\n` via a single `write_all` (atomic at the OS-append
//!   layer on the same handle).  Per-line `fsync` is
//!   intentionally skipped (10x cost for negligible recovery
//!   benefit; a crash mid-job loses at most the trailing
//!   event, and workspace state is recovered via boot recovery
//!   elsewhere).  The trailing `flush()` call is a no-op on
//!   `std::fs::File` today (no user-space buffer), kept as a
//!   defensive habit in case a future revision wraps the file
//!   in a buffered writer.
//!
//! ## Why a generic
//!
//! The previous `TrainJobLog` and `ConvertJobLog` were 95 %
//! identical (same `file + seq` shape, same open / append /
//! retention dance) with the converter's docstring explicitly
//! calling itself a "mirror" of the training one.  Generalising
//! over `E: Serialize` collapses both into one writer; each
//! producer owns its typed event enum and the wire shape stays
//! a stable `{seq, at, ...E}` round-trippable by [`super::log_page`].

use std::io;
use std::marker::PhantomData;
use std::path::Path;

use serde::Serialize;

use crate::common::ids::JobId;

/// Per-job JSONL writer generic over the producer's event type.
/// Holds the append-mode file handle + the monotonic per-file
/// `seq` counter; not thread-safe (callers wrap in
/// `Arc<Mutex<_>>` when multiple producer paths share one log).
///
/// `_marker` is `PhantomData<fn(&E)>` rather than `PhantomData<E>`
/// because this struct only **borrows** `E` ([`Self::emit`] takes
/// `&E`) and never owns an instance.  The fn-pointer form drops
/// `Send`/`Sync`/drop-check inheritance from `E` (fn pointers
/// are always `Send + Sync`); today's events are all
/// `'static + Send + Sync` so this is observable only as
/// compile-time intent.
#[derive(Debug)]
pub struct JsonlEventLog<E: Serialize> {
    file: std::fs::File,
    seq: u64,
    _marker: PhantomData<fn(&E)>,
}

/// Per-line wire envelope.  Producer's event flattens in via
/// `#[serde(flatten)]` so the resulting object is `{seq, at,
/// ...event-fields}` — the shape every JSONL reader in the
/// daemon expects.
#[derive(Debug, Serialize)]
struct Envelope<'a, E: Serialize> {
    seq: u64,
    at: String,
    #[serde(flatten)]
    event: &'a E,
}

impl<E: Serialize> JsonlEventLog<E> {
    /// Open `<workspace_dir>/<subtree>/<job_id>.jsonl` for append,
    /// creating the dir if missing; apply
    /// [`super::LOG_RETENTION_KEEP_COUNT`] over the dir's `.jsonl`
    /// files post-open.  The just-created log is the freshest by
    /// mtime and survives every sweep, modulo forward-stamped
    /// siblings (see [`super::log_retention`] for the clock-skew
    /// safety branch).
    ///
    /// `subtree` is the per-producer dir name beneath
    /// `<workspace_dir>` (e.g. [`super::TRAINING_LOGS_DIR_NAME`],
    /// [`super::CONVERTER_LOGS_DIR_NAME`]); the caller passes a
    /// constant so the on-disk layout stays grep-able.
    ///
    /// Returns plain [`io::Result`] — producers map the error
    /// into their own taxonomy at the call site (preserving
    /// path context they already hold).
    pub fn open(workspace_dir: &Path, subtree: &str, job_id: JobId) -> io::Result<Self> {
        let dir = workspace_dir.join(subtree);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{job_id}.jsonl"));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        super::enforce_keep_last_n(&dir, super::LOG_RETENTION_KEEP_COUNT);
        Ok(Self {
            file,
            seq: 0,
            _marker: PhantomData,
        })
    }

    /// Append one JSONL line carrying `event` flattened into the
    /// `{seq, at}` envelope.  `seq` is incremented BEFORE the
    /// serialise + write attempt, so a failure consumes the
    /// candidate `seq` and the next successful emit lands on
    /// `seq + 1` (gap of 1 on disk).  The [`super::log_page`]
    /// reader tolerates these gaps — it skips unparseable /
    /// missing seq values without affecting the cursor.
    ///
    /// `serde_json::Error` is wrapped via [`io::Error::other`] so
    /// the caller has one error variant to map.  `flush()` is
    /// called after `write_all` as a defensive habit; for
    /// `std::fs::File` today it is a no-op (see module docs).
    pub fn emit(&mut self, event: &E) -> io::Result<()> {
        use std::io::Write as _;
        self.seq = self.seq.saturating_add(1);
        let line = Envelope {
            seq: self.seq,
            at: super::now_rfc3339(),
            event,
        };
        let mut bytes = serde_json::to_vec(&line).map_err(io::Error::other)?;
        bytes.push(b'\n');
        self.file.write_all(&bytes)?;
        let _ = self.file.flush();
        Ok(())
    }

    /// Monotonic per-file sequence: the `seq` value of the last
    /// event successfully emitted, or 0 if no event has been
    /// written yet.  Useful for introspection from tests; not
    /// part of the on-disk shape.
    #[cfg(test)]
    pub(crate) fn current_seq(&self) -> u64 {
        self.seq
    }
}

#[cfg(test)]
mod tests {
    // Tests stage and inspect `.jsonl` fixtures with `std::fs::*`;
    // production guards (atomic-write helpers) don't apply to
    // append-only log files.
    #![allow(clippy::disallowed_methods)]
    use super::*;
    use serde::Serialize;

    /// Synthetic event shape: mirrors the production producers'
    /// `#[serde(tag = "kind")]` discriminator pattern so the
    /// emitted lines look like real training / converter events.
    #[derive(Debug, Serialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum Probe {
        First,
        Second { value: u32 },
    }

    /// Round-trips the on-disk shape: one JSONL line per `emit`,
    /// monotonic `seq` starting at 1, RFC3339 `at`, and the
    /// event's fields flattened into the same object.  Pins the
    /// envelope so a future shape change surfaces here, not via
    /// a silent break of the consumer.
    #[test]
    fn emit_writes_envelope_with_seq_at_and_flattened_event() {
        let tmp = tempfile::tempdir().unwrap();
        let job_id = JobId::new();
        let mut log =
            JsonlEventLog::<Probe>::open(tmp.path(), "test_logs", job_id).expect("open log");
        log.emit(&Probe::First).expect("first emit");
        log.emit(&Probe::Second { value: 42 }).expect("second emit");
        assert_eq!(log.current_seq(), 2);
        drop(log);

        let path = tmp.path().join("test_logs").join(format!("{job_id}.jsonl"));
        let body = std::fs::read_to_string(&path).expect("read log");
        let lines: Vec<_> = body.lines().collect();
        assert_eq!(lines.len(), 2, "one JSONL line per emit() call");

        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["seq"], 1);
        assert_eq!(first["kind"], "first");
        assert!(
            first["at"].as_str().unwrap().ends_with('Z'),
            "RFC3339 with Z suffix",
        );

        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["seq"], 2);
        assert_eq!(second["kind"], "second");
        assert_eq!(second["value"], 42);
        assert!(second["at"].as_str().is_some());
    }

    /// Open creates the subtree dir if missing.  Producers rely
    /// on this so the first open in a fresh workspace doesn't
    /// require an extra `create_dir_all` at the call site.
    #[test]
    fn open_creates_subtree_dir_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let subtree_dir = tmp.path().join("nested_logs");
        assert!(!subtree_dir.exists(), "subtree dir absent pre-open");
        let job_id = JobId::new();
        let _log = JsonlEventLog::<Probe>::open(tmp.path(), "nested_logs", job_id)
            .expect("open creates dir");
        assert!(subtree_dir.is_dir(), "subtree dir materialised on open");
    }

    /// `enforce_keep_last_n` runs at open time: pre-existing
    /// stale `.jsonl` siblings beyond the cap are unlinked, and
    /// the newly-opened log survives as the freshest entry.
    /// Mirrors the per-producer retention test in `log_retention`
    /// at the writer boundary, so an open-side regression
    /// surfaces here without needing the helper-level test to
    /// chase it through the producer mutexes.
    #[test]
    fn open_enforces_keep_last_n() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace_dir = tmp.path();
        let dir = workspace_dir.join("test_logs");
        std::fs::create_dir_all(&dir).unwrap();
        let cap = super::super::LOG_RETENTION_KEEP_COUNT;
        // Stage one more stale log than the keep cap, oldest
        // first.  Backdate mtimes so the new log out-fresh-es
        // all of them at open time.
        let mut stale_paths = Vec::with_capacity(cap + 1);
        for i in 0..=cap {
            let p = dir.join(format!("00000000-0000-4000-8000-{i:012x}.jsonl"));
            std::fs::write(&p, b"{}\n").unwrap();
            let backdate = std::time::SystemTime::now()
                .checked_sub(std::time::Duration::from_secs((1000 - i as u64) * 60))
                .expect("backdate");
            let secs = backdate
                .duration_since(std::time::UNIX_EPOCH)
                .expect("post-epoch")
                .as_secs();
            let ft = filetime::FileTime::from_unix_time(secs as i64, 0);
            filetime::set_file_mtime(&p, ft).expect("set mtime");
            stale_paths.push(p);
        }
        let job_id = JobId::new();
        let _log =
            JsonlEventLog::<Probe>::open(workspace_dir, "test_logs", job_id).expect("open log");

        let new_path = dir.join(format!("{job_id}.jsonl"));
        assert!(new_path.is_file(), "new log survives");
        // (cap+1) stale + 1 new = cap+2 total; cap+2 - cap = 2
        // oldest stale files unlinked.
        assert!(!stale_paths[0].exists(), "oldest stale unlinked");
        assert!(!stale_paths[1].exists(), "second-oldest stale unlinked");
        assert!(stale_paths[2].exists(), "third-oldest survives the cap");
        let remaining = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .ok()
                    .and_then(|e| e.file_name().into_string().ok())
                    .is_some_and(|n| n.ends_with(".jsonl"))
            })
            .count();
        assert_eq!(remaining, cap, "exactly `cap` jsonl files remain");
    }
}
