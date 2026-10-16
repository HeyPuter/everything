// Camera solver worker: runs the reconstruction off the main thread and streams progress.
import { solveCamera, type SolveResult, type SolveSettings, type SolveTrack } from './pipeline';

export type SolveRequest = { tracks: SolveTrack[]; settings: SolveSettings };
export type SolveMessage = { type: 'progress'; fraction: number; message: string } | { type: 'done'; result: SolveResult } | { type: 'error'; error: string };

const scope = globalThis as unknown as { document?: unknown; onmessage: ((e: MessageEvent<SolveRequest>) => void) | null; postMessage: (m: SolveMessage) => void };
const WGS = (globalThis as { WorkerGlobalScope?: new () => unknown }).WorkerGlobalScope;
if (typeof scope.document === 'undefined' && WGS && globalThis instanceof WGS) {
  scope.onmessage = (e) => {
    let last = -1,
      lastMsg = '';
    try {
      const result = solveCamera(e.data.tracks, e.data.settings, {
        progress: (fraction, message) => {
          if (fraction - last < 0.005 && message === lastMsg) return;
          last = fraction;
          lastMsg = message;
          scope.postMessage({ type: 'progress', fraction, message });
        },
      });
      scope.postMessage({ type: 'done', result });
    } catch (err) {
      scope.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  };
}
