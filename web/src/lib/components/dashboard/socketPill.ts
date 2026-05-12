import type { SocketState } from '$lib/stream/client';

// Shared status-pill vocabulary for the Visualization and Inference
// panels.  Same socket lifecycle, same colours; centralising prevents
// drift if one panel's pill is restyled without the other.

export const SOCKET_LABEL: Record<SocketState, string> = {
  connecting: 'connecting',
  open: 'live',
  closed: 'disconnected',
  error: 'error'
};

export function socketPillClass(state: SocketState): string {
  switch (state) {
    case 'open':
      return 'bg-emerald-100 text-emerald-700';
    case 'connecting':
      return 'bg-amber-100 text-amber-700';
    default:
      return 'bg-rose-100 text-rose-700';
  }
}
