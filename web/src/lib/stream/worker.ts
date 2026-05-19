/// <reference lib="webworker" />

import { decodeEnvelope, type TopK } from './proto';

// Web Worker that owns both WebSocket streams (/stream/audio,
// /stream/infer) for the lifetime of the page.  It decodes envelopes,
// runs the Opus payload through WebCodecs AudioDecoder, and posts
// transferable Float32Array PCM windows + inference frames to the main
// thread.  Frames are drained continuously regardless of UI visibility
// (the daemon disconnects clients that lag > 64 frames).

const SUBPROTOCOL = 'acoustics';
// Initial reconnect delay after a WS close.  Doubles on each successive
// failure up to RECONNECT_MAX_MS; resets to MIN on a successful onopen.
// MIN was 200 ms originally -- too aggressive: under a steady WS reject
// (daemon up but `/stream/audio` failing) the first ~5 retries fire in
// well under 10 s, each posting a `status` message to the main thread
// that re-renders the deploy preview's pill.  1 s gives the daemon a
// realistic window to come back without flooding the main thread.
// Most daemon restarts take ≥ 1 s anyway, so the recovery latency
// regression is negligible; the cap at 5 s is unchanged so persistent
// outages settle into the same long-tail cadence.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 5_000;
const OPUS_SAMPLE_RATE = 48_000;

type Channel = 'audio' | 'infer';
type SocketState = 'connecting' | 'open' | 'closed' | 'error';

type InMsg = { type: 'start' } | { type: 'stop' };

type OutMsg =
  | { type: 'audio'; seq: number; t_us_capture: number | null; pcm: Float32Array }
  | {
      type: 'inference';
      seq: number;
      t_us_capture: number | null;
      top_k: TopK[];
      head_id: string | null;
      head_version: number | null;
    }
  | { type: 'status'; channel: Channel; state: SocketState }
  | { type: 'unsupported'; reason: string };

interface ChannelState {
  ws: WebSocket | null;
  backoff: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const channels: Record<Channel, ChannelState> = {
  audio: { ws: null, backoff: RECONNECT_MIN_MS, retryTimer: null },
  infer: { ws: null, backoff: RECONNECT_MIN_MS, retryTimer: null }
};

let running = false;
let opusDecoder: AudioDecoder | null = null;
const pendingAudioMeta: { seq: number; t_us: number | null }[] = [];

self.onmessage = (e: MessageEvent<InMsg>) => {
  switch (e.data.type) {
    case 'start':
      start();
      break;
    case 'stop':
      stop();
      break;
  }
};

function start(): void {
  if (running) return;
  running = true;

  if (typeof AudioDecoder === 'undefined') {
    post({
      type: 'unsupported',
      reason:
        'WebCodecs AudioDecoder is unavailable in this browser. Live audio playback will not work.'
    });
    // The audio channel never gets `openChannel`'d in this branch
    // (no decoder to feed), so explicitly post `closed` for it so
    // the main thread's optimistic 'connecting' state -- set
    // synchronously inside `streams.connectClient` to avoid a
    // first-frame "disconnected" flash -- flips back to the
    // truthful "we won't try" sentinel.  Without this, audioStatus
    // would hang at 'connecting' forever and the dashboard's
    // VisualizationPanel pill would read amber indefinitely.
    post({ type: 'status', channel: 'audio', state: 'closed' });
    // Inference still works without the audio decoder.
    openChannel('infer');
    return;
  }

  opusDecoder = new AudioDecoder({
    output: onDecodedAudio,
    error: (e) => {
      console.warn('opus decode error', e);
    }
  });
  opusDecoder.configure({ codec: 'opus', sampleRate: OPUS_SAMPLE_RATE, numberOfChannels: 1 });

  openChannel('audio');
  openChannel('infer');
}

function stop(): void {
  running = false;
  for (const ch of ['audio', 'infer'] as const) {
    const c = channels[ch];
    if (c.retryTimer) clearTimeout(c.retryTimer);
    c.retryTimer = null;
    c.ws?.close();
    c.ws = null;
  }
  pendingAudioMeta.length = 0;
  opusDecoder?.close();
  opusDecoder = null;
}

function openChannel(ch: Channel): void {
  if (!running) return;
  const c = channels[ch];
  post({ type: 'status', channel: ch, state: 'connecting' });

  const url = `${wsBase()}/stream/${ch === 'audio' ? 'audio' : 'infer'}`;
  const ws = new WebSocket(url, SUBPROTOCOL);
  ws.binaryType = 'arraybuffer';
  c.ws = ws;

  ws.onopen = () => {
    c.backoff = RECONNECT_MIN_MS;
    post({ type: 'status', channel: ch, state: 'open' });
  };
  ws.onmessage = (e) => {
    handleFrame(new Uint8Array(e.data as ArrayBuffer));
  };
  ws.onerror = () => {
    post({ type: 'status', channel: ch, state: 'error' });
  };
  ws.onclose = () => {
    post({ type: 'status', channel: ch, state: 'closed' });
    if (!running) return;
    c.retryTimer = setTimeout(() => {
      openChannel(ch);
    }, c.backoff);
    c.backoff = Math.min(RECONNECT_MAX_MS, c.backoff * 2);
  };
}

function wsBase(): string {
  return self.location.origin.replace(/^http/, 'ws');
}

function handleFrame(bytes: Uint8Array): void {
  let env;
  try {
    env = decodeEnvelope(bytes);
  } catch (e) {
    console.warn('envelope decode failed', e);
    return;
  }
  switch (env.kind) {
    case 'audio':
      dispatchAudio(env.audio);
      return;
    case 'inference':
      dispatchInference(env.inference);
      return;
    case 'unknown':
      return;
  }
}

function dispatchAudio(frame: import('./proto').AudioFrame): void {
  if (frame.codec !== 'opus' || !frame.payload || !opusDecoder) return;
  pendingAudioMeta.push({ seq: frame.seq, t_us: frame.t_us_capture_monotonic });
  try {
    opusDecoder.decode(
      new EncodedAudioChunk({
        type: 'key',
        timestamp: frame.t_us_capture_monotonic ?? 0,
        data: frame.payload
      })
    );
  } catch (e) {
    // Drop the matched meta entry on failure so we don't desynchronise
    // the FIFO.
    pendingAudioMeta.pop();
    console.warn('opus decode dispatch failed', e);
  }
}

function onDecodedAudio(audio: AudioData): void {
  const meta = pendingAudioMeta.shift();
  const pcm = new Float32Array(audio.numberOfFrames);
  try {
    audio.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
  } catch {
    try {
      audio.copyTo(pcm, { planeIndex: 0, format: 'f32' });
    } catch (e) {
      console.warn('AudioData copy failed', e);
      audio.close();
      return;
    }
  }
  audio.close();
  const msg: OutMsg = {
    type: 'audio',
    seq: meta?.seq ?? 0,
    t_us_capture: meta?.t_us ?? null,
    pcm
  };
  (self as unknown as Worker).postMessage(msg, [pcm.buffer]);
}

function dispatchInference(frame: import('./proto').InferenceFrame): void {
  post({
    type: 'inference',
    seq: frame.seq,
    t_us_capture: frame.t_us_capture_monotonic,
    top_k: frame.top_k,
    head_id: frame.head_id,
    head_version: frame.head_version
  });
}

function post(msg: OutMsg): void {
  (self as unknown as Worker).postMessage(msg);
}

export {};
