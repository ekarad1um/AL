// Silence detection for slice validation.
//
// The daemon's training pipeline drops a slice when its
// 43x232 log-magnitude spectrogram contains a non-finite
// value (see [modules/training/finetune.rs]'s `extract_features`
// NaN scan, and [modules/preproc.rs] for the framing).  The
// dominant trigger for FE-generated slices is digital silence:
// any 2048-sample FFT frame whose windowed PCM is all-zero
// produces `log(0) = -inf` in every bin, which poisons the
// per-plane z-normalize to `NaN` (`(-inf - -inf) / NaN = NaN`).
// The trained classifier's `spectrogram_elements_finite` filter
// then drops the slice from the training set; > 10 % drops
// fails the whole job (`MAX_DROP_RATIO` in `finetune.rs`).
//
// On the daemon side, WAV ingest (`wav_io::read_wav_mono` +
// `to_waveform`) accepts our frontend-encoded PCM-i16 slices
// unconditionally -- the IO-error drop reasons (WavOpen /
// Decode / Format / InvalidHeader / TooLong / BadSample /
// Resample) cannot fire for a 44.1 kHz mono PCM-i16 WAV that
// was just hashed and uploaded.  So the *only* drop reason
// reachable from the slicer's output is the NaN-spectrogram
// path, and that one is fully predictable from the source PCM
// alone: an FFT frame is all-zero iff every sample inside it
// quantizes to int16 0 (the daemon reads int16 0 as f32 0.0).
//
// We mirror the daemon's frame layout exactly so this
// frontend gate is a precise inverse of the backend filter --
// no false positives (we never flag a slice that the daemon
// would accept) and no false negatives (we never let through
// a slice that the daemon would NaN-drop).  Locked in by the
// `any_silent_frame_produces_all_nan_spectrogram` test in
// [modules/preproc.rs].
//
// Bidirectional precision depends on one extra invariant: the
// bundled Blackman window
// (`modules/preproc/window_blackman_2048.bin`) must have NO
// exact-zero taps.  If any tap is exactly 0.0f32, the BE FFT
// would zero out the corresponding PCM sample's contribution
// regardless of its value, and "frame all-zero" would no
// longer require "PCM all-zero" -- a stray non-zero sample at
// a zeroed tap would still produce an all-zero FFT input that
// our window-based check would miss.  Verified empirically:
// the bundled bytes give `w[0] = 1.49e-8` and every other tap
// >= 8.6e-7, so the BE NaN trigger reduces exactly to "every
// PCM sample in some FFT frame quantizes to int16 0", which
// is what `wouldNanAtPreproc` below checks.  If the bundled
// window is ever regenerated (e.g. switching back to the
// `numpy.blackman` symmetric variant, which has `w[0] = 0`
// exactly), revisit the algorithm below.

// FFT frame length used by the daemon's preproc.  Mirrors
// `FRAME_LEN` in [modules/preproc.rs].
export const PREPROC_FRAME_LEN = 2048;
// Hop between FFT frames.  Mirrors `HopSamples::USIZE` in
// [modules/common/dims.rs].
export const PREPROC_HOP = 1024;
// Frame count emitted by the daemon's spectrogram.  Mirrors
// `NFrames::USIZE`.
export const PREPROC_N_FRAMES = 43;
// Effective input length the daemon's spectrogram consumes.
// Frontend slices are 44 100 samples (1 s @ 44.1 kHz); the
// daemon's `to_waveform` truncates the trailing 68 samples
// before the spectrogram, so silence detection looks only at
// the first 44 032.  Mirrors `WaveformLen::USIZE`.
export const PREPROC_WAVEFORM_LEN = 44_032;
// Non-overlapping 1024-sample windows that tile the 44 032
// effective-input range.  Each window appears in at most two
// adjacent FFT frames (frame 0 = window 0 only, frame i>=1 =
// windows (i-1) and i).  Equals `PREPROC_WAVEFORM_LEN /
// PREPROC_HOP`; pinned to the literal so the type-narrowing
// assertion below catches a drift in any of the three
// constants at compile time.
export const PREPROC_N_WINDOWS = 43;

// Compile-time sanity: framing constants must match the
// daemon byte-for-byte or the detector silently disagrees with
// the BE NaN trigger.  Sized so a typo here trips
// `svelte-check`'s narrowing rather than running in prod.
// `void` references prevent eslint `no-unused-vars` from
// flagging what are really compile-time type assertions.
// Derivation invariant (PREPROC_N_WINDOWS * PREPROC_HOP ===
// PREPROC_WAVEFORM_LEN) is not expressible at the TS type
// level without a cast (literal arithmetic isn't evaluated),
// so it's enforced via the runtime assertion below instead.
const _PREPROC_FRAME_OK: 2048 = PREPROC_FRAME_LEN;
const _PREPROC_HOP_OK: 1024 = PREPROC_HOP;
const _PREPROC_N_FRAMES_OK: 43 = PREPROC_N_FRAMES;
const _PREPROC_WAVEFORM_OK: 44_032 = PREPROC_WAVEFORM_LEN;
const _PREPROC_N_WINDOWS_OK: 43 = PREPROC_N_WINDOWS;
void _PREPROC_FRAME_OK;
void _PREPROC_HOP_OK;
void _PREPROC_N_FRAMES_OK;
void _PREPROC_WAVEFORM_OK;
void _PREPROC_N_WINDOWS_OK;

// Module-load self-check: catches a drift between
// WAVEFORM_LEN, HOP, and N_WINDOWS that the literal pins
// above would let through (e.g. someone bumped HOP from 1024
// to 2048 and updated N_WINDOWS to match but forgot
// WAVEFORM_LEN).  Throws synchronously at module load so the
// page errors out instead of silently mis-classifying every
// slice as non-silent (the FFT framing would then disagree
// with the daemon).  Cost is one multiply at startup.
if (PREPROC_N_WINDOWS * PREPROC_HOP !== PREPROC_WAVEFORM_LEN) {
  throw new Error(
    `silence framing invariant broken: N_WINDOWS(${PREPROC_N_WINDOWS}) * HOP(${PREPROC_HOP}) !== WAVEFORM_LEN(${PREPROC_WAVEFORM_LEN})`
  );
}

// Does this float quantize to int16 0 under
// `quantiseFloat32ToInt16` in [audio/wav.ts]?  Asymmetric
// int16 scaling (-1 -> -32768, +1 -> +32767) combined with
// ECMA `Math.round`'s "round half toward +Infinity" rule
// (`Math.round(-0.5) === 0`, `Math.round(0.5) === 1`) makes
// the zero-band asymmetric on each side, so we simulate the
// exact encoder formula rather than using a single absolute
// threshold.  Inlined-friendly enough that V8 / JSC fold the
// multiply-round-compare into ~3 instructions; the per-frame
// loop early-exits on the first non-zero sample, so loud audio
// pays ~one call per frame at worst.
function quantizesToZero(s: number): boolean {
  // NaN -> int16 0 via the encoder's `out[i] = Math.round(...)`
  // chain (`Math.round(NaN) = NaN`, then `Int16Array[i] = NaN`
  // applies ECMA `ToInt16(NaN) = 0`).  Defensive: every FE PCM
  // source (Web Audio decode, recorder, resample) produces
  // finite samples, so NaN should be unreachable here, but
  // treating it as zero keeps the FE filter aligned with what
  // the encoder would write -- the alternative (leaving NaN as
  // "non-silent") would let a NaN-tainted slice through to the
  // daemon, which sees a frame of all-zero int16 and NaN-drops
  // it.
  if (Number.isNaN(s)) return true;
  // Match the encoder's clamp: any input outside [-1, 1] is
  // saturated before the round.  +/-Inf clamps to +/-1, which
  // then encodes to +/-32767/-32768 -- non-zero.
  const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
  if (clamped < 0) {
    // Negative arm: scale by 0x8000.  `Math.round(-0.5) = 0`
    // (toward +Inf), so the zero-band on this side is
    // `[-0.5/32768, 0)` -- closed at the boundary
    // (`Math.round(-0.5) = 0` includes the edge), open at zero
    // (s=0 takes the non-negative arm below).
    return Math.round(clamped * 0x8000) === 0;
  }
  // Non-negative arm (includes +0 and -0; `-0 < 0` is false in
  // ECMA).  Scale by 0x7fff.  `Math.round(+0.5) = 1`, so the
  // zero-band is `[0, 0.5/32767)` -- closed at zero, open at
  // the boundary.
  return Math.round(clamped * 0x7fff) === 0;
}

// Is every sample in `pcm[start..end)` quantize-to-zero?
// Treats samples past `pcm.length` as zero (matches the
// daemon's `to_waveform` zero-pad behaviour for short inputs).
function isWindowSilent(pcm: Float32Array, start: number, end: number): boolean {
  const lo = Math.max(0, start);
  const hi = Math.min(end, pcm.length);
  for (let i = lo; i < hi; i++) {
    if (!quantizesToZero(pcm[i])) return false;
  }
  return true;
}

// Would the daemon's preproc emit a NaN spectrogram for the
// slice located at `pcm[offset .. offset + PREPROC_WAVEFORM_LEN]`?
//
// Returns true iff at least one of the 43 FFT frames the
// daemon constructs would have all-zero windowed input after
// the int16 round-trip.  Frame layout (mirrors `preproc.rs`):
//
//   frame 0 -> pcm[offset .. offset+1024]
//              (with 1024 leading zero pad from `FRONT_PAD`)
//   frame i -> pcm[offset + (i-1)*1024 .. offset + (i+1)*1024]
//              for i in 1..43.
//
// Reduce to non-overlapping 1024-sample windows
// (`window k = pcm[offset + k*1024 .. offset + (k+1)*1024]`):
//
//   frame 0 silent  <->  window 0 silent.
//   frame i>=1 silent  <->  window (i-1) AND window i both silent.
//
// So the slice produces a NaN spectrogram iff window 0 is
// silent OR any two adjacent windows are both silent.  Single
// pass over the windows, holding the prior window's silent
// flag so we never re-scan: worst case is 43 * 1024 =
// PREPROC_WAVEFORM_LEN sample comparisons (an entirely-silent
// slice); typical case (any loud audio anywhere) is bounded
// by the first non-zero sample of the first window we touch.
export function wouldNanAtPreproc(pcm: Float32Array, offset = 0): boolean {
  let prevSilent = false;
  for (let k = 0; k < PREPROC_N_WINDOWS; k++) {
    const start = offset + k * PREPROC_HOP;
    const end = start + PREPROC_HOP;
    const curSilent = isWindowSilent(pcm, start, end);
    if (k === 0) {
      // Frame 0 reads window 0 only (the front pad fills the
      // leading half), so an all-zero window 0 -> all-zero
      // frame 0 -> NaN regardless of later windows.
      if (curSilent) return true;
    } else if (prevSilent && curSilent) {
      // Frame k reads windows (k-1) and k.  Both silent ->
      // frame k all-zero -> NaN.
      return true;
    }
    prevSilent = curSilent;
  }
  return false;
}
